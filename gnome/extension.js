// SPDX-License-Identifier: GPL-2.0-or-later
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    PROVIDERS, QuotaError, Refresher, detectAccounts, defaultLabel, errorFromStatus, parseCreds,
    parseClaudeUsage, parseCodexUsage, effectivePercent, barWidth, level, panelPercent,
    formatDuration, formatAgo, validColor, validProxy, isDue, sameWindow, sanitizeUsage, isSmallRegularFile,
} from './lib/core.js';

Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'make_directory_async', 'make_directory_finish');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CACHE_VERSION = 1;

// A track whose fill is allocated at exactly `percent` of the track's own
// content box, so 100% is always full regardless of CSS, scaling or theme.
// Done in vfunc_allocate: resizing the fill from outside the layout pass
// relayouts mid-allocation and spams Clutter warnings.
const Bar = GObject.registerClass(
class Bar extends St.Widget {
    _init(trackClass, fillClass) {
        super._init({style_class: trackClass, y_align: Clutter.ActorAlign.CENTER});
        this._fill = new St.Widget({style_class: fillClass});
        this.add_child(this._fill);
        this._percent = 0;
    }

    set(percent, lvl) {
        this._percent = percent;
        for (const l of ['ok', 'warn', 'critical'])
            this._fill.remove_style_class_name(`aqm-${l}`);
        this._fill.add_style_class_name(`aqm-${lvl}`);
        this.queue_relayout();
    }

    get fillWidth() {
        return this._fill.get_allocation_box().get_width();
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const c = this.get_theme_node().get_content_box(box);
        const fill = new Clutter.ActorBox({x1: c.x1, y1: c.y1, x2: c.x1 + barWidth(this._percent, c.get_width()), y2: c.y2});
        this._fill.allocate(fill);
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'AI Quota Meter');
        this._ext = ext;
        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box aqm-panel'});
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(GLib.build_filenamev([ext.path, 'icons', 'aqm-symbolic.svg'])),
            style_class: 'system-status-icon aqm-icon',
        });
        this._box.add_child(this._icon);
        this._segments = new St.BoxLayout({style_class: 'aqm-segments'});
        this._box.add_child(this._segments);
        this.add_child(this._box);

        this._accountsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._accountsSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const refresh = new PopupMenu.PopupMenuItem('Refresh now');
        refresh.connect('activate', () => ext.refreshAll(true));
        this.menu.addMenuItem(refresh);
        const prefs = new PopupMenu.PopupMenuItem('Settings');
        prefs.connect('activate', () => ext.openPreferences());
        this.menu.addMenuItem(prefs);

        this._menuOpenId = this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                ext.refreshAll(false); // catch up after suspend/resume
                this.render();
            }
        });
    }

    destroy() {
        this.menu.disconnect(this._menuOpenId);
        super.destroy();
    }

    render() {
        const ext = this._ext;
        const s = ext.settings;
        const now = Date.now();
        const warn = s.get_int('warn-threshold');
        const crit = s.get_int('critical-threshold');
        const mode = s.get_string('display-mode');
        const metric = s.get_string('panel-metric');
        const showLabels = s.get_boolean('show-labels');
        const colorize = s.get_boolean('colorize');
        const accounts = ext.visibleAccounts();

        this._icon.visible = s.get_boolean('show-icon');

        // ---- panel
        this._segments.destroy_all_children();
        const inPanel = accounts.filter(a => a.cfg.panel);
        for (const acc of inPanel) {
            const st = ext.refresher.state(acc.key);
            const seg = new St.BoxLayout({style_class: 'aqm-segment'});
            if (showLabels && inPanel.length > 1)
                seg.add_child(new St.Label({
                    text: ext.short(acc), style_class: 'aqm-short', y_align: Clutter.ActorAlign.CENTER,
                    style: acc.cfg.color ? `color: ${acc.cfg.color};` : null,
                }));
            const values = st.usage ? panelPercent(st.usage, metric, now) : [null];
            const top = Math.max(...values.map(v => v ?? 0));
            if (mode !== 'text') {
                const bar = new Bar('aqm-panel-track', 'aqm-panel-fill');
                bar.set(top, level(top, warn, crit));
                seg.add_child(bar);
            }
            if (mode !== 'bar') {
                let text = values.map(v => (v === null ? '–' : `${Math.round(v)}%`)).join('·');
                if (!st.usage)
                    text = st.error ? '!' : '…';
                const label = new St.Label({text, style_class: 'aqm-pct', y_align: Clutter.ActorAlign.CENTER});
                if (colorize && st.usage)
                    label.add_style_class_name(`aqm-text-${level(top, warn, crit)}`);
                seg.add_child(label);
            }
            if (st.error)
                seg.add_style_class_name('aqm-stale');
            this._segments.add_child(seg);
        }
        if (!inPanel.length) {
            this._segments.add_child(new St.Label({
                text: !ext.scanned ? '…' : (accounts.length ? '' : 'No accounts'), style_class: 'aqm-pct', y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        // ---- menu
        this._accountsSection.removeAll();
        if (!accounts.length) {
            const text = ext.scanned ? 'No accounts found. Add a folder in Settings.' : 'Looking for accounts…';
            const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
            this._accountsSection.addMenuItem(item);
            return;
        }
        accounts.forEach((acc, i) => {
            if (i > 0)
                this._accountsSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._accountsSection.addMenuItem(this._accountItem(acc, now, warn, crit));
        });
    }

    _accountItem(acc, now, warn, crit) {
        const ext = this._ext;
        const st = ext.refresher.state(acc.key);
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({vertical: true, style_class: 'aqm-card', x_expand: true});

        const head = new St.BoxLayout({style_class: 'aqm-card-head'});
        const meta = ext.meta(acc.key);
        const title = ext.title(acc);
        head.add_child(new St.Label({text: title, style_class: 'aqm-title'}));
        const plan = meta.plan ? ` · ${meta.plan}` : '';
        const exp = PROVIDERS[acc.provider].experimental ? ' (experimental)' : '';
        head.add_child(new St.Label({
            text: `${PROVIDERS[acc.provider].name}${plan}${exp}`,
            style_class: 'aqm-sub', x_expand: true, x_align: Clutter.ActorAlign.END,
        }));
        box.add_child(head);
        const sub = [meta.email, acc.dir.replace(GLib.get_home_dir(), '~')].filter(v => v && v !== title).join(' · ');
        const subLabel = new St.Label({text: sub, style_class: 'aqm-dim'});
        subLabel.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        box.add_child(subLabel);

        for (const w of st.usage?.windows ?? []) {
            const p = effectivePercent(w, now);
            const row = new St.BoxLayout();
            row.add_child(new St.Label({text: w.label, style_class: 'aqm-wlabel'}));
            row.add_child(new St.Label({
                text: `${p.toFixed(p % 1 ? 1 : 0)}%`, style_class: `aqm-wpct aqm-text-${level(p, warn, crit)}`,
                x_expand: true, x_align: Clutter.ActorAlign.END,
            }));
            box.add_child(row);
            const bar = new Bar('aqm-track', 'aqm-fill');
            bar.x_expand = true;
            bar.set(p, level(p, warn, crit));
            box.add_child(bar);
            if (w.resetsAt)
                box.add_child(new St.Label({text: this._resetText(w.resetsAt, now), style_class: 'aqm-dim'}));
        }

        if (st.error) {
            const err = new St.Label({text: `⚠ ${this._errorText(acc, st, now)}`, style_class: 'aqm-error'});
            err.clutter_text.line_wrap = true;
            box.add_child(err);
        }
        box.add_child(new St.Label({
            text: st.fetchedAt ? `Updated ${formatAgo(st.fetchedAt, now)}` : (st.inflight ? 'Loading…' : 'No data yet'),
            style_class: 'aqm-dim',
        }));
        item.add_child(box);
        return item;
    }

    _resetText(resetsAt, now) {
        if (resetsAt <= now)
            return 'Reset (waiting for new data)';
        const fmt = this._ext.settings.get_string('reset-format');
        const rel = `Resets in ${formatDuration(resetsAt - now)}`;
        const dt = GLib.DateTime.new_from_unix_local(Math.floor(resetsAt / 1000));
        const sameDay = dt.format('%F') === GLib.DateTime.new_now_local().format('%F');
        const clock = this._ext.settings.get_string('clock-format');
        const h12 = clock === '12h' || (clock === 'system' && this._ext.desktopSettings.get_string('clock-format') === '12h');
        const time = h12 ? '%-I:%M %p' : '%H:%M';
        const abs = dt.format(sameDay ? time : `%a %d %b, ${time}`);
        if (fmt === 'relative')
            return rel;
        if (fmt === 'absolute')
            return `Resets ${abs}`;
        return `${rel} (${abs})`;
    }

    _errorText(acc, st, now) {
        const e = st.error;
        const cli = acc.provider === 'claude' ? 'Claude Code' : 'Codex';
        const retry = st.retryAt > now ? `, retry in ${formatDuration(st.retryAt - now)}` : '';
        switch (e.kind) {
        case 'expired': return `Token expired. Open ${cli} to refresh it.`;
        case 'auth': return `Login rejected. Log in again with ${cli}.`;
        case 'nocreds': return 'No login found in this folder';
        case 'ratelimit': return `Usage API rate limited${retry}`;
        default: return `${e.message}${retry}`;
        }
    }
});

export default class AiQuotaMeterExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this.desktopSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._desktopId = this.desktopSettings.connect('changed::clock-format', () => this._scheduleRender());
        this._session = this._createSession();
        this._accounts = [];
        this._monitors = new Map(); // key -> {monitor, id, debounce}
        this._meta = {}; // key -> {email, plan, notified: {label: resetsAt}}
        this._cachePath = GLib.build_filenamev([GLib.get_user_cache_dir(), 'ai-quota-meter', 'state.json']);

        this._cancellable = new Gio.Cancellable();
        this.scanned = false;
        this.refresher = new Refresher({
            load: (acc, c) => this._load(acc, c),
            onUpdate: (acc, st) => this._onUpdate(acc, st),
            getInterval: () => this.settings.get_int('refresh-interval'),
        });

        this._loadCache().catch(e => console.warn(`AI Quota Meter: ${e.message}`));
        this._createIndicator();

        this._settingsId = this.settings.connect('changed', (_s, key) => this._onSetting(key));
        this._netMonitor = Gio.NetworkMonitor.get_default();
        this._netId = this._netMonitor.connect('network-changed', (_m, available) => {
            if (available)
                this._debounce('_netDebounce', 2, () => this.refreshAll(false));
        });

        // Not forced: GNOME re-enables extensions on every unlock; cached data
        // younger than the interval is shown without hitting the API again.
        this.refreshAll(false);
        this._startTimer();
    }

    disable() {
        this._stopTimer();
        if (this._netDebounce) {
            GLib.source_remove(this._netDebounce);
            this._netDebounce = 0;
        }
        if (this._renderDebounce) {
            GLib.source_remove(this._renderDebounce);
            this._renderDebounce = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        this._scanGen = (this._scanGen ?? 0) + 1;
        this._scan = null;
        this._netMonitor?.disconnect(this._netId);
        this._netMonitor = null;
        this.settings?.disconnect(this._settingsId);
        this.desktopSettings?.disconnect(this._desktopId);
        this.desktopSettings = null;
        for (const key of [...this._monitors?.keys() ?? []])
            this._unwatch(key);
        this.refresher?.destroy();
        this.refresher = null;
        this._session?.abort();
        this._session = null;
        this._indicator?.destroy();
        this._indicator = null;
        this.settings = null;
        this._accounts = [];
        this._monitors = null;
        this._meta = null;
    }

    // ------------------------------------------------------------ accounts

    _config() {
        try {
            const c = JSON.parse(this.settings.get_string('account-config'));
            return c && typeof c === 'object' ? c : {};
        } catch {
            return {};
        }
    }

    // One scan at a time. A request that arrives during a scan makes that scan
    // loop once more, so every caller's promise resolves after a scan that
    // started after its request.
    _rescan() {
        if (this._scan) {
            this._scanAgain = true;
            return this._scan;
        }
        const gen = this._scanGen ?? 0;
        this._scan = (async () => {
            const added = [];
            try {
                do {
                    this._scanAgain = false;
                    const found = await detectAccounts({
                        manual: this.settings.get_strv('manual-folders'),
                        auto: this.settings.get_boolean('auto-detect'),
                        cancellable: this._cancellable,
                    });
                    if (gen !== (this._scanGen ?? 0))
                        return [];
                    added.push(...this._applyScan(found));
                } while (this._scanAgain);
            } catch (e) {
                if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
                    console.warn(`AI Quota Meter: scan failed: ${e.message}`);
            } finally {
                if (gen === (this._scanGen ?? 0))
                    this._scan = null;
            }
            return added;
        })();
        return this._scan;
    }

    _applyScan(found) {
        this.scanned = true;
        const cfg = this._config();
        for (const acc of found) {
            const c = cfg[acc.key] ?? {};
            acc.cfg = {
                label: (typeof c.label === 'string' && c.label.trim().slice(0, 40)) || null,
                short: (typeof c.short === 'string' && c.short.trim().slice(0, 4)) || null,
                color: validColor(c.color),
                enabled: c.enabled !== false,
                panel: c.panel !== false,
            };
        }
        const keys = new Set(found.map(a => a.key));
        for (const old of this._accounts) {
            if (!keys.has(old.key)) {
                this._unwatch(old.key);
                this.refresher.forget(old.key);
            }
        }
        const isNew = acc => !this._accounts.some(a => a.key === acc.key);
        const added = found.filter(isNew);
        this._accounts = found;
        for (const acc of found) {
            if (acc.cfg.enabled) {
                this._watch(acc);
            } else {
                this._unwatch(acc.key);
                this.refresher.stop(acc.key);
            }
        }
        return added;
    }

    visibleAccounts() {
        return this._accounts.filter(a => a.cfg.enabled);
    }

    // Custom name > account email > folder name (~/.claude-personal -> "personal").
    title(acc) {
        return acc.cfg.label || this.meta(acc.key).email || defaultLabel(acc);
    }

    short(acc) {
        return acc.cfg.short || (acc.cfg.label || defaultLabel(acc)).charAt(0).toUpperCase();
    }

    meta(key) {
        return this._meta[key] ??= {email: null, plan: null, notified: {}};
    }

    // Claude Code / Codex rewrite the credentials file when they refresh the
    // token. Watching it means a fresh token is used within ~1s instead of
    // waiting for the next timer tick.
    _watch(acc) {
        if (this._monitors.has(acc.key))
            return;
        try {
            const monitor = Gio.File.new_for_path(acc.credPath).monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
            const entry = {monitor, debounce: 0};
            entry.id = monitor.connect('changed', () => {
                if (entry.debounce)
                    GLib.source_remove(entry.debounce);
                entry.debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                    entry.debounce = 0;
                    this._rescan().then(() => {
                        const cur = this._accounts?.find(a => a.key === acc.key);
                        if (this.refresher && cur?.cfg.enabled)
                            this.refresher.refresh(cur);
                    });
                    return GLib.SOURCE_REMOVE;
                });
            });
            this._monitors.set(acc.key, entry);
        } catch (e) {
            console.warn(`AI Quota Meter: cannot watch ${acc.credPath}: ${e.message}`);
        }
    }

    _unwatch(key) {
        const e = this._monitors.get(key);
        if (!e)
            return;
        if (e.debounce)
            GLib.source_remove(e.debounce);
        e.monitor.disconnect(e.id);
        e.monitor.cancel();
        this._monitors.delete(key);
    }

    // ------------------------------------------------------------ refresh

    async refreshAll(force) {
        if (!this.refresher)
            return;
        const added = await this._rescan();
        if (!this.refresher)
            return; // disabled while scanning
        const interval = this.settings.get_int('refresh-interval') * 1000;
        for (const acc of this.visibleAccounts()) {
            if (force || added.includes(acc) || isDue(this.refresher.state(acc.key), interval))
                this.refresher.refresh(acc);
        }
        this._scheduleRender();
    }

    _startTimer() {
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this.settings.get_int('refresh-interval'), () => {
            this.refreshAll(false);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
    }

    _debounce(field, seconds, fn) {
        if (this[field])
            GLib.source_remove(this[field]);
        this[field] = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this[field] = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleRender() {
        if (this._renderDebounce)
            return;
        this._renderDebounce = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._renderDebounce = 0;
            this._indicator?.render();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onSetting(key) {
        switch (key) {
        case 'refresh-interval':
            this._stopTimer();
            this._startTimer();
            break;
        case 'proxy-url':
            this._session?.abort();
            this._session = this._createSession();
            for (const acc of this.visibleAccounts())
                this.refresher.restart(acc);
            break;
        case 'panel-box':
            this._indicator?.destroy();
            this._createIndicator();
            break;
        case 'manual-folders':
        case 'auto-detect':
        case 'account-config':
            this.refreshAll(false);
            break;
        }
        this._scheduleRender();
    }

    _createIndicator() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, this.settings.get_string('panel-box'));
        this._indicator.render();
    }

    _createSession() {
        const session = new Soup.Session({timeout: 30, user_agent: 'ai-quota-meter'});
        const proxy = this.settings.get_string('proxy-url').trim();
        // Fail closed: a mistyped proxy must not silently send traffic direct.
        this._proxyInvalid = !!proxy && !validProxy(proxy);
        if (proxy && !this._proxyInvalid)
            session.set_proxy_resolver(Gio.SimpleProxyResolver.new(proxy, null));
        return session;
    }

    // ------------------------------------------------------------ fetching

    async _getJson(url, headers, cancellable) {
        const msg = Soup.Message.new('GET', url);
        for (const [k, v] of Object.entries(headers))
            msg.request_headers.append(k, v);
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
        if (msg.status_code !== 200)
            throw errorFromStatus(msg.status_code, msg.response_headers.get_one('retry-after'));
        try {
            return JSON.parse(new TextDecoder().decode(bytes.get_data()));
        } catch {
            throw new QuotaError('parse', 'Invalid JSON from API');
        }
    }

    async _load(acc, cancellable) {
        if (this._proxyInvalid)
            throw new QuotaError('network', 'Invalid proxy URL in settings');
        // valid is fresh: every trigger rescans first. The regular-file check
        // keeps a FIFO from hanging the read forever.
        if (!acc.valid || !await isSmallRegularFile(acc.credPath, cancellable))
            throw new QuotaError('nocreds', 'No credentials');
        let text;
        try {
            const [contents] = await Gio.File.new_for_path(acc.credPath).load_contents_async(cancellable);
            text = new TextDecoder().decode(contents);
        } catch (e) {
            if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            throw new QuotaError('nocreds', 'Cannot read credentials');
        }
        const creds = parseCreds(acc.provider, text);
        if (!creds)
            throw new QuotaError('nocreds', 'No credentials');
        // Expired token: calling the API would only 401. Keep cached data and
        // wait for the CLI to rewrite the file (the FileMonitor fires).
        if (creds.expiresAt && creds.expiresAt <= Date.now())
            throw new QuotaError('expired', 'Token expired');

        const meta = this.meta(acc.key);
        if (creds.plan)
            meta.plan = creds.plan;
        if (creds.email)
            meta.email = creds.email;

        if (acc.provider === 'codex') {
            const headers = {Authorization: `Bearer ${creds.token}`};
            if (creds.accountId)
                headers['ChatGPT-Account-Id'] = creds.accountId;
            const usage = parseCodexUsage(await this._getJson(CODEX_USAGE_URL, headers, cancellable));
            if (usage.plan)
                meta.plan = usage.plan;
            return usage;
        }

        const headers = {'Authorization': `Bearer ${creds.token}`, 'anthropic-beta': 'oauth-2025-04-20'};
        const usage = parseClaudeUsage(await this._getJson(CLAUDE_USAGE_URL, headers, cancellable));
        if (!meta.email) {
            // Once per account (then cached on disk); failure is harmless.
            try {
                const p = await this._getJson(CLAUDE_PROFILE_URL, headers, cancellable);
                meta.email = p?.account?.email ?? null;
            } catch (e) {
                if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    throw e;
            }
        }
        return usage;
    }

    _onUpdate(acc, st) {
        if (st.usage && !st.error) {
            this._maybeNotify(acc, st.usage);
            this._saveCache();
        }
        this._scheduleRender();
    }

    _maybeNotify(acc, usage) {
        const s = this.settings;
        const meta = this.meta(acc.key);
        const threshold = s.get_int('notify-threshold');
        for (const w of usage.windows) {
            const id = `${w.label}`;
            const prev = meta.notified[id];
            const p = effectivePercent(w, Date.now());
            if (p >= threshold) {
                if (!sameWindow(prev, w.resetsAt) && s.get_boolean('notify')) {
                    Main.notify(`${this.title(acc)}: ${w.label} usage at ${Math.round(p)}%`,
                        w.resetsAt ? `Resets in ${formatDuration(w.resetsAt - Date.now())}` : '');
                }
                meta.notified[id] = w.resetsAt;
            } else if (prev !== undefined) {
                delete meta.notified[id];
                if (!sameWindow(prev, w.resetsAt) && s.get_boolean('notify-reset'))
                    Main.notify(`${this.title(acc)}: ${w.label} limit reset`, `Now at ${Math.round(p)}%`);
            }
        }
    }

    // ------------------------------------------------------------ cache

    async _loadCache() {
        const cancellable = this._cancellable;
        let j;
        try {
            const [bytes] = await Gio.File.new_for_path(this._cachePath).load_contents_async(cancellable);
            j = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            return; // first run, unreadable or disabled meanwhile: start empty
        }
        if (!this.refresher || j?.version !== CACHE_VERSION || typeof j.accounts !== 'object' || !j.accounts)
            return;
        for (const [key, a] of Object.entries(j.accounts)) {
            // Untrusted file: one bad entry must not break enable().
            const usage = sanitizeUsage(a?.usage);
            if (!usage)
                continue;
            const str = v => (typeof v === 'string' ? v : null);
            const notified = {};
            if (a.notified && typeof a.notified === 'object') {
                for (const [k, v] of Object.entries(a.notified)) {
                    if (v === null || Number.isFinite(v))
                        notified[k] = v;
                }
            }
            this.refresher.seed(key, usage, Number.isFinite(a.fetchedAt) ? a.fetchedAt : 0);
            // Live data learned before the cache finished loading wins.
            const m = this.meta(key);
            m.email ??= str(a.email);
            m.plan ??= str(a.plan);
            if (!Object.keys(m.notified).length)
                m.notified = notified;
        }
        this._scheduleRender();
    }

    _cacheSnapshot() {
        const accounts = {};
        for (const acc of this._accounts) {
            const st = this.refresher.state(acc.key);
            if (!st.usage)
                continue;
            const m = this.meta(acc.key);
            accounts[acc.key] = {usage: st.usage, fetchedAt: st.fetchedAt, email: m.email, plan: m.plan, notified: m.notified};
        }
        return JSON.stringify({version: CACHE_VERSION, accounts});
    }

    // Writes are serialised: a save requested during a write runs once more
    // afterwards with the latest state, so an older snapshot never lands last.
    // replace_contents writes a temp file and renames it, so a crash cannot
    // leave a half-written cache.
    async _saveCache() {
        if (this._saving) {
            this._saveAgain = true;
            return;
        }
        this._saving = true;
        const file = Gio.File.new_for_path(this._cachePath);
        try {
            do {
                this._saveAgain = false;
                if (!this.refresher)
                    break;
                const bytes = new GLib.Bytes(new TextEncoder().encode(this._cacheSnapshot()));
                try {
                    await file.get_parent().make_directory_async(GLib.PRIORITY_DEFAULT, null);
                } catch (e) {
                    if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)))
                        throw e;
                }
                await file.replace_contents_bytes_async(bytes, null, false,
                    Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            } while (this._saveAgain);
        } catch (e) {
            console.warn(`AI Quota Meter: cannot write cache: ${e.message}`);
        } finally {
            this._saving = false;
        }
    }
}
