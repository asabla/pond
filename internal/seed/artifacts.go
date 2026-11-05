package seed

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/asabla/pond/internal/graph"
	"github.com/asabla/pond/internal/lake"
)

// SavedQuery is a named SQL query for the workbench.
type SavedQuery struct {
	Name string `json:"name"`
	SQL  string `json:"sql"`
}

// SavedArtifacts is the format of a pond-seed/*.pond.json file.
type SavedArtifacts struct {
	Queries []SavedQuery       `json:"queries,omitempty"`
	Graphs  []graph.Definition `json:"graphs,omitempty"`
}

// Target adds saved artifact support to the MiniLake client used for seeding.
type Target struct {
	*lake.Client
	graphs *graph.Service
}

// NewTarget returns the seed target for a running context.
func NewTarget(client *lake.Client) *Target {
	return &Target{Client: client, graphs: graph.New(client)}
}

// SeedArtifacts creates missing queries and graphs, preserving existing definitions.
func (t *Target) SeedArtifacts(ctx context.Context, artifacts SavedArtifacts) error {
	for _, query := range artifacts.Queries {
		if err := t.EnsureSavedQuery(ctx, query.Name, query.SQL); err != nil {
			return fmt.Errorf("query %q: %w", query.Name, err)
		}
	}
	if len(artifacts.Graphs) == 0 {
		return nil
	}
	existing, err := t.graphs.List(ctx)
	if err != nil {
		return err
	}
	names := map[string]bool{}
	for _, def := range existing {
		names[def.Name] = true
	}
	for _, def := range artifacts.Graphs {
		if names[def.Name] {
			continue
		}
		if _, err := t.graphs.Save(ctx, def, false); err != nil {
			return fmt.Errorf("graph %q: %w", def.Name, err)
		}
		names[def.Name] = true
	}
	return nil
}

func runArtifacts(ctx context.Context, target Lake, data []byte) error {
	var artifacts SavedArtifacts
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&artifacts); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("expected one saved-artifact JSON object")
	}
	if len(artifacts.Queries) == 0 && len(artifacts.Graphs) == 0 {
		return fmt.Errorf("saved-artifact file needs queries or graphs")
	}
	for _, query := range artifacts.Queries {
		if strings.TrimSpace(query.Name) == "" || strings.TrimSpace(query.SQL) == "" {
			return fmt.Errorf("saved queries need name and sql")
		}
	}
	for _, def := range artifacts.Graphs {
		if strings.TrimSpace(def.Name) == "" || strings.TrimSpace(def.EdgesSQL) == "" {
			return fmt.Errorf("saved graphs need name and edges_sql")
		}
	}
	return target.SeedArtifacts(ctx, artifacts)
}

// EnsureArtifacts adds missing saved definitions to an existing context. It does
// not run SQL or Python seeds, so existing table data is kept.
func EnsureArtifacts(ctx context.Context, target Lake, dir string, logf func(string, ...any)) error {
	files, err := Files(dir)
	if err != nil {
		return err
	}
	for _, file := range files {
		if !strings.HasSuffix(file, ".pond.json") {
			continue
		}
		data, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		if err := runArtifacts(ctx, target, data); err != nil {
			return fmt.Errorf("seed %s: %w", filepath.Base(file), err)
		}
		logf("Saved queries and graphs: %s", filepath.Base(file))
	}
	return nil
}
