// SPDX-License-Identifier: GPL-2.0-or-later

// AI Quota Meter for macOS and Windows: a menu bar / system tray app that
// shows Claude Code (and experimental Codex) plan usage for every account.
package main

import (
	"context"
	"flag"
	"fmt"
	"time"

	"fyne.io/systray"
)

var version = "dev" // set by the build: -ldflags "-X main.version=1.0.0"

func main() {
	showVersion := flag.Bool("version", false, "print version and exit")
	check := flag.Bool("check", false, "fetch every account once, print the result and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println("ai-quota-meter", version)
		return
	}
	if *check {
		runCheck()
		return
	}
	t := &Tray{app: NewApp()}
	systray.Run(t.onReady, func() {})
}

// runCheck is a terminal diagnostic: same detection and fetch code as the tray.
func runCheck() {
	a := NewApp()
	a.rescan()
	if len(a.accounts) == 0 {
		fmt.Println("No accounts found.")
		return
	}
	ctx := context.Background()
	now := time.Now()
	for _, acc := range a.accounts {
		a.maybeFetch(ctx, acc, true)
		s := a.states[acc.Key()]
		fmt.Printf("%s  [%s %s]\n", a.Label(acc), acc.Provider, acc.Dir)
		for _, w := range s.Windows {
			fmt.Printf("  %-12s %5.1f%%  resets in %s\n", w.Label, effectivePercent(w, now), formatDuration(w.ResetsAt.Sub(now)))
		}
		if s.Err != "" {
			fmt.Printf("  error: %s\n", s.Err)
		}
	}
	a.saveCache()
}
