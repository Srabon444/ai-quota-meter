// SPDX-License-Identifier: GPL-2.0-or-later
// Run: gjs -m test/run.js   (exit 0 = all pass)
import GLib from 'gi://GLib';
import System from 'system';
import {
    QuotaError, Refresher, backoffSeconds, barWidth, defaultLabel, detectAccounts, effectivePercent,
    errorFromStatus, jwtClaims, panelPercent, parseClaudeUsage, parseCodexUsage, parseCreds, validProxy,
    isDue, sameWindow, sanitizeUsage,
} from '../lib/core.js';

let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
function eq(a, b, msg = '') {
    const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
    if (x !== y)
        throw new Error(`${msg} expected ${y}, got ${x}`);
}

// ---- parsing (real response shape captured 2026-11-17, account at 100%)
const CLAUDE = {
    five_hour: {utilization: 100.0, resets_at: '2026-11-17T18:09:59.892299+00:00'},
    seven_day: {utilization: 81.0, resets_at: '2026-11-20T16:59:59.892317+00:00'},
    seven_day_opus: null, seven_day_sonnet: null,
};

test('claude usage parses 100% and 81%', () => {
    const u = parseClaudeUsage(CLAUDE);
    eq(u.windows.map(w => [w.label, w.kind, w.percent]), [['5-hour', 'session', 100], ['7-day', 'weekly', 81]]);
    eq(u.windows[0].resetsAt, Date.parse('2026-11-17T18:09:59.892Z'));
});
test('claude usage rejects error body', () => {
    try {
        parseClaudeUsage({error: {type: 'rate_limit_error'}});
    } catch (e) {
        eq(e.kind, 'parse');
        return;
    }
    throw new Error('no throw');
});
test('claude limits list: real shape + per-model limits in any scope shape', () => {
    const real = {...CLAUDE, limits: [
        {kind: 'session', group: 'session', percent: 100, severity: 'critical', resets_at: '2026-11-17T18:09:59.897513+00:00', scope: null, is_active: true},
        {kind: 'weekly_all', group: 'weekly', percent: 81, severity: 'warning', resets_at: '2026-11-20T16:59:59.897543+00:00', scope: null, is_active: false},
    ]};
    eq(parseClaudeUsage(real).windows.map(w => [w.label, w.kind, w.percent]), [['5-hour', 'session', 100], ['7-day', 'weekly', 81]]);
    const fable = {limits: [
        {kind: 'session', group: 'session', percent: 99, resets_at: '2026-11-17T18:00:00Z'},
        {kind: 'weekly_all', group: 'weekly', percent: 36},
        {kind: 'weekly_model', group: 'weekly', percent: 26, scope: 'Fable'},
        {kind: 'weekly_model', group: 'weekly', percent: 12, scope: {display_name: 'Opus'}},
        {kind: 'weekly_sonnet', group: 'weekly', percent: 5, scope: null},
        {kind: 'weekly_model', group: 'weekly', percent: 'x', scope: 'Bad'},
        null, 'junk', {percent: 50},
    ]};
    eq(parseClaudeUsage(fable).windows.map(w => [w.label, w.kind, w.percent]), [
        ['5-hour', 'session', 99], ['7-day', 'weekly', 36], ['7-day · Fable', 'model', 26],
        ['7-day · Opus', 'model', 12], ['7-day · Sonnet', 'model', 5],
    ]);
    eq(panelPercent(parseClaudeUsage(fable), 'highest', 0), [99]);
    // empty / unusable limits list -> legacy fields still work
    eq(parseClaudeUsage({...CLAUDE, limits: []}).windows.length, 2);
    eq(parseClaudeUsage({...CLAUDE, limits: [{percent: 'x'}]}).windows.length, 2);
});

test('codex usage parses windows', () => {
    const u = parseCodexUsage({plan_type: 'plus', rate_limit: {
        primary_window: {used_percent: 42, limit_window_seconds: 18000, reset_at: 1800000000},
        secondary_window: {used_percent: 7, limit_window_seconds: 604800, reset_after_seconds: 60},
    }}, 1000);
    eq(u.windows.map(w => [w.label, w.kind, w.percent, w.resetsAt]),
        [['5-hour', 'session', 42, 1800000000000], ['7-day', 'weekly', 7, 61000]]);
    eq(u.plan, 'plus');
});

