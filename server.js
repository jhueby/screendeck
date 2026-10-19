#!/usr/bin/env node
/**
 * Screendeck — a web console for GNU screen sessions.
 *
 * screen is the session backend on purpose: sessions survive the browser
 * closing, this server restarting, and the network dropping. The web UI is a
 * view onto them, never the thing keeping them alive — you can always fall
 * back to `screen -r <name>` from a shell.
 *
 * Configuration (all optional, via environment):
 *   PORT             listen port                     (default 7681)
 *   BIND             listen address                  (default 0.0.0.0)
 *   DEFAULT_COMMAND  what a new session runs          (default: $SHELL or bash)
 *   SESSION_PREFIX   prefix for created sessions      (default sd-)
 *   DEFAULT_DIR      starting directory for new work  (default $HOME)
 *   WORKSPACE_ROOT   restrict the directory browser to this subtree (optional)
 *   CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD
 *                    Cloudflare Access app guarding the public hostname; see below
 *
 * SECURITY: this ships with no authentication. Anyone who can reach the port
 * gets an interactive shell as the user running this process. Bind it to a
 * trusted interface, or put an authenticating reverse proxy in front.
 */
'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 7681;
const BIND = process.env.BIND || '0.0.0.0';
const SESSION_PREFIX = process.env.SESSION_PREFIX || 'sd-';
const DEFAULT_DIR = process.env.DEFAULT_DIR || os.homedir();
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || null;
const DEFAULT_COMMAND = process.env.DEFAULT_COMMAND || process.env.SHELL || 'bash';

// Rate-limit tracking: `claude -p` emits a rate_limit_event on its stream-json
// output with Anthropic's own computed utilization for the account's 5-hour
// and 7-day windows — no separate API/token needed, since it rides on the
// same auth the interactive sessions already use. Checking costs a sliver of
// real usage, so it is polled infrequently and cached rather than live.
const RATE_LIMIT_POLL_MINUTES = Number(process.env.RATE_LIMIT_POLL_MINUTES) || 15;
const RATE_LIMIT_MODEL = process.env.RATE_LIMIT_MODEL || 'claude-haiku-4-5-20251001';
const RATE_LIMIT_STATE_FILE = process.env.RATE_LIMIT_STATE_FILE
  || path.join(os.homedir(), '.screendeck-ratelimit.json');

// If this server is itself running inside screen, that session must not be
// killable from the UI — doing so takes the server down with it. screen exports
// STY as "<pid>.<name>" for exactly this kind of self-identification.
const OWN_SESSION = process.env.STY || null;

// Screen has no notion of session order, so a user-defined one has to be stored.
// Kept server-side rather than in localStorage so the order is the same from a
// phone as from a laptop. It is ephemeral data about ephemeral things — losing
// it costs nothing but the arrangement.
const STATE_FILE = process.env.STATE_FILE || path.join(os.homedir(), '.screendeck-order.json');

function loadOrder() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).order || []; }
  catch (_) { return []; }
}
function saveOrder(order) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ order }, null, 2));
    return true;
  } catch (e) {
    console.error('could not persist session order:', e.message);
    return false;
  }
}

// Fork parentage: maps a forked session's custom name -> its parent's custom name,
// so the UI can group forks under (and indented below) the session they branched
// from. Keyed by custom name (stable across the pid prefix), like the launch store.
const FORKS_FILE = process.env.FORKS_STATE_FILE || path.join(os.homedir(), '.screendeck-forks.json');
function loadForks() {
  try { return JSON.parse(fs.readFileSync(FORKS_FILE, 'utf8')) || {}; } catch (_) { return {}; }
}
function saveForks(f) {
  try { fs.writeFileSync(FORKS_FILE, JSON.stringify(f, null, 2)); }
  catch (e) { console.error('could not persist forks:', e.message); }
}

// What to relaunch a session with, keyed by its unprefixed (custom) name —
// screen sessions do not survive a real reboot, so this is what boot recovery
// replays. Kept separate from STATE_FILE: order is cosmetic, this is not.
const LAUNCH_FILE = process.env.LAUNCH_STATE_FILE || path.join(os.homedir(), '.screendeck-launch.json');

function loadLaunches() {
  try { return JSON.parse(fs.readFileSync(LAUNCH_FILE, 'utf8')); }
  catch (_) { return {}; }
}
function saveLaunches(map) {
  try { fs.writeFileSync(LAUNCH_FILE, JSON.stringify(map, null, 2)); }
  catch (e) { console.error('could not persist session launches:', e.message); }
}
// screen session names are "<pid>.<custom>" — the registry only cares about
// the custom part, since the pid is different every time a session is (re)born.
function customPart(fullName) {
  const i = fullName.indexOf('.');
  return i === -1 ? fullName : fullName.slice(i + 1);
}

let rateLimitState = (() => {
  try { return JSON.parse(fs.readFileSync(RATE_LIMIT_STATE_FILE, 'utf8')); }
  catch (_) { return null; }
})();

