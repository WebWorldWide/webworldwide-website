/**
 * Web World Wide CMS — Express Server
 *
 * Admin panel for managing the blog. Runs on the Pi, accessible via Cloudflare Tunnel.
 * Provides: post CRUD, media upload, git publish, auth (passkey + password), system health.
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { versionizeHtml } from './src/utils/assets.js';

// Route modules
import authRoutes from './src/routes/auth.js';
import postsRoutes from './src/routes/posts.js';
import mediaRoutes from './src/routes/media.js';
import publishRoutes from './src/routes/publish.js';
import healthRoutes from './src/routes/health.js';
// Phase 5e CMS-completeness routes — site settings, taxonomies,
// redirects, and the activity log dashboard widget.
import settingsRoutes from './src/routes/settings.js';
import taxonomiesRoutes from './src/routes/taxonomies.js';
import redirectsRoutes from './src/routes/redirects.js';
import activityRoutes from './src/routes/activity.js';
// Phase 7: paste-to-embed lookup. Resolves YouTube/Vimeo/Bluesky/…
// URLs through their oEmbed endpoints (or a generic OG scrape) and
// caches the result for 24h in the `embed_cache` table.
import embedRoutes from './src/routes/embed.js';
// Phase 8: Webmention receiver — the inbound side of Fediverse
// federation via Bridgy Fed. `publicRouter` mounts at /webmention
// (no auth, rate-limited) for incoming pings; `adminRouter` mounts
// at /api/webmentions for moderation behind the session cookie.
import {
  publicRouter as webmentionPublicRoutes,
  adminRouter as webmentionAdminRoutes,
} from './src/routes/webmentions.js';
// Phase 8.5: unified comment moderation surface. Proxies Remark42's
// admin API + folds in pending webmentions so the CMS user manages
// every comment from one place.
import commentsRoutes from './src/routes/comments.js';
import * as remark42Poller from './src/services/remark42-poller.js';
// Server-side Umami analytics proxy — the dashboard traffic widgets
// read /api/analytics/* so the browser never talks to Umami directly
// (credentials stay server-side; responses cached 5 min for the Pi).
import analyticsRoutes from './src/routes/analytics.js';
// Phase 4: tiny migration runner — applies any pending DDL in
// `src/db/migrations/` (auth tables, media table, …) before we serve
// the first request. Safe to call on every boot; already-applied
// migrations are tracked in the `schema_migrations` table.
import { runMigrations } from './src/db/migrate.js';
// Phase 5: conversion job worker. Started after migrations so the
// `conversion_jobs` table is guaranteed to exist before the worker
// opens its read cursor. SIGTERM/SIGINT bind a graceful drain.
import { startWorker, bindShutdownSignals } from './src/services/conversion/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const SITE_DIR = process.env.SITE_DIR || join(__dirname, '..', 'site');
// Astro serves everything under `site/public` at the web root, so uploaded
// media (images/files) lives there — NOT in Hugo's old `site/static`.
// Keep this in lockstep with the media route + conversion worker; a host
// can override it via SITE_PUBLIC_DIR.
const SITE_PUBLIC_DIR = process.env.SITE_PUBLIC_DIR || join(SITE_DIR, 'public');

// Per-deploy cache-busting token for admin assets. Prefer the deployed git
// commit (the repo is mounted at /app/.git); fall back to start time, which
// still changes on every deploy since the container is recreated.
const ASSET_VERSION =
  (() => {
    try {
      return execSync('git rev-parse --short HEAD', {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
    } catch {
      return '';
    }
  })() || `t${Date.now()}`;
const PUBLIC_DIR = join(__dirname, 'public');

// Run migrations before opening the listener so a fresh install never
// races a request against partial DDL.
try {
  const { applied, skipped } = runMigrations();
  if (applied.length) {
    console.log(
      `  · migrations applied: ${applied.join(', ')} (${skipped.length} already on file)`,
    );
  }
} catch (err) {
  console.error('Fatal: migrations failed to apply:', err);
  process.exit(1);
}

// Phase 5: launch the conversion worker. Concurrency defaults to 2 (Pi
// budget) but is overridable via CONVERSION_CONCURRENCY for beefier
// hosts. SIGTERM/SIGINT trigger a graceful drain.
if (process.env.CONVERSION_WORKER !== 'off') {
  try {
    startWorker();
    bindShutdownSignals();
  } catch (workerErr) {
    console.error('[conversion-worker] failed to start:', workerErr);
  }
}

// Phase 8.5: launch the Remark42 poller. It self-skips when Remark42
// isn't configured (no REMARK42_URL / REMARK42_SITE_ID) so dev sessions
// without docker up don't see a hot error loop.
if (process.env.REMARK42_POLLER !== 'off') {
  try {
    remark42Poller.start();
    const drainPoller = () => remark42Poller.stop();
    process.once('SIGTERM', drainPoller);
    process.once('SIGINT', drainPoller);
  } catch (pollerErr) {
    console.error('[remark42-poller] failed to start:', pollerErr);
  }
}

// Trust proxy (behind Caddy/Cloudflare)
app.set('trust proxy', 1);

// Security headers.
//
// CSP notes:
//   - All first-party scripts/styles/fonts are self-hosted (the
//     simplewebauthn UMD and KaTeX live under /vendor — no CDNs).
//   - `style-src-attr 'unsafe-inline'` is required: several UI modules
//     (media, comments, dashboard) set style="" attributes from JS
//     template strings. Inline <style>/<script> BLOCKS stay forbidden.
//   - `img-src https:` is required for federated avatars — webmention
//     author photos and Remark42 avatars come from arbitrary origins.
//   - `frame-src` mirrors the embed providers the editor can render
//     (src/services/embed/providers.js).
//   - CSP_REPORT_ONLY=1 flips to report-only for staged rollouts.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      reportOnly: process.env.CSP_REPORT_ONLY === '1',
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'script-src-attr': ["'none'"],
        'style-src': ["'self'"],
        'style-src-attr': ["'unsafe-inline'"],
        'font-src': ["'self'"],
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        'media-src': ["'self'", 'blob:'],
        'connect-src': ["'self'"],
        'frame-src': [
          'https://www.youtube.com',
          'https://www.youtube-nocookie.com',
          'https://player.vimeo.com',
          'https://embed.bsky.app',
          'https://open.spotify.com',
          'https://w.soundcloud.com',
          'https://codepen.io',
          'https://www.tiktok.com',
        ],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'self'"],
        'worker-src': ["'self'"],
      },
    },
  }),
);

// Session-cookie signing secret. A predictable secret means forgeable
// sessions, so production refuses to boot without one; dev/test get a
// random per-process secret (fine — sessions just don't survive a
// restart there).
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET && process.env.NODE_ENV === 'production') {
  console.error('Fatal: SESSION_SECRET must be set in production (see docker/.env).');
  process.exit(1);
}
if (!SESSION_SECRET) {
  console.warn(
    '[server] SESSION_SECRET unset — using a random per-process secret (dev/test only).',
  );
}

// Middleware. Body caps are deliberately small: file uploads go through
// Multer (multipart) on /api/media, not these parsers; everything else
// is JSON/form data measured in kilobytes. The webmention endpoint
// mounts its own 8kb parser below, so skip it here.
const urlencodedParser = express.urlencoded({ extended: true, limit: '2mb' });
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  if (req.path.startsWith('/webmention')) return next();
  return urlencodedParser(req, res, next);
});
app.use(cookieParser(SESSION_SECRET || randomBytes(32).toString('hex')));

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per window
  message: { error: 'Too many auth attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Phase 8: Webmention receiver is public-facing; cap inbound POSTs
// per-IP to absorb spam without dropping Bridgy Fed's legitimate
// bursts (Mastodon fans-out one ping per follower-mentioning-us —
// but each fan-out arrives from Bridgy's IPs at a modest rate).
const webmentionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { error: 'Too many webmentions. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Static files (admin UI).
//
// Cache strategy:
//   - HTML files (admin pages, manifest, sw.js): no-cache + must-revalidate
//     so a deploy lands immediately on the next request.
//   - Fonts (woff2): 1 year, immutable. Filenames are stable for the life
//     of the design system; if we change a font we change the filename.
//   - Everything else (CSS/JS/images): 1 hour. Admin assets aren't
//     hash-fingerprinted yet, so we can't go higher without risking
//     stale clients after a push.
//
// The static() max-age option only sets the default; setHeaders runs
// after and can override per-path. We use it for the HTML + font split.
// Serve admin HTML pages ourselves (before express.static) so we can rewrite
// local /js + /css references to carry a per-deploy ?v=<ASSET_VERSION> query.
// Combined with the no-cache header on HTML, this makes deploys land instantly
// even behind an aggressive CDN cache. Non-HTML and missing files fall through.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const rel = req.path === '/' ? 'index.html' : req.path.replace(/^\/+/, '');
  if (!rel.endsWith('.html')) return next();
  const file = join(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + '/')) return next(); // traversal guard
  let html;
  try {
    html = readFileSync(file, 'utf-8');
  } catch {
    return next(); // not an admin HTML page — let static/routers handle it
  }
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.type('html').send(versionizeHtml(html, ASSET_VERSION));
});

app.use(
  express.static(join(__dirname, 'public'), {
    maxAge: '1h',
    etag: true,
    lastModified: true,
    setHeaders(res, path) {
      if (path.endsWith('.html') || path.endsWith('manifest.json') || path.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      } else if (path.endsWith('.woff2') || path.endsWith('.woff') || path.endsWith('.ttf')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }),
);

// Serve uploaded media straight off Astro's public tree — the very files
// the published site serves at the web root (`/images/...`, `/files/...`),
// so the library UI and the live site agree the moment a file is uploaded.
// Mounting `images` and `files` as separate roots so we never expose the
// rest of `site/public/`.
app.use(
  '/images',
  express.static(join(SITE_PUBLIC_DIR, 'images'), {
    fallthrough: false,
    maxAge: '7d',
  }),
);
app.use(
  '/files',
  express.static(join(SITE_PUBLIC_DIR, 'files'), {
    fallthrough: false,
    maxAge: '7d',
  }),
);

// Auth routes (rate limited)
app.use('/auth', authLimiter, authRoutes);

// Phase 8: Webmention receiver. Public-facing endpoint (no session
// required) — mounted BEFORE the /api auth middleware so the
// auth-cookie check below doesn't bounce Bridgy Fed's POSTs.
// The admin moderation surface mounts under /api/webmentions further
// down (behind the session cookie).
// A webmention is two URLs in a form body — 8kb is generous.
app.use(
  '/webmention',
  webmentionLimiter,
  express.urlencoded({ extended: false, limit: '8kb' }),
  webmentionPublicRoutes,
);

// Auth middleware for API routes
app.use('/api', (req, res, next) => {
  const session = req.signedCookies?.session;
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const sessionData = JSON.parse(Buffer.from(session, 'base64').toString('utf-8'));
    // Reject malformed-but-parseable payloads (e.g. `null`, a string, or a
    // missing/!numeric expiry) so we never attach junk to req.user.
    if (
      !sessionData ||
      typeof sessionData !== 'object' ||
      typeof sessionData.expires !== 'number'
    ) {
      res.clearCookie('session');
      return res.status(401).json({ error: 'Invalid session' });
    }
    if (sessionData.expires < Date.now()) {
      res.clearCookie('session');
      return res.status(401).json({ error: 'Session expired' });
    }
    req.user = sessionData;
    next();
  } catch {
    res.clearCookie('session');
    return res.status(401).json({ error: 'Invalid session' });
  }
});

// API routes
app.use('/api/posts', postsRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/publish', publishRoutes);
app.use('/api/health', healthRoutes);
// Phase 5e
app.use('/api/settings', settingsRoutes);
app.use('/api/taxonomies', taxonomiesRoutes);
app.use('/api/redirects', redirectsRoutes);
app.use('/api/activity', activityRoutes);
// Umami analytics proxy — degrades to { configured: false } when the
// UMAMI_* env vars are absent, so dev sessions without docker up work.
app.use('/api/analytics', analyticsRoutes);
// Phase 7
app.use('/api/embed', embedRoutes);
// Phase 8 — admin moderation surface for inbound webmentions. Sits
// behind the same session auth as /api/posts etc.
app.use('/api/webmentions', webmentionAdminRoutes);
// Phase 8.5 — unified Remark42 + webmention moderation. Exposes a
// single /api/comments surface so the admin UI doesn't need to know
// which backend a row came from. Includes an SSE channel
// (/api/comments/stream) for real-time updates.
app.use('/api/comments', commentsRoutes);
// Templates static mount — read-only access to admin/templates/*.md so
// the "New Post" picker can fetch each scaffold.
app.use('/api/templates', express.static(join(__dirname, 'templates'), { fallthrough: false }));

// SPA fallback — serve index.html for client-side routing.
// (Plain middleware, not app.get('*'): express 5 / path-to-regexp 8
// rejects the bare-'*' route pattern.)
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Export SITE_DIR (+ the app, for the boot smoke test) for use elsewhere.
export { SITE_DIR, app };

// Don't bind a port under test. Importing this module still builds the whole
// app — every route registers — which is exactly what the boot smoke test
// relies on to catch registration-time crashes (e.g. an Express-incompatible
// route) that per-router unit tests never exercise.
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ■ Web World Wide CMS`);
    console.log(`  ├─ Admin: http://localhost:${PORT}`);
    console.log(`  ├─ Site:  ${SITE_DIR}`);
    console.log(`  └─ Ready.\n`);
  });
}
