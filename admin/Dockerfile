FROM node:20-bookworm-slim

# Debian (glibc) base — not Alpine/musl. sharp 0.34 ships self-contained
# glibc prebuilts that install with NO source build (on Alpine it insisted on
# a source build that needs local node-gyp). Raspberry Pi OS is Debian/glibc
# too, so this also matches the deploy target.
#
# System packages:
#   git, procps        — runtime for publish + monitoring
#   ca-certificates    — TLS trust store. The slim base ships NONE, so
#                        `git push https://github.com/…` fails with
#                        "server certificate verification failed.
#                        CAfile: none" and the publish silently never
#                        reaches GitHub. This is REQUIRED for publish.
#   ffmpeg             — Phase 5b video/audio/animated-GIF transcode
#   poppler-utils      — Phase 5c PDF preview (pdfinfo / pdftoppm)
#   libheif1           — HEIC/HEIF decode (libvips dlopens it at runtime)
#   python3, make, g++ — fallback compile for any native dep without a
#                        prebuilt (better-sqlite3 normally ships one)
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates procps ffmpeg poppler-utils libheif1 python3 make g++ \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Mark /app as a trusted git worktree. The image's WORKDIR /app is created
# root-owned, while the bind-mounted .git/ and site/ are uid 1000 and the
# process runs as uid 1000 (compose `user:`). Git's ownership check sees
# the root-owned worktree root vs the uid-1000 caller and aborts EVERY
# command with "detected dubious ownership in repository at '/app'" — so
# publish can never `git add/commit/push`. A --system entry (in
# /etc/gitconfig, applied to all users without needing $HOME) clears it.
# git.js also passes `-c safe.directory=…` per-command as belt-and-suspenders.
RUN git config --system --add safe.directory /app

# Copy package files (lockfile included) and install the EXACT pinned
# tree — `npm ci` honors package-lock.json; `npm install` would silently
# drift from what CI tested.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy app code
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/
# Operational scripts (media/alt-text backfills) so they can run against
# the production DB volume: docker compose exec cms node scripts/<name>.js
COPY scripts/ ./scripts/

# The container runs as uid 1000 (compose `user:`), matching the host
# owner of the mounted site/ and .git. Git author identity comes from
# GIT_AUTHOR_* / GIT_COMMITTER_* env vars in docker-compose.yml. The only
# git config baked in is the --system safe.directory above (required for
# publish to run at all under the root-owned WORKDIR).

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
