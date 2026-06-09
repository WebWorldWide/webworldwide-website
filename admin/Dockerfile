FROM node:20-bookworm-slim

# Debian (glibc) base — not Alpine/musl. sharp 0.34 ships self-contained
# glibc prebuilts that install with NO source build (on Alpine it insisted on
# a source build that needs local node-gyp). Raspberry Pi OS is Debian/glibc
# too, so this also matches the deploy target.
#
# System packages:
#   git, procps        — runtime for publish + monitoring
#   ffmpeg             — Phase 5b video/audio/animated-GIF transcode
#   poppler-utils      — Phase 5c PDF preview (pdfinfo / pdftoppm)
#   libheif1           — HEIC/HEIF decode (libvips dlopens it at runtime)
#   python3, make, g++ — fallback compile for any native dep without a
#                        prebuilt (better-sqlite3 normally ships one)
RUN apt-get update && apt-get install -y --no-install-recommends \
      git procps ffmpeg poppler-utils libheif1 python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

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
# GIT_AUTHOR_* / GIT_COMMITTER_* env vars in docker-compose.yml — no
# root-only `git config --global` here.

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
