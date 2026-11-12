/**
 * Commenter accounts — public routes, served ONLY on the comments domain:
 * Caddy maps https://comments.<domain>/account/* here (docker/Caddyfile), so
 * the session cookies land on the same origin as the Remark42 widget.
 *
 *   GET  /commenter/            sign-in / create-account page
 *   GET  /commenter/app.js      its script (no inline JS: strict CSP)
 *   GET  /commenter/me          { username } (null when signed out)
 *   POST /commenter/register    { username, password }
 *   POST /commenter/login       { username, password }
 *   POST /commenter/logout
 *   POST /commenter/password    { current, next }
 *
 * Admin moderation (list / reset / delete) is in adminRouter, mounted under
 * the session-protected /api/commenters.
 */
import { Router, json, type Request, type Response, type NextFunction } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as accounts from '../services/commenter-accounts.js';
import * as remark42 from '../services/remark42.js';
import { logActivity } from '../services/activity.js';
import { getClientIp } from '../utils/clientIp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = join(__dirname, '..', '..', 'public', 'commenter');

// The comments origin (and the site, for postMessage back to the post page).
const commentsOrigin = (): string => (process.env.COMMENTS_ORIGIN || '').replace(/\/$/, '');
const siteOrigin = (): string =>
  (process.env.SITE_ORIGIN || 'https://webworldwide.online').replace(/\/$/, '');

const JWT_COOKIE = 'JWT';
const XSRF_COOKIE = 'XSRF-TOKEN';

const ipKey = (req: Request): string => ipKeyGenerator(getClientIp(req) || 'unknown');
const limiter = (windowMin: number, max: number) =>
  rateLimit({
    windowMs: windowMin * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: ipKey,
    message: {
      error: 'too_many',
      message: 'Too many attempts. Please wait a few minutes and try again.',
    },
  });
const loginLimiter = limiter(15, 15);
const registerLimiter = limiter(60, 6);
const passwordLimiter = limiter(15, 10);

/** State-changing requests must come from the comments origin, as JSON. */
function sameOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = commentsOrigin();
  if (!origin || req.headers.origin !== origin) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    res.status(415).json({ error: 'json_required' });
    return;
  }
  next();
}

/** The session token from the request's JWT cookie, if any. */
function sessionCookie(req: Request): string | undefined {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === JWT_COOKIE) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return undefined;
}

function signIn(res: Response, acct: accounts.Account): void {
  const { jwt, xsrf, maxAgeMs } = accounts.sessionToken(acct);
  const base = { path: '/', secure: true, sameSite: 'lax' as const, maxAge: maxAgeMs };
  // Same names Remark42 uses for its own sessions, so its widget, its
  // sign-out button and its XSRF check all just work.
  res.cookie(JWT_COOKIE, jwt, { ...base, httpOnly: true });
  res.cookie(XSRF_COOKIE, xsrf, { ...base, httpOnly: false });
  // Best effort: the "verified" badge marks registered names on comments.
  remark42.verifyUser(accounts.remarkUserId(acct), true).catch(() => {});
}

function signOut(res: Response): void {
  const base = { path: '/', secure: true, sameSite: 'lax' as const };
  res.clearCookie(JWT_COOKIE, { ...base, httpOnly: true });
  res.clearCookie(XSRF_COOKIE, base);
}

function fail(res: Response, err: unknown): void {
  if (err instanceof accounts.AccountError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  console.error('[commenter]', err);
  res
    .status(500)
    .json({ error: 'server_error', message: 'Something went wrong. Please try again.' });
}

function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.set('Cache-Control', 'no-store');
  next();
}

export const publicRouter = Router();
publicRouter.use(noStore);

publicRouter.get('/', (_req, res) => {
  const html = readFileSync(join(PAGE_DIR, 'index.html'), 'utf8').replaceAll(
    '__SITE_ORIGIN__',
    siteOrigin(),
  );
  res
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      // Helmet's default (same-origin) would cut the popup off from the blog
      // post that opened it, so it couldn't report the sign-in. Messages go
      // only to the site origin, and the page can't be framed.
      'Cross-Origin-Opener-Policy': 'unsafe-none',
    })
    .send(html);
});

for (const asset of ['app.js', 'style.css']) {
  publicRouter.get(`/${asset}`, (_req, res) => {
    res.type(asset.endsWith('.js') ? 'application/javascript' : 'text/css');
    res.send(readFileSync(join(PAGE_DIR, asset), 'utf8'));
  });
}

// Signed out is a normal answer here (200, username null), not an error, so
// visitors' consoles stay clean.
publicRouter.get('/me', (req, res) => {
  const acct = accounts.sessionAccount(sessionCookie(req));
  res.json({ username: acct ? acct.username : null });
});

const body = json({ limit: '2kb' });

publicRouter.post('/register', registerLimiter, sameOrigin, body, async (req, res) => {
  try {
    const acct = await accounts.register(req.body?.username, req.body?.password);
    signIn(res, acct);
    logActivity({ req, action: 'commenter.register', target: acct.username });
    res.json({ username: acct.username });
  } catch (err) {
    fail(res, err);
  }
});

publicRouter.post('/login', loginLimiter, sameOrigin, body, async (req, res) => {
  try {
    const acct = await accounts.login(req.body?.username, req.body?.password);
    signIn(res, acct);
    res.json({ username: acct.username });
  } catch (err) {
    fail(res, err);
  }
});

publicRouter.post('/logout', sameOrigin, body, (_req, res) => {
  signOut(res);
  res.json({ ok: true });
});

publicRouter.post('/password', passwordLimiter, sameOrigin, body, async (req, res) => {
  const acct = accounts.sessionAccount(sessionCookie(req));
  if (!acct) return res.status(401).json({ error: 'signed_out', message: 'Please sign in again.' });
  try {
    const updated = await accounts.changePassword(acct.id, req.body?.current, req.body?.next);
    signIn(res, updated);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

// ── Admin (mounted under the session-protected /api/commenters) ─────────

export const adminRouter = Router();

adminRouter.get('/', (_req, res) => {
  res.json({ items: accounts.list() });
});

adminRouter.post('/:id/reset', async (req, res) => {
  try {
    const temp = await accounts.adminResetPassword(String(req.params.id));
    logActivity({ req, action: 'commenter.reset', target: String(req.params.id) });
    res.json({ temporaryPassword: temp });
  } catch (err) {
    fail(res, err);
  }
});

adminRouter.delete('/:id', async (req, res) => {
  const acct = accounts.findById(String(req.params.id));
  if (!acct) return res.status(404).json({ error: 'not_found' });
  accounts.adminDelete(acct.id);
  // A deleted account's existing sign-in is still a valid Remark42 session
  // until it expires; block it so it can't keep commenting.
  await remark42.blockUser(accounts.remarkUserId(acct), { block: true }).catch(() => {});
  logActivity({ req, action: 'commenter.delete', target: acct.username });
  res.status(204).end();
});
