# Web World Wide Blog Architecture

[![Quality](https://github.com/AdamNolle/web-world-wide-online/actions/workflows/quality.yml/badge.svg)](https://github.com/AdamNolle/web-world-wide-online/actions/workflows/quality.yml)
[![E2E + a11y](https://github.com/AdamNolle/web-world-wide-online/actions/workflows/e2e.yml/badge.svg)](https://github.com/AdamNolle/web-world-wide-online/actions/workflows/e2e.yml)
[![Lighthouse](https://github.com/AdamNolle/web-world-wide-online/actions/workflows/lighthouse.yml/badge.svg)](https://github.com/AdamNolle/web-world-wide-online/actions/workflows/lighthouse.yml)
[![Deploy](https://github.com/AdamNolle/web-world-wide-online/actions/workflows/deploy.yml/badge.svg)](https://github.com/AdamNolle/web-world-wide-online/actions/workflows/deploy.yml)

Welcome to **Web World Wide**, a high-performance, $0/month, self-hosted blog stack designed for Raspberry Pi. It replaces bloated, database-heavy platforms (like Ghost or WordPress) with a hyper-fast static site generator and a lightweight Node.js admin panel.

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development, the quality pipeline, and branch-protection setup.

## Quickstart (local dev)

A fresh clone runs the entire stack — Astro, the admin CMS, Remark42, Umami,
and Postgres — on a laptop (Windows, macOS, or Linux) in two commands.

**Requires**: Node 22+ and Docker. Start Docker before running the dev
command.

| Platform | Docker option(s)                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------- |
| Windows  | Docker Desktop (with WSL2 backend recommended)                                                          |
| macOS    | Docker Desktop, OrbStack, or Colima — any one works                                                     |
| Linux    | Docker Engine (`apt install docker.io` or distro equivalent) — start with `sudo systemctl start docker` |

```bash
git clone https://github.com/AdamNolle/web-world-wide-online
cd web-world-wide-online
npm install        # cascades into site/ and admin/ on first run
npm run dev        # preflight → docker + astro + admin in parallel
```

The same two commands work identically on Windows (PowerShell or Git
Bash), macOS, and Linux. `npm run dev` shells through
`npm-run-all2`/`run-p`, which uses platform-native parallel execution
on all three; no bash-isms in any npm script.

The first `npm install` takes a few minutes (pulls Astro, React, Three.js,
TipTap, better-sqlite3 prebuilt binaries). Subsequent runs are fast.

`npm run dev` runs a preflight that auto-creates `docker/.env.dev` from
`.env.dev.example` and verifies Docker is reachable — if Docker isn't
running it tells you so and exits cleanly.

Open:

- Public site: <http://localhost:4321>
- Admin: <http://localhost:3000> (log in: `admin` / `password`)
- Comments (Remark42): <http://localhost:8081> (admin user: `admin`)
- Analytics (Umami): <http://localhost:3001> (configure on first visit)

Operational scripts:

- `npm run dev:check` — ping every service, print a status table, non-zero on any failure
- `npm run db:seed` — create the admin user (`admin`/`password`) and 5 sample media rows
- `npm run db:reset` — wipe the local DB and dev uploads, then re-seed (prompts unless `--yes`)
- `npm run dev:stop` — shut down the Docker services
- `npm run dev:site` / `npm run dev:admin` — run just the Astro site or just the admin (no Docker)

WebAuthn uses `rpID=localhost` in dev, so passkeys work without HTTPS on
every browser. Register one from **Settings → Security** after first login.

## The Stack

- **Site Generator**: Astro 5 (compiles Markdown + React islands into ultra-fast static HTML)
- **CMS Admin**: Custom Node.js/Express Dashboard with WebAuthn (Passkeys)
- **Analytics**: Umami (Self-hosted privacy-friendly analytics via PostgreSQL)
- **Comments**: Remark42 (Self-hosted privacy-focused commenting engine)
- **Reverse Proxy**: Caddy (Automatic HTTPS and routing)
- **Tunneling**: Cloudflare Tunnel (Exposes your Pi to the internet securely without port-forwarding)

## Feature matrix

The full stack ships everything a personal blog needs out of the box. Every
capability has a CONTRIBUTING.md section explaining how it's wired and how to
extend it.

| Capability                      | What it gives you                                                                                             | Where it's documented                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Local development**           | One-command full stack (Astro + admin + Remark42 + Umami + Postgres)                                          | [Local development](CONTRIBUTING.md#local-development)                                                 |
| **Passkey auth**                | WebAuthn passkeys for passwordless admin login (Touch ID / Face ID / Windows Hello)                           | [Passkeys in local dev](CONTRIBUTING.md#passkeys-in-local-dev)                                         |
| **Block editor**                | TipTap + CodeMirror with slash commands, tables, callouts, math, footnotes, code highlighting, find & replace | [Editor shortcuts](CONTRIBUTING.md#editor-shortcuts)                                                   |
| **Block types**                 | Headings, lists, blockquotes, tables, callouts, KaTeX math, footnotes, code blocks with syntax highlighting   | [Editor block types](CONTRIBUTING.md#editor-block-types)                                               |
| **Media library**               | Drop any file — auto-converts images (AVIF/WebP/responsive srcset), video, audio, PDFs, archives, code        | [Testing the conversion pipeline](CONTRIBUTING.md#testing-the-conversion-pipeline)                     |
| **Authoring extras**            | Scheduled publishing, draft preview links, per-post custom CSS/JS, cover images, redirects, activity log      | [Phase 5e — CMS authoring extras](CONTRIBUTING.md#phase-5e--cms-authoring-extras)                      |
| **Embeds**                      | Paste-to-embed for YouTube, Vimeo, Bluesky, Mastodon, CodePen, Gist, Spotify, SoundCloud, TikTok + generic OG | [Phase 7 — embeds](CONTRIBUTING.md#phase-7--embeds-paste-to-embed)                                     |
| **Fediverse**                   | h-card / h-entry microformats, webmention receiver, Bridgy Fed federation, Mastodon-style replies             | [Phase 8 — Fediverse federation](CONTRIBUTING.md#phase-8--fediverse-federation-via-bridgy-fed)         |
| **Comments**                    | Unified moderation queue (Remark42 + webmentions + Bluesky) with SSE live updates and one-tap reply           | [Phase 8.5 — unified comment moderation](CONTRIBUTING.md#phase-85--unified-comment-moderation)         |
| **Bluesky**                     | AT Protocol cross-post on publish + thread embed; mirrors thread replies into the moderation queue            | [Phase 9 — Bluesky cross-post](CONTRIBUTING.md#phase-9--at-protocol--bluesky-cross-post--thread-embed) |
| **Accessibility (WCAG 2.2 AA)** | Skip links, focus traps, contrast tokens, motion respect, status independence, axe-core in CI                 | [Accessibility](CONTRIBUTING.md#accessibility-wcag-22-aa)                                              |
| **Performance**                 | Inline critical CSS, fingerprinted JS + SRI, responsive images, lazy embeds, CSP, Lighthouse gates            | [Performance](CONTRIBUTING.md#performance-phase-11)                                                    |

## Operational checklist

The first push to `main` triggers `deploy.yml` (already wired). Before that,
read [MIGRATION.md](MIGRATION.md) for the post-merge steps: GitHub branch
protection, Bluesky / SMTP / Bridgy Fed credentials, and the two cron entries
that drive scheduled publish + webmention dump.

## Thanks

This stack stands on the shoulders of:

[Astro](https://astro.build) (static site engine + React islands),
[TipTap](https://tiptap.dev) + [ProseMirror](https://prosemirror.net) (editor),
[CodeMirror](https://codemirror.net) (raw markdown / code panes),
[KaTeX](https://katex.org) (math),
[Express](https://expressjs.com) + [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (admin backend),
[Bridgy Fed](https://fed.brid.gy) (Fediverse bridge),
[Remark42](https://remark42.com) (comments),
[Umami](https://umami.is) (analytics),
[Caddy](https://caddyserver.com) (HTTPS + reverse proxy),
[Cloudflare Tunnel](https://www.cloudflare.com/products/tunnel/) (secure ingress),
[@atproto/api](https://github.com/bluesky-social/atproto) (Bluesky / AT Protocol),
[axe-core](https://github.com/dequelabs/axe-core) + [Playwright](https://playwright.dev) (a11y + e2e),
[Vitest](https://vitest.dev) + [node:test](https://nodejs.org/api/test.html) (unit tests),
[Lighthouse CI](https://github.com/GoogleChrome/lighthouse-ci) (perf budget).

## How It Works

1. You access the **Admin CMS** (`admin.yourdomain.com`) from your phone or laptop using Touch ID / Face ID.
2. You write a post using the WYSIWYG editor and hit `Save`. The post is saved as a `.md` file on the Raspberry Pi.
3. You click `[PUBLISH SITE]`. The CMS commits the markdown files to GitHub.
4. GitHub Actions automatically builds the Astro site and deploys it to GitHub Pages for free, global CDN hosting.
5. Visitors view your ultra-fast site while Umami and Remark42 handle analytics and comments via the Cloudflare Tunnel.

## Setup Instructions

### 1. Prerequisites

- A Raspberry Pi (or any Linux server)
- A Cloudflare account with a Domain name
- A GitHub account and a Personal Access Token (PAT)

### 2. Cloudflare Zero Trust

1. Create a Cloudflare Tunnel in Zero Trust.
2. Add Public Hostnames pointing to `http://caddy:80` for:
   - `admin.yourdomain.com`
   - `comments.yourdomain.com`
   - `analytics.yourdomain.com`

### 3. Pi Bootstrap

SSH into your fresh Raspberry Pi OS Lite (64-bit) and run:

```bash
sudo apt-get update -y && sudo apt-get install -y git
sudo git clone https://github.com/AdamNolle/web-world-wide-online.git /opt/web-world-wide
sudo /opt/web-world-wide/scripts/bootstrap.sh
```

The script is idempotent — re-running on an already-set-up Pi prints "all
phases healthy" in under 30 seconds. On a fresh Pi it:

1. Verifies arch, OS, disk, network connectivity (fail-fast).
2. Installs Docker, Node 22, and required apt packages.
3. Sets up a 2 GB swapfile.
4. Prompts for your **Cloudflare Tunnel token** and **GitHub PAT** (with `--cf-token=` and `--gh-pat=` flag overrides for scripted runs).
5. Validates the Cloudflare token against the Cloudflare API in under 5 seconds.
6. Generates random secrets, creates `docker/.env`, brings the stack up.
7. Installs systemd boot-check + cron jobs (backups, auto-update, maintenance).
8. Polls every service with backoff until all healthy, then prints a status table.
9. Generates the age-encrypted backup keypair and pushes the public key to `www-blog-backups` (creates the repo automatically if your PAT has `repo` scope).
10. Prints the age private key **last** — save it to a password manager before closing the SSH session.

Expected runtime on a Pi 5 with good network: under 6 minutes from `sudo ./bootstrap.sh` to passkey-registration prompt.

### 4. Admin Setup

1. Go to `admin.yourdomain.com`
2. Create your first admin account.
3. Once logged in, click "Register Passkey" to bind your device (Face ID / Touch ID) for instant passwordless logins.

## Backups

The `bootstrap.sh` script automatically sets up daily automated backups of your SQLite Auth DB, PostgreSQL analytics, and Remark42 comments. These are encrypted using `age` and pushed to a private `www-blog-backups` repository.

Enjoy your blazingly fast, fully-owned piece of the internet!
