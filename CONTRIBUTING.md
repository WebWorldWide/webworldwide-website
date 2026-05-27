# Contributing to Terminal Eighty

Thanks for the interest. This is a personal blog stack, but the quality bar applies
to every contribution — including future-me.

## Layout

```text
.
├── site/        Hugo static site (public-facing blog)
│   ├── assets/  CSS pipeline
│   ├── content/ Markdown posts
│   ├── layouts/ Hugo Go templates
│   └── static/  Static assets including site/static/js/app.js
├── admin/       Express CMS (runs on the Pi, never deployed to Pages)
├── migrate/     One-shot Ghost → Hugo migrator
├── scripts/     Bootstrap, backup, restore, maintenance shell scripts
├── docker/      Compose stack for the Pi
└── test/        Cross-cutting Playwright + fixtures
```

## Local development

You need Node 20 LTS or newer, Hugo extended ≥ 0.161, and Docker (for the
full-stack mode below). macOS, Linux, and WSL are all supported.

### Quickstart (full stack)

The Phase 5d scripts boot Hugo + admin + Remark42 + Umami + Postgres in one
command. Use this when you want to exercise the complete authoring loop.

```bash
npm install
cd admin && npm install && cd ..
cp docker/.env.dev.example docker/.env.dev
npm run db:seed          # admin user "admin" / "password" + 5 media fixtures
npm run dev:all          # Docker + hugo + admin in parallel, colored logs
```

| Script               | What it does                                                           |
| -------------------- | ---------------------------------------------------------------------- |
| `npm run dev:all`    | `run-p` over `dev:docker`, `dev:hugo`, `dev:admin` (the full stack)    |
| `npm run dev:docker` | Foreground `docker compose up` against `docker/docker-compose.dev.yml` |
| `npm run dev:hugo`   | `hugo server --buildDrafts --buildFuture` on port `1313`               |
| `npm run dev:admin`  | `node --watch server.js` in `admin/` on port `3000`                    |
| `npm run dev:check`  | Ping every service, print status table, exit non-zero on any failure   |
| `npm run db:seed`    | Idempotent — creates admin user + media fixtures                       |
| `npm run db:reset`   | Wipe dev DB + dev uploads, re-seed (prompts; pass `--yes` to skip)     |
| `npm run dev:stop`   | `docker compose down`                                                  |

Service ports (deliberately offset from prod so both compose files could
coexist on one host):

| Service   | Dev URL                 | Notes                                                 |
| --------- | ----------------------- | ----------------------------------------------------- |
| Hugo      | <http://localhost:1313> | Drafts + future posts visible                         |
| Admin CMS | <http://localhost:3000> | `admin` / `password` after `npm run db:seed`          |
| Remark42  | <http://localhost:8081> | Admin auth: user `admin`, password `admin`            |
| Umami     | <http://localhost:3001> | Admin/admin on first visit; will prompt to change pwd |
| Postgres  | `localhost:5433`        | Database `umami`, user `umami`                        |

### Passkeys in local dev

WebAuthn's `rpID` is set to `localhost` in dev, so passkeys work on every
modern browser without HTTPS. After logging in with the seeded password,
hit **Settings → Security → Register Passkey** to bind Touch ID / Windows
Hello to the dev admin user. The credential is stored in
`admin/data/auth-dev.db` and lost the next time you run `npm run db:reset`.

### Testing the conversion pipeline

Drop any file into the media library (`/media` in the admin) — the
conversion worker picks it up immediately and writes derived variants into
`site/static/images/<id>/` (images) or `site/static/files/<id>/` (video,
audio, PDF, archives). Watch the admin terminal — every job logs with the
`[conversion-worker]` prefix. If a job hangs, delete its row from the
`conversion_jobs` table:

```bash
sqlite3 admin/data/auth-dev.db \
  "DELETE FROM conversion_jobs WHERE status IN ('running', 'pending');"
```

The worker reads its claim cursor on the next tick, so deletes take effect
without restarting the admin.

### Testing oEmbed (Phase 6 sneak peek)

Paste a YouTube / Vimeo / Bluesky URL into the editor on a line by itself.
The TipTap embed extension (lands in Phase 6 — Phase 5d ships the
plumbing) calls the admin's `/api/embed?url=…` endpoint, which proxies to
the source oEmbed provider with a 5-second timeout.

### Light-loop alternative (no Docker)

If you only need the admin + Hugo (no comments/analytics), the legacy
two-terminal flow still works:

```bash
npm run dev:site         # hugo server on http://127.0.0.1:1414
npm run dev:admin        # admin CMS on http://localhost:3000
```

### Checks before pushing

```bash
npm run lint             # parallel: ESLint, Stylelint, Prettier, markdownlint, htmlhint, tsc
npm test                 # Vitest (site + dev scripts) + node --test (admin)
npm run build            # production Hugo build into site/public/
npm run fix              # auto-fixable: prettier --write + eslint --fix + stylelint --fix
```

## Quality gates that block a PR

Every push (any branch) and every PR to `main` runs three workflows. A PR cannot
merge until they're all green and a `@AdamNolle` review is approved.

| Workflow         | Trigger             | Time budget | Blocks merge? |
| ---------------- | ------------------- | ----------- | ------------- |
| `quality.yml`    | push, PR to main    | < 3 min     | yes           |
| `e2e.yml`        | PR to main, nightly | < 8 min     | yes           |
| `lighthouse.yml` | PR to main          | < 4 min     | yes           |
| `deploy.yml`     | push to main        | < 2 min     | n/a (deploys) |

`quality.yml` enforces:

- ESLint zero errors (`no-unused-vars`, `eqeqeq`, `prefer-const`,
  `promise/*`, `security/*`)
- Stylelint zero errors on `site/assets/css/*.css`
- Prettier formatting on all `*.{js,css,json,md}`
- `tsc --noEmit` with `@ts-check` + JSDoc on `admin/**/*.js` and
  `site/static/js/**/*.js`
- markdownlint on every `.md` outside `Blog/`, `.planning/`, and `site/content/`
- htmlhint on `admin/public/*.html` and `site/public/**/*.html` after a build
- shellcheck on `scripts/*.sh`
- Vitest suite for `site/static/js/app.js`
- Node built-in test runner for `admin/src/routes/*.js` against a real temp-file SQLite

`e2e.yml` enforces:

- Playwright smoke for `/`, `/about/`, `/bye-bye-dji/`, `/tags/tech/`, `/index.json`, etc.
- axe-core: zero `serious` or `critical` violations on the audited pages
- Microformat surfaces and JSON-LD parse on the post page

