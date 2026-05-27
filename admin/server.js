/**
 * Terminal Eighty CMS — Express Server
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

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: false, // Disabled to allow external images/scripts for now
  }),
);

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser(process.env.SESSION_SECRET || 'terminal-eighty-secret'));

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
// bursts (Mastodon fans-out one ping per follower-mentioning-us).
const webmentionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: { error: 'Too many webmentions. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Static files (admin UI)
app.use(express.static(join(__dirname, 'public')));

// Phase 4: serve uploaded originals straight off the site's static
// tree. In production these are also baked into Hugo's output by the
// publish step; the admin process serves them directly so the library
// UI works the moment a file is uploaded — no `hugo build` round-trip.
// Mounting `images` and `files` as separate roots so we never expose
// the rest of `site/static/`.
app.use(
  '/images',
  express.static(join(SITE_DIR, 'static', 'images'), {
    fallthrough: false,
    maxAge: '7d',
  }),
);
app.use(
  '/files',
  express.static(join(SITE_DIR, 'static', 'files'), {
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
app.use('/webmention', webmentionLimiter, webmentionPublicRoutes);

// Auth middleware for API routes
app.use('/api', (req, res, next) => {
  const session = req.signedCookies?.session;
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const sessionData = JSON.parse(Buffer.from(session, 'base64').toString());
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

// SPA fallback — serve index.html for client-side routing
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Export SITE_DIR for use in routes
export { SITE_DIR };

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ■ Terminal Eighty CMS`);
  console.log(`  ├─ Admin: http://localhost:${PORT}`);
  console.log(`  ├─ Site:  ${SITE_DIR}`);
  console.log(`  └─ Ready.\n`);
});
