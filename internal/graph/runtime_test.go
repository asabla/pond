package graph

import (
	"context"
	"encoding/json"
	"github.com/dop251/goja"
	"math"
	"os"
	"os/exec"
	"reflect"
	"testing"
	"time"
)

func TestEmbeddedEngine(t *testing.T) {
	e, err := newEngine(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer e.close()
	for _, sql := range []string{"SELECT 1, 2; DROP TABLE t", "SELECT 1, 2 -- comment\n; DELETE FROM t"} {
		problem, err := e.call("validateDefinition", Definition{EdgesSQL: sql, Directed: true})
		if err != nil || goja.IsNull(problem) {
			t.Fatalf("multiple statements accepted: %q: %v %v", sql, problem, err)
		}
	}
	v, err := e.call("definitionFromTables", map[string]any{"edgeTable": "a.b.c", "source": "s", "target": "t"})
	if err != nil {
		t.Fatal(err)
	}
	var def Definition
	if err := e.export(v, &def); err != nil {
		t.Fatal(err)
	}
	if def.EdgesSQL == "" {
		t.Fatal("empty definition")
	}
	if _, err := e.vm.RunString(`var g = pondGraphCore.createGraph(graphology, true);
pondGraphCore.addEdges(g, [{source:"a",target:"b",weight:2,attributes:{}},{source:"b",target:"a",weight:3,attributes:{}}], true);
pondGraphCore.metric(g, graphologyLibrary, "pagerank", true);`); err != nil {
		t.Fatal(err)
	}
}

func TestBrowserAndEmbeddedParity(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is required for browser-engine parity")
	}
	source, err := os.ReadFile("../../web/test/analysis-fixture.js")
	if err != nil {
		t.Fatal(err)
	}
	e, err := newEngine(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer e.close()
	if _, err := e.vm.RunString(string(source)); err != nil {
		t.Fatal(err)
	}
	v, err := e.vm.RunString("runGraphFixtures()")
	if err != nil {
		t.Fatal(err)
	}
	var actual any
	if err := e.export(v, &actual); err != nil {
		t.Fatal(err)
	}
	script := `const fs=require('fs'),vm=require('vm'); const ctx=vm.createContext({DOMParser:function(){},Document:function(){}});
for(const f of ['../../web/static/vendor/graphology.umd.min.js','../../web/static/vendor/graphology-library.min.js','../../web/static/graph-core.js','../../web/test/analysis-fixture.js']) vm.runInContext(fs.readFileSync(f,'utf8'),ctx);
process.stdout.write(vm.runInContext('JSON.stringify(runGraphFixtures())',ctx));`
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, node, "-e", script).CombinedOutput()
	if err != nil {
		t.Fatalf("browser engine: %v: %s", err, out)
	}
	var expected any
	if err := json.Unmarshal(out, &expected); err != nil {
		t.Fatal(err)
	}
	compareJSON(t, "fixtures", actual, expected)
}

func compareJSON(t *testing.T, path string, a, b any) {
	t.Helper()
	switch a := a.(type) {
	case float64:
		v, ok := b.(float64)
		if !ok || math.Abs(a-v) > 1e-9 {
			t.Errorf("%s: %v != %v", path, a, b)
		}
	case []any:
		v, ok := b.([]any)
		if !ok || len(a) != len(v) {
			t.Errorf("%s: array mismatch", path)
			return
		}
		for i := range a {
			compareJSON(t, path+"[]", a[i], v[i])
		}
	case map[string]any:
		v, ok := b.(map[string]any)
		if !ok || len(a) != len(v) {
			t.Errorf("%s: object mismatch", path)
			return
		}
		for key := range a {
			compareJSON(t, path+"."+key, a[key], v[key])
		}
	default:
		if !reflect.DeepEqual(a, b) {
			t.Errorf("%s: %v != %v", path, a, b)
		}
	}
}

func TestRuntimeCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	e, err := newEngine(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer e.close()
	cancel()
	if _, err := e.vm.RunString("for (;;) {}"); err == nil {
		t.Fatal("execution was not interrupted")
	}
}

func TestEmbeddedSQLPathPromise(t *testing.T) {
	e, err := newEngine(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer e.close()
	value, err := e.vm.RunString(`pondGraphCore.sqlShortestPath({def:{edges_sql:"SELECT a,b FROM t"}, columns:{source:"a",target:"b"},from:1,to:2,directed:true,runSql:()=>({rows:[[1,2]]})})`)
	if err != nil {
		t.Fatal(err)
	}
	promise, ok := value.Export().(*goja.Promise)
	if !ok || promise.State() != goja.PromiseStateFulfilled {
		t.Fatalf("path promise: %v", value)
	}
	var nodes []int
	if err := e.export(promise.Result(), &nodes); err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 2 || nodes[0] != 1 || nodes[1] != 2 {
		t.Fatalf("path: %v", nodes)
	}
}
