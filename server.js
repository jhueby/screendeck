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
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 7681;
const BIND = process.env.BIND || '0.0.0.0';
const SESSION_PREFIX = process.env.SESSION_PREFIX || 'sd-';
const DEFAULT_DIR = process.env.DEFAULT_DIR || os.homedir();
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || null;
const DEFAULT_COMMAND = process.env.DEFAULT_COMMAND || process.env.SHELL || 'bash';

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

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

/** What is actually running inside the session — useful at a glance. */
async function sessionCommand(pid) {
  const { stdout } = await sh('pgrep', ['-P', String(pid)]);
  for (const kid of stdout.split('\n').filter(Boolean)) {
    try {
      const cmd = fs.readFileSync(`/proc/${kid}/cmdline`, 'utf8')
        .replace(/\0/g, ' ').trim();
      if (cmd) return cmd.slice(0, 120);
    } catch (_) { /* exited */ }
  }
  return null;
}

async function listSessions(withPreview = false) {
  const { stdout } = await sh('screen', ['-ls']);
  const host = os.hostname();
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
    out.push({
      name: fullName,
      pid: Number(pid),
      label,
      created,
      attached: /Attached/i.test(state),
      dead: /Dead/i.test(state),
      state: state.trim(),
      cwd: await sessionCwd(pid),
      command: await sessionCommand(pid),
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

app.post('/api/sessions', async (req, res) => {
  const { dir, command, name } = req.body || {};
  const cwd = dir || DEFAULT_DIR;
  if (!fs.existsSync(cwd)) return res.status(400).json({ error: `no such directory: ${cwd}` });
  if (!withinWorkspace(cwd)) return res.status(403).json({ error: 'outside workspace root' });

  const safe = (name || 'session').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'session';
  const sessionName = `${SESSION_PREFIX}${safe}-${Date.now().toString(36)}`;
  const toRun = (command && command.trim()) || DEFAULT_COMMAND;

  // Run through a login shell so PATH, aliases and profile behave as expected.
  const { err, stderr } = await sh(
    'screen',
    ['-dmS', sessionName, '-c', path.join(__dirname, 'screenrc'), 'bash', '-lc', toRun],
    { cwd }
  );
  if (err) return res.status(500).json({ error: stderr || String(err) });
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
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

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

  term.onData((d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
  term.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[33m[detached from ${session} (exit ${exitCode})]\x1b[0m\r\n`);
      ws.close();
    }
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'input') term.write(msg.data);
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
});

server.listen(PORT, BIND, () => {
  console.log(`screendeck listening on http://${BIND}:${PORT} (host ${os.hostname()})`);
  console.log(`default command: ${DEFAULT_COMMAND}`);
  console.log(`default dir:     ${DEFAULT_DIR}${WORKSPACE_ROOT ? `  (restricted to ${WORKSPACE_ROOT})` : ''}`);
  console.log('NOTE: no authentication — bind to a trusted network or front it with a proxy.');
});
