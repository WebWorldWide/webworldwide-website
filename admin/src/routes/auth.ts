/**
 * Authentication Routes — Passkey (WebAuthn) + Password, server-side sessions.
 *
 * Hardening (2026-11 audit):
 *  - Sessions are random IDs stored server-side (SHA-256 hashed), revocable,
 *    with a 12h idle and 7-day absolute lifetime. Logout really ends the
 *    session; "sign out everywhere" ends all of them. (The old cookie was a
 *    signed JSON blob that stayed valid for 7 days after logout.)
 *  - Once the account has a passkey, password login is refused unless
 *    ALLOW_PASSWORD_LOGIN=1 is set (break-glass recovery) — otherwise a
 *    passkey added nothing over a guessable password.
 *  - Failed logins are capped globally (not just per IP), so a distributed
 *    guesser can't make unlimited attempts.
 *  - Adding a passkey requires a recent sign-in (step-up), so a stolen
 *    session can't quietly enroll an attacker's authenticator.
 *  - Passkeys are discoverable: the login challenge no longer lists every
 *    credential ID to unauthenticated callers.
 *  - Production first-run setup requires SETUP_TOKEN, so losing the auth DB
 *    volume can't hand the admin account to the first visitor.
 *  - Every auth event is written to the activity log with the client IP.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import bcrypt from 'bcrypt';
import Database from 'better-sqlite3';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { getClientIp } from '../utils/clientIp.js';
import { logActivity } from '../services/activity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = Router();

// Config
// Env-var precedence: prefer the WEBAUTHN_* names (Phase 5d dev stack)
// but fall back to the production compose names (RP_ID / ORIGIN) for
// backward compatibility.
const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'Web World Wide CMS';
const RP_ID = process.env.WEBAUTHN_RP_ID || process.env.RP_ID || 'localhost';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || process.env.ORIGIN || 'http://localhost:3000';
const IS_PROD = process.env.NODE_ENV === 'production';

const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000; // 12 hours
const SESSION_TOUCH_MS = 60 * 1000; // persist last_seen at most once a minute
const STEP_UP_MS = 15 * 60 * 1000; // sensitive actions need a sign-in this recent
const MIN_PASSWORD_LENGTH = 12;

/** Cookie name. `__Host-` pins it to this exact origin (Secure, Path=/, no Domain). */
export const SESSION_COOKIE = IS_PROD ? '__Host-session' : 'session';
const cookieOpts = () => ({
  signed: true,
  httpOnly: true,
  secure: IS_PROD,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_ABSOLUTE_MS,
});

// Database
// AUTH_DB_PATH lets tests inject a temp-file DB; production uses admin/data/auth.db.
const dbPath = process.env.AUTH_DB_PATH || join(__dirname, '..', '..', 'data', 'auth.db');
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS passkeys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        credential_id TEXT UNIQUE NOT NULL,
        public_key TEXT NOT NULL,
        counter INTEGER DEFAULT 0,
        transports TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY,
        challenge TEXT NOT NULL,
        type TEXT NOT NULL,
        user_id TEXT,
        created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
        id_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        method TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ip TEXT,
        user_agent TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
