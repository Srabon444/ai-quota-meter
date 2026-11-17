// SPDX-License-Identifier: GPL-2.0-or-later

//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// A FIFO named like a login file must be skipped, never read (a read would block forever).
func TestDetectSkipsFIFO(t *testing.T) {
	home := t.TempDir()
	_ = os.MkdirAll(filepath.Join(home, ".claude"), 0o700)
	if err := syscall.Mkfifo(filepath.Join(home, ".claude", ".credentials.json"), 0o600); err != nil {
		t.Skip(err)
	}
	if got := detect(home, func(string) string { return "" }, nil, nil); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}
