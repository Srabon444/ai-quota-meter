// SPDX-License-Identifier: GPL-2.0-or-later

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#include <stdbool.h>
bool aqmSystemDark(void);
bool aqmClock12h(void);
void aqmSetAppearance(bool dark);
*/
import "C"

func readSystemLook() systemLook {
	dark := bool(C.aqmSystemDark())
	return systemLook{appsDark: dark, barDark: dark, clock12h: bool(C.aqmClock12h())}
}

func applyMenuTheme(dark bool) { C.aqmSetAppearance(C.bool(dark)) }
