# syntax=docker/dockerfile:1.7
#
# nuvio-sync — Stremio subtitle addon with Nuvio-style auto sync.
#
# The addon has ZERO runtime npm dependencies, so the image is just Node plus the source tree.
# ffmpeg is the only real extra: it powers the optional audio alignment stage. Pass
# --build-arg INSTALL_FFMPEG=0 for a ~80 MB smaller image that runs everything except that stage.
#
ARG NODE_VERSION=24-bookworm-slim
FROM node:${NODE_VERSION}

ARG INSTALL_FFMPEG=1
ARG ALASS_VERSION=v2.0.0
# Build identity — surfaced by /healthz, /stats, the boot log and /configure so you can tell
# which build a running container actually is.
ARG GIT_SHA=unknown
ARG BUILD_TIME=

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# tini reaps zombies and forwards SIGTERM, so `docker stop` is a clean shutdown.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# alass is a static x86_64 binary; install it only where it can actually run.
RUN set -eux; \
    if [ "${INSTALL_FFMPEG}" = "1" ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends ffmpeg; \
      rm -rf /var/lib/apt/lists/*; \
      if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
        node -e "fetch('https://github.com/kaegi/alass/releases/download/${ALASS_VERSION}/alass-linux64') \
          .then(r => r.arrayBuffer()) \
          .then(b => require('node:fs').writeFileSync('/usr/local/bin/alass', Buffer.from(b), { mode: 0o755 })) \
          .catch(e => { console.warn('alass download skipped (optional):', e.message); })" \
        && test -x /usr/local/bin/alass || echo "alass not installed (optional, the JS aligner is the default anyway)"; \
      fi; \
    fi

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7878 \
    DATA_DIR=/data \
    LOG_LEVEL=info \
    GIT_SHA=${GIT_SHA} \
    BUILD_TIME=${BUILD_TIME}

WORKDIR /app

# No dependency tree to install: copy the manifest for provenance, then the code.
COPY package.json package-lock.json* ./
COPY src ./src
COPY samples ./samples
COPY public ./public
COPY docs ./docs
COPY README.md README.md
COPY LICENSE* ./

RUN mkdir -p /data \
 && chown -R node:node /data /app \
 && node -e "import('./src/contracts.js').then(m => console.log('contracts v' + m.CONTRACT_VERSION))"

USER node

VOLUME ["/data"]
EXPOSE 7878

# No curl in the image on purpose — node is already there.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||7878)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
