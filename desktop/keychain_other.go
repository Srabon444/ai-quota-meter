// SPDX-License-Identifier: GPL-2.0-or-later

//go:build !darwin

package main

// Only macOS stores Claude Code logins in a keychain.
var keychainCreds func(dir string) ([]byte, bool)