`lighthouse.yml` enforces:

- Performance ≥ 0.95
- Accessibility = 1.0
- Best Practices = 1.0
- SEO = 1.0

## Branch protection setup (repo admin only)

This is configured manually in GitHub, once per repo:

1. Go to **Settings → Branches → Add rule** for `main`.
2. Tick **Require a pull request before merging**.
3. Tick **Require status checks to pass** and select:
   - `Quality / Lint (lint:js)`
   - `Quality / Lint (lint:css)`
   - `Quality / Lint (lint:md)`
   - `Quality / Lint (lint:prettier)`
   - `Quality / Lint (lint:types)`
   - `Quality / Lint (lint:html-admin)`
   - `Quality / Lint (lint:html-site, depends on hugo build)`
   - `Quality / Shellcheck`
   - `Quality / Test (site / Vitest)`
   - `Quality / Test (admin / node --test)`
   - `E2E + a11y / Playwright (site + a11y)`
   - `Lighthouse / Lighthouse CI`
4. Tick **Require branches to be up to date before merging**.
5. Tick **Do not allow bypassing** if you want the rule to apply to admins too.

## Pre-commit hook

Husky runs lint-staged on every commit:

- `*.js` → `eslint --fix` + `prettier --write`
- `*.css` → `stylelint --fix` + `prettier --write`
- `*.md` → `markdownlint-cli2 --fix`
- `*.{json,html}` → `prettier --write`

If a hook blocks your commit, that's a feature — fix the underlying issue and
re-stage. Don't `--no-verify`.

## Commit message style

Short, declarative, no period. Match the existing log: `Phase 1.5: lint, test, and CI scaffolding`, `Fix UI spacing issue in editor toolbar`, etc. Group related changes into a single commit.

## Adding new tests

- **Public-site JS** (`site/static/js/*.js`) → add a `*.test.js` file under
  `site/test/`. Use Vitest + jsdom. Load `app.js` via the eval pattern in
  `site/test/app.test.js` if you need to drive the IIFE.
- **Admin backend** (`admin/src/routes/*.js`) → add a `*.test.js` file under
  `admin/test/`. Use Node's built-in `test` runner, an ephemeral `AUTH_DB_PATH`,
  and a real SQLite database. **Never mock `better-sqlite3`** — integration
  tests catch real schema mismatches.
- **Cross-cutting site behavior** → add a `*.spec.js` file under
  `test/playwright/`. The Hugo dev server starts automatically.

## Adding new lint rules

- **JS** → edit `eslint.config.js`. Prefer `error` for hard rules and `warn`
  for advisory ones.
- **CSS** → edit `.stylelintrc.json`.
- **Markdown** → edit `.markdownlint.json`.

If a rule turns out noisier than useful, downgrade rather than disable globally.

## Accessibility (WCAG 2.2 AA)

The site and the admin CMS both target **WCAG 2.2 AA**. The CI a11y suite
fails on any `serious` or `critical` violation surfaced by axe-core; PRs
that introduce one don't merge. This section captures the contract so you
don't have to rediscover it the hard way.

### Contrast requirements

All design tokens that drop ink on a surface must clear:

- **4.5 : 1** for body text, link text, status labels, captions
- **3.0 : 1** for non-decorative UI components (form borders that signal
  state, focus rings, toggle handles)

The set of token pairs we ship is enumerated in
`site/test/contrast.test.js`. Every token in that file has a target
floor and a one-line justification. Adding a new token or changing an
existing one means updating that table — the unit test will catch the
omission.

Theme tokens live in two files, one per surface:

- `site/assets/css/screen.css` → `:root` + `[data-theme="dark|light"]`
- `admin/public/css/admin.css` → same names + admin-only `--warn` / `--danger`

The dark-on-dark-with-lava-blob backdrop is the trickiest case — see the
`.progress` and `.post-meta` rules in `screen.css` for the documented
workaround (opaque `color-mix` on the strip, `--fg-dim` for foreground).

### Motion

