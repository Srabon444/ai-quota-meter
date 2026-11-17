// SPDX-License-Identifier: GPL-2.0-or-later

package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Account is one CLI login folder (e.g. ~/.claude, ~/.claude-personal, ~/.codex).
type Account struct {
	Provider string // "claude" or "codex"
	Dir      string
	Manual   bool
}

func (a Account) Key() string { return a.Provider + ":" + a.Dir }

var credFile = map[string]string{"claude": ".credentials.json", "codex": "auth.json"}

// Creds is what we need from a login file.
type Creds struct {
	Token     string
	ExpiresAt time.Time // zero = unknown
	Plan      string
	Email     string
	AccountID string
}

// Window is one usage limit window.
type Window struct {
	Label    string    `json:"label"`
	Kind     string    `json:"kind"` // session | weekly | model
	Percent  float64   `json:"percent"`
	ResetsAt time.Time `json:"resetsAt"`
}

// ---------------------------------------------------------------- credentials

func parseCreds(provider string, data []byte) (*Creds, bool) {
	switch provider {
	case "claude":
		var j struct {
			O *struct {
				AccessToken      string  `json:"accessToken"`
				ExpiresAt        float64 `json:"expiresAt"`
				SubscriptionType string  `json:"subscriptionType"`
			} `json:"claudeAiOauth"`
		}
		if json.Unmarshal(data, &j) != nil || j.O == nil || j.O.AccessToken == "" {
			return nil, false
		}
		c := &Creds{Token: j.O.AccessToken, Plan: j.O.SubscriptionType}
		if j.O.ExpiresAt > 0 {
			c.ExpiresAt = time.UnixMilli(int64(j.O.ExpiresAt))
		}
		return c, true
	case "codex":
		var j struct {
			T *struct {
				AccessToken string `json:"access_token"`
				IDToken     string `json:"id_token"`
				AccountID   string `json:"account_id"`
			} `json:"tokens"`
		}
		if json.Unmarshal(data, &j) != nil || j.T == nil || j.T.AccessToken == "" {
			return nil, false
		}
		c := &Creds{Token: j.T.AccessToken, AccountID: j.T.AccountID}
		at, id := jwtClaims(j.T.AccessToken), jwtClaims(j.T.IDToken)
		if exp, ok := at["exp"].(float64); ok {
			c.ExpiresAt = time.Unix(int64(exp), 0)
		}
		c.Email, _ = id["email"].(string)
		if auth, ok := id["https://api.openai.com/auth"].(map[string]any); ok {
			c.Plan, _ = auth["chatgpt_plan_type"].(string)
			if c.AccountID == "" {
				c.AccountID, _ = auth["chatgpt_account_id"].(string)
			}
		}
		return c, true
	}
	return nil, false
}

func jwtClaims(tok string) map[string]any {
	parts := strings.Split(tok, ".")
	if len(parts) < 2 {
		return nil
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return nil
	}
	return m
}

// readCredFile reads a small regular login file; anything else (FIFO, device,
// huge file) is rejected so a read can never hang.
func readCredFile(path string) ([]byte, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Size() > 1<<20 {
		return nil, fmt.Errorf("not a login file")
	}
	return os.ReadFile(path)
}

// ---------------------------------------------------------------- detection

// detect scans every top-level folder in home (plus env overrides and
// manual folders). hasKeychain reports a macOS Keychain login for a dir.
func detect(home string, env func(string) string, manual []string, hasKeychain func(dir string) bool) []Account {
	var candidates []string
	if v := env("CLAUDE_CONFIG_DIR"); v != "" {
		candidates = append(candidates, v)
	}
	if v := env("CODEX_HOME"); v != "" {
		candidates = append(candidates, v)
	}
	if entries, err := os.ReadDir(home); err == nil {
		for _, e := range entries {
			p := filepath.Join(home, e.Name())
			if st, err := os.Stat(p); err == nil && st.IsDir() {
				candidates = append(candidates, p)
			}
		}
	}

	var out []Account
	seen := map[string]bool{}
	add := func(dir string, isManual bool) {
		if !filepath.IsAbs(dir) {
			return
		}
		dir = filepath.Clean(dir)
		if real, err := filepath.EvalSymlinks(dir); err == nil {
			dir = real
		}
		found := false
		for _, prov := range []string{"claude", "codex"} {
			data, err := readCredFile(filepath.Join(dir, credFile[prov]))
			ok := err == nil
			if ok {
				_, ok = parseCreds(prov, data)
			}
			if !ok && prov == "claude" && hasKeychain != nil && strings.HasPrefix(filepath.Base(dir), ".claude") {
				ok = hasKeychain(dir)
			}
			if !ok {
				continue
			}
			found = true
			a := Account{Provider: prov, Dir: dir, Manual: isManual}
			if !seen[a.Key()] {
				seen[a.Key()] = true
				out = append(out, a)
			}
		}
		if !found && isManual {
			a := Account{Provider: "claude", Dir: dir, Manual: true}
			if !seen[a.Key()] {
				seen[a.Key()] = true
				out = append(out, a)
			}
		}
	}
	for _, d := range manual {
		add(d, true)
	}
	for _, d := range candidates {
		add(d, false)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Provider != out[j].Provider {
			return out[i].Provider < out[j].Provider
		}
		ri, rj := rank(out[i]), rank(out[j])
		if ri != rj {
			return ri < rj
		}
		return out[i].Dir < out[j].Dir
	})
	return out
}

