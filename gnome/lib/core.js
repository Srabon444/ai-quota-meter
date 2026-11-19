// SPDX-License-Identifier: GPL-2.0-or-later
// Pure logic shared by extension.js, prefs.js and test/run.js.
// No Shell/Gtk imports here, so it runs under plain `gjs -m`.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const PROVIDERS = {
    claude: {name: 'Claude', credFile: '.credentials.json', envVar: 'CLAUDE_CONFIG_DIR', defaultDir: '.claude'},
    codex: {name: 'Codex', credFile: 'auth.json', envVar: 'CODEX_HOME', defaultDir: '.codex', experimental: true},
};

// ---------------------------------------------------------------- errors

export class QuotaError extends Error {
    constructor(kind, message, retryAfter = 0) {
        super(message);
        this.kind = kind; // nocreds | expired | auth | ratelimit | http | network | parse
        this.retryAfter = retryAfter;
    }

    // Retrying is pointless for nocreds/expired/auth: only a credentials file
    // change (watched by a FileMonitor) can fix those.
    get retriable() {
        return ['ratelimit', 'http', 'network', 'parse'].includes(this.kind);
    }
}

export function errorFromStatus(status, retryAfterHeader) {
    const ra = parseInt(retryAfterHeader ?? '', 10);
    const retryAfter = Number.isFinite(ra) && ra > 0 ? ra : 0;
    if (status === 401 || status === 403)
        return new QuotaError('auth', `Not authorized (HTTP ${status})`);
    if (status === 429)
        return new QuotaError('ratelimit', 'Rate limited by API', retryAfter);
    return new QuotaError('http', `HTTP ${status}`, retryAfter);
}

// Shared by prefs (UX) and extension (enforcement): settings can be written
// directly with gsettings/dconf, bypassing the prefs dialog.
export function validProxy(v) {
    try {
        const u = GLib.Uri.parse(v, GLib.UriFlags.NONE);
        return ['http', 'https', 'socks', 'socks4', 'socks5'].includes(u.get_scheme()) && !!u.get_host();
    } catch {
        return false;
    }
}

// '#RRGGBB' / '#rgb' -> '#rrggbb'; anything else (it ends up in inline CSS) -> null.
export function validColor(v) {
    if (typeof v !== 'string')
        return null;
    const m = v.trim().toLowerCase().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
    if (!m)
        return null;
    return m[1].length === 3 ? `#${[...m[1]].map(c => c + c).join('')}` : `#${m[1]}`;
}

// ---------------------------------------------------------------- credentials

function b64urlDecode(s) {
    let b = s.replace(/-/g, '+').replace(/_/g, '/');
    b += '='.repeat((4 - (b.length % 4)) % 4);
    return new TextDecoder().decode(GLib.base64_decode(b));
}

export function jwtClaims(token) {
    try {
        const part = String(token).split('.')[1];
        return part ? JSON.parse(b64urlDecode(part)) : null;
    } catch {
        return null;
    }
}

// Returns {token, expiresAt(ms)|null, plan, email, accountId} or null if the
// file has no usable credentials for that provider.
export function parseCreds(provider, text) {
    let j;
    try {
        j = JSON.parse(text);
    } catch {
        return null;
    }
    if (provider === 'claude') {
        const o = j?.claudeAiOauth;
        if (typeof o?.accessToken !== 'string' || !o.accessToken)
            return null;
        return {
            token: o.accessToken,
            expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : null,
            plan: typeof o.subscriptionType === 'string' ? o.subscriptionType : null,
            email: null,
            accountId: null,
        };
    }
    if (provider === 'codex') {
        const t = j?.tokens;
        if (typeof t?.access_token !== 'string' || !t.access_token)
            return null;
        const at = jwtClaims(t.access_token);
        const id = jwtClaims(t.id_token);
        const auth = id?.['https://api.openai.com/auth'] ?? at?.['https://api.openai.com/auth'];
        return {
            token: t.access_token,
            expiresAt: typeof at?.exp === 'number' ? at.exp * 1000 : null,
            plan: auth?.chatgpt_plan_type ?? null,
            email: id?.email ?? at?.email ?? null,
            accountId: t.account_id ?? auth?.chatgpt_account_id ?? null,
        };
    }
    return null;
}

