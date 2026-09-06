//go:build !windows

package main

import "os"

func processIDs() (int, int) {
	return os.Getuid(), os.Getgid()
}