`@media (prefers-reduced-motion: reduce)` collapses all transitions and
animations to ~0ms (see the bottom of section 2 in both
`screen.css` and `admin.css`). The reading-progress bar still updates
(it's state, not motion); the lava blob keyframes, scanlines, blink,
and pulse all stop. If you add a new motion effect, gate it behind the
same media query or use `transition-duration` so the global override
catches it.

### Focus management

- The body has `*:focus-visible { outline: 2px solid var(--accent); }`
  in both stylesheets. Don't suppress this on a per-component basis.
  If a component looks bad with the ring, change the spacing — not the
  outline.
- Every dialog (`role="dialog" aria-modal="true"`) installs a focus
  trap via `TE.openModal` / `TE.closeModal` in `admin/public/js/common.js`
  (admin) or the equivalent code paths in `site/static/js/lightbox.js`
  and `site/static/js/app.js` (public). The trap restores focus to the
  triggering element on close.
- The Cmd+K palette gets the same trap. It's a `<dialog>`-shaped div with
  `aria-modal="true"` and a focusable input as the initial target.
- `<main id="main" tabindex="-1">` exists on every page so the skip link
  (`<a class="skip-link" href="#main">`) can land focus there.

### How to run the a11y tests

```bash
# Static-surface axe runs (no live admin server needed)
npx playwright test test/playwright/a11y.spec.js
npx playwright test test/playwright/admin-a11y.spec.js

# Token contrast (Vitest, sub-second)
npx vitest run --config vitest.config.js site/test/contrast.test.js

# Optional: live-server axe scenarios for the cmdk palette + modals
DEV_STACK_RUNNING=1 ADMIN_ORIGIN=http://127.0.0.1:8787 \
  npx playwright test test/playwright/admin-a11y.spec.js
```

CI runs the first three on every PR. The live-server scenarios are
skipped by default; flip `DEV_STACK_RUNNING=1` locally when you have
`npm run dev:all` up to exercise the palette + template-picker modal.

### Accepted axe rule exceptions

We disable the following rules on the admin a11y spec only, each with
a one-line justification (see `test/playwright/admin-a11y.spec.js`):

| Rule                   | Where      | Why                                                                                                                     |
| ---------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `region`               | admin only | The admin is a single-purpose shell with `<aside>` + `<header>` landmarks; content panels are layout `<div>` by design. |
| `page-has-heading-one` | admin only | Hash-router views with the H1 are hidden on file:// boot; the H1 is asserted directly in `admin.spec.js`.               |

Don't expand this list without a PR-level conversation. Every exception
is a place where a real defect can hide.

### Status-and-color independence

Status indicators must pair a glyph with the color. `comments.css` does
this via `::before` pseudo-elements on `.te-cm-status.s-*` — pinned star,
spam ⨯, deleted minus, pending …, visible check. The pattern is:

```css
.te-cm-status.s-spam {
  color: var(--danger);
}
.te-cm-status.s-spam::before {
  content: "⨯ ";
}
```

Same idea for `dashboard.css` health dots (`.ddot.bad`, `.ddot.warn`
already include text) and the post-list pills (`.r-pill.draft` ships
the literal text "DRAFT").

### Forms

Every input gets a real `<label>` — visually hidden via `.sr-only` when
the design calls for a bare icon. Hard errors use
`role="alert"`; soft hints use `aria-describedby` on the input. See
`admin/public/login.html` for the canonical example.

## Performance (Phase 11)

The public site targets Lighthouse mobile **Performance ≥ 95** and
**Accessibility / Best Practices / SEO = 100** on every published route.
The Phase 1.5 config at `lighthouserc.json` enforces those budgets via
`@lhci/cli` in CI; locally:

```bash
npm run test:lighthouse     # full @lhci/cli run, ~2 min, requires Chromium
LHCI=true npx playwright test test/playwright/lighthouse.spec.js
```

Fast feedback runs as part of `npm test`: `site/test/perf.test.js`
asserts the critical-CSS budget, the CSP meta tag, the deferred
stylesheet shape, and the JS fingerprint contract. If you break one of
those, the unit suite fails before you ever boot Chromium.

### Critical CSS contract

- `site/layouts/partials/critical-css.html` ships a **single `<style>`
  block ≤ 3 KB** that paints the first viewport without a layout
  reflow once the deferred stylesheet lands. Trim the partial back to
  first-paint essentials before bumping the budget — beyond ~3 KB the
  inline payload starts costing more TBT / LCP than the round-trip it
  saves on mobile.
- The full `site/assets/css/screen.css` loads via
  `rel="preload" as="style" onload="this.onload=null;this.rel='stylesheet'"`
  with a `<noscript><link rel="stylesheet">` fallback so search-engine
  crawlers and JS-disabled browsers still get the design.
- Both stylesheets are fingerprinted through `resources.Fingerprint` and
  carry an `integrity=` (SRI) attribute. Cache-busting is automatic;
  the deploy can serve the hashed filenames with `Cache-Control:
public, max-age=31536000, immutable`.

### JS bundle layout

- `site/assets/js/{app,embed-loader,lightbox}.js` — canonical source.
  `baseof.html` calls `resources.Get → resources.Fingerprint` so each
  ships as `/js/<name>.<hash>.js` with an `integrity=` attribute.
- Anything under `site/static/js/` is served verbatim with no
  fingerprint or SRI — keep that directory empty for first-party
  bundles. The vitest config covers both paths to catch a stale file
  if a refactor drops one there by accident.
- Tests load the canonical asset paths
  (`site/test/{app,embed-loader,lightbox}.test.js`). If you rename a
  bundle, update the test imports as part of the same commit.

### Image rendering

Every `<img>` we emit MUST carry:

1. `width` + `height` attributes (CLS guard).
2. `loading="lazy"` for below-the-fold images.
3. `decoding="async"` so decode happens off the main thread.

The Phase 6 attachment partials (`site/layouts/partials/attachment-*.html`)
emit a responsive `<picture>` with AVIF / WebP `<source>` sets — the
Phase 5b conversion pipeline drops the variants into `site/data/media.json`.
Markdown image syntax (`![]()`) goes through the Phase 11 render hook at
`site/layouts/_default/_markup/render-image.html`, which automatically:

- Resolves page-resource images and emits intrinsic `width`/`height`.
- Falls back to a plain `<img loading=lazy decoding=async>` for
  absolute URLs (the admin's media library writes
  `/images/yyyy/mm/<file>.png` paths — the attachment shortcode is
  preferred over raw markdown for those).

For post `cover` images set in front-matter, `single.html`:

- Uses `.Resources.GetMatch` to pull the page-bundled image, then
  emits a `<picture>` with 320 / 640 / 1024 / 1920 webp variants.
- Falls back to a plain `<img>` for absolute URLs, optionally honouring
  `cover_width` + `cover_height` front-matter fields. **Always set
  both when the admin attaches a cover** so CLS stays at 0.

### Lava blob cap

The third `.lava-blob.c` is hidden via `@media (max-width: 720px)` in
both `screen.css` and the inline critical-CSS partial. The two
remaining blobs carry the lava aesthetic without taxing the GPU on
lower-tier mobile devices. The global `prefers-reduced-motion: reduce`
rule in `screen.css` §2 (RESET) zeroes the blob animations entirely
for motion-sensitive users.

### Embeds

All third-party embed providers use the Phase 7 / Phase 9 **click-to-load
placeholder pattern** — no iframe or third-party script fires until the
user clicks. The placeholder is a real `<button>` so keyboard + AT
users get the same affordance. See `site/layouts/shortcodes/embed-*.html`
for the per-provider templates.

The Phase 8 Bluesky thread embed follows the same pattern, and the
generic Open Graph card is fully server-rendered (no iframe at all).
This is why Lighthouse stays green even on pages with several embeds.

### Content Security Policy

`head.html` declares a strict CSP meta tag. The allowlists MUST stay
in sync with the embed providers under `site/layouts/shortcodes/`:

| Directive         | Allowlist                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `default-src`     | `'self'`                                                                                                      |
| `script-src`      | `'self' 'unsafe-inline'` + Remark42, Umami, embed.bsky.app, gist.github.com, www.tiktok.com, cdn.jsdelivr.net |
| `style-src`       | `'self' 'unsafe-inline'` (inline critical CSS + theme FOUC script require it)                                 |
| `img-src`         | `'self' data: https:` (third-party thumbnails for YouTube, Vimeo, OG cards)                                   |
| `font-src`        | `'self'` (self-hosted JetBrains Mono only)                                                                    |
| `frame-src`       | embed.bsky.app, youtube-nocookie, player.vimeo, www.tiktok, w.soundcloud, open.spotify, codepen.io            |
| `media-src`       | `'self'` (audio + video attachments only)                                                                     |
| `connect-src`     | `'self'` + analytics host (XHR posts to Remark42 happen from the iframe origin, not the host page)            |
| `base-uri`        | `'self'`                                                                                                      |
| `form-action`     | `'self'`                                                                                                      |
| `frame-ancestors` | `'self'` (clickjacking guard — no one embeds us in their iframe)                                              |

The `'unsafe-inline'` for `script-src` is intentional: the FOUC theme
script in `baseof.html` and the JSON-LD blob in `head.html` are both
server-generated. Moving to a nonce would require runtime header
injection that the static-host deploy (GitHub Pages today, Caddy on
the Pi tomorrow) can't reliably set per-request.

When adding a new embed provider:

1. Drop the placeholder shortcode under `site/layouts/shortcodes/embed-<name>.html`.
2. Extend the `frame-src` (and `script-src` if the loader is a `<script src>`)
   allowlist in `site/layouts/partials/head.html`.
3. Update the table above and re-run `npm test`.

### Editor bundle (admin-only)

The admin TipTap + CodeMirror + Shiki bundle at
`admin/public/js/editor.bundle.js` is **~2.5 MB minified**. It's only
served behind authenticated admin routes — public Lighthouse never
loads it — so Phase 11 intentionally did not code-split. If future
admin perf becomes a constraint, the natural splits are:

- CodeMirror behind the source-mode toggle (lazy-load on first switch).
- Shiki when a code block is selected.
- KaTeX is already lazy-loaded from a CDN.

Document the decision in the phase that picks it up; don't ship a
half-split bundle.

## Editor shortcuts

The admin post editor (`/editor`) is a dual-mode TipTap + CodeMirror surface.
All of the shortcuts below are bound through TipTap's keymap (in WYSIWYG
mode) and CodeMirror's keymap (in Source mode). `Mod` means `Cmd` on
macOS / iPadOS and `Ctrl` everywhere else.

