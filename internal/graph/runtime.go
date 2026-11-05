// Package graph provides browser-independent graph analysis over MiniLake data.
package graph

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/asabla/pond/web"
	"github.com/dop251/goja"
)

var programsOnce sync.Once
var programs []*goja.Program
var programsErr error

type engine struct {
	vm   *goja.Runtime
	core *goja.Object
	stop chan struct{}
	done chan struct{}
}

func newEngine(ctx context.Context) (*engine, error) {
	programsOnce.Do(func() {
		for _, file := range []string{"sql.js", "vendor/graphology.umd.min.js", "vendor/graphology-library.min.js", "graph-core.js"} {
			body, err := web.FS.ReadFile("static/" + file)
			if err != nil {
				programsErr = err
				return
			}
			source := string(body)
			if file == "sql.js" {
				// The scanner is a plain ES module. The embedded runtime loads its
				// declarations as a script and supplies the same validator to the engine.
				source = strings.ReplaceAll(source, "\nexport ", "\n") + "\nglobalThis.pondSqlValidator = isMultiStatement;"
			}
			if at := strings.LastIndex(source, "//# sourceMappingURL="); at >= 0 {
				source = source[:at]
			}
			p, err := goja.Compile(file, source, false)
			if err != nil {
				programsErr = err
				return
			}
			programs = append(programs, p)
		}
	})
	if programsErr != nil {
		return nil, programsErr
	}
	e := &engine{vm: goja.New(), stop: make(chan struct{}), done: make(chan struct{})}
	// The vendor bundle also exports XML importers. Graph analysis does not use
	// them, but the bundle captures these constructors during initialization.
	if _, err := e.vm.RunString(`function DOMParser() { throw new Error("XML import is unavailable in graph analysis"); } function Document() { throw new Error("DOM is unavailable in graph analysis"); }`); err != nil {
		return nil, err
	}
	go func() {
		defer close(e.done)
		select {
		case <-ctx.Done():
			e.vm.Interrupt(ctx.Err())
		case <-e.stop:
		}
	}()
	for _, p := range programs {
		if _, err := e.vm.RunProgram(p); err != nil {
			e.close()
			return nil, err
		}
	}
	e.core = e.vm.Get("pondGraphCore").ToObject(e.vm)
	return e, nil
}

func (e *engine) close() { close(e.stop); <-e.done }

func (e *engine) value(v any) (goja.Value, error) {
	if val, ok := v.(goja.Value); ok {
		return val, nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	parse, _ := goja.AssertFunction(e.vm.Get("JSON").ToObject(e.vm).Get("parse"))
	return parse(goja.Undefined(), e.vm.ToValue(string(b)))
}

func (e *engine) call(name string, args ...any) (goja.Value, error) {
	fn, ok := goja.AssertFunction(e.core.Get(name))
	if !ok {
		return nil, fmt.Errorf("unknown graph function %s", name)
	}
	values := make([]goja.Value, len(args))
	for i, arg := range args {
		v, err := e.value(arg)
		if err != nil {
			return nil, err
		}
		values[i] = v
	}
	return fn(e.core, values...)
}

func (e *engine) sql(name string, args ...any) (string, error) {
	v, err := e.call(name, args...)
	if err != nil {
		return "", err
	}
	return v.String(), nil
}

func (e *engine) export(v goja.Value, out any) error {
	stringify, _ := goja.AssertFunction(e.vm.Get("JSON").ToObject(e.vm).Get("stringify"))
	b, err := stringify(goja.Undefined(), v)
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(b.String()), out)
}
