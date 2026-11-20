// SPDX-License-Identifier: GPL-2.0-or-later

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

const (
	claudeUsageURL   = "https://api.anthropic.com/api/oauth/usage"
	claudeProfileURL = "https://api.anthropic.com/api/oauth/profile"
	codexUsageURL    = "https://chatgpt.com/backend-api/wham/usage"
)

// Config lives in <user config dir>/ai-quota-meter/config.json and is
// created with defaults on first run.
type Config struct {
	RefreshSeconds int               `json:"refresh_seconds"`
	ExtraFolders   []string          `json:"extra_folders"`
	Labels         map[string]string `json:"labels"` // folder -> display name
	Hidden         []string          `json:"hidden"` // folders to ignore
	Proxy          string            `json:"proxy"`
	Theme          string            `json:"theme"`
}

func (c *Config) interval() time.Duration {
	s := c.RefreshSeconds
	if s < 60 {
		s = 60
	}
	if s > 3600 {
		s = 3600
	}
	return time.Duration(s) * time.Second
}

// State is per-account fetch state. Owned by the worker goroutine only;
// the UI receives copies.
type State struct {
	Windows   []Window  `json:"windows"`
	FetchedAt time.Time `json:"fetchedAt"`
	Email     string    `json:"email"`
	Plan      string    `json:"plan"`
	Err       string    `json:"-"`
	ErrKind   string    `json:"-"`
	FailCount int       `json:"-"`
	RetryAt   time.Time `json:"-"`
	lastToken string
	lastMod   time.Time
}

type quotaErr struct {
	kind       string // nocreds | expired | auth | ratelimit | http | network | parse
	msg        string
	retryAfter time.Duration
}

func (e *quotaErr) Error() string { return e.msg }

func retriable(kind string) bool {
	return kind == "ratelimit" || kind == "http" || kind == "network" || kind == "parse"
}

type App struct {
	cfgPath, cachePath string
	cfg                Config
	client             *http.Client
	accounts           []Account
	states             map[string]*State
	refreshNow         chan struct{}
	onChange           func([]Account, map[string]State)
	keychain           func(dir string) ([]byte, bool) // nil off macOS
}

func NewApp() *App {
	cfgDir, _ := os.UserConfigDir()
	cacheDir, _ := os.UserCacheDir()
	a := &App{
		cfgPath:    filepath.Join(cfgDir, "ai-quota-meter", "config.json"),
		cachePath:  filepath.Join(cacheDir, "ai-quota-meter", "state.json"),
		states:     map[string]*State{},
		refreshNow: make(chan struct{}, 1),
		keychain:   keychainCreds,
	}
	a.loadConfig()
	a.loadCache()
	return a
}

func (a *App) loadConfig() {
	a.cfg = Config{RefreshSeconds: 300, Labels: map[string]string{}}
	data, err := os.ReadFile(a.cfgPath)
	if errors.Is(err, os.ErrNotExist) {
		_ = os.MkdirAll(filepath.Dir(a.cfgPath), 0o700)
		b, _ := json.MarshalIndent(Config{RefreshSeconds: 300, ExtraFolders: []string{}, Labels: map[string]string{}, Hidden: []string{}, Theme: "system"}, "", "  ")
		_ = os.WriteFile(a.cfgPath, b, 0o600)
	} else if err == nil && json.Unmarshal(data, &a.cfg) != nil {
		log.Printf("config %s is not valid JSON, using defaults", a.cfgPath)
		a.cfg = Config{RefreshSeconds: 300}
	}
	if a.cfg.Labels == nil {
		a.cfg.Labels = map[string]string{}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if a.cfg.Proxy != "" {
		u, err := url.Parse(a.cfg.Proxy)
		if err != nil || u.Host == "" {
			// Fail closed: a mistyped proxy must not silently go direct.
			transport.Proxy = func(*http.Request) (*url.URL, error) { return nil, fmt.Errorf("invalid proxy in config") }
		} else {
			transport.Proxy = http.ProxyURL(u)
		}
	}
	a.client = &http.Client{Timeout: 30 * time.Second, Transport: transport}
}

func (a *App) loadCache() {
	data, err := os.ReadFile(a.cachePath)
	if err != nil {
		return
	}
	var c map[string]*State
	if json.Unmarshal(data, &c) != nil {
		return
	}
	for k, s := range c {
		if s != nil && len(s.Windows) > 0 {
			a.states[k] = s
		}
	}
}

func (a *App) saveCache() {
	c := map[string]*State{}
	for _, acc := range a.accounts {
		if s := a.states[acc.Key()]; s != nil && len(s.Windows) > 0 {
			c[acc.Key()] = s
		}
	}
	b, _ := json.Marshal(c)
	_ = os.MkdirAll(filepath.Dir(a.cachePath), 0o700)
	tmp := a.cachePath + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, a.cachePath)
	}
}