// ---------------------------------------------------------------- detection

const MAX_CRED_BYTES = 1024 * 1024;

Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async', 'close_finish');

const isCancelled = e => e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);

// Only small regular files: a FIFO or device would make a read hang.
async function fileInfo(path, cancellable) {
    try {
        const info = await Gio.File.new_for_path(path).query_info_async(
            'standard::type,standard::size,id::file', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > MAX_CRED_BYTES)
            return null;
        return info;
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return null;
    }
}

export async function isSmallRegularFile(path, cancellable = null) {
    return !!await fileInfo(path, cancellable);
}

// Returns the file's text, or null if it is missing or not a small regular file.
export async function readText(path, cancellable = null) {
    if (!await fileInfo(path, cancellable))
        return null;
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return new TextDecoder().decode(bytes);
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return null;
    }
}

// Every provider login found in `dir` (a folder may hold both), with the
// credential file's device+inode id for de-duplication.
export async function probeDir(dir, cancellable = null) {
    const hits = [];
    for (const [provider, p] of Object.entries(PROVIDERS)) {
        const credPath = GLib.build_filenamev([dir, p.credFile]);
        const info = await fileInfo(credPath, cancellable);
        if (!info)
            continue;
        const text = await readText(credPath, cancellable);
        if (text !== null && parseCreds(provider, text))
            hits.push({provider, credPath, id: info.get_attribute_string('id::file') ?? credPath});
    }
    return hits;
}

