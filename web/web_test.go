package web

import (
	"os/exec"
	"testing"
)

// TestUI runs the UI's JavaScript unit tests (web/test/) with Node's built-in runner,
// so `go test ./...` covers them too. It skips when Node is not installed.
func TestUI(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not found; run `node --test web/test/` to test the UI")
	}
	out, err := exec.Command(node, "--test", "test/").CombinedOutput()
	if err != nil {
		t.Fatalf("node --test failed: %v\n%s", err, out)
	}
}