### Inline marks

| Shortcut      | Action                      |
| ------------- | --------------------------- |
| `Mod+B`       | Bold                        |
| `Mod+I`       | Italic                      |
| `Mod+Shift+U` | Underline                   |
| `Mod+Shift+X` | Strikethrough               |
| `Mod+E`       | Inline code                 |
| `Mod+K`       | Insert / edit link (dialog) |

### Block type

| Shortcut      | Action     |
| ------------- | ---------- |
| `Mod+Alt+1`   | Heading 1  |
| `Mod+Alt+2`   | Heading 2  |
| `Mod+Alt+3`   | Heading 3  |
| `Mod+Alt+0`   | Paragraph  |
| `Mod+Shift+B` | Blockquote |

### Lists

| Shortcut      | Action                   |
| ------------- | ------------------------ |
| `Mod+Shift+8` | Bullet list              |
| `Mod+Shift+7` | Ordered list             |
| `Mod+Shift+9` | Task list                |
| `Tab`         | Indent (sink list item)  |
| `Shift+Tab`   | Outdent (lift list item) |

### Insert

| Shortcut      | Action                         |
| ------------- | ------------------------------ |
| `Mod+Shift+H` | Horizontal rule                |
| `/`           | Open slash menu (block picker) |

The slash menu, opened by typing `/` inside the editor, offers headings
H1–H3, bullet/ordered/task lists, blockquote, code block, divider, table
(real 3×3 insert), inline + block math, info / tip / warn / danger
callouts, footnotes, and placeholder rows for image / file / embed
(Phases 4 / 6 / 7 wire each one). Navigate with `ArrowUp` / `ArrowDown`,
insert with `Enter`, dismiss with `Escape`.

### Editor block types

Beyond CommonMark, the Phase 3c editor authors five extended constructs.
Each round-trips through the same Markdown source the public site reads,
so what you type in the admin is what gets committed to the repo.

| Block              | Markdown source                                         | Notes                                                                                    |
| ------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Table              | `\| Col \| Col \|\n\| --- \| --- \|\n\| 1 \| 2 \|`      | GFM tables; first row is the header. Toolbar group shows in-context.                     |
| Inline math        | `$x^2$`                                                 | Single-line LaTeX. Rendered by KaTeX (CDN, lazy-loaded SRI-pinned).                      |
| Block math         | `$$\n\\sum_{i=0}^n i\n$$`                               | Display equation, centered.                                                              |
| Callout (info)     | `:::info\n…\n:::`                                       | Also `:::tip`, `:::warn`, `:::danger`. Public site renders `<aside.callout>`.            |
| Footnote           | `text[^id]\n\n[^id]: definition`                        | Auto-numbered; stable id round-trip.                                                     |
| Code with language | <code>\`\`\`js</code><br>`code…`<br><code>\`\`\`</code> | Pick from 13 grammars: js, ts, py, go, rust, html, css, json, bash, md, yaml, sql, diff. |

Click rendered math to open an inline edit textarea — blur (or `Cmd+Enter`)
commits, `Escape` cancels. Tables expose a context-aware toolbar group
(insert/delete row/col, delete table, toggle header) only when the cursor
is inside a table cell. Code blocks expose a language picker `<select>`
only when the cursor is inside a fenced block.

### History + actions

| Shortcut      | Action                   |
| ------------- | ------------------------ |
| `Mod+Z`       | Undo                     |
| `Mod+Shift+Z` | Redo                     |
| `Mod+S`       | Save the post            |
| `Mod+Enter`   | Save and trigger publish |

`Mod+S` and `Mod+Enter` are intercepted by the editor's keymap and
dispatched as `editor-save` / `editor-publish` custom events on
`#editor-root`. `admin/public/js/editor.js` listens for both and routes
them through its existing `savePost()` / `publishSite()` flow.

### Find & replace (Phase 3d)

| Shortcut      | Action                                  |
| ------------- | --------------------------------------- |
| `Mod+F`       | Open the in-editor find / replace modal |
| `Enter`       | Jump to the next match                  |
| `Shift+Enter` | Jump to the previous match              |
| `Alt+Enter`   | Replace the current match               |
| `Esc`         | Close the modal, clear highlights       |