async function refreshRateLimit() {
  const { err, stdout } = await sh(
    'claude',
    ['-p', 'hi', '--model', RATE_LIMIT_MODEL, '--output-format', 'stream-json', '--verbose'],
    { timeout: 30000, maxBuffer: 10 * 1024 * 1024, cwd: os.tmpdir() }
  );
  if (err) { console.error('rate-limit check failed:', err.message); return null; }
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch (_) { continue; }
    const w = d.type === 'rate_limit_event' && d.rate_limit_info && d.rate_limit_info.unifiedWindows;
    if (!w) continue;
    rateLimitState = { five_hour: w.five_hour, seven_day: w.seven_day, checkedAt: Date.now() };
    try { fs.writeFileSync(RATE_LIMIT_STATE_FILE, JSON.stringify(rateLimitState, null, 2)); } catch (_) {}
    return rateLimitState;
  }
  return null;
}

// Cloudflare Access gate. Requests that arrive through Cloudflare carry a
// Cf-Ray header the edge sets and a client cannot strip, and Access adds a
// signed Cf-Access-Jwt-Assertion once the user has logged in. Verifying that
// token here means a missing or mis-scoped Access policy in the dashboard
// fails closed instead of handing out a shell. Direct LAN requests (no Cf-Ray)
// are untouched. Unset CF_ACCESS_AUD rejects all Cloudflare traffic.
const CF_TEAM = (process.env.CF_ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const CF_AUD = process.env.CF_ACCESS_AUD || '';
let cfKeys = new Map();
let cfKeysAt = 0;

async function cfKey(kid) {
  if (!cfKeys.has(kid) && Date.now() - cfKeysAt > 60000) {
    cfKeysAt = Date.now();
    const r = await fetch(`https://${CF_TEAM}/cdn-cgi/access/certs`);
    if (!r.ok) throw new Error(`access certs: HTTP ${r.status}`);
    const { keys } = await r.json();
    cfKeys = new Map(keys.map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })]));
  }
  return cfKeys.get(kid);
}

async function cfAccessOk(req) {
  if (!req.headers['cf-ray']) return true;
  const token = req.headers['cf-access-jwt-assertion'];
  const deny = (why) => { console.error(`access denied ${req.method} ${req.url}: ${why}`); return false; };
  if (!CF_TEAM || !CF_AUD) return deny('CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD not set');
  if (typeof token !== 'string') return deny('no Cf-Access-Jwt-Assertion');
  try {
    const [h, p, sig] = token.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url'));
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    if (header.alg !== 'RS256') return deny(`alg ${header.alg}`);
    const key = await cfKey(header.kid);
    if (!key) return deny(`unknown kid ${header.kid}`);
    if (!crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(sig, 'base64url'))) return deny('bad signature');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== `https://${CF_TEAM}`) return deny(`issuer ${claims.iss}`);
    if (!aud.includes(CF_AUD)) return deny(`aud ${aud.join(',')}`);
    if (claims.exp * 1000 <= Date.now()) return deny('expired');
    return true;
  } catch (e) {
    return deny(e.message);
  }
}

const app = express();
app.use((req, res, next) => {
  cfAccessOk(req).then((ok) => (ok ? next() : res.status(403).send('Forbidden')));
});
app.use(express.json({ limit: '64kb' }));
// Never cache the app shell (browser or CDN). Stale JS/HTML is how a deploy
// silently "doesn't show up" for a remote user behind Cloudflare.
app.use((req, res, next) => {
  if (req.path === '/' || /\.(html|js|css)$/.test(req.path)) {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/rate-limit', (_req, res) => res.json({ state: rateLimitState }));

app.post('/api/rate-limit/refresh', async (_req, res) => {
  // Self-throttled: a refresh spends a little real usage to report on usage,
  // so a click-happy UI can't turn the meter into its own consumption source.
  if (rateLimitState && Date.now() - rateLimitState.checkedAt < 60000) {
    return res.json({ state: rateLimitState, skipped: true });
  }
  const state = await refreshRateLimit();
  res.json({ state: state || rateLimitState, error: state ? undefined : 'check failed' });
});

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10000, ...opts }, (err, stdout, stderr) =>
      resolve({ err, stdout: stdout || '', stderr: stderr || '' })
    );
  });
}

