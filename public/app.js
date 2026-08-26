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

  // Typing directly into the terminal still works — the composer is additive.
  term.onData((d) => sendRaw(d));

  new ResizeObserver(() => {
    try {
      fit.fit();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    } catch (_) {}
  }).observe($('term'));
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
  current = sess;
  $('empty').style.display = 'none';
  $('termWrap').style.display = '';
  $('composerWrap').style.display = '';
  $('curName').textContent = sess.label || sess.name;
  $('curCwd').textContent = sess.cwd || '';
  term.clear();
  try { fit.fit(); } catch (_) {}

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?session=${encodeURIComponent(sess.name)}`
    + `&cols=${term.cols}&rows=${term.rows}`);
  ws.onopen = () => { setConn('live'); $('input').focus(); };
  ws.onmessage = (ev) => term.write(ev.data);
  ws.onclose = () => setConn('dead');
  ws.onerror = () => setConn('dead');
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
    window._sessions = j.sessions || [];
    render();
  } catch (_) { /* server restarting — next tick retries */ }
}

function render() {
  const list = $('list');
  const sessions = window._sessions || [];
  if (!sessions.length) {
    list.innerHTML = '<div style="color:var(--dim);font-size:12px;padding:12px 11px">'
      + 'No sessions yet.</div>';
    return;
  }
  list.innerHTML = '';
  for (const s of sessions) {
    const el = document.createElement('div');
    el.className = 'conv' + (current && current.name === s.name ? ' active' : '');
    el.draggable = true;
    el.dataset.name = s.name;
    const dot = s.dead ? 'dead' : s.active ? 'active' : s.attached ? 'attached' : '';
    // Prefer the live screen contents; fall back to the running command.
    const sub = s.dead ? 'dead — process gone'
      : (s.preview && s.preview.length ? s.preview[s.preview.length - 1]
        : (s.command || ''));
    el.innerHTML = `
      <div class="conv-actions">
        <button class="iconbtn" data-rename="${esc(s.name)}" title="Rename">&#9998;</button>
        ${s.self
          ? '<button class="iconbtn" disabled title="This session hosts the server">&#9635;</button>'
          : `<button class="iconbtn danger" data-kill="${esc(s.name)}" title="Delete">&#10005;</button>`}
      </div>
      <div class="conv-row">
        <span class="dot ${dot}" title="${esc(s.state || '')}${s.active ? ' — producing output' : ''}"></span>
        <span class="conv-title">${esc(s.label || s.name)}</span>
      </div>
      <div class="conv-sub">${esc(sub).slice(0, 200)}</div>`;
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.conv-actions')) return;
      // A drag ends with a click event on some browsers; ignore it.
      if (el.dataset.justDragged) { delete el.dataset.justDragged; return; }
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

  list.querySelectorAll('[data-kill]').forEach((b) => {
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const name = b.dataset.kill;
      if (!confirm(`Delete session ${name}?\n\nThe process running inside it will be terminated.`)) return;
      await fetch('/api/sessions/' + encodeURIComponent(name), { method: 'DELETE' });
      if (current && current.name === name) {
        current = null;
        $('curName').textContent = 'Screendeck';
        $('curCwd').textContent = '';
        $('empty').style.display = '';
        $('termWrap').style.display = 'none';
        $('composerWrap').style.display = 'none';
        setConn('idle');
      }
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
  for (const d of j.dirs) {
    const el = document.createElement('div');
    el.textContent = d.replace(j.path.replace(/\/$/, '') + '/', '  ');
    el.onclick = () => loadDirs(d);
    box.appendChild(el);
  }
}

function wireModal() {
  $('newBtn').onclick = () => { $('modal').classList.add('open'); loadDirs(); };
  $('mCancel').onclick = () => $('modal').classList.remove('open');
  $('modal').addEventListener('click', (e) => {
    if (e.target === $('modal')) $('modal').classList.remove('open');
  });
  $('mCreate').onclick = async () => {
    const btn = $('mCreate');
    btn.disabled = true;
    try {
      const r = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: $('mName').value.trim(),
          dir: $('mDir').value.trim(),
          command: $('mCommand').value.trim(),
        }),
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

$('hamb').onclick = () => {
  $('side').classList.toggle('hidden');
  setTimeout(() => { try { fit.fit(); } catch (_) {} }, 220);
};

initTerm();
wireClipboard();
wireComposer();
wireModal();
setConn('idle');
refresh();
setInterval(refresh, 5000);
