// SPDX-License-Identifier: GPL-2.0-or-later

package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"fyne.io/systray"
)

const (
	maxSlots   = 8
	maxWindows = 6
)

var themeChoices = []string{"system", "light", "dark"}

type slot struct {
	head   *systray.MenuItem
	lines  [maxWindows]*systray.MenuItem
	status *systray.MenuItem
	gap    *systray.MenuItem
}

type accountView struct {
	label, email, plan, err string
	windows                 []Window
	fetchedAt               time.Time
}

type Tray struct {
	app      *App
	slots    []slot
	empty    *systray.MenuItem
	themes   []*systray.MenuItem
	mu       sync.Mutex
	views    []accountView
	theme    string
	sys      systemLook
	icons    map[*systray.MenuItem]string
	trayIcon string
}

func (t *Tray) onReady() {
	t.icons = map[*systray.MenuItem]string{}
	t.theme = normalizeTheme(t.app.cfg.Theme)
	t.sys = readSystemLook()
	applyMenuTheme(t.menuDark())
	systray.SetTitle("…")
	systray.SetTooltip("AI Quota Meter")
	t.setTrayIcon(-1)
	for i := 0; i < maxSlots; i++ {
		s := slot{head: systray.AddMenuItem("", "")}
		for j := range s.lines {
			s.lines[j] = systray.AddMenuItem("", "")
			s.lines[j].Hide()
		}
		s.status = systray.AddMenuItem("", "")
		s.status.Disable()
		s.gap = systray.AddMenuItem("", "")
		s.gap.Disable()
		s.head.Hide()
		s.status.Hide()
		s.gap.Hide()
		t.slots = append(t.slots, s)
	}
	t.empty = systray.AddMenuItem("No accounts found", "")
	t.empty.Disable()
	systray.AddSeparator()
	refresh := systray.AddMenuItem("Refresh now", "")
	themeMenu := systray.AddMenuItem("Theme", "")
	for _, c := range themeChoices {
		t.themes = append(t.themes, themeMenu.AddSubMenuItemCheckbox(titleCase(c), "", c == t.theme))
	}
	settings := systray.AddMenuItem("Open settings file", "")
	quit := systray.AddMenuItem("Quit", "")

	ctx, cancel := context.WithCancel(context.Background())
	t.app.onChange = func(accs []Account, st map[string]State) {
		views := make([]accountView, len(accs))
		for i, acc := range accs {
			s := st[acc.Key()]
			label := t.app.Label(acc)
			email := s.Email
			if email == label {
				email = ""
			}
			views[i] = accountView{label: label, email: email, plan: s.Plan, err: s.Err, windows: s.Windows, fetchedAt: s.FetchedAt}
		}
		t.mu.Lock()
		t.views = views
		t.mu.Unlock()
		t.render()
	}
	go t.app.Run(ctx)
	go t.watchSystemLook(ctx)
	clicks := make(chan string)
	for i, item := range t.themes {
		go func(item *systray.MenuItem, choice string) {
			for range item.ClickedCh {
				clicks <- choice
			}
		}(item, themeChoices[i])
	}
	go func() {
		for {
			select {
			case <-refresh.ClickedCh:
				t.app.RequestRefresh()
			case choice := <-clicks:
				t.setTheme(choice)
			case <-settings.ClickedCh:
				openFile(t.app.cfgPath)
			case <-quit.ClickedCh:
				cancel()
				systray.Quit()
				return
			}
		}
	}()
}

func (t *Tray) setTheme(choice string) {
	if err := saveTheme(t.app.cfgPath, choice); err != nil {
		systray.SetTooltip("AI Quota Meter\nCould not save theme: " + err.Error())
	}
	t.mu.Lock()
	t.theme = choice
	t.mu.Unlock()
	for i, item := range t.themes {
		if themeChoices[i] == choice {
			item.Check()
		} else {
			item.Uncheck()
		}
	}
	applyMenuTheme(t.menuDark())
	t.render()
}

func (t *Tray) watchSystemLook(ctx context.Context) {
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		look := readSystemLook()
		t.mu.Lock()
		changed := look != t.sys
		t.sys = look
		t.mu.Unlock()
		if changed {
			applyMenuTheme(t.menuDark())
			t.render()
		}
	}
}

func (t *Tray) menuDark() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return pickDark(t.theme, t.sys.appsDark)
}

