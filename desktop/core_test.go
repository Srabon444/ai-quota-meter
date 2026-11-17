// SPDX-License-Identifier: GPL-2.0-or-later

package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Real response shape captured 2026-11-17 (account at 100%).
const claudeSample = `{"five_hour":{"utilization":100.0,"resets_at":"2026-11-17T18:09:59.892299+00:00"},
"seven_day":{"utilization":81.0,"resets_at":"2026-11-20T16:59:59.892317+00:00"},"seven_day_opus":null}`

func TestParseClaudeUsage(t *testing.T) {
	ws, err := parseClaudeUsage([]byte(claudeSample))
	if err != nil || len(ws) != 2 || ws[0].Percent != 100 || ws[0].Kind != "session" || ws[1].Percent != 81 {
		t.Fatalf("got %+v %v", ws, err)
	}
	if _, err := parseClaudeUsage([]byte(`{"error":{"type":"rate_limit_error"}}`)); err == nil {
		t.Fatal("error body accepted")
	}
	ws, _ = parseClaudeUsage([]byte(`{"five_hour":{"utilization":5,"resets_at":0}}`))
	if !ws[0].ResetsAt.IsZero() {
		t.Fatal("resets_at 0 must be unknown")
	}
}

func TestParseCodexUsage(t *testing.T) {
	ws, plan, err := parseCodexUsage([]byte(`{"plan_type":"plus","rate_limit":{
		"primary_window":{"used_percent":42,"limit_window_seconds":18000,"reset_at":1800000000},
		"secondary_window":{"used_percent":7,"limit_window_seconds":604800,"reset_after_seconds":60}}}`), time.Unix(1, 0))
	if err != nil || plan != "plus" || ws[0].Label != "5-hour" || ws[1].Label != "7-day" ||
		ws[0].ResetsAt.Unix() != 1800000000 || ws[1].ResetsAt.Unix() != 61 {
		t.Fatalf("got %+v %q %v", ws, plan, err)
	}
}

func TestParseCreds(t *testing.T) {
	c, ok := parseCreds("claude", []byte(`{"claudeAiOauth":{"accessToken":"t","expiresAt":5000,"subscriptionType":"pro"}}`))
	if !ok || c.Token != "t" || c.ExpiresAt.UnixMilli() != 5000 || c.Plan != "pro" {
		t.Fatalf("%+v", c)
	}
	for _, bad := range []string{`{"mcpOAuth":{}}`, `null`, `garbage`, `{"claudeAiOauth":{"accessToken":""}}`} {
		if _, ok := parseCreds("claude", []byte(bad)); ok {
			t.Fatalf("accepted %s", bad)
		}
	}
}

func TestEffectiveAndRing(t *testing.T) {
	now := time.Unix(1000, 0)
	if effectivePercent(Window{Percent: 100, ResetsAt: now}, now) != 0 {
		t.Fatal("reset window must read 0")
	}
	if clampFraction(150) != 1 || clampFraction(-5) != 0 || clampFraction(50) != 0.5 {
		t.Fatal("clamp")
	}
	if len(ringPNG(100)) == 0 || len(pngToICO(ringPNG(-1))) < 22 {
		t.Fatal("icon")
	}
}

func TestBackoff(t *testing.T) {
	iv := 300 * time.Second
	got := []time.Duration{backoff(1, iv, 0), backoff(2, iv, 0), backoff(5, iv, 0), backoff(1, iv, 900*time.Second), backoff(99, iv, 0)}
	want := []time.Duration{30 * time.Second, 60 * time.Second, 300 * time.Second, 900 * time.Second, 300 * time.Second}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("%d: got %v want %v", i, got[i], want[i])
		}
	}
}

func TestDetect(t *testing.T) {
	home := t.TempDir()
	mk := func(dir, file, body string) {
		_ = os.MkdirAll(filepath.Join(home, dir), 0o700)
		if file != "" {
			_ = os.WriteFile(filepath.Join(home, dir, file), []byte(body), 0o600)
		}
	}
	claude := `{"claudeAiOauth":{"accessToken":"x"}}`
	mk(".claude", ".credentials.json", claude)
	mk(".claude-personal", ".credentials.json", claude)
	mk("work-ai", ".credentials.json", claude)
	mk(".claude-empty", ".credentials.json", `{}`)
	mk(".codex", "auth.json", `{"tokens":{"access_token":"y"}}`)
	mk("both", ".credentials.json", claude)
	mk("both", "auth.json", `{"tokens":{"access_token":"y"}}`)
	_ = os.Symlink(filepath.Join(home, ".claude"), filepath.Join(home, ".claude-link"))
	mk("manual-empty", "", "")

	got := detect(home, func(string) string { return "" }, []string{filepath.Join(home, "manual-empty"), "", "rel/x"}, nil)
	var names []string
	for _, a := range got {
		names = append(names, a.Provider+":"+filepath.Base(a.Dir))
	}
	want := []string{"claude:.claude", "claude:.claude-personal", "claude:both", "claude:manual-empty", "claude:work-ai", "codex:.codex", "codex:both"}
	if len(names) != len(want) {
		t.Fatalf("got %v", names)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("got %v want %v", names, want)
		}
	}
	if defaultLabel(got[1]) != "personal" || defaultLabel(got[0]) != "default" {
		t.Fatal("labels")
	}
}
