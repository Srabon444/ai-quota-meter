// SPDX-License-Identifier: GPL-2.0-or-later

#import <Cocoa/Cocoa.h>
#include <stdbool.h>

bool aqmSystemDark(void) {
	NSString *style = [[NSUserDefaults standardUserDefaults] stringForKey:@"AppleInterfaceStyle"];
	return [style isEqualToString:@"Dark"];
}

bool aqmClock12h(void) {
	NSString *fmt = [NSDateFormatter dateFormatFromTemplate:@"j" options:0 locale:[NSLocale currentLocale]];
	return [fmt rangeOfString:@"a"].location != NSNotFound;
}

void aqmSetAppearance(bool dark) {
	dispatch_async(dispatch_get_main_queue(), ^{
		NSApp.appearance = [NSAppearance appearanceNamed:dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
	});
}
