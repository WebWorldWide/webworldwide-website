/**
 * Web World Wide CMS — Express Server
 *
 * Admin panel for managing the blog. Runs on the Pi, accessible via Cloudflare Tunnel.
 * Provides: post CRUD, media upload, git publish, auth (passkey + password), system health.
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
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
import proofreadRoutes from './src/routes/proofread.js';
import healthRoutes from './src/routes/health.js';
// Site settings, redirects, and activity log.
import settingsRoutes from './src/routes/settings.js';
import redirectsRoutes from './src/routes/redirects.js';
import activityRoutes from './src/routes/activity.js';
// Paste-to-embed lookup — resolves YouTube/Vimeo/Bluesky/… URLs via oEmbed
// (or OG scrape) and caches results 24h in `embed_cache`.
import embedRoutes from './src/routes/embed.js';
// Webmention receiver: public /webmention endpoint (rate-limited, no auth) for
// incoming pings; /api/webmentions for moderation behind the session cookie.
import {
  publicRouter as webmentionPublicRoutes,
  adminRouter as webmentionAdminRoutes,
} from './src/routes/webmentions.js';
// Unified comment moderation — proxies Remark42 + webmentions into one surface.
import commentsRoutes from './src/routes/comments.js';
import * as remark42Poller from './src/services/remark42-poller.js';
// Server-side Umami analytics proxy — the dashboard traffic widgets
// read /api/analytics/* so the browser never talks to Umami directly
// (credentials stay server-side; responses cached 5 min for the Pi).
import analyticsRoutes from './src/routes/analytics.js';
// Migration runner — applies any pending DDL at boot; idempotent via
// `schema_migrations` tracking table.
import { runMigrations } from './src/db/migrate.js';
// Conversion job worker — started after migrations so `conversion_jobs`
// exists. SIGTERM/SIGINT bind a graceful drain.
import { startWorker, bindShutdownSignals } from './src/services/conversion/index.js';
// Retention sweeper — keeps the append-only tables (activity_log,
// embed_cache) bounded for a blog used daily over years.
import { startRetention } from './src/services/retention.js';

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

// Retention sweep — prune activity_log + embed_cache on boot and daily.
// Skipped under test (no lingering 24h timer) and via RETENTION=off.
if (process.env.NODE_ENV !== 'test' && process.env.RETENTION !== 'off') {
  try {
    startRetention();
  } catch (retentionErr) {
    console.error('[retention] failed to start:', retentionErr);
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
//     template strings.
//   - `style-src 'unsafe-inline'` is required because TipTap injects its
//     base CSS as a runtime <style> element (editor.bundle.js); the pages
//     are statically served so a per-request nonce can't be threaded in.
//     Script execution stays fully locked (script-src 'self',
//     script-src-attr 'none', object-src 'none', base-uri 'self').
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
        'style-src': ["'self'", "'unsafe-inline'"],
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
          // Homepage editor "Live" preview iframes the published public site.
          'https://webworldwide.online',
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
const jsonParser = express.json({ limit: '2mb' });
// Skip BOTH global body parsers for /webmention: the receiver mounts its
// own 8kb urlencoded parser at the route, and letting the 2mb JSON parser
// run here would let a JSON-typed ping bypass that 8kb cap — memory/DoS
// amplification on the one unauthenticated endpoint.
app.use((req, res, next) => {
  if (req.path.startsWith('/webmention')) return next();
  return jsonParser(req, res, (err) => (err ? next(err) : urlencodedParser(req, res, next)));
});
app.use(cookieParser(SESSION_SECRET || randomBytes(32).toString('hex')));

// Rate limiting.
//
// Key the rate limiter on the REAL client IP so each client gets its own bucket
// (and one brute-forcer can't lock everyone else — incl. the admin — out).
//
// The cms publishes NO host port (docker-compose has no `ports:` for cms) and is
// reachable ONLY via Caddy on the docker network (Caddyfile: `reverse_proxy
// cms:3000`). So the immediate TCP peer is ALWAYS Caddy — there is no direct
// LAN/host path to :3000 to spoof a forwarding header. That makes Cloudflare's
// CF-Connecting-IP (set at the tunnel) / Caddy's X-Forwarded-For authoritative.
// The previous loopback-only check never matched (peer is Caddy's bridge IP, not
// loopback, now that cms + caddy are separate containers), so every client
// collapsed into Caddy's single IP — one global bucket = a trivial login-lockout
// DoS. ipKeyGenerator normalizes IPv6 to a subnet (required since v8).
const clientIpKey = (/** @type {import('express').Request} */ req) => {
  const fwd =
    req.headers['cf-connecting-ip'] ||
    String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
  const key = fwd || req.socket?.remoteAddress || '';
  return ipKeyGenerator(String(key || ''));
};

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per window
  message: { error: 'Too many auth attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKey,
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
  keyGenerator: clientIpKey,
});

