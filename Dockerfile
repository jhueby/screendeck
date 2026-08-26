# Screendeck — web console for GNU screen sessions.
#
# Sessions live INSIDE this container. That is the deliberate choice: it keeps
# the container self-contained and portable. The consequence is that sessions do
# not survive `docker rm`, and anything you want to run must be present in the
# image (or bind-mounted in).
#
# If you instead want to manage sessions on the HOST, do not use this image —
# run server.js directly on the host. Reaching host screen sockets from inside a
# container needs --pid=host plus a bind mount of /run/screen, which gives the
# container effective control of host processes and is not a trade worth making
# by default.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
# node-pty needs a toolchain to build; kept in a separate stage so the runtime
# image does not carry a compiler.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:20-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      screen procps ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY server.js screenrc package.json ./
COPY public ./public

# screen refuses to start without a writable socket directory owned correctly.
RUN mkdir -p /run/screen && chmod 777 /run/screen

ENV PORT=7681 \
    BIND=0.0.0.0 \
    DEFAULT_COMMAND=bash \
    SESSION_PREFIX=sd- \
    DEFAULT_DIR=/workspace \
    WORKSPACE_ROOT=/workspace \
    TERM=xterm-256color

RUN mkdir -p /workspace
VOLUME ["/workspace"]

EXPOSE 7681

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||7681)+'/api/config',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# tini so signals reach node and orphaned screen processes get reaped
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