// ---- bar math: 100% must be exactly full (original bug)
test('bar full at 100% for any track width', () => {
    for (const w of [40, 50, 57, 200, 333])
        eq(barWidth(100, w), w, `w=${w}`);
    eq(barWidth(150, 50), 50);
    eq(barWidth(-5, 50), 0);
    eq(barWidth(NaN, 50), 0);
    eq(barWidth(50, 51), 25);
    eq(barWidth(98.8, 40), 39, 'not full below 100%');
    eq(barWidth(99.99, 300), 299);
});

test('effective percent drops to 0 after reset time passes', () => {
    eq(effectivePercent({percent: 100, resetsAt: 5000}, 4999), 100);
    eq(effectivePercent({percent: 100, resetsAt: 5000}, 5000), 0);
    eq(effectivePercent({percent: 40, resetsAt: null}, 9e15), 40);
});

test('panel metric selection', () => {
    const u = parseClaudeUsage(CLAUDE);
    const now = Date.parse('2026-11-17T15:00:00Z');
    eq(panelPercent(u, 'session', now), [100]);
    eq(panelPercent(u, 'weekly', now), [81]);
    eq(panelPercent(u, 'both', now), [100, 81]);
    eq(panelPercent(u, 'highest', now), [100]);
    eq(panelPercent(u, 'session', Date.parse('2026-11-18T00:00:00Z')), [0]);
});

test('resets_at jitter is the same window; a new window is not', () => {
    eq(sameWindow(1794939000029, 1794938999664), true);
    eq(sameWindow(1794939000000, 1794939000000 + 5 * 3600e3), false);
    eq(sameWindow(null, null), true);
    eq(sameWindow(undefined, null), true);
    eq(sameWindow(null, 5), false);
    eq(sameWindow(5, null), false);
});

test('resets_at 0 / negative / NaN = unknown, not epoch', () => {
    const u = parseClaudeUsage({five_hour: {utilization: 50, resets_at: 0}, seven_day: {utilization: 1, resets_at: -5}});
    eq(u.windows.map(w => w.resetsAt), [null, null]);
    eq(effectivePercent(u.windows[0], Date.now()), 50);
});

test('isDue: interval, backoff, auth, inflight', () => {
    const now = 1e9;
    const base = {inflight: false, retryAt: 0, error: null, fetchedAt: now - 1000};
    eq(isDue(base, 300e3, now), false, 'fresh');
    eq(isDue({...base, fetchedAt: now - 300e3}, 300e3, now), true, 'stale');
    eq(isDue({...base, fetchedAt: 0}, 300e3, now), true, 'never fetched');
    eq(isDue({...base, error: {kind: 'network'}}, 300e3, now), true, 'error');
    eq(isDue({...base, error: {kind: 'network'}, retryAt: now + 1}, 300e3, now), false, 'backoff');
    eq(isDue({...base, error: {kind: 'auth'}, fetchedAt: 0}, 300e3, now), false, 'auth waits for file');
    eq(isDue({...base, inflight: true, fetchedAt: 0}, 300e3, now), false, 'inflight');
});

test('sanitizeUsage drops junk cache entries', () => {
    eq(sanitizeUsage(null), null);
    eq(sanitizeUsage({windows: 'x'}), null);
    eq(sanitizeUsage({windows: [null, {label: 'a', kind: 'session', percent: 'abc', resetsAt: null}]}), null);
    eq(sanitizeUsage({windows: [null, {label: 'a', kind: 'session', percent: 5, resetsAt: null, extra: 1}, {label: 'b', kind: 'weekly', percent: 1, resetsAt: 'x'}]}),
        {windows: [{label: 'a', kind: 'session', percent: 5, resetsAt: null}]});
});