async function listDirs(home, cancellable) {
    const dirs = [];
    const links = []; // symlinked dirs last, so a duplicate keeps the real folder
    try {
        const en = await Gio.File.new_for_path(home).enumerate_children_async(
            'standard::name,standard::type,standard::is-symlink', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        for (;;) {
            const infos = await en.next_files_async(100, GLib.PRIORITY_DEFAULT, cancellable);
            if (!infos.length)
                break;
            for (const info of infos) {
                if (info.get_file_type() === Gio.FileType.DIRECTORY)
                    (info.get_is_symlink() ? links : dirs).push(GLib.build_filenamev([home, info.get_name()]));
            }
        }
        await en.close_async(GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        if (isCancelled(e))
            throw e;
        console.warn(`AI Quota Meter: cannot scan ${home}: ${e.message}`);
    }
    return [...dirs.sort(), ...links.sort()];
}

export const accountKey = (provider, dir) => `${provider}:${dir}`;

// Scans every top-level directory in $HOME (hidden or not) plus the provider
// env vars, so ~/.claude, ~/.claude-personal, ~/work-claude ... are all found.
// Only one level deep, which keeps a scan to a few hundred stat calls.
// Manual folders are always included, even without valid credentials, so the
// user sees why they fail. Duplicates (symlinks, same dir twice) are dropped
// by the credential file's device+inode id.
export async function detectAccounts({home = GLib.get_home_dir(), env = GLib.getenv, manual = [], auto = true, cancellable = null} = {}) {
    const candidates = [];
    if (auto) {
        for (const p of Object.values(PROVIDERS)) {
            const v = env(p.envVar);
            if (v)
                candidates.push(v);
        }
        candidates.push(...await listDirs(home, cancellable));
    }

    const out = [];
    const seen = new Set();
    const push = (dir, provider, credPath, isManual, id) => {
        if (seen.has(id))
            return;
        seen.add(id);
        out.push({key: accountKey(provider, dir), provider, dir, credPath, manual: isManual, valid: !id.startsWith('missing:')});
    };
    const add = async (dir, isManual) => {
        // Settings can be written directly (gsettings/dconf): reject '' and
        // relative paths here too, not only in prefs.
        if (typeof dir !== 'string' || !GLib.path_is_absolute(dir))
            return;
        dir = GLib.canonicalize_filename(dir, null);
        const hits = await probeDir(dir, cancellable);
        for (const h of hits)
            push(dir, h.provider, h.credPath, isManual, h.id);
        if (!hits.length && isManual)
            push(dir, 'claude', GLib.build_filenamev([dir, PROVIDERS.claude.credFile]), true, `missing:${dir}`);
    };
    // Manual first so a manually-added dir keeps its "manual" flag.
    for (const d of manual)
        await add(d, true);
    for (const d of candidates)
        await add(d, false);

    // Stable order: by provider, then default dir first, then name.
    const rank = a => (a.dir.endsWith(`/${PROVIDERS[a.provider].defaultDir}`) ? 0 : 1);
    out.sort((a, b) => a.provider.localeCompare(b.provider) || rank(a) - rank(b) || a.dir.localeCompare(b.dir));
    return out;
}

// Default human label from the directory name: ~/.claude-personal -> "personal".
export function defaultLabel(acc) {
    const base = GLib.path_get_basename(acc.dir).replace(/^\./, '');
    const def = PROVIDERS[acc.provider].defaultDir.replace(/^\./, '');
    const rest = base.startsWith(def) ? base.slice(def.length).replace(/^[-_.]+/, '') : base;
    return rest || 'default';
}

// ---------------------------------------------------------------- usage parsing

const toMs = v => {
    if (typeof v === 'number') {
        if (!Number.isFinite(v) || v <= 0)
            return null;
        return v > 1e12 ? v : v * 1000;
    }
    if (typeof v === 'string') {
        const t = Date.parse(v);
        return Number.isFinite(t) ? t : null;
    }
    return null;
};

const CLAUDE_WINDOWS = [
    ['five_hour', '5-hour', 'session'],
    ['seven_day', '7-day', 'weekly'],
    ['seven_day_opus', '7-day Opus', 'model'],
    ['seven_day_sonnet', '7-day Sonnet', 'model'],
];

const titleCase = s => s.replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, ch => ch.toUpperCase());

// Model name of a scoped limit: a string, or an object with a name field.
function scopeName(scope) {
    if (typeof scope === 'string')
        return scope.trim() || null;
    if (scope && typeof scope === 'object') {
        for (const k of ['display_name', 'name', 'model', 'label']) {
            if (typeof scope[k] === 'string' && scope[k].trim())
                return scope[k].trim();
        }
    }
    return null;
}

// One entry of the API's `limits` list -> window, or null if unusable.
// session -> "5-hour"; weekly_all -> "7-day"; any other weekly limit is
// per model -> "7-day · Fable" (name from scope, else from the kind suffix).
function limitWindow(l) {
    if (!l || typeof l !== 'object' || typeof l.percent !== 'number' || !Number.isFinite(l.percent))
        return null;
    const kind = typeof l.kind === 'string' ? l.kind : '';
    const group = typeof l.group === 'string' ? l.group : '';
    const resetsAt = toMs(l.resets_at);
    if (group === 'session' || kind === 'session')
        return {label: '5-hour', kind: 'session', percent: l.percent, resetsAt};
    if (group === 'weekly' || kind.startsWith('weekly')) {
        const model = scopeName(l.scope) ?? (kind.startsWith('weekly_') && kind !== 'weekly_all' ? titleCase(kind.slice(7)) : null);
        if (!model)
            return {label: '7-day', kind: 'weekly', percent: l.percent, resetsAt};
        return {label: `7-day · ${model}`, kind: 'model', percent: l.percent, resetsAt};
    }
    const name = group || kind;
    return name ? {label: titleCase(name), kind: 'model', percent: l.percent, resetsAt} : null;
}

// Prefers the generic `limits` list, which also carries per-model limits
// (e.g. a weekly Fable limit); falls back to the fixed fields.
export function parseClaudeUsage(j) {
    let windows = [];
    if (Array.isArray(j?.limits))
        windows = j.limits.map(limitWindow).filter(Boolean);
    if (!windows.length) {
        for (const [k, label, kind] of CLAUDE_WINDOWS) {
            const w = j?.[k];
            if (w && typeof w.utilization === 'number' && Number.isFinite(w.utilization))
                windows.push({label, kind, percent: w.utilization, resetsAt: toMs(w.resets_at)});
        }
    }
    if (!windows.length)
        throw new QuotaError('parse', 'Unrecognized usage response');
    return {windows};
}

function windowLabel(seconds, fallback) {
    if (!seconds)
        return fallback;
    const h = Math.round(seconds / 3600);
    return h < 24 ? `${h}-hour` : `${Math.round(h / 24)}-day`;
}

// Experimental: the shape follows the Codex CLI's rate-limit payload and has
// not been checked against a live account.
export function parseCodexUsage(j, now = Date.now()) {
    const rl = j?.rate_limit;
    const windows = [];
    for (const [k, kind, fb] of [['primary_window', 'session', 'Session'], ['secondary_window', 'weekly', 'Weekly']]) {
        const w = rl?.[k];
        if (!w || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent))
            continue;
        let resetsAt = toMs(w.reset_at);
        if (resetsAt === null && typeof w.reset_after_seconds === 'number')
            resetsAt = now + w.reset_after_seconds * 1000;
        windows.push({label: windowLabel(w.limit_window_seconds, fb), kind, percent: w.used_percent, resetsAt});
    }
    if (!windows.length)
        throw new QuotaError('parse', 'Unrecognized usage response');
    return {windows, plan: typeof j?.plan_type === 'string' ? j.plan_type : null};
}

