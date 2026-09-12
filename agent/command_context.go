package main

import (
	"context"
	"os/exec"
	"time"
)

const auxiliaryCommandTimeout = 3 * time.Second

func runBoundedCommand(parent context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	command := exec.CommandContext(ctx, name, args...)
	command.WaitDelay = 100 * time.Millisecond
	output, err := command.CombinedOutput()
	if ctx.Err() != nil {
		return output, ctx.Err()
	}
	return output, err
}
