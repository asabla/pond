package pondctx

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// DataPath is the lake's data on the host: everything MiniLake persists.
func (c Context) DataPath() string { return filepath.Join(c.StateDir(), "data") }

// cacheDirs hold downloads MiniLake can fetch again; snapshots leave them out.
var cacheDirs = []string{".ivy2-cache"}

// Fresh reports whether the context has no lake data yet.
func Fresh(c Context) bool {
	entries, err := os.ReadDir(c.DataPath())
	if err != nil {
		return true
	}
	for _, e := range entries {
		if e.Name() != ".pond-mount" {
			return false
		}
	}
	return true
}

// ClearData deletes the lake's data. The context must not be running.
func ClearData(c Context) error {
	entries, err := os.ReadDir(c.DataPath())
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, e := range entries {
		if err := os.RemoveAll(filepath.Join(c.DataPath(), e.Name())); err != nil {
			return err
		}
	}
	return nil
}

// Export writes the lake's data as a gzipped tar. The context must not be running, so
// MiniLake has written its snapshot and nothing changes underneath.
func Export(c Context, w io.Writer) error {
	if _, err := os.Stat(c.DataPath()); err != nil {
		return fmt.Errorf("%s has no lake data to export", c.Name())
	}
	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)
	err := filepath.WalkDir(c.DataPath(), func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(c.DataPath(), path)
		if err != nil || rel == "." {
			return err
		}
		rel = filepath.ToSlash(rel)
		if d.IsDir() && isCache(rel) {
			return filepath.SkipDir
		}
		if rel == ".pond-mount" || !(d.IsDir() || d.Type().IsRegular()) {
			return nil // skip the mount marker, symlinks, sockets and the like
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		hdr.Name = rel
		hdr.Uid, hdr.Gid, hdr.Uname, hdr.Gname = 0, 0, "", ""
		if d.IsDir() {
			hdr.Name += "/"
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(tw, f)
		return err
	})
	if err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}

func isCache(rel string) bool {
	for _, dir := range cacheDirs {
		if rel == dir {
			return true
		}
	}
	return false
}

// Import replaces the lake's data with a snapshot written by Export. The context must not
// be running. The snapshot is unpacked beside the data first, so a bad one changes nothing.
func Import(c Context, r io.Reader) error {
	if err := PrepareStateDir(c); err != nil {
		return err
	}
	staging := filepath.Join(c.StateDir(), "data.importing")
	if err := os.RemoveAll(staging); err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	if err := unpack(r, staging); err != nil {
		return err
	}
	old := filepath.Join(c.StateDir(), "data.old")
	os.RemoveAll(old)
	if err := os.Rename(c.DataPath(), old); err != nil {
		return err
	}
	if err := os.Rename(staging, c.DataPath()); err != nil {
		os.Rename(old, c.DataPath())
		return err
	}
	for _, dir := range cacheDirs { // snapshots leave caches out; keep the ones already here
		os.Rename(filepath.Join(old, dir), filepath.Join(c.DataPath(), dir))
	}
	return os.RemoveAll(old)
}

// unpack extracts a snapshot into dir, refusing entries that would land outside it.
func unpack(r io.Reader, dir string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return fmt.Errorf("not a pond snapshot: %w", err)
	}
	defer gz.Close()
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return err
	}
	os.Chmod(dir, 0o777) // MiniLake may write as another user, like the data folder it replaces
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("not a pond snapshot: %w", err)
		}
		name := filepath.FromSlash(strings.TrimSuffix(hdr.Name, "/"))
		if !filepath.IsLocal(name) {
			return fmt.Errorf("snapshot entry %q points outside the lake", hdr.Name)
		}
		target := filepath.Join(dir, name)
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o777); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
				return err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, hdr.FileInfo().Mode().Perm()|0o600)
			if err != nil {
				return err
			}
			_, err = io.Copy(f, tr)
			if cerr := f.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return err
			}
		default:
			return fmt.Errorf("snapshot entry %q is not a file or folder", hdr.Name)
		}
	}
}
