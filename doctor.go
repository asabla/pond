package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/asabla/pond/internal/lake"
	"github.com/asabla/pond/internal/pondctx"
)

// doctor only reads runtime state. Mount and in-container API probes run during
// explicit startup, before Pond reports the context ready.
func doctor(a *args) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if a.minilake != "" {
		client, err := lake.New(a.minilake)
		if err != nil {
			return err
		}
		if err := client.Health(ctx); err != nil {
			return err
		}
		fmt.Printf("Runtime: External MiniLake\nService: %s\nHealth: responding\nLifecycle, job runtime and backups: managed by the service owner\n", a.minilake)
		return nil
	}
	c := pondctx.ForDir(a.dir)
	if err := c.RuntimeError(); err != nil {
		return err
	}
	r := c.Runtime
	if a.runtime != "" || a.connection != "" || a.socket != "" || r == nil {
		var err error
		r, err = pondctx.ResolveRuntime(ctx, a.runtime, a.connection, a.socket)
		if err != nil {
			return err
		}
	} else if err := r.Probe(ctx); err != nil {
		return err
	}
	fmt.Printf("Runtime: %s (%s)\nVersion: %s\nConnection: %s\nHost endpoint: %s\nEngine socket for MiniLake: %s\nProject data: %s\n", r.Provider, r.Kind, r.Version, r.Connection, r.Endpoint, r.Socket, c.DataPath())
	if _, err := os.Stat(c.DataPath()); os.IsNotExist(err) {
		fmt.Println("Project data: created on first start")
	} else if err != nil {
		return fmt.Errorf("cannot read project data: %w; check ownership before starting", err)
	}
	fmt.Println("Mount and MiniLake API access: checked in the container on startup")
	fmt.Println("No containers were created and no default connection was changed.")
	return nil
}
