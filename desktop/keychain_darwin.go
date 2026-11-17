// SPDX-License-Identifier: GPL-2.0-or-later

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// On macOS Claude Code keeps its login in the Keychain, not in
// .credentials.json. The default folder uses the service "Claude Code-credentials";
// other CLAUDE_CONFIG_DIR folders add the first 8 hex chars of sha256(dir).
func keychainService(dir string) string {
	home, _ := os.UserHomeDir()
	if filepath.Clean(dir) == filepath.Join(home, ".claude") {
		return "Claude Code-credentials"
	}
	sum := sha256.Sum256([]byte(dir))
	return "Claude Code-credentials-" + hex.EncodeToString(sum[:])[:8]
}

type kcEntry struct {
	data []byte
	ok   bool
	at   time.Time
}

var (
	kcMu    sync.Mutex
	kcCache = map[string]kcEntry{}
)

// keychainCreds reads at most once a minute per folder: each read spawns
// `security`, and the worker polls every 15s.
func keychainCreds(dir string) ([]byte, bool) {
	kcMu.Lock()
	defer kcMu.Unlock()
	if e, hit := kcCache[dir]; hit && time.Since(e.at) < time.Minute {
		return e.data, e.ok
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/security", "find-generic-password", "-s", keychainService(dir), "-w").Output()
	e := kcEntry{data: out, ok: err == nil && len(out) > 0, at: time.Now()}
	kcCache[dir] = e
	return e.data, e.ok
}