`);
// Older DBs predate passkey labels / last-used tracking.
for (const col of ['name TEXT', 'last_used_at TEXT']) {
  try {
    db.exec(`ALTER TABLE passkeys ADD COLUMN ${col}`);
  } catch {
    /* column already exists */
  }
}

function hasUsers() {
  const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  return row.count > 0;
}

export function passkeyCount(userId?: string): number {
  const row = (
    userId
      ? db.prepare('SELECT COUNT(*) as count FROM passkeys WHERE user_id = ?').get(userId)
      : db.prepare('SELECT COUNT(*) as count FROM passkeys').get()
  ) as { count: number };
  return row.count;
}

/** Password login is allowed until the account has a passkey (or break-glass). */
export function passwordLoginAllowed(userId?: string): boolean {
  if (process.env.ALLOW_PASSWORD_LOGIN === '1') return true;
  return passkeyCount(userId) === 0;
}

// Abandoned ceremonies (cancelled OS prompt, closed tab) leave challenge
// rows forever. Sweep anything older than the 5-minute validity window on
// each ceremony start so the table can't grow unbounded.
function pruneChallenges() {
  try {
    db.prepare("DELETE FROM challenges WHERE created_at < datetime('now', '-10 minutes')").run();
    db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?').run(
      Date.now(),
      Date.now() - SESSION_IDLE_MS,
    );
  } catch {
    /* best-effort cleanup */
  }
}

// ── Sessions ──────────────────────────────────────────────────────────────

const hashId = (id: string) => createHash('sha256').update(id).digest('hex');

export interface SessionUser {
  userId: string;
  username: string;
  sessionId: string; // hash — safe to expose to the owner for revocation
  method: string;
  createdAt: number;
}

function createSession(
  req: Request,
  res: Response,
  user: { id: string; username: string },
  method: string,
) {
  const id = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id_hash, user_id, method, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hashId(id),
    user.id,
    method,
    now,
    now,
    now + SESSION_ABSOLUTE_MS,
    getClientIp(req),
    String(req.headers['user-agent'] || '').slice(0, 300),
  );
  res.cookie(SESSION_COOKIE, id, cookieOpts());
  logActivity({
    user: user.username,
    action: 'auth.login',
    meta: { method, ip: getClientIp(req) },
  });
}

/**
 * Resolve the request's session. Returns null for missing, unknown, revoked,
 * idle-expired, or absolute-expired sessions. Used by the /api gate.
 */
export function resolveSession(req: Request): SessionUser | null {
  const raw = req.signedCookies?.[SESSION_COOKIE];
  if (!raw || typeof raw !== 'string' || raw.length > 128) return null;
  const idHash = hashId(raw);
  const row = db
    .prepare(
      `SELECT s.*, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
    )
    .get(idHash) as any;
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now || row.last_seen_at < now - SESSION_IDLE_MS) {
    db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
    return null;
  }
  if (now - row.last_seen_at > SESSION_TOUCH_MS) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(now, idHash);
  }
  return {
    userId: row.user_id,
    username: row.username,
    sessionId: idHash,
    method: row.method,
    createdAt: row.created_at,
  };
}

/** True when the session signed in recently enough for a sensitive action. */
export function isRecentAuth(s: SessionUser | null | undefined): boolean {
  return Boolean(s) && Date.now() - s.createdAt < STEP_UP_MS;
}

export function listSessions(userId: string) {
  return db
    .prepare(
      `SELECT id_hash AS id, method, created_at, last_seen_at, expires_at, ip, user_agent
       FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC`,
    )
    .all(userId);
}

export function revokeSession(userId: string, idHash: string): boolean {
  return (
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash = ?').run(userId, idHash)
      .changes > 0
  );
}

export function revokeOtherSessions(userId: string, keepIdHash: string | null): number {
  return db
    .prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?')
    .run(userId, keepIdHash || '').changes;
}

// ── Failed-login throttle (global, in-memory) ─────────────────────────────
// Per-IP limits live in server.ts. This global cap stops a distributed
// guesser: past FAIL_LIMIT failures in the window, password login pauses.
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 30;
let failures: number[] = [];
function recordFailure() {
  const now = Date.now();
  failures = failures.filter((t) => t > now - FAIL_WINDOW_MS);
  failures.push(now);
}
function loginPaused() {
  const now = Date.now();
  failures = failures.filter((t) => t > now - FAIL_WINDOW_MS);
  return failures.length >= FAIL_LIMIT;
}
/** Test hook. */
export function _resetLoginFailures() {
  failures = [];
}

// ── Setup check ──
router.get('/status', (req, res) => {
  const s = resolveSession(req);
  res.json({
    setupComplete: hasUsers(),
    authenticated: Boolean(s),
    hasPasskey: s ? passkeyCount(s.userId) > 0 : false,
    // Lets the login screen hide the password form once passkeys are enforced.
    passwordLogin: passwordLoginAllowed(),
    username: s ? s.username : undefined,
  });
});

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// ── Initial Setup: Create admin user ──
router.post('/setup', async (req, res) => {
  if (hasUsers()) {
    return res.status(403).json({ error: 'Setup already complete' });
  }
  const { username, password, setupToken } = req.body || {};
  if (IS_PROD) {
    const expected = process.env.SETUP_TOKEN || '';
    if (!expected || typeof setupToken !== 'string' || !safeEqual(setupToken, expected)) {
      logActivity({
        user: 'anonymous',
        action: 'auth.setup_denied',
        meta: { ip: getClientIp(req) },
      });
      return res.status(403).json({
        error: 'setup_token_required',
        message: 'First-run setup requires the SETUP_TOKEN from the server environment.',
      });
    }
  }
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res
      .status(400)
      .json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }

  const id = randomBytes(16).toString('hex');
  const hash = await bcrypt.hash(password, 12);
  // bcrypt.hash() yields the event loop, so the hasUsers() check above is not
  // atomic with this insert — two concurrent /setup requests could both pass
  // it and both create an account. Make the insert itself conditional so
  // SQLite's own single-writer serialization is what actually prevents a
  // second admin account, not the earlier (racy) hasUsers() check.
  const result = db
    .prepare(
      'INSERT INTO users (id, username, password_hash) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)',
    )
    .run(id, username, hash);
  if (result.changes === 0) {
    return res.status(403).json({ error: 'Setup already complete' });
  }

  createSession(req, res, { id, username }, 'setup');
  res.json({ success: true, message: 'Admin account created. Now register a passkey.' });
});