/** Keep the directory browser inside WORKSPACE_ROOT when one is configured. */
function withinWorkspace(p) {
  if (!WORKSPACE_ROOT) return true;
  const resolved = path.resolve(p);
  const root = path.resolve(WORKSPACE_ROOT);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** A session's working directory, taken from its child process. */
async function sessionCwd(pid) {
  // screen's own cwd is wherever it was started; the interesting one belongs to
  // the child, so look there first and fall back to screen itself.
  const { stdout } = await sh('pgrep', ['-P', String(pid)]);
  const kids = stdout.split('\n').filter(Boolean);
  for (const kid of [...kids, String(pid)]) {
    try { return fs.readlinkSync(`/proc/${kid}/cwd`); } catch (_) { /* exited */ }
  }
  return null;
}

// Remembers the last capture per session so we can tell "changed since last
// poll" (i.e. actively producing output) from "idle".
const lastCapture = new Map();

/**
 * Capture a session's visible screen without attaching to it.
 * `screen -X hardcopy` dumps the current window to a file — this is what makes
 * an at-a-glance overview possible for sessions running full-screen TUIs.
 */
async function sessionPreview(name) {
  const tmp = path.join(os.tmpdir(), `sd-cap-${process.pid}-${Buffer.from(name).toString('hex').slice(0, 16)}`);
  try {
    await sh('screen', ['-S', name, '-X', 'hardcopy', tmp]);
    // hardcopy is asynchronous inside screen; give it a moment to land.
    await new Promise((r) => setTimeout(r, 60));
    if (!fs.existsSync(tmp)) return { preview: null, active: false };
    const text = fs.readFileSync(tmp, 'utf8');
    fs.unlink(tmp, () => {});
    const lines = text
      .split('\n')
      // Terminal captures carry control sequences and, for sessions not started
      // in UTF-8 mode, invalid byte sequences. Strip both so the preview is
      // readable rather than a wall of replacement characters.
      .map((l) => l
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
        .replace(/\uFFFD+/g, '')
        .replace(/\s+$/, ''))
      .filter((l) => l.trim());
    const tail = lines.slice(-3);
    const sig = tail.join('\n');
    const prev = lastCapture.get(name);
    lastCapture.set(name, sig);
    return { preview: tail, active: prev !== undefined && prev !== sig };
  } catch (_) {
    return { preview: null, active: false };
  }
}

function readArgv(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); }
  catch (_) { return []; }
}
// Only quote a token when it actually needs it, so the common case (a bare
// command like "claude" or "--continue") stays readable instead of turning
// into '"'"'claude'"'"'-looking noise.
function shellQuote(s) {
  return /^[A-Za-z0-9_.,:/=@%+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * What is actually running inside the session — useful at a glance, and (via
 * `exec`) what boot recovery replays for a session it did not create itself.
 * `display` is a plain argv join for humans; `exec` is shell-quoted so a
 * backfilled command with e.g. a quoted filename round-trips through
 * `bash -lc` instead of having its argument boundaries silently merged.
 */
async function sessionCommand(pid) {
  const { stdout } = await sh('pgrep', ['-P', String(pid)]);
  for (const kid of stdout.split('\n').filter(Boolean)) {
    let target = kid;
    // Every screendeck session is launched as `bash -lc <command>`, so the
    // program anyone actually cares about is one level deeper than this —
    // unwrap exactly that one shell layer, not arbitrarily deep, so a
    // transient subprocess the program itself spawns isn't mistaken for it.
    // The cmdline's first token may be a bare name, a full path, or a
    // login shell's "-bash" — compare basenames, not the raw string.
    const kidArgv = readArgv(kid);
    const firstBase = (kidArgv[0] || '').replace(/^-/, '').split('/').pop();
    if (['bash', 'sh', 'dash', 'zsh'].includes(firstBase)) {
      const { stdout: gout } = await sh('pgrep', ['-P', kid]);
      const grandkids = gout.split('\n').filter(Boolean);
      if (grandkids.length === 1) target = grandkids[0];
    }
    const argv = readArgv(target);
    if (argv.length) {
      return { display: argv.join(' ').slice(0, 120), exec: argv.map(shellQuote).join(' ') };
    }
  }
  return null;
}

async function listSessions(withPreview = false) {
  const { stdout } = await sh('screen', ['-ls']);
  const host = os.hostname();
  const forks = loadForks();
  const out = [];
  for (const line of stdout.split('\n')) {
    // "\t203304.pts-1.myhost\t(01/02/2026 11:43:42 PM)\t(Detached)"
    // Match any trailing state. screen reports "Dead ???" for sessions whose
    // process is gone but whose socket remains — e.g. after a container restart.
    // Matching only Attached|Detached silently hid those and showed an empty list.
    const m = line.match(/^\s*(\d+)\.(\S+)\s+\(([^)]+)\)\s+\(([^)]+)\)\s*$/);
    if (!m) continue;
    const [, pid, tail, created, state] = m;
    // Names are "<pid>.<custom>" (screen -S custom) or "<pid>.<tty>.<host>"
    // when auto-named. Showing the host is useless — every session on a box has
    // the same one — so prefer the custom name, else the tty.
    const parts = tail.split('.');
    const label = parts.length >= 2 && parts[parts.length - 1] === host
      ? parts.slice(0, -1).join('.')
      : tail;
    const fullName = `${pid}.${tail}`;
    const cmdInfo = await sessionCommand(pid);
    out.push({
      name: fullName,
      pid: Number(pid),
      label,
      parent: forks[label] || null,   // custom name of the session this was forked from
      created,
      attached: /Attached/i.test(state),
      dead: /Dead/i.test(state),
      state: state.trim(),
      cwd: await sessionCwd(pid),
      command: cmdInfo ? cmdInfo.display : null,
      // shell-quoted form, used only when boot recovery backfills a launch
      // entry for a session it didn't create — not for display.
      commandExec: cmdInfo ? cmdInfo.exec : null,
      // the session hosting this server — the UI must not offer to kill it
      self: OWN_SESSION === fullName,
      ...(withPreview && !/Dead/i.test(state) ? await sessionPreview(fullName) : {}),
    });
  }
  out.reverse(); // newest first, before any user ordering is applied

  const order = loadOrder();
  if (!order.length) return out;
  const rank = new Map(order.map((n, i) => [n, i]));
  return out.sort((a, b) => {
    const ra = rank.has(a.name) ? rank.get(a.name) : -1;
    const rb = rank.has(b.name) ? rank.get(b.name) : -1;
    // Unranked sessions are new — keep them at the top where they get noticed.
    if (ra === -1 && rb === -1) return 0;
    if (ra === -1) return -1;
    if (rb === -1) return 1;
    return ra - rb;
  });
}

