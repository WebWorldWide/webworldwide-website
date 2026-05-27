FROM node:20-alpine

# System packages:
#   git, procps        — runtime for publish + monitoring
#   python3, make, g++ — better-sqlite3 native build on Alpine ARM64
#   vips, vips-tools,
#   vips-dev           — libvips runtime + headers for sharp (Phase 5 image pipeline)
#   libheif, libheif-tools
#                      — HEIC/HEIF decode support (Phase 5 image handler)
#   ffmpeg             — Phase 5b video/audio/animated-GIF transcode.
#                       Alpine's ffmpeg build includes libx264, libvpx,
#                       libmp3lame, libopus, and the loudnorm filter.
#   poppler-utils      — Phase 5c PDF preview generation (pdfinfo /
#                       pdftoppm). Ships a JPEG renderer + metadata
#                       extractor; ~20 MB image overhead on Alpine.
# sharp ships prebuilts for musl-arm64, but bundling vips/libheif keeps
# the fallback build path working and provides the heif decoder libvips
# dlopens at runtime.
RUN apk add --no-cache git procps python3 make g++ \
    vips vips-tools vips-dev libheif libheif-tools \
    ffmpeg poppler-utils

WORKDIR /app

# Copy package files
COPY package.json ./
RUN npm install --omit=dev

# Copy app code
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/

# Git config for the CMS user
RUN git config --global user.name "Terminal Eighty CMS" && \
    git config --global user.email "cms@terminaleighty.com" && \
    git config --global init.defaultBranch main && \
    git config --global --add safe.directory /app

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
