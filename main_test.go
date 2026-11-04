package main

import (
	"net"
	"strconv"
	"testing"
)

func TestBareAndDirectoryMeanUp(t *testing.T) {
	a, err := parse(nil)
	if err != nil || a.command != "up" || a.dir != "." {
		t.Fatalf("bare: %+v, %v", a, err)
	}
	if a, _ := parse([]string{"../data"}); a.command != "up" || a.dir != "../data" {
		t.Errorf("dir: %+v", a)
	}
	a, _ = parse([]string{"--port", "9000"})
	if a.port != 9000 || !a.portExplicit || a.command != "up" {
		t.Errorf("port: %+v", a)
	}
	a, _ = parse([]string{"up", "proj", "--open", "--image", "img:2"})
	if a.dir != "proj" || !a.open || a.image != "img:2" {
		t.Errorf("flags after dir: %+v", a)
	}
}

func TestPortDefaultsAndEnvironment(t *testing.T) {
	t.Setenv("POND_PORT", "")
	if a, _ := parse(nil); a.port != defaultPort || a.portExplicit {
		t.Errorf("default: %+v", a)
	}
	t.Setenv("POND_PORT", "9100")
	if a, _ := parse(nil); a.port != 9100 || !a.portExplicit {
		t.Errorf("env: %+v", a)
	}
	t.Setenv("POND_HOST", "0.0.0.0")
	t.Setenv("MINILAKE_URL", "http://x:1")
	t.Setenv("POND_MINILAKE_IMAGE", "img:env")
	if a, _ := parse(nil); a.host != "0.0.0.0" || a.minilake != "http://x:1" || a.image != "img:env" {
		t.Errorf("env: %+v", a)
	}
}

func TestSubcommands(t *testing.T) {
	if a, _ := parse([]string{"ls"}); a.command != "ls" {
		t.Errorf("ls: %+v", a)
	}
	if a, _ := parse([]string{"down", "x"}); a.command != "down" || a.dir != "x" {
		t.Errorf("down: %+v", a)
	}
	if a, _ := parse([]string{"version"}); a.command != "version" {
		t.Errorf("version: %+v", a)
	}
	if _, err := parse([]string{"--help"}); err != errHelp {
		t.Errorf("help: %v", err)
	}
	if _, err := parse([]string{"--bogus"}); err == nil {
		t.Error("unknown flag accepted")
	}
	if _, err := parse([]string{"a", "b"}); err == nil {
		t.Error("two directories accepted")
	}
}

func TestBindFallsBackUnlessExplicit(t *testing.T) {
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	port := busy.Addr().(*net.TCPAddr).Port
	if ln, err := bind("127.0.0.1", port, true); err == nil {
		ln.Close()
		t.Error("explicit busy port should fail")
	}
	ln, err := bind("127.0.0.1", port, false)
	if err != nil {
		t.Skipf("no free fallback port: %v", err)
	}
	defer ln.Close()
	if got := ln.Addr().(*net.TCPAddr).Port; got < defaultPort || got >= defaultPort+portAttempts {
		t.Errorf("fell back to %s", strconv.Itoa(got))
	}
}

func TestOnlyLoopbackHostsCountAsLocal(t *testing.T) {
	for host, want := range map[string]bool{
		"127.0.0.1": true, "localhost": true, "::1": true, "[::1]": true, "127.0.0.2": true,
		"0.0.0.0": false, "::": false, "192.168.1.5": false, "my-mac.local": false,
	} {
		if got := isLoopback(host); got != want {
			t.Errorf("isLoopback(%q) = %v, want %v", host, got, want)
		}
	}
}

func TestOpenAndLogs(t *testing.T) {
	if a, err := parse([]string{"open", "proj"}); err != nil || a.command != "open" || a.dir != "proj" {
		t.Errorf("open: %+v, %v", a, err)
	}
	a, err := parse([]string{"logs"})
	if err != nil || a.command != "logs" || a.follow || a.tail != "200" {
		t.Errorf("logs defaults: %+v, %v", a, err)
	}
	a, err = parse([]string{"logs", "proj", "-f", "--tail", "all"})
	if err != nil || a.dir != "proj" || !a.follow || a.tail != "all" {
		t.Errorf("logs flags: %+v, %v", a, err)
	}
	if _, err := parse([]string{"logs", "--tail", "lots"}); err == nil {
		t.Error("bad --tail accepted")
	}
	if _, err := parse([]string{"down", "--port", "1"}); err == nil {
		t.Error("--port accepted for down")
	}
}