func rank(a Account) int {
	if filepath.Base(a.Dir) == "."+a.Provider {
		return 0
	}
	return 1
}

// defaultLabel: ~/.claude-personal -> "personal", ~/.claude -> "default".
func defaultLabel(a Account) string {
	base := strings.TrimPrefix(filepath.Base(a.Dir), ".")
	if strings.HasPrefix(base, a.Provider) {
		base = strings.TrimLeft(strings.TrimPrefix(base, a.Provider), "-_.")
	}
	if base == "" {
		return "default"
	}
	return base
}

// ---------------------------------------------------------------- usage parsing

func toTime(v any) time.Time {
	switch t := v.(type) {
	case string:
		if p, err := time.Parse(time.RFC3339Nano, t); err == nil {
			return p
		}
	case float64:
		if t <= 0 || math.IsNaN(t) || math.IsInf(t, 0) {
			return time.Time{}
		}
		if t > 1e12 {
			return time.UnixMilli(int64(t))
		}
		return time.Unix(int64(t), 0)
	}
	return time.Time{}
}

func titleCase(s string) string {
	words := strings.Fields(strings.NewReplacer("_", " ", "-", " ").Replace(s))
	for i, w := range words {
		words[i] = strings.ToUpper(w[:1]) + w[1:]
	}
	return strings.Join(words, " ")
}

// scopeName: the model of a scoped limit, given as a string or an object.
func scopeName(scope any) string {
	switch s := scope.(type) {
	case string:
		return strings.TrimSpace(s)
	case map[string]any:
		for _, k := range []string{"display_name", "name", "model", "label"} {
			if v, ok := s[k].(string); ok && strings.TrimSpace(v) != "" {
				return strings.TrimSpace(v)
			}
		}
	}
	return ""
}

// limitWindow maps one entry of the API's `limits` list. session -> "5-hour",
// weekly_all -> "7-day", any other weekly limit is per model ("7-day · Fable").
func limitWindow(v any) (Window, bool) {
	l, ok := v.(map[string]any)
	if !ok {
		return Window{}, false
	}
	p, ok := l["percent"].(float64)
	if !ok || math.IsNaN(p) || math.IsInf(p, 0) {
		return Window{}, false
	}
	kind, _ := l["kind"].(string)
	group, _ := l["group"].(string)
	resets := toTime(l["resets_at"])
	switch {
	case group == "session" || kind == "session":
		return Window{Label: "5-hour", Kind: "session", Percent: p, ResetsAt: resets}, true
	case group == "weekly" || strings.HasPrefix(kind, "weekly"):
		model := scopeName(l["scope"])
		if model == "" && strings.HasPrefix(kind, "weekly_") && kind != "weekly_all" {
			model = titleCase(kind[len("weekly_"):])
		}
		if model == "" {
			return Window{Label: "7-day", Kind: "weekly", Percent: p, ResetsAt: resets}, true
		}
		return Window{Label: "7-day · " + model, Kind: "model", Percent: p, ResetsAt: resets}, true
	}
	name := group
	if name == "" {
		name = kind
	}
	if name == "" {
		return Window{}, false
	}
	return Window{Label: titleCase(name), Kind: "model", Percent: p, ResetsAt: resets}, true
}

