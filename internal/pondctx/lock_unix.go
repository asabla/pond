//go:build unix

package pondctx

import (
	"errors"
	"os"
	"syscall"
)

// lockFile takes an exclusive, non-blocking flock on f. The kernel drops it when the
// process exits, however it exits, so a held lock always means a live pond.
func lockFile(f *os.File) (bool, error) {
	err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) {
		return false, nil
	}
	return err == nil, err
}