func (t *Tray) render() {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	menuDark := pickDark(t.theme, t.sys.appsDark)
	var title, tip []string
	top := -1.0
	if len(t.views) == 0 {
		t.empty.Show()
	} else {
		t.empty.Hide()
	}
	for i, s := range t.slots {
		if i >= len(t.views) {
			s.head.Hide()
			s.status.Hide()
			s.gap.Hide()
			for _, l := range s.lines {
				l.Hide()
			}
			continue
		}
		v := t.views[i]
		p, ok := sessionPercent(v.windows, now)
		val := "…"
		if ok {
			val = fmt.Sprintf("%.0f%%", p)
			top = math.Max(top, p)
		} else if v.err != "" {
			val = "!"
		}
		short := strings.ToUpper(string([]rune(v.label)[:1]))
		title = append(title, short+" "+val)
		tip = append(tip, v.label+": "+val)

		s.head.SetTitle(strings.Join(nonEmpty(v.label, v.email, v.plan), "  ·  "))
		s.head.Show()
		n := 0
		for _, w := range v.windows {
			if n == len(s.lines) {
				break
			}
			wp := effectivePercent(w, now)
			text := fmt.Sprintf("%s   %.0f%%", w.Label, wp)
			if !w.ResetsAt.IsZero() {
				text += "   ·   " + resetText(w.ResetsAt, now, t.sys.clock12h)
			}
			t.setItemIcon(s.lines[n], wp, menuDark)
			s.lines[n].SetTitle(text)
			s.lines[n].Show()
			n++
		}
		for ; n < len(s.lines); n++ {
			s.lines[n].Hide()
		}
		status := "No data yet"
		if !v.fetchedAt.IsZero() {
			status = "Updated " + formatDuration(now.Sub(v.fetchedAt)) + " ago"
		}
		if v.err != "" {
			status = "⚠ " + v.err
		}
		s.status.SetTitle(status)
		s.status.Show()
		if i < len(t.views)-1 {
			s.gap.Show()
		} else {
			s.gap.Hide()
		}
	}
	systray.SetTitle(strings.Join(title, "  "))
	systray.SetTooltip("AI Quota Meter\n" + strings.Join(tip, "\n"))
	t.setTrayIcon(top)
}

func nonEmpty(v ...string) []string {
	var out []string
	for _, s := range v {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func (t *Tray) setItemIcon(item *systray.MenuItem, percent float64, dark bool) {
	p := iconStep(percent)
	key := fmt.Sprintf("%v/%v", p, dark)
	if t.icons[item] == key {
		return
	}
	t.icons[item] = key
	item.SetIcon(platformIcon(ringPNG(p, dark)))
}

func (t *Tray) setTrayIcon(percent float64) {
	p := iconStep(percent)
	dark := pickDark(t.theme, t.sys.barDark)
	key := fmt.Sprintf("%v/%v", p, dark)
	if t.trayIcon == key {
		return
	}
	t.trayIcon = key
	systray.SetIcon(platformIcon(ringPNG(p, dark)))
}

func platformIcon(b []byte) []byte {
	if runtime.GOOS == "windows" {
		return pngToICO(b)
	}
	return b
}

func ringPNG(percent float64, dark bool) []byte {
	const n = 32
	img := image.NewRGBA(image.Rect(0, 0, n, n))
	track := color.RGBA{90, 90, 90, 200}
	if dark {
		track = color.RGBA{200, 200, 200, 170}
	}
	fill := map[string]color.RGBA{
		"ok": {34, 197, 94, 255}, "warn": {234, 179, 8, 255}, "critical": {239, 68, 68, 255},
	}[level(percent)]
	frac := clampFraction(percent)
	for y := 0; y < n; y++ {
		for x := 0; x < n; x++ {
			dx, dy := float64(x)-15.5, float64(y)-15.5
			r := math.Hypot(dx, dy)
			if r < 10 || r > 15.5 {
				continue
			}
			a := math.Mod(math.Atan2(dx, -dy)/(2*math.Pi)+1, 1)
			if percent >= 0 && (a < frac || frac >= 1) {
				img.Set(x, y, fill)
			} else {
				img.Set(x, y, track)
			}
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

// pngToICO wraps a PNG in a one-image ICO container (supported since Windows Vista).
func pngToICO(p []byte) []byte {
	var b bytes.Buffer
	_ = binary.Write(&b, binary.LittleEndian, [3]uint16{0, 1, 1})
	b.Write([]byte{32, 32, 0, 0})
	_ = binary.Write(&b, binary.LittleEndian, [2]uint16{1, 32})
	_ = binary.Write(&b, binary.LittleEndian, [2]uint32{uint32(len(p)), 22})
	b.Write(p)
	return b.Bytes()
}

func openFile(path string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", "-t", path)
	case "windows":
		cmd = exec.Command("notepad.exe", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	_ = cmd.Start()
}
