package pondctx

import "syscall"

// signal0 probes whether a process exists without disturbing it.
const signal0 = syscall.Signal(0)
