// SPDX-License-Identifier: GPL-2.0-or-later

//go:build !windows && !darwin

package main

func readSystemLook() systemLook { return systemLook{} }

func applyMenuTheme(bool) {}
