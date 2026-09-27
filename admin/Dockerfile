FROM node:22-bookworm-slim AS build

# Native modules compile here when a prebuilt binary is unavailable. The
# compiler toolchain never reaches the production image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build/admin
COPY admin/package.json admin/package-lock.json ./
RUN npm ci

COPY admin/tsconfig.json ./
COPY admin/server.ts ./
COPY admin/src/ ./src/
COPY admin/client/ ./client/
COPY admin/public/ ./public/
COPY admin/scripts/ ./scripts/
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

# Runtime-only tools used by publishing, health checks, and media conversion.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates procps util-linux ffmpeg poppler-utils libheif1 \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN git config --system --add safe.directory /app

COPY --from=build /build/admin/node_modules ./node_modules
COPY --from=build /build/admin/dist/admin ./
COPY --from=build /build/admin/public ./public/

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