// ---- credentials
const b64u = o => GLib.base64_encode(new TextEncoder().encode(JSON.stringify(o))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
test('creds: claude + codex + garbage', () => {
    eq(parseCreds('claude', '{"claudeAiOauth":{"accessToken":"t","expiresAt":5,"subscriptionType":"pro"}}'),
        {token: 't', expiresAt: 5, plan: 'pro', email: null, accountId: null});
    eq(parseCreds('claude', '{"mcpOAuth":{}}'), null);
    eq(parseCreds('claude', 'not json'), null);
    eq(parseCreds('claude', 'null'), null);
    const at = `h.${b64u({exp: 100})}.s`;
    const id = `h.${b64u({'email': 'a@b.c', 'https://api.openai.com/auth': {chatgpt_plan_type: 'pro', chatgpt_account_id: 'acc'}})}.s`;
    eq(parseCreds('codex', JSON.stringify({tokens: {access_token: at, id_token: id}})),
        {token: at, expiresAt: 100000, plan: 'pro', email: 'a@b.c', accountId: 'acc'});
    eq(jwtClaims('garbage'), null);
});

test('http status -> error kind', () => {
    eq(errorFromStatus(429, '0').kind, 'ratelimit');
    eq(errorFromStatus(429, '120').retryAfter, 120);
    eq(errorFromStatus(401).kind, 'auth');
    eq(errorFromStatus(401).retriable, false);
    eq(errorFromStatus(503).retriable, true);
});

test('backoff grows, capped by interval, honours retry-after', () => {
    eq([1, 2, 3, 4, 5].map(n => backoffSeconds(n, 300)), [30, 60, 120, 240, 300]);
    eq(backoffSeconds(1, 300, 900), 900);
});

test('proxy validation', () => {
    eq(validProxy('http://localhost:11809'), true);
    eq(validProxy('socks5://127.0.0.1:1080'), true);
    eq(validProxy('localhost:11809'), false);
    eq(validProxy('ftp://x'), false);
    eq(validProxy(''), false);
});

// ---- detection on a fake home
test('detects odd folder names, skips non-logins, dedupes symlinks', async () => {
    const home = GLib.dir_make_tmp('aqm-XXXXXX');
    const mk = (d, f, body) => {
        GLib.mkdir_with_parents(`${home}/${d}`, 0o700);
        if (f)
            GLib.file_set_contents(`${home}/${d}/${f}`, body);
    };
    const claude = '{"claudeAiOauth":{"accessToken":"x"}}';
    mk('.claude', '.credentials.json', claude);
    mk('.claude-personal', '.credentials.json', claude);
    mk('work-ai', '.credentials.json', claude);
    mk('.claude-empty', '.credentials.json', '{"mcpOAuth":{}}');
    mk('.codex', 'auth.json', '{"tokens":{"access_token":"y"}}');
    mk('random', null);
    GLib.spawn_command_line_sync(`ln -s ${home}/.claude ${home}/.claude-link`);
    mk('manual-empty', null);
    mk('both', '.credentials.json', claude);
    GLib.file_set_contents(`${home}/both/auth.json`, '{"tokens":{"access_token":"z"}}');
    mk('fifo', null);
    GLib.spawn_command_line_sync(`mkfifo ${home}/fifo/.credentials.json`);

    const found = await detectAccounts({home, env: () => null, manual: [`${home}/manual-empty`, '', 'relative/x', 42]});
    eq(found.map(a => [a.provider, a.dir.slice(home.length + 1), a.valid, a.manual]), [
        ['claude', '.claude', true, false],
        ['claude', '.claude-personal', true, false],
        ['claude', 'both', true, false],
        ['claude', 'manual-empty', false, true],
        ['claude', 'work-ai', true, false],
        ['codex', '.codex', true, false],
        ['codex', 'both', true, false],
    ]);
    eq(found.map(a => defaultLabel(a)), ['default', 'personal', 'both', 'manual-empty', 'work-ai', 'default', 'both']);
    eq((await detectAccounts({home, env: () => null, auto: false})).length, 0);
    GLib.spawn_command_line_sync(`rm -rf ${home}`);
});

// ---- refresher: race / coalescing / destroy
function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
    });
    return {promise, resolve, reject};
}
const tick = () => new Promise(r => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));
const acc = {key: 'claude:/x'};
const U = p => ({windows: [{label: '5-hour', kind: 'session', percent: p, resetsAt: null}]});

test('coalesces triggers: one in flight, one follow-up, newest wins', async () => {
    const calls = [];
    const updates = [];
    const r = new Refresher({
        load: () => {
            const d = deferred();
            calls.push(d);
            return d.promise;
        },
        onUpdate: (_a, st) => updates.push(st.usage?.windows[0].percent),
        getInterval: () => 300,
    });
    r.refresh(acc);
    r.refresh(acc);
    r.refresh(acc);
    eq(calls.length, 1, 'in flight');
    calls[0].resolve(U(10));
    await tick();
    eq(calls.length, 2, 'one follow-up');
    calls[1].resolve(U(20));
    await tick();
    eq(updates, [10, 20]);
    eq(r.state(acc.key).inflight, false);
    r.destroy();
});

