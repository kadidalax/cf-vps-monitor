package main

import (
	"go/version"
	"runtime"
	"testing"
)

func TestAUD20BuildUsesPatchedToolchain(t *testing.T) {
	actual := runtime.Version()
	if !version.IsValid(actual) || version.Compare(actual, "go1.26.8") < 0 {
		t.Fatalf("Agent was compiled with %s; require a supported patched toolchain >= go1.26.8", actual)
	}
	if version.Lang(actual) == "go1.27" && version.Compare(actual, "go1.27.1") < 0 {
		t.Fatalf("Agent was compiled with %s; the Go 1.27 series requires patch 1 or newer", actual)
	}
}