// ---------------------------------------------------------------- display math

// A window whose reset time has passed has rolled over: its old percentage
// no longer applies, so cached data must not keep showing it.
export function effectivePercent(w, now = Date.now()) {
    if (w.resetsAt !== null && w.resetsAt !== undefined && w.resetsAt <= now)
        return 0;
    return w.percent;
}

export const clampFraction = p => (Number.isFinite(p) ? Math.min(1, Math.max(0, p / 100)) : 0);

// Width in px of a bar inside a track of `trackWidth` px. 100% == trackWidth exactly.
// floor: the bar only looks full when the value really is 100%.
export const barWidth = (percent, trackWidth) => Math.floor(clampFraction(percent) * Math.max(0, trackWidth));

// The API's resets_at jitters by a few hundred ms between calls for the same
// window, so compare windows with a tolerance, never with ===.
export const sameWindow = (a, b) =>
    (a === null || a === undefined) ? (b === null || b === undefined)
        : (typeof b === 'number' && Math.abs(a - b) < 5 * 60 * 1000);

// Should a background trigger (timer, menu open, network back) fetch now?
// Manual "Refresh now" and credentials-file changes bypass this.
export function isDue(st, intervalMs, now = Date.now()) {
    if (st.inflight || st.retryAt > now)
        return false;
    if (st.error?.kind === 'auth')
        return false; // only a rewritten credentials file can fix a rejected login
    return !!st.error || now - st.fetchedAt >= intervalMs - 5000;
}

// Untrusted (disk cache) -> usage object, or null.
export function sanitizeUsage(u) {
    if (!Array.isArray(u?.windows))
        return null;
    const windows = u.windows.filter(w => w && typeof w === 'object' &&
        typeof w.label === 'string' && typeof w.kind === 'string' &&
        typeof w.percent === 'number' && Number.isFinite(w.percent) &&
        (w.resetsAt === null || (typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt))))
        .map(w => ({label: w.label, kind: w.kind, percent: w.percent, resetsAt: w.resetsAt}));
    return windows.length ? {windows} : null;
}

export function level(percent, warn, crit) {
    if (percent >= crit)
        return 'critical';
    if (percent >= warn)
        return 'warn';
    return 'ok';
}

// Value shown in the panel for one account.
export function panelPercent(usage, metric, now = Date.now()) {
    const ws = usage?.windows ?? [];
    const of = kind => {
        const w = ws.find(x => x.kind === kind);
        return w ? effectivePercent(w, now) : null;
    };
    const s = of('session');
    const w = of('weekly');
    switch (metric) {
    case 'weekly':
        return [w ?? s];
    case 'both':
        return [s, w].filter(v => v !== null);
    case 'highest': {
        const all = ws.map(x => effectivePercent(x, now));
        return all.length ? [Math.max(...all)] : [null];
    }
    default:
        return [s ?? w];
    }
}

export function formatDuration(ms) {
    if (ms <= 0)
        return 'now';
    const m = Math.floor(ms / 60000);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0)
        return `${d}d ${h % 24}h`;
    if (h > 0)
        return `${h}h ${m % 60}m`;
    return `${Math.max(1, m)}m`;
}

export function formatAgo(ts, now = Date.now()) {
    if (!ts)
        return 'never';
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 60)
        return 'just now';
    return `${formatDuration(s * 1000)} ago`;
}

