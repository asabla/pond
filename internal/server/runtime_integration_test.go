package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/asabla/pond/internal/lake"
)

// Opt-in: this writes synthetic data and runs Spark on a disposable managed Pond.
// Normal unit tests do not start an engine or download images/packages.
func TestLiveRuntimeAcceptance(t *testing.T) {
	endpoint := os.Getenv("POND_RUNTIME_ACCEPTANCE_URL")
	if endpoint == "" {
		t.Skip("set POND_RUNTIME_ACCEPTANCE_URL to a disposable managed Pond context")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	call := func(method, path string, body any) map[string]any {
		t.Helper()
		var payload io.Reader
		if body != nil {
			b, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			payload = bytes.NewReader(b)
		}
		req, err := http.NewRequestWithContext(ctx, method, endpoint+path, payload)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var result map[string]any
		if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
		if response.StatusCode >= 400 {
			t.Fatalf("%s %s: %d %v", method, path, response.StatusCode, result)
		}
		return result
	}
	cfg := call(http.MethodGet, "/pond/config", nil)
	contextInfo, ok := cfg["context"].(map[string]any)
	if !ok {
		t.Fatal("acceptance needs a managed, disposable context")
	}
	t.Logf("runtime: %v", cfg["runtime"])
	key := fmt.Sprintf("runtime_%d", time.Now().UnixNano())
	root := fmt.Sprint(cfg["data_root"])
	path := root + "/" + key
	callback := fmt.Sprintf("http://%s:8000/_minilake/health", contextInfo["container"])
	source := fmt.Sprintf(`import urllib.request
from pyspark.sql import SparkSession
with urllib.request.urlopen(%q, timeout=10) as response:
    assert response.status == 200
spark = (SparkSession.builder
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension")
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog")
    .getOrCreate())
spark.range(3).write.format("delta").mode("overwrite").save(%q)
print("POND_RUNTIME_DELTA_OK", spark.range(3).count())
`, callback, path)
	workspace := "/Shared/pond/acceptance/" + key + ".py"
	call(http.MethodPost, "/api/2.0/workspace/mkdirs", map[string]string{"path": "/Shared/pond/acceptance"})
	call(http.MethodPost, "/api/2.0/workspace/import", map[string]any{"path": workspace, "format": "SOURCE", "language": "PYTHON", "overwrite": false, "content": base64.StdEncoding.EncodeToString([]byte(source))})
	submitted := call(http.MethodPost, "/api/2.2/jobs/runs/submit", map[string]any{"run_name": key, "tasks": []any{map[string]any{"task_key": "main", "spark_python_task": map[string]string{"python_file": workspace}, "libraries": []any{map[string]any{"maven": map[string]string{"coordinates": "io.delta:delta-spark_2.12:3.2.1"}}}}}})
	runID := fmt.Sprint(submitted["run_id"])
	for {
		run := call(http.MethodGet, "/api/2.2/jobs/runs/get?run_id="+runID, nil)
		state := run["state"].(map[string]any)
		life := fmt.Sprint(state["life_cycle_state"])
		if life == "TERMINATED" || life == "INTERNAL_ERROR" || life == "SKIPPED" {
			outputID := runID
			if tasks, ok := run["tasks"].([]any); ok && len(tasks) > 0 {
				outputID = fmt.Sprint(tasks[0].(map[string]any)["run_id"])
			}
			output := call(http.MethodGet, "/api/2.2/jobs/runs/get-output?run_id="+outputID, nil)
			if state["result_state"] != "SUCCESS" || !strings.Contains(fmt.Sprint(output["logs"]), "POND_RUNTIME_DELTA_OK 3") {
				t.Fatalf("job: %v\noutput: %v", state, output)
			}
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(time.Second):
		}
	}
	client, err := lake.New(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	query := fmt.Sprintf("SELECT count(*) AS n FROM delta_scan('%s')", path)
	result, err := client.QuerySQL(ctx, query, 1, 64*1024)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 1 || fmt.Sprint(result.Rows[0][0]) != "3" {
		t.Fatalf("SQL could not read Spark's shared Delta data: %+v", result)
	}
	if err := client.EnsureSavedQuery(ctx, key, query); err != nil {
		t.Fatal(err)
	}
	t.Logf("passed: engine job, shared script/data, MiniLake network callback, Spark Delta write, SQL Delta read; saved query %s", key)
}
