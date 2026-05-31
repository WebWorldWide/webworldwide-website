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

# Copy package files
COPY package.json ./
RUN npm install --omit=dev

# Copy app code
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/

# Git config for the CMS user
RUN git config --global user.name "Web World Wide CMS" && \
    git config --global user.email "cms@webworldwide.online" && \
    git config --global init.defaultBranch main && \
    git config --global --add safe.directory /app

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
