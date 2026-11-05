package pondctx

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestFreshUntilTheLakeHasData(t *testing.T) {
	c := ForDir(t.TempDir())
	if !Fresh(c) {
		t.Error("no .pond/ should be fresh")
	}
	write(t, filepath.Join(c.DataPath(), ".pond-mount"), "x")
	if !Fresh(c) {
		t.Error("only the mount marker should be fresh")
	}
	write(t, filepath.Join(c.DataPath(), "snapshot.json"), "{}")
	if Fresh(c) {
		t.Error("lake with data reported fresh")
	}
	if err := ClearData(c); err != nil || !Fresh(c) {
		t.Errorf("after ClearData: fresh=%v err=%v", Fresh(c), err)
	}
}

func TestExportImportRoundTrip(t *testing.T) {
	src := ForDir(t.TempDir())
	write(t, filepath.Join(src.DataPath(), "snapshot.json"), `{"v":1}`)
	write(t, filepath.Join(src.DataPath(), "delta", "shop", "orders", "part-0.parquet"), "PAR1")
	write(t, filepath.Join(src.DataPath(), ".ivy2-cache", "jars", "big.jar"), "jar")
	write(t, filepath.Join(src.DataPath(), ".pond-mount"), "id")

	var snap bytes.Buffer
	if err := Export(src, &snap); err != nil {
		t.Fatal(err)
	}

	dst := ForDir(t.TempDir())
	write(t, filepath.Join(dst.DataPath(), "old.duckdb"), "old")
	write(t, filepath.Join(dst.DataPath(), ".ivy2-cache", "jars", "kept.jar"), "jar")
	if err := Import(dst, bytes.NewReader(snap.Bytes())); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{
		"snapshot.json":                    `{"v":1}`,
		"delta/shop/orders/part-0.parquet": "PAR1",
		".ivy2-cache/jars/kept.jar":        "jar",
	} {
		if b, err := os.ReadFile(filepath.Join(dst.DataPath(), path)); err != nil || string(b) != want {
			t.Errorf("%s = %q, %v", path, b, err)
		}
	}
	for _, gone := range []string{"old.duckdb", ".ivy2-cache/jars/big.jar", ".pond-mount"} {
		if _, err := os.Stat(filepath.Join(dst.DataPath(), gone)); err == nil {
			t.Errorf("%s should not be in the imported lake", gone)
		}
	}
	if _, err := os.Stat(filepath.Join(dst.StateDir(), "data.importing")); err == nil {
		t.Error("staging folder left behind")
	}
}

func TestImportRefusesUnsafeSnapshotsAndKeepsData(t *testing.T) {
	for name, entry := range map[string]*tar.Header{
		"traversal": {Name: "../escape.txt", Typeflag: tar.TypeReg, Mode: 0o644},
		"absolute":  {Name: "/etc/evil", Typeflag: tar.TypeReg, Mode: 0o644},
		"symlink":   {Name: "link", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"},
	} {
		t.Run(name, func(t *testing.T) {
			var buf bytes.Buffer
			gz := gzip.NewWriter(&buf)
			tw := tar.NewWriter(gz)
			tw.WriteHeader(&tar.Header{Name: snapshotMarker, Typeflag: tar.TypeReg, Mode: 0o644})
			tw.WriteHeader(entry)
			tw.Close()
			gz.Close()

			c := ForDir(filepath.Join(t.TempDir(), "proj"))
			write(t, filepath.Join(c.DataPath(), "snapshot.json"), "keep")
			err := Import(c, &buf)
			if err == nil {
				t.Fatal("unsafe snapshot accepted")
			}
			if b, _ := os.ReadFile(filepath.Join(c.DataPath(), "snapshot.json")); string(b) != "keep" {
				t.Errorf("existing data changed after a refused import: %q", b)
			}
			if _, err := os.Stat(filepath.Join(filepath.Dir(c.Dir), "escape.txt")); err == nil {
				t.Error("file written outside the lake")
			}
		})
	}
	if err := Import(ForDir(t.TempDir()), strings.NewReader("not gzip")); err == nil || !strings.Contains(err.Error(), "not a pond snapshot") {
		t.Errorf("garbage: %v", err)
	}
}

func TestImportRefusesArchivesPondDidNotMake(t *testing.T) {
	for name, entries := range map[string][]string{"empty": nil, "foreign": {"README.md", "main.go"}} {
		var buf bytes.Buffer
		gz := gzip.NewWriter(&buf)
		tw := tar.NewWriter(gz)
		for _, n := range entries {
			tw.WriteHeader(&tar.Header{Name: n, Typeflag: tar.TypeReg, Mode: 0o644})
		}
		tw.Close()
		gz.Close()
		c := ForDir(filepath.Join(t.TempDir(), "proj"))
		write(t, filepath.Join(c.DataPath(), "snapshot.json"), "keep")
		if err := Import(c, &buf); err == nil || !strings.Contains(err.Error(), "not a pond snapshot") {
			t.Errorf("%s: %v", name, err)
		}
		if b, _ := os.ReadFile(filepath.Join(c.DataPath(), "snapshot.json")); string(b) != "keep" {
			t.Errorf("%s: data changed: %q", name, b)
		}
	}
}

func TestRecoverImportRestoresTheOnlyCopy(t *testing.T) {
	c := ForDir(t.TempDir())
	// Killed between the two renames: data is gone and data.old holds the lake.
	write(t, filepath.Join(c.oldDataPath(), "snapshot.json"), "old")
	if err := RecoverImport(c); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(c.DataPath(), "snapshot.json")); err != nil || string(b) != "old" {
		t.Errorf("data not restored: %q, %v", b, err)
	}

	// Killed after the swap: the new data stays, the old copy goes, caches move over.
	write(t, filepath.Join(c.oldDataPath(), ".ivy2-cache", "jar"), "cache")
	if err := RecoverImport(c); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(c.oldDataPath()); !os.IsNotExist(err) {
		t.Errorf("data.old left behind: %v", err)
	}
	if _, err := os.Stat(filepath.Join(c.DataPath(), ".ivy2-cache", "jar")); err != nil {
		t.Errorf("cache not kept: %v", err)
	}
}
