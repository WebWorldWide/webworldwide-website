/**
 * Authentication Routes — Passkey (WebAuthn) + Password
 */

import { Router } from 'express';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import bcrypt from 'bcrypt';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = Router();

// Config
// Env-var precedence: prefer the WEBAUTHN_* names (Phase 5d dev stack)
// but fall back to the production compose names (RP_ID / ORIGIN) for
// backward compatibility.
const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'Web World Wide CMS';
const RP_ID = process.env.WEBAUTHN_RP_ID || process.env.RP_ID || 'localhost';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || process.env.ORIGIN || 'http://localhost:3000';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

// Database
// AUTH_DB_PATH lets tests inject a temp-file DB; production uses admin/data/auth.db.
import { mkdirSync } from 'fs';
const dbPath = process.env.AUTH_DB_PATH || join(__dirname, '..', '..', 'data', 'auth.db');
mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
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
`);

function hasUsers() {
  const row = db.prepare('SELECT COUNT(*) as count FROM users').get();
  return row.count > 0;
}

// Abandoned ceremonies (cancelled OS prompt, closed tab) leave challenge
// rows forever. Sweep anything older than the 5-minute validity window on
// each ceremony start so the table can't grow unbounded.
function pruneChallenges() {
  try {
    db.prepare("DELETE FROM challenges WHERE created_at < datetime('now', '-10 minutes')").run();
  } catch {
    /* best-effort cleanup */
  }
}

function createSession(res, user) {
  const sessionData = {
    userId: user.id,
    username: user.username,
    expires: Date.now() + SESSION_MAX_AGE,
  };
  res.cookie('session', Buffer.from(JSON.stringify(sessionData)).toString('base64'), {
    signed: true,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE,
  });
}

// ── Setup check ──
router.get('/status', (req, res) => {
  const session = req.signedCookies?.session;
  let authenticated = false;
  let hasPasskey = false;
  if (session) {
    try {
      const data = JSON.parse(Buffer.from(session, 'base64').toString());
      if (data.expires > Date.now()) {
        authenticated = true;
        const passkeysCount = db
          .prepare('SELECT COUNT(*) as count FROM passkeys WHERE user_id = ?')
          .get(data.userId);
        hasPasskey = passkeysCount && passkeysCount.count > 0;
      }
    } catch {
      /* invalid session */
    }
  }
  res.json({
    setupComplete: hasUsers(),
    authenticated,
    hasPasskey,
  });
});

// ── Initial Setup: Create admin user ──
router.post('/setup', async (req, res) => {
  if (hasUsers()) {
    return res.status(403).json({ error: 'Setup already complete' });
  }
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const id = randomBytes(16).toString('hex');
  const hash = await bcrypt.hash(password, 12);
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(
    id,
    username,
    hash,
  );

  createSession(res, { id, username });
  res.json({ success: true, message: 'Admin account created. You can now register a passkey.' });
});

// A valid cost-12 bcrypt hash (of a random throwaway string) computed once at
// boot. Compared against in the user-not-found branch so that path does the same
// ~hundreds-of-ms of work as a real compare — otherwise the latency delta lets an
// unauthenticated caller enumerate valid usernames. Cost matches registration (12).
const DUMMY_LOGIN_HASH = bcrypt.hashSync(randomBytes(16).toString('hex'), 12);

// ── Password Login ──
router.post('/login/password', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    // Equalize timing with the found-user path before the identical 401.
    await bcrypt.compare(password, DUMMY_LOGIN_HASH);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  createSession(res, user);
  res.json({ success: true });
});

// ── Passkey Registration (start) ──
router.post('/passkey/register/start', async (req, res) => {
  const session = req.signedCookies?.session;
  if (!session) return res.status(401).json({ error: 'Must be logged in to register passkey' });

  let userData;
  try {
    userData = JSON.parse(Buffer.from(session, 'base64').toString());
  } catch {
    return res.status(401).json({ error: 'Invalid session' });
  }
  // A signed-but-expired session must not initiate registration — mirror
  // the expiry check the /api middleware enforces.
  if (!userData || typeof userData.expires !== 'number' || userData.expires < Date.now()) {
    return res.status(401).json({ error: 'Session expired' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userData.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  pruneChallenges();

  const existingKeys = db
    .prepare('SELECT credential_id FROM passkeys WHERE user_id = ?')
    .all(user.id);

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
      residentKey: 'preferred',
      userVerification: 'preferred',
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
  const { challengeId, credential } = req.body;

  const challengeRow = db
    .prepare(
      "SELECT * FROM challenges WHERE id = ? AND type = ? AND created_at > datetime('now', '-5 minutes')",
    )
    .get(challengeId, 'registration');
  if (!challengeRow) return res.status(400).json({ error: 'Invalid challenge' });

  db.prepare('DELETE FROM challenges WHERE id = ?').run(challengeId);

  try {
    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });

    if (verification.verified && verification.registrationInfo) {
      const { credential: cred } = verification.registrationInfo;
      const passkeyId = randomBytes(16).toString('hex');

      db.prepare(
        `INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports)
                VALUES (?, ?, ?, ?, ?, ?)`,
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
        JSON.stringify(credential.response?.transports || []),
      );

      res.json({ success: true, message: 'Passkey registered!' });
    } else {
      res.status(400).json({ error: 'Verification failed' });
    }
  } catch (err) {
    // Reachable pre-session — return a generic code, not library internals.
    console.error('Passkey registration error:', err);
    res.status(400).json({ error: 'verification_failed' });
  }
});

// ── Passkey Authentication (start) ──
router.post('/passkey/login/start', async (req, res) => {
  pruneChallenges();
  const allKeys = db.prepare('SELECT * FROM passkeys').all();

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: allKeys.map((k) => ({
      id: k.credential_id,
      type: 'public-key',
      transports: JSON.parse(k.transports || '[]'),
    })),
    userVerification: 'preferred',
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
  const { challengeId, credential } = req.body;

  const challengeRow = db
    .prepare(
      "SELECT * FROM challenges WHERE id = ? AND type = ? AND created_at > datetime('now', '-5 minutes')",
    )
    .get(challengeId, 'authentication');
  if (!challengeRow) return res.status(400).json({ error: 'Invalid challenge' });

  db.prepare('DELETE FROM challenges WHERE id = ?').run(challengeId);

  const credId = credential.id;
  const passkey = db.prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(credId);
  if (!passkey) return res.status(401).json({ error: 'Unknown passkey' });

  try {
    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: passkey.credential_id,
        publicKey: Buffer.from(passkey.public_key, 'base64'),
        counter: passkey.counter,
      },
    });

    if (verification.verified) {
      db.prepare('UPDATE passkeys SET counter = ? WHERE id = ?').run(
        verification.authenticationInfo.newCounter,
        passkey.id,
      );

      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(passkey.user_id);
      createSession(res, user);
      res.json({ success: true });
    } else {
      res.status(401).json({ error: 'Authentication failed' });
    }
  } catch (err) {
    console.error('Passkey auth error:', err);
    res.status(401).json({ error: 'verification_failed' });
  }
});

// ── Logout ──
router.post('/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ success: true });
});

export default router;
