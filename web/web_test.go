package web

import (
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestUI runs the UI's JavaScript unit tests (web/test/) with Node's built-in runner,
// so `go test ./...` covers them too. It skips when Node is not installed.
func TestUI(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not found; run `node --test web/test/` to test the UI")
	}
	// Go caches test results by the files the test binary reads, not what node reads, so
	// read the UI and its tests here: changing any of them then reruns this test.
	for _, dir := range []string{"static", "test"} {
		err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				_, err = os.ReadFile(path)
			}
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	out, err := exec.Command(node, "--test", "test/").CombinedOutput()
	if err != nil {
		t.Fatalf("node --test failed: %v\n%s", err, out)
	}
}