/**
 * Boot recovery. `screen` sessions do not survive a real reboot — their
 * sockets live under /run/screen, which is tmpfs — so there is nothing to
 * reattach to, only a record of what used to be running. This reconciles the
 * launch registry against what is actually alive: first backfilling entries
 * for live sessions the registry doesn't know about yet (so sessions created
 * before this feature, or by hand, are covered too), then recreating whatever
 * the registry expects but that isn't currently running. A claude session is
 * relaunched with --continue rather than replaying its original invocation —
 * the point is picking the conversation back up, not starting over.
 */
// A missing registry entry is ambiguous on its own: it could mean "the host
// just rebooted" (restore it) or "this one-off command finished and its
// session exited on its own" (leave it alone — re-running a finished job on
// every unrelated `systemctl restart screendeck` would be its own bug).
// Only the machine's own uptime tells them apart, so restoration is gated to
// shortly after boot rather than running unconditionally on every start.
const BOOT_RESTORE_WINDOW_SECONDS = Number(process.env.BOOT_RESTORE_WINDOW_SECONDS) || 300;

async function reconcileLaunches() {
  const launches = loadLaunches();
  const live = await listSessions(false);
  const liveNames = new Set(live.map((s) => s.label));

  let changed = false;
  for (const s of live) {
    if (!launches[s.label] && s.cwd) {
      launches[s.label] = { cwd: s.cwd, command: s.commandExec || s.command || DEFAULT_COMMAND };
      changed = true;
    }
  }
  if (changed) saveLaunches(launches);

  const missing = Object.entries(launches).filter(([name]) => !liveNames.has(name));
  if (!missing.length) return;

  if (os.uptime() > BOOT_RESTORE_WINDOW_SECONDS) {
    console.log(`${missing.length} registered session(s) aren't running, but this host booted `
      + `${Math.round(os.uptime() / 60)}m ago — leaving them alone rather than assuming a reboot happened.`);
    return;
  }

  console.log(`host booted ${Math.round(os.uptime())}s ago — restoring ${missing.length} session(s)...`);
  for (const [name, info] of missing) {
    if (!info.cwd || !fs.existsSync(info.cwd)) {
      console.log(`  skip ${name}: directory gone (${info.cwd})`);
      continue;
    }
    if (!withinWorkspace(info.cwd)) {
      console.log(`  skip ${name}: ${info.cwd} is outside WORKSPACE_ROOT`);
      continue;
    }
    const isClaude = /^claude(\s|$)/.test(info.command || '');
    const toRun = isClaude ? 'claude --continue' : info.command;
    const { err, stderr } = await sh(
      'screen',
      ['-dmS', name, '-c', path.join(__dirname, 'screenrc'), 'bash', '-lc', toRun],
      { cwd: info.cwd }
    );
    console.log(err ? `  failed to restore ${name}: ${stderr || err.message}` : `  restored ${name} (${toRun})`);
  }
}