test('error keeps last good data and schedules one retry', async () => {
    let n = 0;
    const r = new Refresher({
        load: () => (n++ === 0 ? Promise.resolve(U(55)) : Promise.reject(new QuotaError('ratelimit', 'x'))),
        onUpdate: () => {},
        getInterval: () => 300,
    });
    r.refresh(acc);
    await tick();
    r.refresh(acc);
    await tick();
    const st = r.state(acc.key);
    eq(st.usage.windows[0].percent, 55, 'kept');
    eq(st.error.kind, 'ratelimit');
    eq(st.failCount, 1);
    eq(st.retryId > 0, true, 'retry scheduled');
    r.destroy();
    eq(st.retryId, 0, 'retry cleared on destroy');
});

test('non-retriable error (expired) schedules no retry', async () => {
    const r = new Refresher({load: () => Promise.reject(new QuotaError('expired', 'x')), onUpdate: () => {}, getInterval: () => 300});
    r.refresh(acc);
    await tick();
    eq(r.state(acc.key).retryId, 0);
    r.destroy();
});

test('result after destroy is dropped', async () => {
    const d = deferred();
    let updated = false;
    const r = new Refresher({load: () => d.promise, onUpdate: () => (updated = true), getInterval: () => 300});
    r.refresh(acc);
    r.destroy();
    d.resolve(U(99));
    await tick();
    eq(updated, false);
});

test('restart orphans old in-flight response (proxy change)', async () => {
    const calls = [];
    const updates = [];
    const r = new Refresher({
        load: () => {
            const d = deferred();
            calls.push(d);
            return d.promise;
        },
        onUpdate: (_a, st) => updates.push(st.usage.windows[0].percent),
        getInterval: () => 300,
    });
    r.refresh(acc);
    r.restart(acc);
    eq(calls.length, 2);
    calls[1].resolve(U(2)); // new answers first
    await tick();
    calls[0].resolve(U(1)); // stale answer arrives late
    await tick();
    eq(updates, [2]);
    eq(r.state(acc.key).usage.windows[0].percent, 2);
    r.destroy();
});

test('stop() cancels in-flight + retry, keeps data', async () => {
    const d = deferred();
    let n = 0;
    let updated = 0;
    const r = new Refresher({
        load: () => (n++ === 0 ? Promise.reject(new QuotaError('network', 'x')) : d.promise),
        onUpdate: () => updated++,
        getInterval: () => 300,
    });
    r.seed(acc.key, U(33), 1);
    r.refresh(acc);
    await tick();
    eq(r.state(acc.key).retryId > 0, true);
    r.refresh(acc);
    r.stop(acc.key);
    d.resolve(U(1));
    await tick();
    const st = r.state(acc.key);
    eq([st.retryId, st.inflight, st.usage.windows[0].percent, updated], [0, false, 33, 1]);
    r.destroy();
});

test('throwing onUpdate does not wedge the account', async () => {
    let calls = 0;
    const r = new Refresher({
        load: () => Promise.resolve(U(++calls)),
        onUpdate: () => {
            throw new Error('boom');
        },
        getInterval: () => 300,
    });
    r.refresh(acc);
    await tick();
    r.refresh(acc);
    await tick();
    eq([calls, r.state(acc.key).inflight], [2, false]);
    r.destroy();
});

test('cache seed never overrides live data', async () => {
    const r = new Refresher({load: () => Promise.resolve(U(70)), onUpdate: () => {}, getInterval: () => 300});
    r.seed(acc.key, U(10), 1);
    eq(r.state(acc.key).usage.windows[0].percent, 10);
    r.refresh(acc);
    await tick();
    r.seed(acc.key, U(10), 1);
    eq(r.state(acc.key).usage.windows[0].percent, 70);
    r.destroy();
});

const loop = new GLib.MainLoop(null, false);
(async () => {
    for (const [name, fn] of tests) {
        try {
            await fn();
            print(`ok   ${name}`);
        } catch (e) {
            failed++;
            print(`FAIL ${name}: ${e.message}`);
        }
    }
    print(`\n${tests.length - failed}/${tests.length} passed`);
    loop.quit();
})();
loop.run();
System.exit(failed ? 1 : 0);
