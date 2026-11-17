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

const maxSlots = 8 // menu rows are created up front; systray cannot remove items

type slot struct {
	head  *systray.MenuItem
	lines [6]*systray.MenuItem
}

type Tray struct {
	app   *App
	slots []slot
	mu    sync.Mutex // serialises UI updates coming from the worker
}

func (t *Tray) onReady() {
	systray.SetTitle("…")
	systray.SetTooltip("AI Quota Meter")
	t.setIcon(-1)
	for i := 0; i < maxSlots; i++ {
		s := slot{head: systray.AddMenuItem("", "")}
		for j := range s.lines {
			s.lines[j] = s.head.AddSubMenuItem("", "")
			s.lines[j].Disable()
		}
		s.head.Hide()
		t.slots = append(t.slots, s)
	}
	empty := systray.AddMenuItem("No accounts found", "")
	empty.Disable()
	systray.AddSeparator()
	refresh := systray.AddMenuItem("Refresh now", "")
	settings := systray.AddMenuItem("Open settings file", "")
	quit := systray.AddMenuItem("Quit", "")

	ctx, cancel := context.WithCancel(context.Background())
	t.app.onChange = func(accs []Account, st map[string]State) {
		if len(accs) == 0 {
			empty.Show()
		} else {
			empty.Hide()
		}
		t.render(accs, st)
	}
	go t.app.Run(ctx)
	go func() {
		for {
			select {
			case <-refresh.ClickedCh:
				t.app.RequestRefresh()
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

func (t *Tray) render(accs []Account, st map[string]State) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	var title, tip []string
	top := -1.0
	for i, s := range t.slots {
		if i >= len(accs) {
			s.head.Hide()
			continue
		}
		acc := accs[i]
		state := st[acc.Key()]
		label := t.app.Label(acc)
		short := strings.ToUpper(string([]rune(label)[:1]))
		p, ok := sessionPercent(state.Windows, now)
		val := "…"
		if ok {
			val = fmt.Sprintf("%.0f%%", p)
			top = math.Max(top, p)
		} else if state.Err != "" {
			val = "!"
		}
		title = append(title, short+" "+val)
		tip = append(tip, label+": "+val)

		head := label + "  ·  " + val
		if state.Plan != "" {
			head += "  (" + state.Plan + ")"
		}
		s.head.SetTitle(head)
		s.head.Show()
		n := 0
		for _, w := range state.Windows {
			if n == len(s.lines)-1 {
				break
			}
			text := fmt.Sprintf("%s: %.0f%%", w.Label, effectivePercent(w, now))
			if !w.ResetsAt.IsZero() {
				text += " · resets in " + formatDuration(w.ResetsAt.Sub(now))
			}
			s.lines[n].SetTitle(text)
			s.lines[n].Show()
			n++
		}
		status := "No data yet"
		if !state.FetchedAt.IsZero() {
			status = "Updated " + formatDuration(now.Sub(state.FetchedAt)) + " ago"
		}
		if state.Err != "" {
			status = "⚠ " + state.Err
		}
		s.lines[n].SetTitle(status)
		s.lines[n].Show()
		for n++; n < len(s.lines); n++ {
			s.lines[n].Hide()
		}
	}
	systray.SetTitle(strings.Join(title, "  ")) // macOS menu bar text; ignored on Windows
	systray.SetTooltip("AI Quota Meter\n" + strings.Join(tip, "\n"))
	t.setIcon(top)
}

// setIcon draws a ring that fills with the highest session usage (-1 = no data).
func (t *Tray) setIcon(percent float64) {
	b := ringPNG(percent)
	if runtime.GOOS == "windows" {
		b = pngToICO(b)
	}
	systray.SetIcon(b)
}

func ringPNG(percent float64) []byte {
	const n = 32
	img := image.NewRGBA(image.Rect(0, 0, n, n))
	track := color.RGBA{128, 128, 128, 160}
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
			// angle clockwise from 12 o'clock, 0..1
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
