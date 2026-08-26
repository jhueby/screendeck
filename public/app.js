/* Screendeck — front end.
 *
 * One xterm instance, re-attached as you switch sessions. Closing the socket
 * detaches from screen rather than killing it, so the session keeps running.
 */
'use strict';

const $ = (id) => document.getElementById(id);
let term, fit, ws, current = null;

function initTerm() {
  term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 20000,
    theme: {
      background: '#0f1115', foreground: '#d6dae2', cursor: '#6ea8fe',
      selectionBackground: '#2b3a55',
    },
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('term'));

  term.onData((d) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: d }));
    }
  });

  const ro = new ResizeObserver(() => {
    try {
      fit.fit();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    } catch (_) {}
  });
  ro.observe($('term'));
}

function setConn(state) {
  const el = $('conn');
  el.className = 'pill' + (state === 'live' ? ' live' : state === 'dead' ? ' dead' : '');
  el.textContent = state === 'live' ? 'attached' : state === 'dead' ? 'detached' : 'idle';
}

function attach(sess) {
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
  current = sess;
  $('empty').style.display = 'none';
  $('term').style.display = '';
  $('curName').textContent = sess.name;
  $('curCwd').textContent = sess.cwd || '';
  term.clear();
  try { fit.fit(); } catch (_) {}

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?session=${encodeURIComponent(sess.name)}`
            + `&cols=${term.cols}&rows=${term.rows}`;
  ws = new WebSocket(url);
  ws.onopen = () => { setConn('live'); term.focus(); };
  ws.onmessage = (ev) => term.write(ev.data);
  ws.onclose = () => setConn('dead');
  ws.onerror = () => setConn('dead');
  render();
}

async function refresh() {
  try {
    const r = await fetch('/api/sessions');
    const j = await r.json();
    $('host').textContent = j.host || '';
    window._sessions = j.sessions || [];
    render();
  } catch (_) { /* server restart — next tick will retry */ }
}

function render() {
  const list = $('list');
  const sessions = window._sessions || [];
  if (!sessions.length) {
    list.innerHTML = '<div style="color:#8b93a3;font-size:12px;padding:12px">'
      + 'No screen sessions.<br><br>Create one below, or start one from a shell:'
      + '<br><code style="font-size:11px">screen -S mine bash</code></div>';
    return;
  }
  list.innerHTML = '';
  for (const s of sessions) {
    const el = document.createElement('div');
    el.className = 'sess' + (current && current.name === s.name ? ' active' : '');
    const shortCmd = s.command ? s.command.replace(/^\/\S+\//, '') : '—';
    const killBtn = s.self
      ? '<span class="kill self" title="This session hosts the server — killing it would stop Screendeck">server</span>'
      : `<button class="kill" data-kill="${s.name}">kill</button>`;
    el.innerHTML = `
      ${killBtn}
      <div class="row1">
        <span class="dot ${s.attached ? 'attached' : ''}"></span>
        <span class="name">${s.label || s.name}</span>
      </div>
      <div class="cmd">${shortCmd}</div>
      <div class="meta">${s.cwd || ''}<br>${s.created}</div>`;
    el.addEventListener('click', (ev) => {
      if (ev.target.dataset.kill) return;
      attach(s);
    });
    list.appendChild(el);
  }
  list.querySelectorAll('[data-kill]').forEach((b) => {
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const name = b.dataset.kill;
      if (!confirm(`Kill session ${name}?\n\nThe process running inside it will be terminated.`)) return;
      await fetch('/api/sessions/' + encodeURIComponent(name), { method: 'DELETE' });
      if (current && current.name === name) {
        current = null;
        $('curName').textContent = 'no session selected';
        $('curCwd').textContent = '';
        $('empty').style.display = '';
        setConn('idle');
      }
      refresh();
    });
  });
}

/* ---------- new-session modal ---------- */
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
    const body = {
      name: $('mName').value.trim(),
      dir: $('mDir').value.trim(),
      command: $('mCommand').value.trim(),
    };
    const btn = $('mCreate');
    btn.disabled = true; btn.textContent = 'Creating…';
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
      // screen needs a moment to register before -x will attach
      setTimeout(() => {
        const s = (window._sessions || []).find((x) => x.name.includes(j.session));
        if (s) attach(s);
      }, 700);
    } finally {
      btn.disabled = false; btn.textContent = 'Create';
    }
  };
}

initTerm();
wireModal();
refresh();
setInterval(refresh, 5000);
