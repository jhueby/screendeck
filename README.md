# Screendeck

A web console for GNU `screen` sessions. List, attach to, create and kill
long-running terminal sessions from a browser, with a real interactive terminal
(colors, arrow keys, Ctrl-C, resize) rather than a read-only log tail.

Useful when you keep long-lived jobs in `screen` and want to check on them from
a laptop or phone without SSHing in.

## Why screen as the backend

Sessions are plain `screen` sessions. That means:

- they keep running when you close the browser, restart this server, or lose the network
- you can always fall back to `screen -r <name>` from a shell
- nothing is stored in a database; `screen -ls` is the source of truth

The web UI is a view onto them, never the thing keeping them alive.

## ⚠️ Security

**Screendeck ships with no authentication.** Anyone who can reach the port gets
an interactive shell as the user running the process.

Choose one:

- bind to `127.0.0.1` and reach it over an SSH tunnel or VPN (default in `docker-compose.yml`)
- put an authenticating reverse proxy in front (Caddy, nginx + basic auth, oauth2-proxy)
- restrict with a firewall to trusted hosts

Do not expose it to the internet as-is.

## Run with Docker

```bash
docker compose up -d --build
# then open http://127.0.0.1:7681
```

Sessions live **inside** the container, so:

- they do **not** survive `docker restart` or `docker rm`. A container restart
  kills every process in it; screen's socket file survives on the container
  filesystem, so the session lingers as `Dead ???` until it is wiped. Screendeck
  clears these at startup.
- whatever you want to run must exist in the image, or be bind-mounted in
- `./workspace` is mounted at `/workspace` and is where new sessions start

To manage sessions on the **host** instead, don't use the image — run the server
directly (below). Reaching host `screen` sockets from a container requires
`--pid=host` plus a bind mount of `/run/screen`, which effectively gives the
container control of host processes. That trade isn't made here by default.

## Run directly

```bash
npm install
node server.js
```

Requires Node 18+, `screen`, and `procps` (for `pgrep`). `node-pty` compiles
natively, so a toolchain (`python3`, `make`, `g++`) must be present at install
time.

## Running as a service

See [`screendeck.service.example`](screendeck.service.example).

**One trap worth knowing:** systemd's default `KillMode=control-group` kills
everything in the service's cgroup on restart. screen daemonises its sessions
but they remain in that cgroup, so restarting Screendeck would terminate every
session it had started. The example unit sets `KillMode=process` to prevent
that — verified by restarting the service with live sessions attached.

## Configuration

All optional, via environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `7681` | listen port |
| `BIND` | `0.0.0.0` | listen address |
| `DEFAULT_COMMAND` | `$SHELL` or `bash` | what a new session runs |
| `DEFAULT_DIR` | `$HOME` | starting directory for new sessions |
| `WORKSPACE_ROOT` | *(unset)* | restrict the directory browser to this subtree |
| `SESSION_PREFIX` | `sd-` | prefix for session names created here |
| `STATE_FILE` | `~/.screendeck-order.json` | where the sidebar ordering is persisted |

`DEFAULT_COMMAND` is what makes this general — point it at a shell, a REPL, a
build watcher, a monitoring tool, or any long-running CLI.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/sessions` | list sessions with pid, cwd, running command, attach state |
| `POST` | `/api/sessions` | create one — `{name, dir, command}` |
| `PATCH` | `/api/sessions/:name` | rename — `{newName}` |
| `DELETE` | `/api/sessions/:name` | kill a session |
| `GET`/`PUT` | `/api/order` | read/write the sidebar ordering |
| `GET` | `/api/dirs?path=` | browse directories for the new-session dialog |
| `GET` | `/api/config` | effective defaults |
| `WS` | `/ws?session=&cols=&rows=` | attach a terminal |

## Copy and paste

| Action | How |
|---|---|
| Copy selection | select text, or `Ctrl+Shift+C`, or `Ctrl+C` when text is selected |
| Paste | `Ctrl+V` (also `Ctrl+Shift+V`, middle-click) |
| Copy on touch | **Copy** button — copies the selection, or the visible screen if nothing is selected |
| Select = copy | toggle button; copies automatically on selection, like most terminals |

`Ctrl+C` only copies when something is selected. With no selection it passes
through as SIGINT, so interrupting a running process still works.

**Over plain HTTP, the Paste *button* will not work.** Browsers gate
`navigator.clipboard` behind a secure context, so reading the clipboard
programmatically is unavailable on a LAN address. `Ctrl+V` is unaffected — a
user-initiated paste fires a native event that does not need the API. Copying
falls back to `execCommand`, which still works on HTTP.

To get the Paste button working, serve over HTTPS (a reverse proxy with a
certificate) or reach it via `localhost` — both count as secure contexts.

## Behaviour worth knowing

- **Attach uses `screen -x`, not `-r`.** Opening a browser tab does not steal the
  session from an existing SSH attach, and two tabs can watch the same session.
- **Closing a tab detaches, it does not kill.** The socket close sends `Ctrl-A d`.
  Only the explicit *kill* button terminates a session.
- **Session labels** strip the hostname that `screen` appends to auto-named
  sessions, since every session on a host would otherwise show the same label.
- **Working directory** is read from the session's child process via `/proc`,
  not from where `screen` itself was launched.
- **Ordering is drag-and-drop** and stored server-side, so it is the same from
  every device rather than per-browser. New sessions appear at the top.
- **Previews** come from `screen -X hardcopy`, which reads a session's visible
  screen without attaching. Comparing successive captures also gives the
  "currently producing output" indicator.

## Requirements

- Node 18+
- GNU `screen`
- `procps` (`pgrep`)
- Linux (reads `/proc` for session metadata)

## License

MIT — see [LICENSE](LICENSE).