func (a *App) Label(acc Account) string {
	if l := a.cfg.Labels[acc.Dir]; l != "" {
		return l
	}
	if s := a.states[acc.Key()]; s != nil && s.Email != "" {
		return s.Email
	}
	return defaultLabel(acc)
}

func (a *App) rescan() {
	home, _ := os.UserHomeDir()
	var hasKC func(string) bool
	if a.keychain != nil {
		hasKC = func(d string) bool { _, ok := a.keychain(d); return ok }
	}
	hidden := map[string]bool{}
	for _, h := range a.cfg.Hidden {
		hidden[filepath.Clean(h)] = true
	}
	var accs []Account
	for _, acc := range detect(home, os.Getenv, a.cfg.ExtraFolders, hasKC) {
		if !hidden[acc.Dir] {
			accs = append(accs, acc)
		}
	}
	a.accounts = accs
}

// Run is the single worker: every fetch, every state change and every cache
// write happens here, one at a time, so there is nothing to race.
func (a *App) Run(ctx context.Context) {
	a.rescan()
	a.publish()
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	lastScan := time.Now()
	for {
		force := false
		select {
		case <-ctx.Done():
			return
		case <-a.refreshNow:
			force = true
		case <-tick.C:
		}
		if force || time.Since(lastScan) >= a.cfg.interval() {
			a.loadConfig()
			a.rescan()
			lastScan = time.Now()
		}
		changed := false
		for _, acc := range a.accounts {
			if ctx.Err() != nil {
				return
			}
			if a.maybeFetch(ctx, acc, force) {
				changed = true
				a.publish()
			}
		}
		if changed {
			a.saveCache()
		}
		a.publish()
	}
}

// RequestRefresh coalesces clicks: at most one pending forced refresh.
func (a *App) RequestRefresh() {
	select {
	case a.refreshNow <- struct{}{}:
	default:
	}
}

func (a *App) publish() {
	if a.onChange == nil {
		return
	}
	cp := make(map[string]State, len(a.states))
	for k, s := range a.states {
		cp[k] = *s
	}
	a.onChange(append([]Account(nil), a.accounts...), cp)
}

func (a *App) state(acc Account) *State {
	s := a.states[acc.Key()]
	if s == nil {
		s = &State{}
		a.states[acc.Key()] = s
	}
	return s
}

func (a *App) readCreds(acc Account) (*Creds, time.Time, error) {
	path := filepath.Join(acc.Dir, credFile[acc.Provider])
	if st, err := os.Stat(path); err == nil {
		data, err := readCredFile(path)
		if err == nil {
			if c, ok := parseCreds(acc.Provider, data); ok {
				return c, st.ModTime(), nil
			}
		}
	}
	if acc.Provider == "claude" && a.keychain != nil {
		if data, ok := a.keychain(acc.Dir); ok {
			if c, ok := parseCreds("claude", data); ok {
				return c, time.Time{}, nil
			}
		}
	}
	return nil, time.Time{}, &quotaErr{kind: "nocreds", msg: "No login found in this folder"}
}