export function backoffSeconds(failCount, interval, retryAfter = 0) {
    const exp = Math.min(interval, 30 * 2 ** Math.max(0, failCount - 1));
    return Math.max(exp, Math.min(retryAfter, 3600));
}

// ---------------------------------------------------------------- refresher

// Owns per-account fetch state. Guarantees, per account:
//  - at most one request in flight; triggers during a request are coalesced
//    into exactly one follow-up run (so a newer trigger is never lost and an
//    older response can never overwrite a newer one);
//  - failures keep the last good data and schedule one backoff retry;
//  - nothing is touched after destroy().
// `load(acc, cancellable)` returns a Promise of {windows, plan?}.
export class Refresher {
    constructor({load, onUpdate, getInterval}) {
        this._load = load;
        this._onUpdate = onUpdate;
        this._getInterval = getInterval;
        this._st = new Map();
        this._destroyed = false;
    }

    state(key) {
        let st = this._st.get(key);
        if (!st) {
            st = {usage: null, fetchedAt: 0, error: null, failCount: 0, retryAt: 0,
                inflight: false, pending: false, cancellable: null, retryId: 0, gen: 0};
            this._st.set(key, st);
        }
        return st;
    }

    // Seed from disk cache. Never overrides live data.
    seed(key, usage, fetchedAt) {
        const st = this.state(key);
        if (!st.fetchedAt && usage) {
            st.usage = usage;
            st.fetchedAt = fetchedAt;
        }
    }

    refresh(acc) {
        if (this._destroyed)
            return;
        const st = this.state(acc.key);
        if (st.inflight) {
            st.pending = true;
            return;
        }
        this._clearRetry(st);
        this._run(acc, st);
    }

    async _run(acc, st) {
        st.inflight = true;
        st.pending = false;
        const gen = ++st.gen;
        const c = st.cancellable = new Gio.Cancellable();
        try {
            const usage = await this._load(acc, c);
            if (this._destroyed || gen !== st.gen)
                return;
            st.usage = usage;
            st.fetchedAt = Date.now();
            st.error = null;
            st.failCount = 0;
            st.retryAt = 0;
        } catch (e) {
            if (this._destroyed || gen !== st.gen)
                return;
            const cancelled = e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
            if (!cancelled) {
                const err = e instanceof QuotaError ? e : new QuotaError('network', e.message ?? String(e));
                st.error = err;
                st.failCount++;
                if (err.retriable)
                    this._scheduleRetry(acc, st, backoffSeconds(st.failCount, this._getInterval(), err.retryAfter));
            }
        } finally {
            if (gen === st.gen) {
                st.inflight = false;
                st.cancellable = null;
            }
        }
        if (this._destroyed || gen !== st.gen)
            return;
        try {
            this._onUpdate(acc, st);
        } catch (e) {
            console.error(`AI Quota Meter: update failed: ${e.message}`);
        }
        if (st.pending)
            this.refresh(acc);
    }

    _scheduleRetry(acc, st, seconds) {
        this._clearRetry(st);
        st.retryAt = Date.now() + seconds * 1000;
        st.retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            st.retryId = 0;
            this.refresh(acc);
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearRetry(st) {
        if (st.retryId) {
            GLib.source_remove(st.retryId);
            st.retryId = 0;
        }
        st.retryAt = 0;
    }

    // Cancel any request/retry but keep the data (account disabled).
    stop(key) {
        const st = this._st.get(key);
        if (!st)
            return;
        st.gen++;
        st.cancellable?.cancel();
        st.inflight = false;
        st.pending = false;
        st.cancellable = null;
        this._clearRetry(st);
    }

    // Abort the in-flight request (e.g. proxy changed) and re-run it.
    restart(acc) {
        const st = this.state(acc.key);
        if (st.inflight) {
            st.gen++; // orphan the old run
            st.cancellable?.cancel();
            st.inflight = false;
            st.cancellable = null;
        }
        this.refresh(acc);
    }

    forget(key) {
        const st = this._st.get(key);
        if (!st)
            return;
        st.gen++;
        st.cancellable?.cancel();
        this._clearRetry(st);
        this._st.delete(key);
    }

    destroy() {
        this._destroyed = true;
        for (const key of [...this._st.keys()])
            this.forget(key);
    }
}