// parseClaudeUsage prefers the generic `limits` list, which also carries
// per-model limits (e.g. a weekly Fable limit), then the fixed fields.
func parseClaudeUsage(data []byte) ([]Window, error) {
	var j map[string]any
	if err := json.Unmarshal(data, &j); err != nil {
		return nil, fmt.Errorf("invalid JSON")
	}
	var ws []Window
	if list, ok := j["limits"].([]any); ok {
		for _, v := range list {
			if w, ok := limitWindow(v); ok {
				ws = append(ws, w)
			}
		}
	}
	if len(ws) > 0 {
		return ws, nil
	}
	defs := [][3]string{
		{"five_hour", "5-hour", "session"},
		{"seven_day", "7-day", "weekly"},
		{"seven_day_opus", "7-day Opus", "model"},
		{"seven_day_sonnet", "7-day Sonnet", "model"},
	}
	for _, d := range defs {
		w, ok := j[d[0]].(map[string]any)
		if !ok {
			continue
		}
		p, ok := w["utilization"].(float64)
		if !ok || math.IsNaN(p) || math.IsInf(p, 0) {
			continue
		}
		ws = append(ws, Window{Label: d[1], Kind: d[2], Percent: p, ResetsAt: toTime(w["resets_at"])})
	}
	if len(ws) == 0 {
		return nil, fmt.Errorf("unrecognized usage response")
	}
	return ws, nil
}

func windowLabel(seconds float64, fallback string) string {
	if seconds <= 0 {
		return fallback
	}
	h := math.Round(seconds / 3600)
	if h < 24 {
		return fmt.Sprintf("%.0f-hour", h)
	}
	return fmt.Sprintf("%.0f-day", math.Round(h/24))
}

// Experimental: follows the Codex CLI's rate-limit payload; not checked
// against a live account.
func parseCodexUsage(data []byte, now time.Time) ([]Window, string, error) {
	var j struct {
		Plan string `json:"plan_type"`
		RL   map[string]struct {
			Used        *float64 `json:"used_percent"`
			WindowSecs  float64  `json:"limit_window_seconds"`
			ResetAt     any      `json:"reset_at"`
			ResetAfterS *float64 `json:"reset_after_seconds"`
		} `json:"rate_limit"`
	}
	if err := json.Unmarshal(data, &j); err != nil {
		return nil, "", fmt.Errorf("invalid JSON")
	}
	var ws []Window
	for _, d := range [][3]string{{"primary_window", "session", "Session"}, {"secondary_window", "weekly", "Weekly"}} {
		w, ok := j.RL[d[0]]
		if !ok || w.Used == nil || math.IsNaN(*w.Used) {
			continue
		}
		r := toTime(w.ResetAt)
		if r.IsZero() && w.ResetAfterS != nil {
			r = now.Add(time.Duration(*w.ResetAfterS * float64(time.Second)))
		}
		ws = append(ws, Window{Label: windowLabel(w.WindowSecs, d[2]), Kind: d[1], Percent: *w.Used, ResetsAt: r})
	}
	if len(ws) == 0 {
		return nil, "", fmt.Errorf("unrecognized usage response")
	}
	return ws, j.Plan, nil
}

// ---------------------------------------------------------------- display math

// A window past its reset time has rolled over; its old value no longer applies.
func effectivePercent(w Window, now time.Time) float64 {
	if !w.ResetsAt.IsZero() && !now.Before(w.ResetsAt) {
		return 0
	}
	return w.Percent
}

func clampFraction(p float64) float64 {
	if math.IsNaN(p) {
		return 0
	}
	return math.Min(1, math.Max(0, p/100))
}

func level(p float64) string {
	switch {
	case p >= 90:
		return "critical"
	case p >= 70:
		return "warn"
	}
	return "ok"
}

func sessionPercent(ws []Window, now time.Time) (float64, bool) {
	for _, k := range []string{"session", "weekly"} {
		for _, w := range ws {
			if w.Kind == k {
				return effectivePercent(w, now), true
			}
		}
	}
	return 0, false
}

func formatDuration(d time.Duration) string {
	if d <= 0 {
		return "now"
	}
	m := int(d.Minutes())
	h, days := m/60, m/60/24
	switch {
	case days > 0:
		return fmt.Sprintf("%dd %dh", days, h%24)
	case h > 0:
		return fmt.Sprintf("%dh %dm", h, m%60)
	}
	return fmt.Sprintf("%dm", max(1, m))
}

func backoff(failCount int, interval, retryAfter time.Duration) time.Duration {
	exp := 30 * time.Second << max(0, min(failCount-1, 10))
	d := min(exp, interval)
	return max(d, min(retryAfter, time.Hour))
}