app.get('/api/sessions', async (req, res) => {
  try {
    const withPreview = req.query.preview === '1';
    res.json({ sessions: await listSessions(withPreview), host: os.hostname() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/order', (_req, res) => res.json({ order: loadOrder() }));

app.put('/api/order', (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
  const clean = order.filter((n) => typeof n === 'string').slice(0, 500);
  if (!saveOrder(clean)) return res.status(500).json({ error: 'could not persist order' });
  res.json({ ok: true, count: clean.length });
});

app.get('/api/config', (_req, res) => {
  res.json({ defaultCommand: DEFAULT_COMMAND, defaultDir: DEFAULT_DIR, host: os.hostname() });
});

app.get('/api/dirs', (req, res) => {
  const base = req.query.path || DEFAULT_DIR;
  if (!withinWorkspace(base)) return res.status(403).json({ error: 'outside workspace root' });
  try {
    const dirs = fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => path.join(base, d.name))
      .sort()
      .slice(0, 300);
    const parent = withinWorkspace(path.dirname(base)) ? path.dirname(base) : base;
    res.json({ path: base, parent, dirs });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

app.post('/api/dirs', (req, res) => {
  const { path: parent, name } = req.body || {};
  const base = parent || DEFAULT_DIR;
  if (!withinWorkspace(base)) return res.status(403).json({ error: 'outside workspace root' });
  const safe = String(name || '').trim();
  if (!safe || safe.includes('/') || safe.includes('\\') || safe === '.' || safe === '..' || safe.startsWith('.')) {
    return res.status(400).json({ error: 'invalid folder name' });
  }
  const dir = path.join(base, safe);
  if (!withinWorkspace(dir)) return res.status(403).json({ error: 'outside workspace root' });
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    return res.status(400).json({ error: e.code === 'EEXIST' ? 'already exists' : e.message });
  }
  res.json({ ok: true, path: dir });
});

app.post('/api/sessions', async (req, res) => {
  const { dir, command, name, resume, engine, model, host, resumeId, fork } = req.body || {};
  const cwd = dir || DEFAULT_DIR;
  if (!fs.existsSync(cwd)) return res.status(400).json({ error: `no such directory: ${cwd}` });
  if (!withinWorkspace(cwd)) return res.status(403).json({ error: 'outside workspace root' });

  const safe = (name || 'session').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'session';
  const sessionName = `${SESSION_PREFIX}${safe}-${Date.now().toString(36)}`;
  // Command building by engine. An explicit command override always wins; then
  // Ollama (local-model chat REPL); then resume/fork a specific Claude
  // conversation by id; then --continue (most recent); else the default.
  let toRun;
  if (command && command.trim()) {
    toRun = command.trim();
  } else if (engine === 'ollama') {
    const m = String(model || '').trim();
    if (!/^[A-Za-z0-9._:/-]+$/.test(m)) return res.status(400).json({ error: 'pick an Ollama model' });
    const oh = OLLAMA_HOSTS.includes(host) ? host : OLLAMA_HOSTS[0];
    if (req.body.mode === 'agent') {
      const ab = aiderBin();
      if (!ab) return res.status(400).json({ error: 'aider is not installed on this host' });
      // aider reaches Ollama through litellm (ollama_chat/<model>). OLLAMA_API_BASE
      // selects the host; OLLAMA_CONTEXT_LENGTH lifts Ollama's tiny default context
      // so the repo map + edits fit. User drives/approves edits in the terminal.
      toRun = `OLLAMA_API_BASE=${shellQuote(oh)} OLLAMA_CONTEXT_LENGTH=8192 ${shellQuote(ab)} --model ${shellQuote('ollama_chat/' + m)}`;
    } else {
      toRun = `OLLAMA_HOST=${shellQuote(oh)} python3 ${shellQuote(path.join(__dirname, 'ollama-chat.py'))} ${shellQuote(m)}`;
    }
  } else if (resumeId) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(resumeId))) return res.status(400).json({ error: 'invalid conversation id' });
    toRun = `claude --resume ${shellQuote(String(resumeId))}${fork ? ' --fork-session' : ''}`;
  } else if (resume) {
    toRun = 'claude --continue';
  } else {
    toRun = DEFAULT_COMMAND;
  }

  // Run through a login shell so PATH, aliases and profile behave as expected.
  const { err, stderr } = await sh(
    'screen',
    ['-dmS', sessionName, '-c', path.join(__dirname, 'screenrc'), 'bash', '-lc', toRun],
    { cwd }
  );
  if (err) return res.status(500).json({ error: stderr || String(err) });
  const launches = loadLaunches();
  launches[sessionName] = { cwd, command: toRun };
  saveLaunches(launches);
  res.json({ ok: true, session: sessionName, cwd, command: toRun });
});

app.patch('/api/sessions/:name', async (req, res) => {
  const { newName } = req.body || {};
  // screen session names go into a socket filename, so keep them conservative.
  const clean = String(newName || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60);
  if (!clean) return res.status(400).json({ error: 'invalid name' });
  const { err, stderr } = await sh('screen', ['-S', req.params.name, '-X', 'sessionname', clean]);
  if (err) return res.status(500).json({ error: stderr || String(err) });
  // The pid prefix is preserved, so the new full name is predictable.
  const pid = req.params.name.split('.')[0];
  const newFull = `${pid}.${clean}`;
  // The stored order is keyed by full name, which the rename just changed.
  const order = loadOrder();
  const idx = order.indexOf(req.params.name);
  if (idx !== -1) { order[idx] = newFull; saveOrder(order); }
  const launches = loadLaunches();
  const oldKey = customPart(req.params.name);
  if (launches[oldKey]) {
    // Two different sessions can only collide here if one was never created
    // through this app (registry keys drop the pid, and screendeck's own
    // names carry a timestamp suffix) — surface it rather than losing the
    // other entry's relaunch info silently.
    if (launches[clean] && launches[clean] !== launches[oldKey]) {
      console.warn(`rename: launch entry for "${clean}" already existed and is being replaced by "${oldKey}"'s`);
    }
    launches[clean] = launches[oldKey];
    delete launches[oldKey];
    saveLaunches(launches);
  }
  // Keep fork parentage across the rename: move this session's own record (if it's
  // a fork) and re-point any children that referenced its old name as their parent.
  const forks = loadForks();
  let forksChanged = false;
  if (forks[oldKey]) { forks[clean] = forks[oldKey]; delete forks[oldKey]; forksChanged = true; }
  for (const [child, parent] of Object.entries(forks)) {
    if (parent === oldKey) { forks[child] = clean; forksChanged = true; }
  }
  if (forksChanged) saveForks(forks);
  res.json({ ok: true, name: newFull });
});

app.delete('/api/sessions/:name', async (req, res) => {
  // Defence in depth: a crafted request must not be able to kill the session
  // this server runs in, even though the UI hides the button.
  if (OWN_SESSION && req.params.name === OWN_SESSION) {
    return res.status(409).json({
      error: 'refusing to kill the session hosting this server',
    });
  }
  const { err, stderr } = await sh('screen', ['-S', req.params.name, '-X', 'quit']);
  if (err) return res.status(500).json({ error: stderr || String(err) });
  const launches = loadLaunches();
  const key = customPart(req.params.name);
  if (launches[key]) { delete launches[key]; saveLaunches(launches); }
  const forks = loadForks();
  if (forks[key]) { delete forks[key]; saveForks(forks); }   // drop parentage record
  res.json({ ok: true });
});

// Fork a running session's conversation into a new one. A live session is the
// newest transcript in its own cwd, so forking the newest there branches the
// right conversation (original keeps running, untouched).
function newestConversationId(cwd) {
  const pdir = projectDirFor(cwd);
  let files;
  try { files = fs.readdirSync(pdir).filter((f) => f.endsWith('.jsonl')); } catch (_) { return null; }
  let best = null, bestM = 0;
  for (const f of files) {
    try { const m = fs.statSync(path.join(pdir, f)).mtimeMs; if (m > bestM) { bestM = m; best = f; } } catch (_) {}
  }
  return best ? best.replace(/\.jsonl$/, '') : null;
}

app.post('/api/sessions/:name/fork', async (req, res) => {
  const src = req.params.name;
  const pid = parseInt(src.split('.')[0], 10);
  let cwd = pid ? await sessionCwd(pid) : null;
  if (!cwd) { const l = loadLaunches()[customPart(src)]; cwd = l && l.cwd; }
  cwd = cwd || DEFAULT_DIR;
  if (!fs.existsSync(cwd)) return res.status(400).json({ error: `source directory missing: ${cwd}` });
  const id = newestConversationId(cwd);
  if (!id) return res.status(404).json({ error: 'no Claude conversation found for this session to fork' });
  const forkCmd = `claude --resume ${shellQuote(id)} --fork-session`;
  // Keep the parent's name and append "-Forked" (screen names can't hold spaces;
  // the UI displays it as "<parent> Forked"). Ensure it's unique among live names.
  const parentCustom = customPart(src);
  const cleanParent = (parentCustom || 'session').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'session';
  let sessionName = `${cleanParent}-Forked`;
  const liveLabels = new Set((await listSessions(false)).map((s) => s.label));
  if (liveLabels.has(sessionName)) sessionName = `${sessionName}-${Date.now().toString(36).slice(-3)}`;
  const { err, stderr } = await sh(
    'screen',
    ['-dmS', sessionName, '-c', path.join(__dirname, 'screenrc'), 'bash', '-lc', forkCmd],
    { cwd }
  );
  if (err) return res.status(500).json({ error: stderr || String(err) });
  const launches = loadLaunches();
  launches[sessionName] = { cwd, command: forkCmd };
  saveLaunches(launches);
  const forks = loadForks();
  forks[sessionName] = parentCustom;   // remember parentage for grouping/indent
  saveForks(forks);
  res.json({ ok: true, session: sessionName, cwd, forkedFrom: id, parent: parentCustom });
});

// ─────────── Claude Code skills ───────────
// Skills are directories under ~/.claude/skills each holding a SKILL.md. Claude
// Code discovers them by presence, so "disable" = move the dir into .disabled/
// (still one level down, but without a SKILL.md at the scanned depth, so it's
// invisible to Claude Code while remaining trivially reversible).
const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
const SKILLS_DISABLED = path.join(SKILLS_DIR, '.disabled');
const HUB_SYNC = path.join(SKILLS_DIR, 'skills-hub', 'scripts', 'sync.sh');
// .disabled is our own bookkeeping; synced/ is claude.ai's self-syncing bucket,
// nested differently and not ours to toggle — hide both from the manageable set.
const SKILL_RESERVED = new Set(['.disabled', 'synced']);
const SKILL_NAME_RE = /^[A-Za-z0-9._-]+$/;

function safeSkillName(name) {
  const n = String(name || '');
  if (!SKILL_NAME_RE.test(n) || n === '.' || n === '..' || SKILL_RESERVED.has(n)) return null;
  return n;
}

// Pull name + description out of a SKILL.md YAML frontmatter block. Handles both
// a single-line `description:` and a folded/literal (`>` / `|`) block.
function parseSkillMeta(md, fallback) {
  const out = { name: fallback, description: '' };
  const fmMatch = /^---\s*\n([\s\S]*?)\n---/.exec(md);
  if (!fmMatch) return out;
  const fm = fmMatch[1];
  const nameM = /^name:[ \t]*(.+)$/m.exec(fm);
  if (nameM) out.name = nameM[1].trim();
  const descM = /^description:[ \t]*(>[-+]?|\|[-+]?)?[ \t]*(.*)$/m.exec(fm);
  if (descM) {
    if (descM[1]) {
      // folded/literal block: gather the following more-indented lines
      const rest = fm.slice(descM.index + descM[0].length).replace(/^\n/, '').split('\n');
      const buf = [descM[2]];
      for (const line of rest) {
        if (line.trim() === '' || /^[ \t]/.test(line)) buf.push(line.trim());
        else break;
      }
      out.description = buf.join(' ').replace(/\s+/g, ' ').trim();
    } else {
      out.description = descM[2].trim();
    }
  }
  return out;
}

function readSkillDir(baseDir, enabled) {
  let entries;
  try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    if (enabled && SKILL_RESERVED.has(d.name)) continue;
    const skillMd = path.join(baseDir, d.name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    let meta = { name: d.name, description: '' };
    let mtime = null;
    try {
      meta = parseSkillMeta(fs.readFileSync(skillMd, 'utf8'), d.name);
      mtime = fs.statSync(skillMd).mtimeMs;
    } catch (_) { /* unreadable — still list it by dir name */ }
    out.push({ dir: d.name, name: meta.name || d.name, description: meta.description, enabled, mtime });
  }
  return out;
}

app.get('/api/skills', (_req, res) => {
  const list = [...readSkillDir(SKILLS_DIR, true), ...readSkillDir(SKILLS_DISABLED, false)];
  list.sort((a, b) => a.dir.localeCompare(b.dir));
  res.json({ skills: list, hub: fs.existsSync(HUB_SYNC), dir: SKILLS_DIR });
});

app.get('/api/skills/:name', (req, res) => {
  const name = safeSkillName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid skill name' });
  for (const base of [SKILLS_DIR, SKILLS_DISABLED]) {
    const f = path.join(base, name, 'SKILL.md');
    if (fs.existsSync(f)) {
      try {
        return res.json({ name, enabled: base === SKILLS_DIR, content: fs.readFileSync(f, 'utf8').slice(0, 200000) });
      } catch (e) { return res.status(500).json({ error: String(e) }); }
    }
  }
  res.status(404).json({ error: 'not found' });
});

app.post('/api/skills/:name/toggle', (req, res) => {
  const name = safeSkillName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid skill name' });
  const enable = !!(req.body && req.body.enabled);
  const from = path.join(enable ? SKILLS_DISABLED : SKILLS_DIR, name);
  const to = path.join(enable ? SKILLS_DIR : SKILLS_DISABLED, name);
  if (!fs.existsSync(path.join(from, 'SKILL.md'))) return res.status(404).json({ error: 'not found' });
  if (fs.existsSync(to)) return res.status(409).json({ error: 'a skill with that name already exists on the other side' });
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  } catch (e) { return res.status(500).json({ error: String(e) }); }
  res.json({ ok: true, name, enabled: enable });
});

app.post('/api/skills/hub', async (req, res) => {
  const action = String((req.body && req.body.action) || '');
  if (!['pull', 'push', 'status'].includes(action)) return res.status(400).json({ error: 'action must be pull|push|status' });
  if (!fs.existsSync(HUB_SYNC)) return res.status(404).json({ error: 'skills-hub is not installed' });
  const { err, stdout, stderr } = await sh('bash', [HUB_SYNC, action], { timeout: 45000 });
  res.json({ ok: !err, action, output: ((stdout || '') + (stderr || '')).trim().slice(-8000) || (err ? String(err) : '(no output)') });
});

// ─────────── conversations (resume / fork) ───────────
// Claude keeps one transcript per conversation at
// ~/.claude/projects/<cwd-with-slashes-as-dashes>/<session-id>.jsonl
function projectDirFor(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', String(cwd).replace(/\//g, '-'));
}
// Transcripts sometimes capture raw terminal noise — ANSI/OSC escapes and SGR
// mouse reports like "4;22M5;22M…" — as message text. Strip it so titles read.
const RE_ESC = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const RE_MOUSE = /(?:\d+;\d+;\d+[Mm])+|(?:\d+;\d+[Mm]){2,}/g;
const RE_CTRL = /[\x00-\x08\x0b-\x1f\x7f]/g;
function cleanTitle(s) {
  return String(s || '').replace(RE_ESC, '').replace(RE_MOUSE, '').replace(RE_CTRL, '')
    .replace(/\s+/g, ' ').trim();
}
function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

app.get('/api/conversations', (req, res) => {
  const cwd = req.query.dir;
  if (!cwd) return res.status(400).json({ error: 'dir required' });
  let files;
  try { files = fs.readdirSync(projectDirFor(cwd)).filter((f) => f.endsWith('.jsonl')); }
  catch (_) { return res.json({ conversations: [] }); }
  const pdir = projectDirFor(cwd);
  const convos = files.map((f) => {
    const full = path.join(pdir, f);
    let title = null, firstUser = null, mtime = 0;
    try {
      mtime = fs.statSync(full).mtimeMs;
      for (const ln of readHead(full, 65536).split('\n')) {
        if (!ln.trim()) continue;
        let d; try { d = JSON.parse(ln); } catch (_) { continue; }
        if (d.type === 'custom-title' && d.customTitle) { title = d.customTitle; break; }
        if (!firstUser && d.type === 'user') {
          const c = d.message && d.message.content;
          if (typeof c === 'string') firstUser = c;
          else if (Array.isArray(c)) { const t = c.find((p) => p && p.type === 'text'); if (t) firstUser = t.text; }
        }
      }
    } catch (_) {}
    return { id: f.replace(/\.jsonl$/, ''), title: cleanTitle(title || firstUser).slice(0, 90) || '(untitled)', mtime };
  }).filter((c) => c.id).sort((a, b) => b.mtime - a.mtime).slice(0, 60);
  res.json({ conversations: convos });
});

// ─────────── Ollama engine ───────────
// Two Ollama hosts on the homelab (.21, .22); either can be picked per session.
// .22 (aiserver, RX 6800 16 GB) first = default host; .21 still selectable.
const OLLAMA_HOSTS = (process.env.OLLAMA_HOSTS || 'http://192.168.1.22:11434,http://192.168.1.21:11434')
  .split(',').map((s) => s.trim()).filter(Boolean);

// aider gives Ollama models an agentic (file-editing, git) coding loop. It lives
// in a venv or the user site depending on how it installed; resolve either.
function aiderBin() {
  const cands = [
    path.join(os.homedir(), '.aider-venv', 'bin', 'aider'),
    path.join(os.homedir(), '.local', 'bin', 'aider'),
  ];
  return cands.find((p) => fs.existsSync(p)) || null;
}

app.get('/api/ollama/models', async (req, res) => {
  const host = OLLAMA_HOSTS.includes(req.query.host) ? req.query.host : OLLAMA_HOSTS[0];
  const aider = !!aiderBin();
  try {
    const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    res.json({ host, hosts: OLLAMA_HOSTS, models: (j.models || []).map((m) => m.name), aider });
  } catch (e) {
    res.json({ host, hosts: OLLAMA_HOSTS, models: [], error: String((e && e.message) || e), aider });
  }
});

const server = http.createServer(app);
// The browser attaches its Access cookie to a cross-site WebSocket too, so a
// foreign page could otherwise drive a terminal; only same-host origins attach.
const wss = new WebSocketServer({
  server, path: '/ws',
  verifyClient: ({ req, origin }, done) => {
    let sameHost = !origin;
    try { sameHost = sameHost || new URL(origin).host === req.headers.host; } catch (_) {}
    if (!sameHost) return done(false, 403);
    cfAccessOk(req).then((ok) => done(ok, 403));
  },
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const session = url.searchParams.get('session');
  const cols = Number(url.searchParams.get('cols')) || 120;
  const rows = Number(url.searchParams.get('rows')) || 32;
  if (!session) { ws.close(1008, 'session required'); return; }

  // -x (multi-display attach) rather than -r, so opening a browser tab does not
  // steal the session from an existing SSH attach, and two tabs can watch one
  // session simultaneously.
  const term = pty.spawn('screen', ['-x', session], {
    name: 'xterm-256color',
    cols, rows,
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  // Claude Code's TUI (alt screen) enables mouse tracking so the wheel scrolls the
  // chat — we must KEEP that (1000 basic + 1006 SGR) or the wheel degrades to arrow
  // keys that hit the input history. But strip only the MOTION modes (1002 drag,
  // 1003 any-motion): those flood mouse-move reports that leak into the session as
  // text ("4;22M…"). Wheel and clicks are reported fine without motion tracking.
  const stripMouseMotion = (s) => s.replace(/\x1b\[\?100[23]h/g, '');

  term.onData((d) => { if (ws.readyState === ws.OPEN) ws.send(stripMouseMotion(d)); });
  term.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[33m[detached from ${session} (exit ${exitCode})]\x1b[0m\r\n`);
      ws.close();
    }
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'input') term.write(msg.data);   // pass wheel/click reports through
    else if (msg.type === 'resize') { try { term.resize(msg.cols, msg.rows); } catch (_) {} }
  });

  ws.on('close', () => {
    // Detach (Ctrl-A d) rather than killing screen, so the session keeps running.
    try { term.write('\x01d'); } catch (_) {}
    setTimeout(() => { try { term.kill(); } catch (_) {} }, 200);
  });
});

// A container restart (or a host reboot) leaves sockets behind for processes
// that no longer exist. Clear them once at startup so the list reflects reality.
sh('screen', ['-wipe']).then(({ stdout }) => {
  const wiped = (stdout.match(/^\s*\d+\./gm) || []).length;
  if (wiped) console.log(`wiped ${wiped} dead session socket(s) left over from a previous run`);
  return reconcileLaunches();
}).catch((e) => console.error('session restore failed:', e.message));

server.listen(PORT, BIND, () => {
  console.log(`screendeck listening on http://${BIND}:${PORT} (host ${os.hostname()})`);
  console.log(`default command: ${DEFAULT_COMMAND}`);
  console.log(`default dir:     ${DEFAULT_DIR}${WORKSPACE_ROOT ? `  (restricted to ${WORKSPACE_ROOT})` : ''}`);
  console.log('NOTE: no authentication — bind to a trusted network or front it with a proxy.');
  console.log(`cloudflare access: ${CF_TEAM && CF_AUD ? `required via ${CF_TEAM}` : 'not configured, Cloudflare traffic rejected'}`);
});

// Skip the immediate check if a cached reading is still fresh (e.g. a quick
// restart), so a restart-loop can't turn into a rate-limit-check-loop.
if (!rateLimitState || Date.now() - rateLimitState.checkedAt > RATE_LIMIT_POLL_MINUTES * 60000) {
  refreshRateLimit();
}
setInterval(refreshRateLimit, RATE_LIMIT_POLL_MINUTES * 60000);
