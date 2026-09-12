package main

import (
	"encoding/json"
	"os"
	"time"
)

var marker = "old"

func main() {
	data, _ := json.Marshal(map[string]string{
		"marker": marker, "token": os.Getenv("CF_MONITOR_TOKEN"),
		"name": os.Getenv("CF_MONITOR_NAME"), "nic_include": os.Getenv("CF_MONITOR_NIC_INCLUDE"),
		"mount_include": os.Getenv("CF_MONITOR_MOUNT_INCLUDE"),
	})
	_ = os.WriteFile(os.Getenv("CF_MONITOR_TEST_OUTPUT"), data, 0600)
	for {
		time.Sleep(time.Second)
	}
}