// A valid cost-12 bcrypt hash (of a random throwaway string) computed once at
// boot. Compared against in the user-not-found branch so that path does the same
// ~hundreds-of-ms of work as a real compare — otherwise the latency delta lets an
// unauthenticated caller enumerate valid usernames. Cost matches registration (12).
const DUMMY_LOGIN_HASH = bcrypt.hashSync(randomBytes(16).toString('hex'), 12);

// ── Password Login ──
router.post('/login/password', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (loginPaused()) {
    return res.status(429).json({
      error: 'login_paused',
      message: 'Too many failed sign-ins recently. Password login is paused for a few minutes.',
    });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
  const valid = user
    ? await bcrypt.compare(password, user.password_hash || DUMMY_LOGIN_HASH)
    : // Equalize timing with the found-user path before the identical 401.
      (await bcrypt.compare(password, DUMMY_LOGIN_HASH), false);
  if (!user || !valid) {
    recordFailure();
    logActivity({
      user: 'anonymous',
      action: 'auth.login_failed',
      meta: { method: 'password', username: String(username).slice(0, 64), ip: getClientIp(req) },
    });
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  // Checked only AFTER a correct password so the response doesn't reveal
  // whether an account exists or has passkeys.
  if (!passwordLoginAllowed(user.id)) {
    logActivity({
      user: user.username,
      action: 'auth.password_refused',
      meta: { ip: getClientIp(req) },
    });
    return res.status(403).json({
      error: 'password_login_disabled',
      message: 'This account uses a passkey. Sign in with your passkey instead.',
    });
  }

  createSession(req, res, user, 'password');
  res.json({ success: true, hasPasskey: passkeyCount(user.id) > 0 });
});

// ── Passkey Registration (start) ──
router.post('/passkey/register/start', async (req, res) => {
  const s = resolveSession(req);
  if (!s) return res.status(401).json({ error: 'Must be logged in to register passkey' });
  // Step-up: the first passkey can be added right after sign-in; adding more
  // later needs a fresh sign-in so a stolen session can't enroll a new key.
  if (!isRecentAuth(s)) {
    return res.status(403).json({
      error: 'reauth_required',
      message: 'For your security, sign out and sign in again before adding a passkey.',
    });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.userId) as any;
  if (!user) return res.status(401).json({ error: 'User not found' });
  pruneChallenges();

  const existingKeys = db
    .prepare('SELECT credential_id FROM passkeys WHERE user_id = ?')
    .all(user.id) as Array<{ credential_id: string }>;

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: new TextEncoder().encode(user.id),
    userName: user.username,
    attestationType: 'none',
    excludeCredentials: existingKeys.map((k) => ({
      id: k.credential_id,
      type: 'public-key',
    })),
    authenticatorSelection: {
      // Discoverable credentials let login skip `allowCredentials`, so the
      // unauthenticated login challenge never enumerates our credential IDs.
      residentKey: 'required',
      userVerification: 'required',
    },
  });

  const challengeId = randomBytes(16).toString('hex');
  db.prepare('INSERT INTO challenges (id, challenge, type, user_id) VALUES (?, ?, ?, ?)').run(
    challengeId,
    options.challenge,
    'registration',
    user.id,
  );

  res.json({ options, challengeId });
});

