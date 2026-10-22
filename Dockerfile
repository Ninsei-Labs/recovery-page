# syntax=docker/dockerfile:1
#
# THE PAGE IN A CONTAINER: Bun builds it and Bun serves it. No Node anywhere.
#
# WHY THIS IS POSSIBLE. The build is esbuild plus a few file operations; Bun runs the same scripts
# (`bun build/build.mjs`, `bun tools/check.mjs`), installs from `bun.lock` and is the runtime that
# serves the result. Keeping a second toolchain in the image would add a package manager and a
# dependency tree the running container never uses.
#
# WHY TWO STAGES, BOTH BUN. The build stage needs node_modules and esbuild; the runtime stage needs a
# directory and one file. Copying only `dist/` and `serve.bun.mjs` leaves an image with no package
# manager and nothing to audit.
#
# TLS IS NOT HERE. The container speaks HTTP. Put it behind a reverse proxy that terminates TLS and
# passes the two Cross-Origin-* headers through untouched; without them the page cannot use
# SharedArrayBuffer and the wallet will not start.

FROM oven/bun:1.4.4-slim AS build
WORKDIR /src

# Dependencies first: the lock file changes less often than the page, so this layer is cached.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
# Build and then the repository's own checks: a broken page fails the image, not a visitor.
RUN bun build/build.mjs && bun tools/check.mjs

FROM oven/bun:1.4.4-slim AS runtime

ENV TZ=UTC \
    NODE_ENV=production \
    PORT=8080 \
    ROOT=/srv/recovery

# tzdata keeps timestamps honest in logs; ca-certificates is what a reverse proxy or an operator's
# tooling may need. No secret ever enters through this file.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY --from=build /src/dist ./recovery
COPY serve.bun.mjs ./serve.bun.mjs

# A FIXED, UNPRIVILEGED UID: a runtime that changes identity between hosts is one whose file
# permissions surprise the next operator. 10001 is the convention used by the other services here.
RUN chown -R 10001:10001 /srv
USER 10001:10001

EXPOSE 8080

# THE PAGE IS THE HEALTH CHECK, fetched over HTTP like a browser would: status 2xx AND the page's own
# marker in the body. A listener that answers 404, or an index that points at assets that are not
# there, fails here instead of in a support report.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/index.html" | grep -q "Ninsei recovery" || exit 1

# Bun handles SIGTERM itself and closes the listener; naming the signal keeps an orchestrator from
# guessing.
STOPSIGNAL SIGTERM

CMD ["bun", "serve.bun.mjs"]
