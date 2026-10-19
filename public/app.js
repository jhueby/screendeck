/* Screendeck — front end.
 *
 * Chat-shaped shell around a real terminal. The composer sends lines to the
 * pty; the transcript stays a terminal because the processes people run here
 * (agents, TUIs, build watchers) redraw the screen rather than emitting
 * discrete messages. Parsing that into chat bubbles would be guesswork.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t == null ? '' : t)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

let term, fit, ws, current = null;
// The 5s poll re-renders the list, which would yank the element out from under
// a drag in progress. Suspend refreshes while dragging.
let dragging = null, suspendRefresh = false;
let autoCopy = localStorage.getItem('sd-autocopy') === '1';

// A session that was producing output and has since gone quiet has likely
// finished a task and is sitting at a prompt again — flag it until it's
// opened. Keyed off the active->idle transition, not "idle" alone, so a
// session that was never touched doesn't light up on first load.
let needsAttention = new Set();
let prevActive = new Map();

/* ─────────── terminal ─────────── */
function initTerm() {
  term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 20000,
    theme: {
      background: '#0d0d0d', foreground: '#ececec', cursor: '#4a9eff',
      selectionBackground: '#2f4a6d',
      black: '#0d0d0d', brightBlack: '#6f6f6f',
    },
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('term'));

  // Wheel/trackpad scrolling is left to xterm's native handling: Claude Code renders
  // in the normal buffer (it sets no alt-screen / mouse / alt-scroll modes), so the
  // native wheel smoothly scrolls the scrollback — the chat. A custom handler that
  // returned false only broke that smooth scroll.

  // Typing directly into the terminal still works — the composer is additive.
  term.onData((d) => sendRaw(d));

  new ResizeObserver(() => {
    try {
      fit.fit();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: reportCols(), rows: term.rows }));
      }
    } catch (_) {}
  }).observe($('term'));
}

// Single-column mode: cap the columns we REPORT to the pty so Claude Code (and other
// wide TUIs) render one column — its side "changes" panel only appears above a width
// threshold. The xterm window stays full size; Claude just uses the left COLCAP cols.
const COLCAP = 100;
function colcapOn() { try { return localStorage.getItem('sd-1col') === '1'; } catch (_) { return false; } }
function reportCols() { return colcapOn() && term ? Math.min(term.cols, COLCAP) : (term ? term.cols : 80); }
function setColcap(on) {
  try { localStorage.setItem('sd-1col', on ? '1' : '0'); } catch (_) {}
  const b = $('colBtn'); if (b) b.classList.toggle('on', on);
  // push a resize now so the open session re-lays-out immediately
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: reportCols(), rows: term.rows })); } catch (_) {}
}

function sendRaw(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data }));
  }
}

function setConn(state) {
  const el = $('conn');
  el.className = 'status' + (state === 'live' ? ' live' : state === 'dead' ? ' dead' : '');
  el.textContent = state === 'live' ? 'connected' : state === 'dead' ? 'disconnected' : 'idle';
  $('send').disabled = state !== 'live';
}

