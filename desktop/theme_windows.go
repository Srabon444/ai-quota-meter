// SPDX-License-Identifier: GPL-2.0-or-later

package main

import (
	"strings"
	"sync"
	"syscall"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var (
	uxOnce           sync.Once
	setPreferredMode uintptr
	flushMenuThemes  uintptr
)

func readSystemLook() systemLook {
	var look systemLook
	if k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE); err == nil {
		if v, _, err := k.GetIntegerValue("AppsUseLightTheme"); err == nil {
			look.appsDark = v == 0
		}
		if v, _, err := k.GetIntegerValue("SystemUsesLightTheme"); err == nil {
			look.barDark = v == 0
		}
		k.Close()
	}
	if k, err := registry.OpenKey(registry.CURRENT_USER, `Control Panel\International`, registry.QUERY_VALUE); err == nil {
		if v, _, err := k.GetStringValue("sShortTime"); err == nil {
			look.clock12h = strings.Contains(v, "h")
		}
		k.Close()
	}
	return look
}

func applyMenuTheme(dark bool) {
	uxOnce.Do(func() {
		h, err := windows.LoadLibrary("uxtheme.dll")
		if err != nil {
			return
		}
		setPreferredMode, _ = windows.GetProcAddressByOrdinal(h, 135)
		flushMenuThemes, _ = windows.GetProcAddressByOrdinal(h, 136)
	})
	if setPreferredMode == 0 {
		return
	}
	mode := uintptr(3)
	if dark {
		mode = 2
	}
	syscall.SyscallN(setPreferredMode, mode)
	if flushMenuThemes != 0 {
		syscall.SyscallN(flushMenuThemes)
	}
}
