// SPDX-License-Identifier: GPL-2.0-or-later
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {PROVIDERS, detectAccounts, defaultLabel, probeDir, readText, validColor, validProxy} from './lib/core.js';

Gio._promisify(Gtk.FileDialog.prototype, 'select_folder', 'select_folder_finish');

// Handlers on the shared Gio.Settings are disconnected when the window closes;
// the prefs process can outlive one window.
function trackSignal(window, obj, id) {
    window._aqmSignals.push([obj, id]);
}

function comboRow(window, settings, key, title, subtitle, options) {
    const row = new Adw.ComboRow({
        title, subtitle,
        model: Gtk.StringList.new(options.map(o => o[1])),
    });
    const sync = () => {
        const i = options.findIndex(o => o[0] === settings.get_string(key));
        row.selected = Math.max(0, i);
    };
    sync();
    row.connect('notify::selected', () => {
        const v = options[row.selected]?.[0];
        if (v && v !== settings.get_string(key))
            settings.set_string(key, v);
    });
    trackSignal(window, settings, settings.connect(`changed::${key}`, sync));
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper, step) {
    const row = new Adw.SpinRow({
        title, subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class AiQuotaMeterPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = window._settings = this.getSettings();
        window._aqmSignals = [];
        window.connect('close-request', () => {
            for (const [obj, id] of window._aqmSignals)
                obj.disconnect(id);
            window._aqmSignals = [];
            return false;
        });
        window.set_default_size(640, 720);
        window.add(this._accountsPage(window, settings));
        window.add(this._displayPage(window, settings));
        window.add(this._generalPage(settings));
    }

    // ------------------------------------------------------------ accounts

    _accountsPage(window, settings) {
        const page = new Adw.PreferencesPage({title: 'Accounts', icon_name: 'system-users-symbolic'});

        const detect = new Adw.PreferencesGroup({
            title: 'Detection',
            description: 'Folders in your home that contain Claude Code (.credentials.json) or Codex (auth.json) logins are found automatically.',
        });
        detect.add(switchRow(settings, 'auto-detect', 'Auto-detect accounts', 'Scan home folders like ~/.claude, ~/.claude-personal, ~/.codex'));
        page.add(detect);

        const group = new Adw.PreferencesGroup({title: 'Accounts'});
        const buttons = new Gtk.Box({spacing: 6});
        const rescan = new Gtk.Button({icon_name: 'view-refresh-symbolic', tooltip_text: 'Rescan', css_classes: ['flat']});
        const add = new Gtk.Button({label: 'Add Folder…', css_classes: ['flat']});
        buttons.append(rescan);
        buttons.append(add);
        group.set_header_suffix(buttons);
        page.add(group);

        let rows = [];
        let gen = 0;
        // Async scan; only the newest rebuild may touch the rows.
        const rebuild = async () => {
            const mine = ++gen;
            const emails = await this._cachedEmails();
            const accounts = await detectAccounts({
                manual: settings.get_strv('manual-folders'),
                auto: settings.get_boolean('auto-detect'),
            });
            if (mine !== gen)
                return;
            this._emails = emails;
            for (const r of rows)
                group.remove(r);
            rows = [];
            if (!accounts.length) {
                const empty = new Adw.ActionRow({title: 'No accounts found', subtitle: 'Log in with Claude Code or Codex, or use “Add Folder…”'});
                group.add(empty);
                rows.push(empty);
            }
            for (const acc of accounts) {
                const row = this._accountRow(settings, acc);
                group.add(row);
                rows.push(row);
            }
        };

        const safeRebuild = () => rebuild().catch(e => console.error(`AI Quota Meter: ${e.message}`));
        rescan.connect('clicked', safeRebuild);
        add.connect('clicked', () => this._addFolder(window, settings).catch(e => console.error(e)));
        for (const sig of ['changed::manual-folders', 'changed::auto-detect'])
            trackSignal(window, settings, settings.connect(sig, safeRebuild));
        safeRebuild();
        return page;
    }

    // Emails the extension learned from the APIs (cache written by extension.js).
    async _cachedEmails() {
        try {
            const path = GLib.build_filenamev([GLib.get_user_cache_dir(), 'ai-quota-meter', 'state.json']);
            const accounts = JSON.parse(await readText(path))?.accounts ?? {};
            return Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k, typeof v?.email === 'string' ? v.email : null]));
        } catch {
            return {};
        }
    }

    _readConfig(settings) {
        try {
            const c = JSON.parse(settings.get_string('account-config'));
            return c && typeof c === 'object' ? c : {};
        } catch {
            return {};
        }
    }

    _patchConfig(settings, key, patch) {
        const cfg = this._readConfig(settings);
        cfg[key] = {...cfg[key] ?? {}, ...patch};
        settings.set_string('account-config', JSON.stringify(cfg));
    }

    _accountRow(settings, acc) {
        const c = this._readConfig(settings)[acc.key] ?? {};
        // Name/short left empty = automatic (account email, else folder name).
        const label = c.label || this._emails?.[acc.key] || defaultLabel(acc);
        const prov = PROVIDERS[acc.provider];
        const status = acc.valid ? prov.name + (prov.experimental ? ' (experimental)' : '') : 'No credentials found';
        const row = new Adw.ExpanderRow({
            title: GLib.markup_escape_text(label, -1),
            subtitle: GLib.markup_escape_text(`${acc.dir.replace(GLib.get_home_dir(), '~')} · ${status}${acc.manual ? ' · manual' : ''}`, -1),
        });

        const enabled = new Gtk.Switch({active: c.enabled !== false, valign: Gtk.Align.CENTER});
        enabled.connect('notify::active', () => this._patchConfig(settings, acc.key, {enabled: enabled.active}));
        row.add_suffix(enabled);

        const nameRow = new Adw.EntryRow({title: 'Name (empty = account email)', text: c.label ?? '', show_apply_button: true});
        nameRow.connect('apply', () => {
            const v = nameRow.text.trim().slice(0, 40);
            nameRow.text = v;
            this._patchConfig(settings, acc.key, {label: v});
            row.title = GLib.markup_escape_text(v || this._emails?.[acc.key] || defaultLabel(acc), -1);
        });
        row.add_row(nameRow);

        const shortRow = new Adw.EntryRow({title: 'Panel label (max 4 chars)', text: c.short ?? '', show_apply_button: true});
        shortRow.connect('apply', () => {
            const v = shortRow.text.trim().slice(0, 4);
            shortRow.text = v;
            this._patchConfig(settings, acc.key, {short: v});
        });
        row.add_row(shortRow);
        row.add_row(this._colorRow(settings, acc, validColor(c.color)));

        const panel = new Adw.SwitchRow({title: 'Show in top panel', active: c.panel !== false});
        panel.connect('notify::active', () => this._patchConfig(settings, acc.key, {panel: panel.active}));
        row.add_row(panel);

        if (acc.manual) {
            const remove = new Adw.ActionRow({title: 'Remove this folder'});
            const btn = new Gtk.Button({label: 'Remove', valign: Gtk.Align.CENTER, css_classes: ['destructive-action']});
            btn.connect('clicked', () => {
                settings.set_strv('manual-folders', settings.get_strv('manual-folders').filter(d => d !== acc.dir));
            });
            remove.add_suffix(btn);
            row.add_row(remove);
        }
        return row;
    }

    // No saved color = the panel's default label color (white picker swatch).
    _colorRow(settings, acc, color) {
        const row = new Adw.ActionRow({title: 'Panel label color', subtitle: color ? null : 'Default'});
        const rgba = c => {
            const v = new Gdk.RGBA();
            v.parse(c ?? '#ffffff');
            return v;
        };
        const btn = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}), rgba: rgba(color), valign: Gtk.Align.CENTER,
        });
        let quiet = false;
        btn.connect('notify::rgba', () => {
            if (quiet)
                return;
            const hex = `#${[btn.rgba.red, btn.rgba.green, btn.rgba.blue]
                .map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`;
            this._patchConfig(settings, acc.key, {color: hex});
            row.subtitle = '';
        });
        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic', tooltip_text: 'Use default color', valign: Gtk.Align.CENTER, css_classes: ['flat'],
        });
        reset.connect('clicked', () => {
            quiet = true;
            btn.rgba = rgba(null);
            quiet = false;
            this._patchConfig(settings, acc.key, {color: ''});
            row.subtitle = 'Default';
        });
        row.add_suffix(btn);
        row.add_suffix(reset);
        return row;
    }

    async _addFolder(window, settings) {
        const dialog = new Gtk.FileDialog({
            title: 'Select an account folder (e.g. ~/.claude-work)',
            initial_folder: Gio.File.new_for_path(GLib.get_home_dir()),
        });
        let file;
        try {
            file = await dialog.select_folder(window, null);
        } catch {
            return; // cancelled
        }
        const dir = file?.get_path();
        if (!dir)
            return;
        const canon = GLib.canonicalize_filename(dir, null);
        // Verify before saving: the folder must hold a real login.
        if (!(await probeDir(canon)).length) {
            window.add_toast(new Adw.Toast({title: 'No Claude Code or Codex login found in that folder', timeout: 4}));
            return;
        }
        const manual = settings.get_strv('manual-folders');
        if (manual.includes(canon)) {
            window.add_toast(new Adw.Toast({title: 'Folder already added', timeout: 3}));
            return;
        }
        settings.set_strv('manual-folders', [...manual, canon]);
        window.add_toast(new Adw.Toast({title: 'Account added', timeout: 2}));
    }

    // ------------------------------------------------------------ display

    _displayPage(window, settings) {
        const page = new Adw.PreferencesPage({title: 'Display', icon_name: 'preferences-desktop-display-symbolic'});

        const panel = new Adw.PreferencesGroup({title: 'Top Panel'});
        panel.add(comboRow(window, settings, 'display-mode', 'Display mode', 'Percentage text, progress bar, or both',
            [['text', 'Text'], ['bar', 'Bar'], ['both', 'Bar + text']]));
        panel.add(comboRow(window, settings, 'panel-metric', 'Usage shown', 'Which limit window the panel shows per account',
            [['session', '5-hour (session)'], ['weekly', 'Weekly'], ['both', 'Session + weekly'], ['highest', 'Highest of all']]));
        panel.add(comboRow(window, settings, 'panel-box', 'Position', 'Where in the top panel',
            [['right', 'Right'], ['center', 'Center'], ['left', 'Left']]));
        panel.add(switchRow(settings, 'show-icon', 'Show icon', null));
        panel.add(switchRow(settings, 'show-labels', 'Show account labels', 'Short label before each account (only with 2+ accounts)'));
        panel.add(switchRow(settings, 'colorize', 'Color by usage level', 'Yellow at warning, red at critical'));
        page.add(panel);

        const menu = new Adw.PreferencesGroup({title: 'Menu'});
        menu.add(comboRow(window, settings, 'menu-theme', 'Theme', 'Light or dark menu colors',
            [['system', 'Same as system'], ['light', 'Light'], ['dark', 'Dark']]));
        page.add(menu);

        const levels = new Adw.PreferencesGroup({title: 'Levels'});
        levels.add(spinRow(settings, 'warn-threshold', 'Warning at (%)', null, 1, 100, 1));
        levels.add(spinRow(settings, 'critical-threshold', 'Critical at (%)', null, 1, 100, 1));
        levels.add(comboRow(window, settings, 'reset-format', 'Reset time', 'How reset times appear in the menu',
            [['relative', 'Countdown (in 2h 5m)'], ['absolute', 'Clock time (18:10)'], ['both', 'Both']]));
        levels.add(comboRow(window, settings, 'clock-format', 'Clock', 'Format of reset times',
            [['system', 'Same as system'], ['24h', '24-hour (18:10)'], ['12h', '12-hour (6:10 PM)']]));
        page.add(levels);
        return page;
    }

    // ------------------------------------------------------------ general

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        const refresh = new Adw.PreferencesGroup({
            title: 'Refresh',
            description: 'Updates also happen right away when Claude Code or Codex refreshes its login, when the network comes back, and when you open the menu.',
        });
        refresh.add(spinRow(settings, 'refresh-interval', 'Refresh interval (seconds)', 'The usage API rate-limits frequent polling; 300 is a safe default', 60, 3600, 30));
        page.add(refresh);

        const notify = new Adw.PreferencesGroup({title: 'Notifications'});
        notify.add(switchRow(settings, 'notify', 'Notify on high usage', 'Once per limit window'));
        notify.add(spinRow(settings, 'notify-threshold', 'Notify at (%)', null, 1, 100, 1));
        notify.add(switchRow(settings, 'notify-reset', 'Notify when a limit resets', 'After you were notified for it'));
        page.add(notify);

        const net = new Adw.PreferencesGroup({title: 'Network'});
        const proxy = new Adw.EntryRow({title: 'Proxy URL (e.g. http://localhost:11809, empty = none)', show_apply_button: true});
        proxy.text = settings.get_string('proxy-url');
        proxy.connect('apply', () => {
            const v = proxy.text.trim();
            if (v && !validProxy(v)) {
                proxy.add_css_class('error');
                return;
            }
            proxy.remove_css_class('error');
            settings.set_string('proxy-url', v);
        });
        net.add(proxy);
        page.add(net);
        return page;
    }
}
