// SPDX-License-Identifier: GPL-2.0-or-later

package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"slices"
	"time"
)

type systemLook struct {
	appsDark, barDark, clock12h bool
}

func normalizeTheme(s string) string {
	if slices.Contains(themeChoices, s) {
		return s
	}
	return "system"
}

func pickDark(theme string, systemDark bool) bool {
	switch theme {
	case "dark":
		return true
	case "light":
		return false
	}
	return systemDark
}

func iconStep(percent float64) float64 {
	if percent < 0 {
		return -1
	}
	return math.Min(100, math.Round(percent/5)*5)
}

func resetText(at, now time.Time, h12 bool) string {
	layout := "15:04"
	if h12 {
		layout = "3:04 PM"
	}
	at = at.Local()
	n := now.Local()
	when := at.Format(layout)
	if at.YearDay() != n.YearDay() || at.Year() != n.Year() {
		when = at.Format("Mon ") + when
	}
	return "resets " + when + " (in " + formatDuration(at.Sub(now)) + ")"
}

func saveTheme(path, theme string) error {
	cfg := map[string]any{}
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if len(data) > 0 {
		if err := json.Unmarshal(data, &cfg); err != nil {
			return fmt.Errorf("config is not valid JSON")
		}
	}
	cfg["theme"] = theme
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
