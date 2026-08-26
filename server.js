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

async function listSessions() {
  const { stdout } = await sh('screen', ['-ls']);
  const host = os.hostname();
  const out = [];
  for (const line of stdout.split('\n')) {
    // "\t203304.pts-1.myhost\t(01/02/2026 11:43:42 PM)\t(Detached)"
    const m = line.match(/^\s*(\d+)\.(\S+)\s+\(([^)]+)\)\s+\((Attached|Detached)\)/);
    if (!m) continue;
    const [, pid, tail, created, state] = m;
    // Names are "<pid>.<custom>" (screen -S custom) or "<pid>.<tty>.<host>"
    // when auto-named. Showing the host is useless — every session on a box has
    // the same one — so prefer the custom name, else the tty.
    const parts = tail.split('.');
    const label = parts.length >= 2 && parts[parts.length - 1] === host
      ? parts.slice(0, -1).join('.')
      : tail;
    out.push({
      name: `${pid}.${tail}`,
      pid: Number(pid),
      label,
      created,
      attached: state === 'Attached',
      cwd: await sessionCwd(pid),
      command: await sessionCommand(pid),
    });
  }
  return out.reverse(); // newest first
}

app.get('/api/sessions', async (_req, res) => {
  try {
    res.json({ sessions: await listSessions(), host: os.hostname() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
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

app.delete('/api/sessions/:name', async (req, res) => {
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

server.listen(PORT, BIND, () => {
  console.log(`screendeck listening on http://${BIND}:${PORT} (host ${os.hostname()})`);
  console.log(`default command: ${DEFAULT_COMMAND}`);
  console.log(`default dir:     ${DEFAULT_DIR}${WORKSPACE_ROOT ? `  (restricted to ${WORKSPACE_ROOT})` : ''}`);
  console.log('NOTE: no authentication — bind to a trusted network or front it with a proxy.');
});