// ── Passkey Registration (finish) ──
router.post('/passkey/register/finish', async (req, res) => {
  const s = resolveSession(req);
  if (!s) return res.status(401).json({ error: 'Must be logged in to register passkey' });
  const { challengeId, credential, name } = req.body || {};

  const challengeRow = db
    .prepare(
      "SELECT * FROM challenges WHERE id = ? AND type = ? AND user_id = ? AND created_at > datetime('now', '-5 minutes')",
    )
    .get(challengeId, 'registration', s.userId) as any;
  if (!challengeRow) return res.status(400).json({ error: 'Invalid challenge' });

  db.prepare('DELETE FROM challenges WHERE id = ?').run(challengeId);

  try {
    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });

    if (verification.verified && verification.registrationInfo) {
      const { credential: cred } = verification.registrationInfo;
      const passkeyId = randomBytes(16).toString('hex');
      const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : 'Passkey';

      db.prepare(
        `INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, name)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        passkeyId,
        challengeRow.user_id,
        // @simplewebauthn v13 already gives cred.id as a base64url STRING;
        // re-encoding it (Buffer.from(string)) double-encoded it, so the
        // login assertion's credential id never matched and passkey login
        // was silently broken. Store as-is (defensive for byte-array forms).
        typeof cred.id === 'string' ? cred.id : Buffer.from(cred.id).toString('base64url'),
        Buffer.from(cred.publicKey).toString('base64'),
        cred.counter,
        JSON.stringify(credential?.response?.transports || []),
        label,
      );
      logActivity({
        user: s.username,
        action: 'auth.passkey_added',
        target: label,
        meta: { ip: getClientIp(req) },
      });

      res.json({ success: true, message: 'Passkey registered!' });
    } else {
      res.status(400).json({ error: 'Verification failed' });
    }
  } catch (err) {
    console.error('Passkey registration error:', err);
    res.status(400).json({ error: 'verification_failed' });
  }
});

// ── Passkey Authentication (start) ──
router.post('/passkey/login/start', async (req, res) => {
  pruneChallenges();
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    // Empty → the browser offers discoverable credentials for this RP.
    allowCredentials: [],
    userVerification: 'required',
  });

  const challengeId = randomBytes(16).toString('hex');
  db.prepare('INSERT INTO challenges (id, challenge, type) VALUES (?, ?, ?)').run(
    challengeId,
    options.challenge,
    'authentication',
  );

  res.json({ options, challengeId });
});

// ── Passkey Authentication (finish) ──
router.post('/passkey/login/finish', async (req, res) => {
  const { challengeId, credential } = req.body || {};

  const challengeRow = db
    .prepare(
      "SELECT * FROM challenges WHERE id = ? AND type = ? AND created_at > datetime('now', '-5 minutes')",
    )
    .get(challengeId, 'authentication') as any;
  if (!challengeRow) return res.status(400).json({ error: 'Invalid challenge' });

  db.prepare('DELETE FROM challenges WHERE id = ?').run(challengeId);

  const credId = credential?.id;
  const passkey = db.prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(credId) as any;
  if (!passkey) {
    recordFailure();
    logActivity({
      user: 'anonymous',
      action: 'auth.login_failed',
      meta: { method: 'passkey', reason: 'unknown_credential', ip: getClientIp(req) },
    });
    return res.status(401).json({ error: 'Unknown passkey' });
  }

  try {
    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      credential: {
        id: passkey.credential_id,
        publicKey: Buffer.from(passkey.public_key, 'base64'),
        counter: passkey.counter,
      },
    });

    if (verification.verified) {
      db.prepare(
        "UPDATE passkeys SET counter = ?, last_used_at = datetime('now') WHERE id = ?",
      ).run(verification.authenticationInfo.newCounter, passkey.id);

      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(passkey.user_id) as any;
      createSession(req, res, user, 'passkey');
      res.json({ success: true });
    } else {
      recordFailure();
      res.status(401).json({ error: 'Authentication failed' });
    }
  } catch (err) {
    recordFailure();
    console.error('Passkey auth error:', err);
    res.status(401).json({ error: 'verification_failed' });
  }
});

// ── Logout ──
router.post('/logout', (req, res) => {
  const s = resolveSession(req);
  if (s) {
    db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(s.sessionId);
    logActivity({ user: s.username, action: 'auth.logout', meta: { ip: getClientIp(req) } });
  }
  res.clearCookie(SESSION_COOKIE, { path: '/', secure: IS_PROD, sameSite: 'lax' });
  // Clear the pre-2026-11 cookie name too.
  if (SESSION_COOKIE !== 'session') res.clearCookie('session');
  res.json({ success: true });
});

export default router;
