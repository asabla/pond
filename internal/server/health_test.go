package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/asabla/pond/internal/lake"
)

func TestHealthDistinguishesEngineAndLakeAndRecoversWithoutSQL(t *testing.T) {
	for _, tc := range []struct {
		name        string
		engineError error
		want        string
	}{
		{"lake", nil, "MiniLake is not responding"},
		{"engine", errors.New("socket unavailable"), "Container engine is not responding"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var unavailable atomic.Bool
			unavailable.Store(true)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/_minilake/health" {
					t.Errorf("health performed a stateful call: %s", r.URL.Path)
				}
				if unavailable.Load() {
					w.WriteHeader(http.StatusServiceUnavailable)
				}
				w.Write([]byte(`{}`))
			}))
			defer upstream.Close()
			client, err := lake.New(upstream.URL)
			if err != nil {
				t.Fatal(err)
			}
			h := New(Options{Lake: client, RuntimeHealth: func(context.Context) error { return tc.engineError }})
			read := func() string {
				request := httptest.NewRequest(http.MethodGet, "http://localhost/pond/health", nil)
				recorder := httptest.NewRecorder()
				h.ServeHTTP(recorder, request)
				if recorder.Code != http.StatusOK {
					t.Fatalf("status: %d", recorder.Code)
				}
				return recorder.Body.String()
			}
			if body := read(); !strings.Contains(body, tc.want) {
				t.Fatalf("outage: %s", body)
			}
			unavailable.Store(false)
			if body := read(); strings.Contains(body, "error") || !strings.Contains(body, `"lake":"responding"`) {
				t.Fatalf("recovery: %s", body)
			}
		})
	}
}
