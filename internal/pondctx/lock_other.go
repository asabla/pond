//go:build !unix

package pondctx

import "os"

// lockFile is a no-op where flock is unavailable: pond cannot detect another instance there.
func lockFile(*os.File) (bool, error) { return true, nil }