The modal is pinned to the top-right of the editor pane (not the
browser's native find bar). Options live as inline checkboxes:

- **Aa** — case-sensitive
- **W** — whole word (regex `\b…\b`)
- **.\*** — interpret the query as a regular expression

The modal works in both **Rich** and **Markdown** modes — WYSIWYG uses
a ProseMirror decoration plugin to highlight matches in place, while
the Markdown source mode delegates to `@codemirror/search`'s
`findNext` / `replaceNext` / `replaceAll` commands.

Focus is trapped inside the modal; `Esc` returns focus to whatever was
focused before the modal opened (typically the editor surface).

### Block reorder (drag-handle)

Hover any top-level block (heading, paragraph, blockquote, code block,
table, image) to surface a `⋮⋮` grab handle in the left margin. Drag
the handle to drop the block at a new position — a blue line indicates
the drop target while dragging; the dragged block fades during the
gesture.

Keyboard alternative:

| Shortcut              | Action                                                     |
| --------------------- | ---------------------------------------------------------- |
| `Alt+Shift+ArrowUp`   | Move the top-level block containing the cursor up one slot |
| `Alt+Shift+ArrowDown` | Move the top-level block containing the cursor down        |

### TOC + SEO panels

Two toggleable right-side panels live between the editor pane and the
frontmatter sidebar. Their open/closed state persists to
`localStorage` per browser.

- **Table of contents** — auto-generated from every H1–H6 in the doc,
  indented by level. Click a heading to jump there + move the
  selection. The heading containing the cursor gets
  `aria-current="location"` and is visually highlighted.
- **SEO preview** — Google SERP-shaped snippet showing the rendered
  title, site URL with slug, and meta description (falls back to the
  first 160 chars of the post body when the meta description is
  empty). Two progress bars warn when the title exceeds 60 chars or the
  description exceeds 160 chars.

Topbar buttons (`≡` for TOC, `⌕` for SEO) toggle each panel. The aux
column is removed from the grid entirely when both panels are closed,
giving the editor the full main width.

### Status bar + autosave indicator

The editor pane has a fixed status bar at the bottom showing
`<words> · <chars> · <reading-time>`. Reading time uses the industry-
standard 250 wpm. Metrics update via `requestAnimationFrame` on every
input event so large pastes don't thrash the UI.

The autosave indicator (right side of the status bar) has four states:

| State    | Visual                       | Behaviour                                            |
| -------- | ---------------------------- | ---------------------------------------------------- |
| `idle`   | Muted grey pip               | No pending changes; this is the resting state        |
| `dirty`  | Warning-coloured pip         | Unsaved edits, autosave countdown running            |
| `saving` | Pulsing accent pip           | Save in flight                                       |
| `saved`  | Accent pip, soft background  | Last save succeeded — fades back to `idle` after 2 s |
| `error`  | Danger pip, clickable button | Last save failed — click or `Enter`/`Space` to retry |

The pip wraps the existing autosave write logic in `editor.js`. Custom
events fire on `#editor-root` so future Phase-4+ features (offline
queueing, federation hooks) can subscribe without monkey-patching:

| Event              | Detail         |
| ------------------ | -------------- |
| `autosave-dirty`   | (none)         |
| `autosave-start`   | (none)         |
| `autosave-success` | `{ filename }` |
| `autosave-error`   | `{ message }`  |

### Mode toggle

The editor toolbar's rightmost group toggles between **Rich** (WYSIWYG)
and **Markdown** (Source / CodeMirror) modes. Markdown round-trips
through the same parser/serializer pair the server uses, so switching
modes is a fixed point after the first normalisation pass.

## Known quirks

- **macOS dev + better-sqlite3**: the prebuilt binary in `admin/node_modules/`
  may have an ABI mismatch with Node 26. Admin tests detect this and skip with
  a descriptive reason — CI on Linux + Node 20 runs them for real. To fix
  locally: `cd admin && npm rebuild better-sqlite3`. (Phase 2 will bump the
  dependency to a Node-26-compatible version.)
- **Vitest + Node 26**: Node's experimental top-level `localStorage` shadows
  jsdom's. `site/test/setup.js` polyfills it.

## Phase 5e — CMS authoring extras

### Scheduled publishing

Add `publish_at: "2026-07-04T12:00:00Z"` to a draft's front-matter and
keep `draft: true`. A Pi cron (every 5 min) invokes
`scripts/promote-scheduled.sh`, which calls `node
admin/src/services/scheduler.js` to flip every past-due draft to
`draft: false` and commits + pushes the change. Hugo's next build picks
them up. The editor sidebar's **Schedule** panel surfaces this — a
"Scheduled" badge appears whenever a draft has a future `publish_at`.

To install the cron on the Pi (one-time):

```bash
*/5 * * * * /opt/terminal-eighty/scripts/promote-scheduled.sh \
    >> /var/log/terminal-eighty-scheduler.log 2>&1
```

The `--dry-run` flag prints what would change without writing.

### Draft preview links

`POST /api/posts/<filename>/preview` returns a 7-day signed HMAC-SHA256
JWT URL of the shape `https://terminaleighty.com/drafts/<slug>/?token=…`.
The secret is `SITE_SECRET` (falls back to `SESSION_SECRET`).

**Verification choice (deliberate for Phase 5e):** the JWT is issued by
the admin; verification is **expected to happen at the reverse-proxy
layer** (Caddy/Cloudflare Worker) using the same shared secret. Phase
5e ships the issuer only — the proxy work is a Phase 11+ follow-up
when drafts move behind the CDN edge. Until then, a draft URL anyone
gets is functionally a bearer token; treat the link itself as the
credential.

### Per-post custom CSS / JS — trust model

Front-matter fields `custom_css` and `custom_js` are rendered verbatim
into the page (`safeCSS` / `safeJS`).

**Trust model:** only authenticated admin users can write these fields
— `server.js` requires a valid session on `PUT /api/posts/*`. The
sanitization choice (none on write, `safeCSS`/`safeJS` pass-through on
render) is intentional: an admin who can write JS to the site already
controls the site, and stripping CSS/JS at write time would block
legitimate uses (per-post stylesheets, embed widgets). Compromise the
admin account and the attacker can already publish a malicious post —
custom CSS/JS doesn't expand the blast radius.

If you ever delegate write access to a less-trusted contributor,
either remove the fields from the UI or wrap them in a DOMPurify pass
before persistence.

### Shortcodes documentation

`admin/#/shortcodes` reads every file in `site/layouts/shortcodes/*.html`
and extracts the first Hugo comment block as documentation. The
convention is:

- Anything before a `---` separator → `doc`
- Anything after → `usage`

Keep these comments at the top of new shortcode templates so they show
up in the admin reference automatically.

### Attachments (Phase 6)

Embed any uploaded file with a rich preview using the `attachment`
shortcode:

```markdown
{{< attachment id="abc123" >}}
{{< attachment id="abc123" caption="My caption" >}}
```

The `id` is the media-library id (visible in `admin/#/media`).
At publish time, `admin/src/services/publish-media-data.js` writes
`site/data/media.json` with every media record's metadata + conversion
URLs. The shortcode looks the id up there and dispatches to a per-type
partial in `site/layouts/partials/attachment-*.html`:

- `image/*` → responsive `<picture>` (AVIF + WebP + fallback) with
  click-to-lightbox
- `video/*` → `<video controls>` with H.264 MP4 + VP9 WebM sources
- `audio/*` → waveform image + `<audio controls>` with MP3 + Opus
- `application/pdf` → cover thumb + page count + Open + Download
- code files → pre-rendered Shiki HTML + language badge
- archives → collapsible `<details>` file tree
- anything else → generic file card with byte size + Download

Every preview offers a **Download original** link with the
`download="<original-filename>"` attribute — GitHub Pages does not
support `Content-Disposition` headers, so the attribute is how we hint
the browser to use the original filename when saving.

The editor's slash menu's **File attachment** entry opens the media
library, lets you pick or upload a file, and inserts the shortcode at
the cursor. Drag-drop of non-image files into the editor body does the
same (image drops still use TipTap's native image node).

Image clicks (and gallery items from the `gallery` shortcode) open
`site/static/js/lightbox.js`, a tiny vanilla overlay with focus trap,
arrow-key navigation, and ESC/backdrop close.

### Activity log

Every CMS mutation writes a row to the `activity_log` SQLite table
(see `admin/src/db/migrations/004_activity_log.sql`). Writes are
fire-and-forget via `services/activity.js`, so a DB hiccup never
blocks a save. The dashboard widget surfaces the 10 most recent
entries; the dedicated `/admin/#/activity` page shows the latest 50
with optional `?action=...` and `?since=...` filters.

### Backup status

`scripts/backup.sh` writes a `~/.terminal-eighty/.last_backup`
timestamp on success. The dashboard reads it via `getBackupStatus` and
colour-codes the line:

- ok (≤24h)
- warn (24–36h)
- stale (>36h, shown in `--danger`)

Override the marker directory with `TE_STATE_DIR` if your Pi keeps
state outside `$HOME`.

### Redirects

Site-wide forwards live in `site/data/redirects.json`. The admin's
**Redirects** page wraps `GET/POST/PUT/DELETE /api/redirects`.
At build time, `scripts/dev/build-redirects.mjs` emits one static
HTML page per entry under `site/static/<from>/index.html` with a
meta-refresh + JS fallback + canonical link. `npm run build` and
`npm run build:check` invoke it automatically.

For **per-post** redirects (e.g. the post moved slug), prefer Hugo's
built-in `aliases:` front-matter field — those are auto-emitted by
Hugo and stay alongside the post.

## Phase 7 — embeds (paste-to-embed)

Pasting a single bare URL into the editor offers an inline
"Insert embed" picker. Confirming calls `GET /api/embed?url=…`,
which walks a small provider registry (`admin/src/services/embed/`)
and returns a uniform record + a Hugo shortcode the editor pastes in
place of the URL.

Supported first-class providers:

- YouTube (`youtube.com/watch`, `youtu.be/…`, `/shorts/…`)
- Vimeo (`vimeo.com/<id>`)
- Bluesky (`bsky.app/profile/<handle>/post/<rkey>`)
- Mastodon (any instance — `https://<host>/@user/<status-id>`)
- TikTok (`tiktok.com/@user/video/<id>`)
- GitHub Gist (`gist.github.com/<owner>/<id>`)
- CodePen (`codepen.io/<user>/pen/<id>`)
- SoundCloud (`soundcloud.com/<user>/<track>`)
- Spotify (`open.spotify.com/<kind>/<id>`)

Everything else falls through to a server-side OG-scrape that returns
a static link card (no iframe, no JS).

### Privacy + performance contract

Every shortcode renders a `<button data-embed-href="…">` placeholder
that is swapped for a real `<iframe>` (or, for Gist, a `<script>`) on
click by `site/static/js/embed-loader.js`. No iframe loads on initial
paint — Lighthouse stays in the green and the user opts in per embed.

The `[data-embed-href]` selector is reserved for embeds; the Phase 6
lightbox (`site/static/js/lightbox.js`) explicitly skips clicks that
descend from one. Don't reuse the attribute name for anything else.

### Adding a new provider

1. Add a `match(URL)` + `resolve(URL, m)` pair to the `PROVIDERS`
   array in `admin/src/services/embed/providers.js`. The matcher
   returns `null` to defer to the next provider; the resolver returns
   the uniform `{ provider, id, shortcode, … }` record.
2. Create `site/layouts/shortcodes/embed-<name>.html` that emits the
   placeholder button. Reuse the `embed-placeholder` class so the
   theme tokens carry across.
3. Add a coverage row to `admin/test/embed.test.js`.
4. Add the provider id to the "Supported first-class providers" list
   above.

### Mastodon host handling

Mastodon doesn't have a single host — every instance ships its own
`/api/oembed` endpoint at the same path. The matcher in `providers.js`
accepts any host whose path looks like `/@<user>/<numeric-status-id>`
and explicitly denylists known impostors (Threads, Twitter/X). The
resolver dials the host extracted from the input URL.

### Cache

Successful resolutions cache for 24h in the `embed_cache` table
(`admin/src/db/migrations/005_embed_cache.sql`). Responses set
`X-Embed-Cache: HIT|MISS` so a paste-twice flow is observable.

### h-entry / microformats note (Phase 8 forward)

The placeholder buttons and OG card live inside the post body. Phase 8
will wrap the whole body in an `e-content` element; the embed buttons
are plain HTML descendants and do not break that contract. The
generic OG card is already an `<a>` with `rel="noopener external"` —
Phase 8 can layer `u-bookmark-of` on top without changing this file.

## Phase 8 — Fediverse federation via Bridgy Fed

Terminal Eighty federates as `@blog@terminaleighty.com` to all of
ActivityPub-land WITHOUT running its own ActivityPub server. The trick
is [Bridgy Fed](https://fed.brid.gy) — it bridges any IndieWeb-shaped
site (microformats2 + webmentions + webfinger) onto the Fediverse.

### Discovery surfaces

Three pieces of plumbing make the site federation-discoverable:

1. **Microformats2 on every post.** `single.html` carries `h-entry`,
   `p-name`, `dt-published`, `e-content`, `u-url`, `p-author h-card`,
   and `p-category` — Bridgy Fed parses these to construct the
   ActivityPub `Note`. The author block expands to a full `h-card`
   (via `partials/h-card.html`) with `rel="me"` social links so the
   identity loop is verifiable.
2. **`/.well-known/webfinger`.** Hugo renders this from
   `layouts/index.webfinger` via a custom output format that maps
   `application/jrd+json` → no file suffix. The response declares
   `acct:blog@terminaleighty.com` and points `rel=self` at
   `https://fed.brid.gy/web/terminaleighty.com`, so any Fediverse
   server resolving the handle delegates the inbox/outbox to Bridgy
   Fed.
3. **`<link rel="webmention" …>` in `<head>`.** Advertises
   `https://admin.terminaleighty.com/webmention` so senders (Bridgy
   Fed, Webmention.io, mention.tech, …) can deliver replies.

### Webmention receiver

`admin/src/routes/webmentions.js` implements the
[W3C Webmention spec](https://www.w3.org/TR/webmention/):

| Endpoint                             | Purpose                                               |
| ------------------------------------ | ----------------------------------------------------- |
| `POST /webmention`                   | Public ping receiver. Returns 202 + Location header.  |
| `GET  /webmention/:id`               | Public status of a single ping.                       |
| `GET  /webmention/feed?target=<url>` | Public JSON feed of approved mentions for one target. |
| `GET  /api/webmentions[?status=]`    | Admin moderation list (session-cookie auth).          |
| `POST /api/webmentions/:id/approve`  | Flip status to `approved`.                            |
| `POST /api/webmentions/:id/reject`   | Flip status to `rejected`.                            |
| `DELETE /api/webmentions/:id`        | Drop the row entirely (purge).                        |

Validation flow (per row):

1. POST arrives → row inserted with `status='pending'`.
2. `setImmediate` validator fetches the source (8-second timeout,
   5-MB cap, `redirect: 'follow'`, https-only).
3. Source HTML is parsed by `services/microformats.js` (mf2-parser).
   We detect `u-in-reply-to` / `u-like-of` / `u-repost-of` /
   `u-bookmark-of` against the target; fall back to plain `<a>` back-link
   detection if no microformats are present.
4. Author is read from the matched h-entry's `p-author h-card`, or
   the document's `h-card`, or `rel="author"`, or finally the source
   host as a label.
5. Row is updated with type + author + content. Default new state is
   `pending` (admin moderates); set `WEBMENTION_AUTO_APPROVE=1` to
   auto-publish anything that survives back-link validation.

`status='rejected'` rows store the rejection reason (`fetch_failed:
…` or `no_link_back`) in `raw_html` for debugging.

### Build-time rendering

Hugo doesn't talk to the CMS at build time, so we materialise
approved mentions to disk via `admin/src/services/dump-webmentions.js`.
It groups by slug (first non-empty URL path segment) and writes
`site/data/webmentions/<slug>.json`; the partial
`partials/webmentions.html` reads `hugo.Data.webmentions[slug]` and
renders replies + aggregated likes/reposts inline above the Remark42
comments block.

On the Pi, install the cron alongside the scheduled-posts cron:

```bash
*/5 * * * * /opt/terminal-eighty/scripts/dump-webmentions.sh \
    >> /var/log/terminal-eighty-webmentions.log 2>&1
```

`scripts/maintenance.sh` also runs the dumper as a daily safety net.

### One-time Bridgy Fed setup

After this phase ships, do these manually on
[fed.brid.gy](https://fed.brid.gy):

1. Sign in (the site OAuth's against a domain you control — sign in
   with your IndieAuth-on-terminaleighty.com identity, or use a
   bootstrap site like silo.computer if the IndieAuth piece is not
   live yet).
2. Visit `https://fed.brid.gy/web/terminaleighty.com` and click
   **Federate this site to the Fediverse**.
3. Confirm the discovery checklist: Bridgy Fed shows ✅ for h-card,
   webfinger, and webmention endpoint. If any fail, hit the
   "Re-fetch" button after the next `hugo --gc --minify`.
4. From any Mastodon / Pixelfed / Akkoma / etc. account, search for
   `@blog@terminaleighty.com` — it should appear with the h-card
   avatar + bio. Click **Follow**.
5. Post a reply to any post page (Mastodon will fetch the post page
   and convert the reply into a `Create Note` activity targeted at
   our actor). Bridgy Fed forwards it as a webmention to
   `https://admin.terminaleighty.com/webmention`.

### Adding a new social `rel="me"` link

Edit `site/data/author.json`:

```json
{
  "name": "Terminal Eighty",
  "bio": "Tech it like I talk (write) it.",
  "avatar": "https://terminaleighty.com/images/avatar.png",
  "url": "https://terminaleighty.com",
  "social": {
    "bluesky": "https://bsky.app/profile/terminaleighty.com",
    "mastodon": "https://mastodon.social/@terminaleighty",
    "github": "https://github.com/AdamNolle",
    "youtube": "https://www.youtube.com/@TerminalEighty"
  }
}
```

The `h-card.html` partial picks every entry up automatically and
emits a `rel="me"` link in the footer h-card on every page. The
remote profile MUST link back to `terminaleighty.com` (any `rel="me"`
or plain `<a href>`) for the verification loop to close — Bridgy Fed
won't trust an unverified social identity.

## Phase 8.5 — unified comment moderation

The CMS now manages every comment from one screen. You should never
need to log into Remark42's web UI again.

### What's on the page

`/admin/#/comments` (sidebar → Comments) shows:

| Tab              | Source                                 | Notes                             |
| ---------------- | -------------------------------------- | --------------------------------- |
| All              | Remark42 + webmentions                 | newest first, paginated           |
| Visible          | Remark42                               | comments currently shown publicly |
| Pinned           | Remark42 admin pins                    |                                   |
| Pending mentions | Webmentions w/ `status='pending'`      | approve / reject inline           |
| Spam             | Remark42 soft-deleted + author blocked |                                   |
| Deleted          | Remark42 soft-deleted                  |                                   |
| Blocked          | Local mirror of Remark42 block list    | unblock via row button            |

Row click opens a drawer with the full body, post link, original
source (for webmentions), and a reply composer (Markdown, Cmd+Enter to
send). Bulk checkboxes drive the bottom action bar: **Approve**,
**Mark spam**, **Delete**.

### Live updates

The page opens an `EventSource` on `/api/comments/stream`. Two events:

- `comment-new` — fired by the Remark42 poller (every 30s) when it
  spots a new comment.
- `webmention-new` — fired the instant a webmention POST lands.

A `ping` heartbeat keeps the connection alive through Cloudflare
Tunnel and Caddy. The sidebar shows a **green dot** when live, **red**
when the stream drops, and the Comments badge bumps each time a new
event arrives (resets when you open the page).

### Server-side env vars

Add these to `.env` (and the production secrets file):

```bash
# Remark42 admin proxy
REMARK42_URL=http://remark42:8080         # internal Docker hostname
REMARK42_SITE_ID=terminaleighty
REMARK42_SECRET=<same as the Remark42 container's SECRET>
REMARK42_ADMIN_USER=admin
REMARK42_ADMIN_ID=admin

# Polling cadence (default 30s)
REMARK42_POLL_MS=30000

# Turn the poller off (e.g. on a dev box without docker up):
# REMARK42_POLLER=off
```

`REMARK42_SECRET` is the same `SECRET` env var the Remark42 container
already uses (see `docker/docker-compose.yml`). The admin process
mints a short-lived HS256 JWT with `user.admin: true` per write call —
the admin user themselves never sees the secret.

### Optional email digest

If you want a periodic email summary of new comments + webmentions,
install nodemailer in the admin and set the SMTP env vars:

```bash
cd admin && npm install nodemailer
```

```bash
# .env additions
SMTP_HOST=smtp.fastmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=robot@example.com
SMTP_PASS=<app-password>
SMTP_FROM="Terminal Eighty <robot@example.com>"
DIGEST_TO=adam@example.com
DIGEST_WINDOW_MS=3600000     # last hour
```

Then add the cron:

```cron
5 * * * * cd /opt/terminal-eighty && node scripts/email-digest.mjs >>/var/log/t80-digest.log 2>&1
```

Or rely on `scripts/maintenance.sh` (which already calls
`email-digest.mjs` and no-ops when SMTP isn't configured).

### Block-list reconciliation

`GET /api/comments/blocks` reconciles against Remark42's
`/api/v1/admin/blocked` on every load, so out-of-band changes — e.g.
the day you log directly into Remark42's UI to clear a single user —
eventually converge into the local `blocks` table. The local row also
records `reason` and `created_by` (admin username), which Remark42
doesn't store.

### Replies to webmentions

`POST /api/comments/:id/reply` returns `409 cannot_reply_to_webmention`
for webmention rows that don't come from Bluesky. Phase 9 adds an
exception: when the webmention's source is a `bsky.app` URL (which the
receiver detects and stores in `bluesky_uri`), the admin reply is
mirrored back to the Bluesky thread so the conversation stays linked.

## Phase 9 — AT Protocol / Bluesky cross-post + thread embed

Every time you hit **Publish** in the CMS, the admin now:

1. Commits + pushes the post(s) as before.
2. For each post that is newly published / updated and doesn't already
   have a `bluesky_uri` in its front-matter, composes a Bluesky thread
   (title + excerpt + link card) and posts it as the site account.
3. Writes the resulting `at://` URI back to the post's front-matter
   and pushes a follow-up commit (`Update Bluesky URIs (N posts)`).
4. The post page now renders the official Bluesky embed (click-to-load
   placeholder, same pattern as the embed-\* shortcodes) so replies
   show up natively below the post — the conversation lives on
   Bluesky, not in our DB.

### Setup

1. Generate an **app password** at
   <https://bsky.app/settings/app-passwords>. This is REVOCABLE per-app
   and can't change account settings — never paste the main account
   password into `.env`.
2. Add to `docker/.env`:

   ```bash
   BLUESKY_HANDLE=blog.terminaleighty.com
   BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
   ```

3. Restart the admin container. The cross-post hook will fire on the
   next publish; check the activity log (`/admin/#/activity`) for
   `bluesky.crosspost` entries.

### Idempotency model

| Condition                                                         | Behaviour                                                                                     |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `BLUESKY_HANDLE` / `BLUESKY_APP_PASSWORD` unset                   | Skipped (no error). Hook logs `not_configured`.                                               |
| Post has `draft: true`                                            | Skipped.                                                                                      |
| Post already has `bluesky_uri` in front-matter                    | Skipped (`already_posted`). Edits do NOT re-post.                                             |
| `date` is more than `BLUESKY_MAX_AGE_MS` (default 1h) in the past | Skipped (`too_old`). Stops content-only edits of historical posts from spamming the timeline. |
| More than `BLUESKY_MAX_PER_RUN` (default 5) posts in one publish  | Excess skipped (`rate_limit`). Caps the blast radius of an accidental bulk-republish.         |

The "substantial edit" question: we deliberately **don't** re-post on
edits at all. Once `bluesky_uri` is set, the post is permanently
linked to a single Bluesky thread. If you want a re-post (e.g. major
rewrite), delete the `bluesky_uri` front-matter line and republish —
the hook treats it as a fresh post. The previous BSky thread is left
in place; you can delete it manually if desired.

### Thread composition

The cross-post text is:

```text
<title>

<excerpt — from front-matter `description`, else auto-extracted from
the post body, stripped of headings / code / link syntax>

<post URL>
```

An `app.bsky.embed.external` link card carries the title + excerpt +
cover image so the in-app preview renders rich. If the title +
excerpt + URL together exceed 300 chars, the excerpt is split across
continuation reply posts numbered `(2/N)`, `(3/N)`, … chained off the
root via `reply.root` / `reply.parent`. We cap the chain at 4 posts
total.

### Comments mirror

`POST /api/comments/:id/reply` now mirrors to Bluesky when the
webmention row has `bluesky_uri` set. The receiver detects bsky.app
source URLs (Bridgy Fed forwards them as webmentions) at insert time
and captures the AT URI then; no later lookup needed.

If credentials aren't configured, the route returns
`409 cannot_reply_to_webmention` with a clearer hint pointing at the
missing env vars. Non-Bluesky webmentions (Mastodon, generic) still
get the original 409 (reply on the source site).

### Migration

A new migration (`008_webmention_bluesky.sql`) adds the
`bluesky_uri TEXT` column to the `webmentions` table. The migration
runner picks it up at server boot — no manual step needed for fresh
installs. The test-only safety net in `routes/webmentions.js` and
`routes/comments.js` also ALTERs old direct-import test DBs to add
the column.

### Privacy / Lighthouse

The thread embed is a **click-to-load** placeholder — no Bluesky
trackers fire for drive-by readers. Only when a reader clicks "View
thread on Bluesky" do we inject the official `embed.bsky.app` iframe
(sandboxed, lazy-loaded, focus moves to the iframe so keyboard users
land in the thread).