// maybeFetch decides whether acc is due and fetches it. Returns true if state changed.
func (a *App) maybeFetch(ctx context.Context, acc Account, force bool) bool {
	s := a.state(acc)
	now := time.Now()
	stale := s.FetchedAt.IsZero() || now.Sub(s.FetchedAt) >= a.cfg.interval()-5*time.Second

	creds, mod, credErr := a.readCreds(acc)
	// A rewritten login (CLI refreshed its token) is fetched right away.
	credsChanged := creds != nil && (creds.Token != s.lastToken || (!mod.IsZero() && !mod.Equal(s.lastMod)))
	// auth/expired/nocreds only clear when the login changes (credsChanged).
	waitsForLogin := s.ErrKind == "auth" || s.ErrKind == "expired" || s.ErrKind == "nocreds"
	due := force || credsChanged ||
		(stale || s.Err != "") && now.After(s.RetryAt) && !waitsForLogin
	if !due {
		return false
	}
	if creds != nil {
		s.lastToken, s.lastMod = creds.Token, mod
	}

	var err error
	if credErr != nil {
		err = credErr
	} else if !creds.ExpiresAt.IsZero() && !now.Before(creds.ExpiresAt) {
		// Expired: keep cached data, wait for the CLI to refresh the login.
		err = &quotaErr{kind: "expired", msg: "Login expired. Open the CLI to refresh it."}
	} else {
		err = a.fetch(ctx, acc, creds, s)
	}
	if err != nil {
		var qe *quotaErr
		if !errors.As(err, &qe) {
			qe = &quotaErr{kind: "network", msg: err.Error()}
		}
		s.Err, s.ErrKind = qe.msg, qe.kind
		s.FailCount++
		s.RetryAt = time.Time{}
		if retriable(qe.kind) {
			s.RetryAt = now.Add(backoff(s.FailCount, a.cfg.interval(), qe.retryAfter))
		}
		return true
	}
	s.Err, s.ErrKind, s.FailCount, s.RetryAt = "", "", 0, time.Time{}
	s.FetchedAt = time.Now()
	return true
}

func (a *App) getJSON(ctx context.Context, rawURL string, headers map[string]string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "ai-quota-meter")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := a.client.Do(req)
	if err != nil {
		return nil, &quotaErr{kind: "network", msg: "No connection"}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, &quotaErr{kind: "network", msg: "Connection dropped"}
	}
	switch {
	case resp.StatusCode == http.StatusOK:
		return body, nil
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		return nil, &quotaErr{kind: "auth", msg: "Login rejected. Log in again with the CLI."}
	case resp.StatusCode == 429:
		ra, _ := strconv.Atoi(resp.Header.Get("Retry-After"))
		return nil, &quotaErr{kind: "ratelimit", msg: "Usage API rate limited", retryAfter: time.Duration(ra) * time.Second}
	}
	return nil, &quotaErr{kind: "http", msg: fmt.Sprintf("HTTP %d", resp.StatusCode)}
}

func (a *App) fetch(ctx context.Context, acc Account, c *Creds, s *State) error {
	if c.Plan != "" {
		s.Plan = c.Plan
	}
	if c.Email != "" {
		s.Email = c.Email
	}
	if acc.Provider == "codex" {
		h := map[string]string{"Authorization": "Bearer " + c.Token}
		if c.AccountID != "" {
			h["ChatGPT-Account-Id"] = c.AccountID
		}
		body, err := a.getJSON(ctx, codexUsageURL, h)
		if err != nil {
			return err
		}
		ws, plan, err := parseCodexUsage(body, time.Now())
		if err != nil {
			return &quotaErr{kind: "parse", msg: err.Error()}
		}
		s.Windows = ws
		if plan != "" {
			s.Plan = plan
		}
		return nil
	}
	h := map[string]string{"Authorization": "Bearer " + c.Token, "anthropic-beta": "oauth-2025-04-20"}
	body, err := a.getJSON(ctx, claudeUsageURL, h)
	if err != nil {
		return err
	}
	ws, err := parseClaudeUsage(body)
	if err != nil {
		return &quotaErr{kind: "parse", msg: err.Error()}
	}
	s.Windows = ws
	if s.Email == "" {
		// Once per account, then cached; failure is harmless.
		if body, err := a.getJSON(ctx, claudeProfileURL, h); err == nil {
			var p struct {
				Account struct {
					Email string `json:"email"`
				} `json:"account"`
			}
			if json.Unmarshal(body, &p) == nil {
				s.Email = p.Account.Email
			}
		}
	}
	return nil
}
