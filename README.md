# Terminal Eighty Blog Architecture

[![Quality](https://github.com/AdamNolle/terminal-eighty-blog/actions/workflows/quality.yml/badge.svg)](https://github.com/AdamNolle/terminal-eighty-blog/actions/workflows/quality.yml)
[![E2E + a11y](https://github.com/AdamNolle/terminal-eighty-blog/actions/workflows/e2e.yml/badge.svg)](https://github.com/AdamNolle/terminal-eighty-blog/actions/workflows/e2e.yml)
[![Lighthouse](https://github.com/AdamNolle/terminal-eighty-blog/actions/workflows/lighthouse.yml/badge.svg)](https://github.com/AdamNolle/terminal-eighty-blog/actions/workflows/lighthouse.yml)
[![Deploy](https://github.com/AdamNolle/terminal-eighty-blog/actions/workflows/deploy.yml/badge.svg)](https://github.com/AdamNolle/terminal-eighty-blog/actions/workflows/deploy.yml)

Welcome to **Terminal Eighty**, a high-performance, $0/month, self-hosted blog stack designed for Raspberry Pi. It replaces bloated, database-heavy platforms (like Ghost or WordPress) with a hyper-fast static site generator and a lightweight Node.js admin panel.

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development, the quality pipeline, and branch-protection setup.

## Quickstart (local dev)

A fresh clone runs the entire stack — Hugo, the admin CMS, Remark42, Umami,
and Postgres — on a laptop in one command.

```bash
git clone https://github.com/AdamNolle/terminal-eighty-blog
cd terminal-eighty-blog
npm install
cp docker/.env.dev.example docker/.env.dev
npm run db:seed       # creates admin user (admin / password) and 5 sample media rows
npm run dev:all       # docker (Remark42 + Umami + Postgres) + hugo + admin in parallel
```

Open:

- Public site: <http://localhost:1313>
- Admin: <http://localhost:3000> (log in: `admin` / `password`)
- Comments (Remark42): <http://localhost:8081> (admin user: `admin`)
- Analytics (Umami): <http://localhost:3001> (configure on first visit)

Operational scripts:

- `npm run dev:check` — ping every service, print a status table, non-zero on any failure
- `npm run db:reset` — wipe the local DB and dev uploads, then re-seed (prompts unless `--yes`)
- `npm run dev:stop` — shut down the Docker services

WebAuthn uses `rpID=localhost` in dev, so passkeys work without HTTPS on
every browser. Register one from **Settings → Security** after first login.

## The Stack

- **Site Generator**: Hugo (compiles Markdown into ultra-fast static HTML)
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
| **Local development**           | One-command full stack (Hugo + admin + Remark42 + Umami + Postgres)                                           | [Local development](CONTRIBUTING.md#local-development)                                                 |
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

[Hugo](https://gohugo.io) (static site engine),
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
4. GitHub Actions automatically compiles the Hugo site and deploys it to GitHub Pages for free, global CDN hosting.
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

SSH into your fresh Raspberry Pi OS Lite and run:

```bash
wget https://raw.githubusercontent.com/YourUser/terminal-eighty-blog/main/scripts/bootstrap.sh
chmod +x bootstrap.sh
./bootstrap.sh
```

Follow the prompts to enter your GitHub PAT and Cloudflare Token. The script will install Docker, configure your environment secrets, and boot the entire stack!

### 4. Admin Setup

1. Go to `admin.yourdomain.com`
2. Create your first admin account.
3. Once logged in, click "Register Passkey" to bind your device (Face ID / Touch ID) for instant passwordless logins.

## Backups

The `bootstrap.sh` script automatically sets up daily automated backups of your SQLite Auth DB, PostgreSQL analytics, and Remark42 comments. These are encrypted using `age` and pushed to a private `terminal-eighty-backups` repository.

Enjoy your blazingly fast, fully-owned piece of the internet!
