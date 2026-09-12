package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func main() {
	name := strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe")
	data, err := json.Marshal(struct {
		Name string   `json:"name"`
		Args []string `json:"args"`
	}{Name: name, Args: os.Args[1:]})
	if err != nil || os.WriteFile(os.Getenv("REAUDIT_PING_ARGS"), data, 0600) != nil {
		os.Exit(19)
	}
	delay, _ := strconv.Atoi(os.Getenv("REAUDIT_PING_DELAY_MS"))
	time.Sleep(time.Duration(delay) * time.Millisecond)
}