// Spell/grammar proofreading is auth-gated, but it's called as the writer
// types (debounced client-side). Cap it generously per-IP so a stuck client
// or a misbehaving tab can't hammer the LanguageTool container.
const proofreadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  message: { error: 'Too many proofread requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKey,
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
// Defense-in-depth for user-uploaded media served from the admin origin (and,
// once committed, by GitHub Pages — which has NO CSP). Never let an uploaded
// SVG/HTML render inline as active content: nosniff everything, and force a
// download for script-capable types. (Such uploads are also blocked at the door
// — see mediaTypes DENYLIST_EXTENSIONS.)
const RISKY_INLINE_MEDIA = /\.(svg|svgz|html?|xhtml|xml|js|mjs|wasm)$/i;
const mediaStaticHeaders = (/** @type {any} */ res, /** @type {string} */ filePath) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (RISKY_INLINE_MEDIA.test(filePath)) res.setHeader('Content-Disposition', 'attachment');
};

// Mounting `images` and `files` as separate roots so we never expose the
// rest of `site/public/`.
app.use(
  '/images',
  express.static(join(SITE_PUBLIC_DIR, 'images'), {
    fallthrough: false,
    maxAge: '7d',
    setHeaders: mediaStaticHeaders,
  }),
);
app.use(
  '/files',
  express.static(join(SITE_PUBLIC_DIR, 'files'), {
    fallthrough: false,
    maxAge: '7d',
    setHeaders: mediaStaticHeaders,
  }),
);
// `/assets` holds the static design images (app icons, globe) the homepage
// references as `/assets/*.png`. Mounting it read-only — like images/files —
// so the homepage editor preview + media references resolve to real files
// instead of 404ing into the SPA fallback (broken-image glyphs).
app.use(
  '/assets',
  express.static(join(SITE_PUBLIC_DIR, 'assets'), {
    fallthrough: false,
    maxAge: '7d',
    setHeaders: mediaStaticHeaders,
  }),
);

// Auth routes. The brute-force limiter must cover credential attempts
// (every sensitive /auth endpoint is a POST) but NOT GET /auth/status —
// the SPA pings status on every page load, and metering it locks a
// normal user out of their own admin within minutes.
app.use(
  '/auth',
  (req, res, next) => (req.method === 'POST' ? authLimiter(req, res, next) : next()),
  authRoutes,
);

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
app.use('/api/proofread', proofreadLimiter, proofreadRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/redirects', redirectsRoutes);
app.use('/api/activity', activityRoutes);
// Umami analytics proxy — degrades to { configured: false } when UMAMI_* vars are absent.
app.use('/api/analytics', analyticsRoutes);
app.use('/api/embed', embedRoutes);
app.use('/api/webmentions', webmentionAdminRoutes);
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

// Final error handler — must be last in the chain. Express 5 forwards
// async-route rejections here automatically; without it Express would
// leak an HTML stack trace to the client. Log the detail server-side and
// return a clean JSON 500 (or the error's own status, if it set one).
app.use((err, req, res, _next) => {
  console.error('[error]', req.method, req.path, '—', err?.stack || err?.message || err);
  if (res.headersSent) return;
  res.status(err?.status || err?.statusCode || 500).json({ error: 'internal_error' });
});

export { SITE_DIR, app };

// Don't bind a port under test. Importing this module still builds the whole
// app — every route registers — which is exactly what the boot smoke test
// relies on to catch registration-time crashes (e.g. an Express-incompatible
// route) that per-router unit tests never exercise.
if (process.env.NODE_ENV !== 'test') {
  // Process-level safety nets. The CMS does fire-and-forget work
  // (un-awaited logActivity, the remark42 poller, the conversion worker)
  // whose rejections would otherwise be unhandled.
  process.on('unhandledRejection', (reason) => {
    // Log and keep serving — a single stray rejection must never take the
    // whole CMS down for the day.
    console.error('[fatal] unhandledRejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    // After an uncaught throw the process state is undefined; exit so the
    // container's `restart: unless-stopped` policy hands us a clean one.
    console.error('[fatal] uncaughtException — exiting for a clean restart:', err);
    process.exit(1);
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ■ Web World Wide CMS`);
    console.log(`  ├─ Admin: http://localhost:${PORT}`);
    console.log(`  ├─ Site:  ${SITE_DIR}`);
    console.log(`  └─ Ready.\n`);
  });
}