function attach(sess) {
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
  needsAttention.delete(sess.name);
  current = sess;
  $('empty').style.display = 'none';
  $('termWrap').style.display = '';
  $('composerWrap').style.display = '';
  $('curName').textContent = sess.label || sess.name;
  $('curCwd').textContent = sess.cwd || '';
  // A full reset, not just clear() — clear() only wipes the screen buffer.
  // Terminal modes (e.g. mouse tracking) set by a previous session's program
  // survive clear() and would otherwise leak into whatever is attached next.
  term.reset();
  try { fit.fit(); } catch (_) {}

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?session=${encodeURIComponent(sess.name)}`
    + `&cols=${reportCols()}&rows=${term.rows}`);
  ws.onopen = () => { setConn('live'); $('input').focus(); };
  ws.onmessage = (ev) => term.write(ev.data);
  ws.onclose = () => setConn('dead');
  ws.onerror = () => setConn('dead');
  const x = $('paneClose'); if (x) x.style.display = '';
  render();
}

// Close the open terminal pane (deselect back to the empty state) — does NOT kill
// the session; it keeps running and can be reopened from the sidebar.
function closePane() {
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
  current = null;
  $('empty').style.display = '';
  $('termWrap').style.display = 'none';
  $('composerWrap').style.display = 'none';
  $('curName').textContent = 'Screendeck';
  $('curCwd').textContent = '';
  const x = $('paneClose'); if (x) x.style.display = 'none';
  setConn('idle');
  render();
}

/* ─────────── clipboard ───────────
 * Browsers gate navigator.clipboard behind a secure context. Served over plain
 * HTTP on a LAN address, that API is simply absent — so copying falls back to a
 * hidden textarea + execCommand, which still works. Reading the clipboard has
 * no such fallback, but Ctrl+V does not need one: the browser fires a native
 * paste event that xterm handles, because the user initiated it.
 */
const canReadClipboard = () => !!(navigator.clipboard && navigator.clipboard.readText && window.isSecureContext);

function flash(msg) {
  const el = $('conn');
  const prev = { text: el.textContent, cls: el.className };
  el.textContent = msg;
  setTimeout(() => { el.textContent = prev.text; el.className = prev.cls; }, 1400);
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) {}
  document.body.removeChild(ta);
  return ok;
}

async function copySelection(fallbackToBuffer) {
  let text = term.getSelection();
  if (!text && fallbackToBuffer) {
    // Selecting text by hand is painful on a phone, so the button copies the
    // visible screen when nothing is selected.
    const b = term.buffer.active;
    const lines = [];
    for (let i = b.viewportY; i < b.viewportY + term.rows; i++) {
      const line = b.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    text = lines.join('\n').replace(/\n+$/, '');
  }
  if (!text) { flash('nothing selected'); return; }
  let ok = false;
  if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {}
  }
  if (!ok) ok = fallbackCopy(text);
  flash(ok ? 'copied' : 'copy blocked');
}

async function pasteFromClipboard() {
  if (!canReadClipboard()) {
    flash('use Ctrl+V');
    return;
  }
  try {
    const text = await navigator.clipboard.readText();
    if (text) sendRaw(text);
  } catch (_) { flash('paste blocked'); }
}

function wireClipboard() {
  // Terminal conventions: Ctrl+Shift+C/V always copy/paste; plain Ctrl+C copies
  // only when there is a selection, otherwise it must reach the process as
  // SIGINT — which is exactly what you want for interrupting an agent.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.shiftKey && (e.code === 'KeyC' || e.key === 'C')) { copySelection(false); return false; }
    if (ctrl && e.shiftKey && (e.code === 'KeyV' || e.key === 'V')) { pasteFromClipboard(); return false; }
    if (ctrl && !e.shiftKey && (e.code === 'KeyC' || e.key === 'c') && term.hasSelection()) {
      copySelection(false);
      term.clearSelection();
      return false;
    }
    return true; // Ctrl+V falls through to the browser's native paste event
  });

  // Select-to-copy, like most terminal emulators.
  term.onSelectionChange(() => {
    if (autoCopy && term.hasSelection()) copySelection(false);
  });

  // Middle-click pastes on Linux desktops; approximate it where we can.
  $('term').addEventListener('auxclick', (e) => {
    if (e.button === 1) { e.preventDefault(); pasteFromClipboard(); }
  });
}

/* ─────────── composer ─────────── */
// Upload a file / pasted image into the open session's folder; drop its path into
// the composer so you can describe it and send it to Claude.
async function uploadFile(file) {
  if (!current) { alert('Open a session first to attach a file.'); return; }
  const name = file.name || ('pasted-' + Date.now() + '.png');
  const st = $('attachStatus');
  if (st) { st.style.display = ''; st.textContent = 'uploading ' + name + '…'; }
  try {
    const r = await fetch('/api/sessions/' + encodeURIComponent(current.name) + '/upload?name=' + encodeURIComponent(name),
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    const j = await r.json();
    if (j.error) { if (st) st.textContent = '✗ ' + j.error; return; }
    const ta = $('input');
    ta.value = ta.value + (ta.value && !/\s$/.test(ta.value) ? ' ' : '') + j.rel + ' ';
    ta.dispatchEvent(new Event('input'));
    ta.focus();
    if (st) { st.textContent = '📎 ' + j.rel + ' (' + Math.round(j.bytes / 1024) + ' KB) — path added; describe it and press Enter'; setTimeout(() => { st.style.display = 'none'; }, 7000); }
  } catch (e) { if (st) st.textContent = '✗ upload failed'; }
}

function wireComposer() {
  const ta = $('input');

  const autogrow = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  };
  ta.addEventListener('input', autogrow);

  const submit = () => {
    const text = ta.value;
    if (!text.trim() || !ws || ws.readyState !== WebSocket.OPEN) return;
    // Multi-line input goes through as-is, then a single Enter to submit —
    // matching how you would paste into the terminal by hand.
    sendRaw(text.replace(/\n/g, '\r') + '\r');
    ta.value = '';
    autogrow();
  };

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  $('send').addEventListener('click', submit);

  // Attach files / paste screenshots → upload into the session folder, path into composer.
  $('attachBtn').onclick = () => $('fileInput').click();
  $('fileInput').addEventListener('change', (e) => { for (const f of e.target.files) uploadFile(f); e.target.value = ''; });
  ta.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.type && it.type.indexOf('image') === 0) { const f = it.getAsFile(); if (f) { e.preventDefault(); uploadFile(f); return; } }
    }
  });

  // Control keys a textarea cannot express, but a terminal session needs.
  const SEQ = { ctrlc: '\x03', esc: '\x1b', tab: '\t', up: '\x1b[A' };
  $('keys').addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    if (act === 'copy') { copySelection(true); return; }
    if (act === 'paste') { pasteFromClipboard(); return; }
    if (act === 'autocopy') {
      autoCopy = !autoCopy;
      localStorage.setItem('sd-autocopy', autoCopy ? '1' : '0');
      e.target.classList.toggle('on', autoCopy);
      flash(autoCopy ? 'select = copy on' : 'select = copy off');
      return;
    }
    const k = e.target.dataset.key;
    if (!k) return;
    sendRaw(SEQ[k] || '');
    ta.focus();
  });
  // reflect persisted preference on load
  const acBtn = document.querySelector('[data-act="autocopy"]');
  if (acBtn && autoCopy) acBtn.classList.add('on');
}

/* ─────────── sessions ─────────── */
async function refresh() {
  if (suspendRefresh) return;
  try {
    const r = await fetch('/api/sessions?preview=1');
    const j = await r.json();
    $('host').textContent = j.host || '';
    const sessions = j.sessions || [];
    for (const s of sessions) {
      const wasActive = prevActive.get(s.name);
      const isOpen = current && current.name === s.name;
      if (wasActive === true && !s.active && !s.dead && !isOpen) needsAttention.add(s.name);
      prevActive.set(s.name, !!s.active);
    }
    window._sessions = sessions;
    render();
  } catch (_) { /* server restarting — next tick retries */ }
}

// Order sessions so each fork sits directly below its parent, with a depth for
// indentation. Roots keep their existing (user) order; children follow their parent.
function groupForks(sessions) {
  const byLabel = new Map(sessions.map((s) => [s.label, s]));
  const children = new Map();
  const roots = [];
  for (const s of sessions) {
    if (s.parent && s.parent !== s.label && byLabel.has(s.parent)) {
      if (!children.has(s.parent)) children.set(s.parent, []);
      children.get(s.parent).push(s);
    } else roots.push(s);
  }
  const out = [];
  const visit = (s, depth) => {
    s._depth = depth;
    out.push(s);
    for (const c of (children.get(s.label) || [])) visit(c, depth + 1);
  };
  roots.forEach((s) => visit(s, 0));
  for (const s of sessions) if (!out.includes(s)) { s._depth = 0; out.push(s); } // orphans/cycles
  return out;
}

function render() {
  const list = $('list');
  const sessions = groupForks(window._sessions || []);
  if (!sessions.length) {
    list.innerHTML = '<div style="color:var(--dim);font-size:12px;padding:12px 11px">'
      + 'No sessions yet.</div>';
    return;
  }
  list.innerHTML = '';
  for (const s of sessions) {
    const attn = needsAttention.has(s.name);
    const el = document.createElement('div');
    el.className = 'conv' + (current && current.name === s.name ? ' active' : '') + (attn ? ' needs-attn' : '');
    el.draggable = true;
    el.dataset.name = s.name;
    if (s._depth) { el.classList.add('forked'); el.style.marginLeft = (s._depth * 16) + 'px'; }
    // Forked sessions keep the parent's name + "Forked" (stored as "<parent>-Forked").
    const title = (s.label || s.name).replace(/-Forked/g, ' Forked');
    const dot = s.dead ? 'dead' : s.active ? 'active' : attn ? 'waiting' : s.attached ? 'attached' : '';
    // Prefer the live screen contents; fall back to the running command.
    const sub = s.dead ? 'dead — process gone'
      : (s.preview && s.preview.length ? s.preview[s.preview.length - 1]
        : (s.command || ''));
    el.innerHTML = `
      <div class="conv-actions">
        ${s.dead ? '' : `<button class="iconbtn" data-fork="${esc(s.name)}" title="Fork this conversation into a new session"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="18" r="2.6"/><circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="6" r="2.6"/><path d="M6 8.6v6.8M18 8.6c0 4.5-6 2-6 6.8"/></svg></button>`}
        <button class="iconbtn" data-rename="${esc(s.name)}" title="Rename">&#9998;</button>
        ${s.self
          ? '<button class="iconbtn" disabled title="This session hosts the server">&#9635;</button>'
          : `<button class="iconbtn danger" data-kill="${esc(s.name)}" title="Delete">&#10005;</button>`}
      </div>
      <div class="conv-row">
        <span class="dot ${dot}" title="${esc(s.state || '')}${s.active ? ' — producing output' : attn ? ' — ready for input' : ''}"></span>
        <span class="conv-title">${esc(title)}</span>
        ${attn ? '<span class="attn-badge" title="Ready for input">&#9679;</span>' : ''}
      </div>
      <div class="conv-sub">${esc(sub).slice(0, 200)}</div>`;
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.conv-actions')) return;
      // A drag ends with a click event on some browsers; ignore it.
      if (el.dataset.justDragged) { delete el.dataset.justDragged; return; }
      needsAttention.delete(s.name);
      attach(s);
    });

    el.addEventListener('dragstart', (ev) => {
      dragging = el;
      suspendRefresh = true;
      el.classList.add('drag-src');
      ev.dataTransfer.effectAllowed = 'move';
      // Firefox will not start a drag without data set.
      ev.dataTransfer.setData('text/plain', s.name);
    });
    el.addEventListener('dragend', async () => {
      el.classList.remove('drag-src');
      list.querySelectorAll('.drop-before,.drop-after')
        .forEach((n) => n.classList.remove('drop-before', 'drop-after'));
      dragging = null;
      el.dataset.justDragged = '1';
      await persistOrder();
      suspendRefresh = false;
    });
    el.addEventListener('dragover', (ev) => {
      if (!dragging || dragging === el) return;
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      const after = ev.clientY > r.top + r.height / 2;
      el.classList.toggle('drop-after', after);
      el.classList.toggle('drop-before', !after);
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('drop-before', 'drop-after');
    });
    el.addEventListener('drop', (ev) => {
      if (!dragging || dragging === el) return;
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      const after = ev.clientY > r.top + r.height / 2;
      el.parentNode.insertBefore(dragging, after ? el.nextSibling : el);
      el.classList.remove('drop-before', 'drop-after');
    });

    list.appendChild(el);
  }

  // The sidebar can be hidden (mobile, or toggled off), so the hamburger
  // itself carries a badge too — otherwise a waiting session is invisible.
  $('hamb').classList.toggle('has-attn', needsAttention.size > 0);

  list.querySelectorAll('[data-rename]').forEach((b) => {
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const full = b.dataset.rename;
      const cur = (window._sessions.find((x) => x.name === full) || {}).label || '';
      const next = prompt('Rename session\n\n(letters, digits, . _ - only)', cur);
      if (!next || next === cur) return;
      const r = await fetch('/api/sessions/' + encodeURIComponent(full), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName: next }),
      });
      const j = await r.json();
      if (j.error) { alert('Rename failed: ' + j.error); return; }
      if (current && current.name === full) current = { ...current, name: j.name, label: next };
      refresh();
    });
  });

  list.querySelectorAll('[data-fork]').forEach((b) => {
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const name = b.dataset.fork;
      b.disabled = true;
      try {
        const r = await fetch('/api/sessions/' + encodeURIComponent(name) + '/fork', { method: 'POST' });
        const j = await r.json();
        if (j.error) { alert('Fork failed: ' + j.error); return; }
        await refresh();
        // attach to the new fork once screen has registered it
        setTimeout(() => {
          const s = (window._sessions || []).find((x) => x.name.includes(j.session));
          if (s) attach(s);
        }, 700);
      } finally { b.disabled = false; }
    });
  });

  list.querySelectorAll('[data-kill]').forEach((b) => {
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const name = b.dataset.kill;
      if (!confirm(`Delete session ${name}?\n\nThe process running inside it will be terminated.`)) return;
      await fetch('/api/sessions/' + encodeURIComponent(name), { method: 'DELETE' });
      needsAttention.delete(name);
      if (current && current.name === name) closePane();
      refresh();
    });
  });
}

async function persistOrder() {
  const order = [...$('list').querySelectorAll('.conv')].map((n) => n.dataset.name);
  if (!order.length) return;
  // Keep the local copy in the new order too, so the next render agrees with
  // what the user just did rather than briefly snapping back.
  const byName = new Map((window._sessions || []).map((s) => [s.name, s]));
  window._sessions = order.map((n) => byName.get(n)).filter(Boolean);
  try {
    await fetch('/api/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    });
  } catch (_) { /* order is cosmetic; a failure is not worth interrupting for */ }
}

/* ─────────── new-session modal ─────────── */
async function loadDirs(p) {
  const r = await fetch('/api/dirs' + (p ? '?path=' + encodeURIComponent(p) : ''));
  const j = await r.json();
  if (j.error) return;
  $('mDir').value = j.path;
  const box = $('dirs');
  box.innerHTML = '';
  const up = document.createElement('div');
  up.textContent = '../';
  up.onclick = () => loadDirs(j.parent);
  box.appendChild(up);
  const mk = document.createElement('div');
  mk.textContent = '+ New folder…';
  mk.style.color = 'var(--accent)';
  mk.onclick = async () => {
    const name = prompt('New folder name (created inside ' + j.path + ')');
    if (!name) return;
    const r2 = await fetch('/api/dirs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: j.path, name }),
    });
    const j2 = await r2.json();
    if (j2.error) { alert('Could not create folder: ' + j2.error); return; }
    loadDirs(j2.path);
  };
  box.appendChild(mk);
  for (const d of j.dirs) {
    const el = document.createElement('div');
    el.textContent = d.replace(j.path.replace(/\/$/, '') + '/', '  ');
    el.onclick = () => loadDirs(d);
    box.appendChild(el);
  }
  if (mEngine === 'claude') loadConversations(j.path);
}

/* engine + conversation/ollama pickers */
let mEngine = 'claude';
let mConvSel = null; // null = new conversation; else { id, fork }
let mOllamaMode = 'agent'; // 'agent' (aider, edits files) | 'chat' (plain REPL)

function fmtAgo(ms) {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + 'm ago';
  if (s < 129600) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

function updateCreateLabel() {
  const b = $('mCreate');
  if ($('mCommand').value.trim()) b.textContent = 'Run';
  else if (mEngine === 'ollama') b.textContent = 'Start';
  else if (mConvSel && mConvSel.fork) b.textContent = 'Fork';
  else if (mConvSel) b.textContent = 'Resume';
  else b.textContent = 'Create';
}

function setConvSel(sel, row) {
  mConvSel = sel;
  document.querySelectorAll('#convList .convpick').forEach((n) => {
    n.classList.remove('sel');
    n.querySelectorAll('.cf').forEach((b) => b.classList.remove('on'));
  });
  if (row) row.classList.add('sel');
  updateCreateLabel();
}

async function loadConversations(dir) {
  const box = $('convList');
  box.innerHTML = '<div style="padding:9px 10px;color:var(--dim);font-size:12px">Loading…</div>';
  mConvSel = null;
  let j;
  try { j = await (await fetch('/api/conversations?dir=' + encodeURIComponent(dir))).json(); }
  catch (e) { box.innerHTML = '<div style="padding:9px 10px;color:var(--bad);font-size:12px">Could not load</div>'; return; }
  const convos = j.conversations || [];
  box.innerHTML = '';
  const nw = document.createElement('div');
  nw.className = 'convpick sel';
  nw.innerHTML = '<span class="ct">✦ New conversation</span>';
  nw.onclick = () => setConvSel(null, nw);
  box.appendChild(nw);
  $('convHint').textContent = convos.length ? convos.length + ' here' : 'none yet';
  for (const c of convos) {
    const row = document.createElement('div');
    row.className = 'convpick';
    row.innerHTML = `<span class="ct" title="${esc(c.title)}">${esc(c.title)}</span>
      <span class="cm">${fmtAgo(c.mtime)}</span>
      <button type="button" class="cf" data-mode="resume">resume</button>
      <button type="button" class="cf" data-mode="fork">fork</button>`;
    const pick = (mode) => {
      setConvSel({ id: c.id, fork: mode === 'fork' }, row);
      row.querySelector(`.cf[data-mode="${mode}"]`).classList.add('on');
    };
    row.querySelector('[data-mode="resume"]').onclick = (e) => { e.stopPropagation(); pick('resume'); };
    row.querySelector('[data-mode="fork"]').onclick = (e) => { e.stopPropagation(); pick('fork'); };
    row.onclick = () => pick('resume');
    box.appendChild(row);
  }
}

async function loadOllama(host) {
  const hostSel = $('mHost'), modelSel = $('mModel');
  modelSel.innerHTML = '<option>loading…</option>';
  let j;
  try { j = await (await fetch('/api/ollama/models' + (host ? '?host=' + encodeURIComponent(host) : ''))).json(); }
  catch (e) { modelSel.innerHTML = '<option value="">(unreachable)</option>'; return; }
  // agent mode requires aider on the host
  const agentBtn = document.querySelector('#ollamaMode button[data-mode="agent"]');
  if (agentBtn) {
    agentBtn.disabled = !j.aider;
    agentBtn.style.opacity = j.aider ? '' : '.5';
    agentBtn.title = j.aider ? '' : 'aider not installed on this host';
    if (!j.aider && mOllamaMode === 'agent') setOllamaMode('chat');
  }
  if (!hostSel.dataset.loaded) {
    hostSel.innerHTML = '';
    for (const h of (j.hosts || [])) {
      const o = document.createElement('option');
      o.value = h; o.textContent = h.replace(/^https?:\/\//, '');
      hostSel.appendChild(o);
    }
    hostSel.value = j.host;
    hostSel.dataset.loaded = '1';
  }
  modelSel.innerHTML = '';
  if (!(j.models || []).length) {
    modelSel.innerHTML = `<option value="">${j.error ? '(host unreachable)' : '(no models)'}</option>`;
    $('modelHint').textContent = j.error ? '— ' + j.host.replace(/^https?:\/\//, '') + ' down' : '';
    return;
  }
  $('modelHint').textContent = '— ' + j.models.length + ' available';
  for (const m of j.models) {
    const o = document.createElement('option'); o.value = m; o.textContent = m; modelSel.appendChild(o);
  }
  // Default to the benchmark pick: qwen2.5-coder:7b (best accuracy/speed for agentic editing)
  const preferred = 'qwen2.5-coder:7b';
  if (j.models.includes(preferred)) modelSel.value = preferred;
}

function setOllamaMode(mode) {
  mOllamaMode = mode;
  document.querySelectorAll('#ollamaMode button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-mode') === mode));
  const note = $('agentNote');
  if (note) note.textContent = mode === 'agent'
    ? 'Runs aider — reads & edits files in this folder, auto-commits to git.'
    : 'Plain chat REPL — no file access.';
}

function setEngine(eng) {
  mEngine = eng;
  document.querySelectorAll('#engineSeg button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-engine') === eng));
  $('claudeOpts').style.display = eng === 'claude' ? '' : 'none';
  $('ollamaOpts').style.display = eng === 'ollama' ? '' : 'none';
  if (eng === 'claude') loadConversations($('mDir').value || '');
  else loadOllama($('mHost').dataset.loaded ? $('mHost').value : '');
  updateCreateLabel();
}

function wireModal() {
  $('newBtn').onclick = () => { $('modal').classList.add('open'); setEngine('claude'); loadDirs(); };
  $('mCancel').onclick = () => $('modal').classList.remove('open');
  $('modal').addEventListener('click', (e) => {
    if (e.target === $('modal')) $('modal').classList.remove('open');
  });
  $('engineSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-engine]');
    if (b) setEngine(b.getAttribute('data-engine'));
  });
  $('mHost').addEventListener('change', () => loadOllama($('mHost').value));
  $('ollamaMode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b && !b.disabled) setOllamaMode(b.getAttribute('data-mode'));
  });
  $('mCommand').addEventListener('input', updateCreateLabel);
  $('mCreate').onclick = async () => {
    const btn = $('mCreate');
    const body = {
      name: $('mName').value.trim(),
      dir: $('mDir').value.trim(),
      command: $('mCommand').value.trim(),
    };
    if (body.command) { /* explicit override wins */ }
    else if (mEngine === 'ollama') {
      body.engine = 'ollama'; body.host = $('mHost').value; body.model = $('mModel').value; body.mode = mOllamaMode;
      if (!body.model) { alert('Pick an Ollama model'); return; }
    } else if (mConvSel) { body.resumeId = mConvSel.id; body.fork = mConvSel.fork; }
    btn.disabled = true;
    try {
      const r = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.error) { alert('Failed: ' + j.error); return; }
      $('modal').classList.remove('open');
      $('mCommand').value = '';
      await refresh();
      // screen needs a beat to register before -x can attach
      setTimeout(() => {
        const s = (window._sessions || []).find((x) => x.name.includes(j.session));
        if (s) attach(s);
      }, 700);
    } finally { btn.disabled = false; }
  };
}

/* ─────────── usage tracker ─────────── */
function levelClass(u) { return u >= 0.9 ? 'bad' : u >= 0.7 ? 'warn' : ''; }
function fmtResets(ts) {
  if (!ts) return '';
  const ms = ts * 1000 - Date.now();
  if (ms <= 0) return 'resetting…';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return `resets in ${h > 0 ? h + 'h ' : ''}${m}m`;
}
function fmtClock(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function renderUsage(state) {
  const rows = [['uFill5h', 'uPct5h', state && state.five_hour], ['uFill7d', 'uPct7d', state && state.seven_day]];
  for (const [fillId, pctId, w] of rows) {
    const fill = $(fillId), pct = $(pctId);
    if (!w) { fill.style.width = '0%'; fill.className = 'usage-fill'; pct.textContent = '—'; pct.title = ''; continue; }
    fill.style.width = Math.min(100, Math.round(w.utilization * 100)) + '%';
    fill.className = 'usage-fill ' + levelClass(w.utilization);
    pct.textContent = Math.round(w.utilization * 100) + '%';
    pct.title = fmtResets(w.resetsAt);
  }
  const fiveH = state && state.five_hour;
  $('uEnd5h').textContent = fiveH ? `resets ${fmtClock(fiveH.resetsAt)} (${fmtResets(fiveH.resetsAt)})` : '';
}
async function refreshUsage() {
  try {
    const r = await fetch('/api/rate-limit');
    const j = await r.json();
    renderUsage(j.state);
  } catch (_) {}
}
$('uRefresh').addEventListener('click', async () => {
  const btn = $('uRefresh');
  btn.disabled = true;
  try {
    const r = await fetch('/api/rate-limit/refresh', { method: 'POST' });
    const j = await r.json();
    renderUsage(j.state);
  } finally {
    setTimeout(() => { btn.disabled = false; }, 60000);
  }
});

// Sidebar collapsed state persists across reloads — same toggle, remembered.
if (localStorage.getItem('sd-sidebar-hidden') === '1') $('side').classList.add('hidden');
$('hamb').onclick = () => {
  const hidden = $('side').classList.toggle('hidden');
  localStorage.setItem('sd-sidebar-hidden', hidden ? '1' : '0');
  setTimeout(() => { try { fit.fit(); } catch (_) {} }, 220);
};

/* ─────────── skills panel ─────────── */
async function renderSkills() {
  const box = $('skillsList');
  box.innerHTML = '<div style="padding:14px;color:var(--dim);font-size:12px">Loading…</div>';
  let j;
  try { j = await (await fetch('/api/skills')).json(); }
  catch (e) { box.innerHTML = '<div style="padding:14px;color:var(--bad);font-size:12px">Could not load skills</div>'; return; }
  const skills = j.skills || [];
  document.querySelectorAll('#hubRow button').forEach((b) => { b.disabled = !j.hub; });
  if (!j.hub) $('hubOut').textContent = 'hub sync not installed on this host';
  if (!skills.length) {
    box.innerHTML = '<div style="padding:14px;color:var(--dim);font-size:12px">No skills in ~/.claude/skills.</div>';
    return;
  }
  box.innerHTML = '';
  for (const s of skills) {
    const row = document.createElement('div');
    row.className = 'skrow' + (s.enabled ? '' : ' off');
    row.innerHTML = `
      <div class="skhead">
        <label class="sw" title="${s.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}">
          <input type="checkbox" ${s.enabled ? 'checked' : ''} data-toggle="${esc(s.dir)}">
          <span class="track"></span><span class="knob"></span>
        </label>
        <span class="skname">${esc(s.name)}${s.name !== s.dir ? `<span class="scope">${esc(s.dir)}/</span>` : ''}</span>
        <button class="skview" data-view="${esc(s.dir)}">view ▾</button>
      </div>
      <div class="skdesc">${esc(s.description || '(no description)')}</div>
      <div class="skbody" data-body="${esc(s.dir)}"></div>`;
    box.appendChild(row);
  }
  box.querySelectorAll('input[data-toggle]').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const dir = inp.getAttribute('data-toggle');
      inp.disabled = true;
      try {
        const r = await fetch(`/api/skills/${encodeURIComponent(dir)}/toggle`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: inp.checked }),
        });
        const jj = await r.json();
        if (jj.error) { alert('Toggle failed: ' + jj.error); inp.checked = !inp.checked; }
        else inp.closest('.skrow').classList.toggle('off', !inp.checked);
      } catch (e) { alert('Toggle failed'); inp.checked = !inp.checked; }
      finally { inp.disabled = false; }
    });
  });
  box.querySelectorAll('button[data-view]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const dir = btn.getAttribute('data-view');
      const body = box.querySelector(`.skbody[data-body="${CSS.escape(dir)}"]`);
      if (body.classList.contains('open')) { body.classList.remove('open'); btn.textContent = 'view ▾'; return; }
      btn.textContent = 'hide ▴';
      if (!body.dataset.loaded) {
        body.textContent = 'Loading…';
        try {
          const jj = await (await fetch('/api/skills/' + encodeURIComponent(dir))).json();
          body.textContent = jj.content || jj.error || '(empty)';
          body.dataset.loaded = '1';
        } catch (e) { body.textContent = 'Could not load SKILL.md'; }
      }
      body.classList.add('open');
    });
  });
}

async function hubAction(action) {
  const out = $('hubOut');
  out.textContent = action + '…';
  const btns = document.querySelectorAll('#hubRow button');
  btns.forEach((b) => { b.disabled = true; });
  try {
    const r = await fetch('/api/skills/hub', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const j = await r.json();
    const last = (j.output || '').split('\n').filter(Boolean).pop() || '(done)';
    out.textContent = (j.ok ? '✓ ' : '✗ ') + last;
    out.title = j.output || '';
    if (action === 'pull') renderSkills();
  } catch (e) { out.textContent = '✗ ' + action + ' failed'; }
  finally { btns.forEach((b) => { b.disabled = false; }); }
}

function wireSkills() {
  $('skillsBtn').onclick = () => { $('skillsModal').classList.add('open'); $('hubOut').textContent = ''; renderSkills(); };
  $('skillsClose').onclick = () => $('skillsModal').classList.remove('open');
  $('skillsModal').addEventListener('click', (e) => {
    if (e.target === $('skillsModal')) $('skillsModal').classList.remove('open');
  });
  $('hubRow').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-hub]');
    if (b && !b.disabled) hubAction(b.getAttribute('data-hub'));
  });
}

initTerm();
wireClipboard();
wireComposer();
wireModal();
wireSkills();
// Close buttons via event delegation on document — robust to load timing and any
// re-render: the corner × on a pop-up panel closes its modal; the top-bar × closes
// the terminal pane.
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.closest) return;
  const xc = t.closest('.xclose');
  if (xc) { const m = xc.closest('.modal'); if (m) m.classList.remove('open'); return; }
  if (t.closest('#paneClose')) { closePane(); return; }
  if (t.closest('#colBtn')) { setColcap(!colcapOn()); return; }
});
try { $('colBtn').classList.toggle('on', colcapOn()); } catch (_) {}
setConn('idle');
refresh();
setInterval(refresh, 5000);
refreshUsage();
setInterval(refreshUsage, 60000);
