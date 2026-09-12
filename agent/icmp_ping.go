package main

import (
	"errors"
	"fmt"
	"net"
	"os/exec"
)

func icmpPingCommand(platform string, ip net.IP) (string, []string, error) {
	if ip == nil {
		return "", nil, fmt.Errorf("ICMP requires a resolved IP address")
	}
	target := ip.String()
	family := "-6"
	if ip.To4() != nil {
		family = "-4"
	}
	switch platform {
	case "windows":
		return "ping", []string{family, "-n", "1", "-w", "2000", target}, nil
	case "linux":
		return "ping", []string{family, "-n", "-c", "1", "-W", "2", target}, nil
	case "darwin":
		if family == "-6" {
			// Apple ping6 -W sends a Node Information query. Its common flags
			// have no per-packet timeout; the caller's context bounds the child.
			return "ping6", []string{"-n", "-c", "1", target}, nil
		}
		return "ping", []string{"-n", "-c", "1", "-W", "2000", target}, nil
	case "freebsd":
		if family == "-6" {
			if _, err := exec.LookPath("ping6"); err == nil {
				// FreeBSD 12 ping6 and the newer ping6 alias share these flags.
				// Their timeout options differ, so keep the outer two-second budget.
				return "ping6", []string{"-n", "-c", "1", target}, nil
			} else if !errors.Is(err, exec.ErrNotFound) {
				return "", nil, fmt.Errorf("find IPv6 ping: %w", err)
			}
			// Merged ping supports -6 on FreeBSD 13+. A system lacking both
			// forms fails as unavailable instead of probing a different address.
			return "ping", []string{"-6", "-n", "-c", "1", "-W", "2000", target}, nil
		}
		return "ping", []string{"-n", "-c", "1", "-W", "2000", target}, nil
	default:
		return "", nil, fmt.Errorf("ICMP command is unsupported on %s", platform)
	}
}
