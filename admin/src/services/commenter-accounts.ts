/**
 * Commenter accounts — username + password sign-in for blog comments.
 *
 * Remark42 (the comments server) has no password login of its own, so this
 * service holds the accounts and, on sign-in, issues the same signed session
 * token Remark42 issues for its own logins (HS256 JWT with the shared
 * REMARK42_SECRET). Remark42 then treats the commenter as signed in; a
 * registered name is theirs alone and carries Remark42's "verified" badge,
 * so an anonymous visitor typing the same name is visibly not them.
 *
 * Security
 * - Passwords: Argon2id (Node's built-in crypto.argon2), OWASP parameters
 *   (m = 19 MiB, t = 2, p = 1), 16-byte random salt per password, stored as
 *   a PHC string. The password itself is never stored or logged.
 * - Verification recomputes the hash and compares in constant time; unknown
 *   usernames are checked against a dummy hash so timing never reveals which
 *   usernames exist.
 * - Brute force: per-account lockout (5 failures → 15 min, doubling up to
 *   24 h), on top of per-IP rate limits in the route.
 * - Sessions: 30-day JWT in an HttpOnly + Secure cookie on the comments
 *   domain. A password change bumps token_version, which
 *   locks older sessions out of the account page at once; Remark42 itself
 *   only checks the signature, so an older session can still comment until
 *   it expires (deleting an account also blocks it in Remark42 at once).
 * - The database (and so the hashes) is backed up nightly, age-encrypted,
 *   to a private GitHub repo (scripts/backup.sh).
 */
import Database from 'better-sqlite3';
import { argon2, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Storage ─────────────────────────────────────────────────────────────

let handle: Database.Database | null = null;
function db(): Database.Database {
  if (handle) return handle;
  const dbPath = process.env.AUTH_DB_PATH || join(__dirname, '..', '..', 'data', 'auth.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  handle = new Database(dbPath);
  handle.pragma('journal_mode = WAL');
  return handle;
}

export type Account = {
  id: string;
  username: string;
  username_key: string;
  password_hash: string;
  created_at: number;
  last_login_at: number | null;
  failed_attempts: number;
  locked_until: number | null;
  token_version: number;
};

// ── Password hashing (Argon2id) ─────────────────────────────────────────

type ArgonParams = { memory: number; passes: number; parallelism: number; tagLength: number };
const ARGON: ArgonParams = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };

function argon(password: string, salt: Buffer, p: ArgonParams = ARGON): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        parallelism: p.parallelism,
        tagLength: p.tagLength,
        memory: p.memory,
        passes: p.passes,
      },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

const b64 = (b: Buffer): string => b.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await argon(password, salt);
  return `$argon2id$v=19$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(
    phc,
  );
  if (!m) return false;
  const expected = Buffer.from(m[5], 'base64');
  const actual = await argon(password, Buffer.from(m[4], 'base64'), {
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Verified against when the username doesn't exist, so "no such user" and
// "wrong password" take the same time.
let dummyHash: Promise<string> | null = null;
const dummy = (): Promise<string> => (dummyHash ||= hashPassword(randomBytes(24).toString('hex')));

// ── Validation ──────────────────────────────────────────────────────────

const RESERVED = new Set([
  'admin',
  'administrator',
  'anonymous',
  'moderator',
  'mod',
  'root',
  'system',
  'webworldwide',
  'web world wide',
  'www',
  'support',
  'staff',
]);

/** Letters, numbers, space, _ . - ; 3–24 chars; no leading/trailing space. */
export function checkUsername(
  raw: unknown,
): { ok: true; name: string; key: string } | { ok: false; error: string } {
  const name = String(raw ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length < 3 || name.length > 24)
    return { ok: false, error: 'Usernames are 3 to 24 characters.' };
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(name))
    return { ok: false, error: 'Use letters, numbers, spaces, dots, dashes or underscores.' };
  const key = name.toLowerCase();
  if (RESERVED.has(key)) return { ok: false, error: 'That username is reserved.' };
  return { ok: true, name, key };
}

/** NIST 800-63B style: long enough, not obviously guessable; no composition rules. */
export function checkPassword(
  raw: unknown,
  username = '',
): { ok: true } | { ok: false; error: string } {
  const pw = String(raw ?? '');
  if (pw.length < 10) return { ok: false, error: 'Passwords need at least 10 characters.' };
  if (pw.length > 200) return { ok: false, error: 'Passwords can be at most 200 characters.' };
  const low = pw.toLowerCase();
  if (username && low.includes(username.toLowerCase()))
    return { ok: false, error: 'Your password can’t contain your username.' };
  if (/^(.)\1+$/.test(pw) || COMMON.has(low))
    return { ok: false, error: 'That password is too common. Try a short phrase instead.' };
  return { ok: true };
}

const COMMON = new Set([
  'password12',
  'password123',
  'password1234',
  '1234567890',
  '12345678910',
  'qwertyuiop',
  'iloveyou123',
  'letmein123',
  'welcome123',
  'admin12345',
  'abcdefghij',
  'qwerty1234',
  '0123456789',
  'passw0rd123',
  'football123',
  'baseball123',
]);

// ── Accounts ────────────────────────────────────────────────────────────

const LOCK_AFTER = 5;
const LOCK_BASE_MS = 15 * 60 * 1000;
const LOCK_MAX_MS = 24 * 60 * 60 * 1000;

export class AccountError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function findByKey(key: string): Account | undefined {
  return db().prepare('SELECT * FROM commenter_accounts WHERE username_key = ?').get(key) as
    Account | undefined;
}

export function findById(id: string): Account | undefined {
  return db().prepare('SELECT * FROM commenter_accounts WHERE id = ?').get(id) as
    Account | undefined;
}

export async function register(username: unknown, password: unknown): Promise<Account> {
  const u = checkUsername(username);
  if (u.ok === false) throw new AccountError('bad_username', u.error);
  const p = checkPassword(password, u.name);
  if (p.ok === false) throw new AccountError('bad_password', p.error);
  if (findByKey(u.key)) throw new AccountError('taken', 'That username is taken.', 409);
  const hash = await hashPassword(String(password));
  const id = nanoid();
  try {
    db()
      .prepare(
        'INSERT INTO commenter_accounts (id, username, username_key, password_hash, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, u.name, u.key, hash, Date.now(), Date.now());
  } catch {
    // Lost a race for the same name.
    throw new AccountError('taken', 'That username is taken.', 409);
  }
  return findById(id) as Account;
}

/** Check credentials; applies lockout. Returns the account or throws. */
export async function login(username: unknown, password: unknown): Promise<Account> {
  const u = checkUsername(username);
  const acct = u.ok ? findByKey(u.key) : undefined;
  const pw = String(password ?? '').slice(0, 200);
  const now = Date.now();
  if (acct?.locked_until && acct.locked_until > now) {
    throw new AccountError(
      'locked',
      'Too many wrong passwords. This account is locked for a while; try again later.',
      429,
    );
  }
  const ok = await verifyPassword(pw, acct ? acct.password_hash : await dummy());
  if (!acct || !ok) {
    if (acct) {
      const failures = acct.failed_attempts + 1;
      const over = failures - LOCK_AFTER;
      const lockMs = over >= 0 ? Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** over) : 0;
      db()
        .prepare('UPDATE commenter_accounts SET failed_attempts = ?, locked_until = ? WHERE id = ?')
        .run(failures, lockMs ? now + lockMs : null, acct.id);
    }
    throw new AccountError('bad_credentials', 'Wrong username or password.', 401);
  }
  db()
    .prepare(
      'UPDATE commenter_accounts SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?',
    )
    .run(now, acct.id);
  return acct;
}

export async function changePassword(
  id: string,
  current: unknown,
  next: unknown,
): Promise<Account> {
  const acct = findById(id);
  if (!acct) throw new AccountError('not_found', 'Account not found.', 404);
  if (!(await verifyPassword(String(current ?? '').slice(0, 200), acct.password_hash)))
    throw new AccountError('bad_credentials', 'Your current password is wrong.', 401);
  const p = checkPassword(next, acct.username);
  if (p.ok === false) throw new AccountError('bad_password', p.error);
  db()
    .prepare(
      'UPDATE commenter_accounts SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
    )
    .run(await hashPassword(String(next)), id);
  return findById(id) as Account;
}

export function adminDelete(id: string): boolean {
  return db().prepare('DELETE FROM commenter_accounts WHERE id = ?').run(id).changes > 0;
}

export function list(): Array<Omit<Account, 'password_hash' | 'username_key'>> {
  return db()
    .prepare(
      'SELECT id, username, created_at, last_login_at, failed_attempts, locked_until, token_version FROM commenter_accounts ORDER BY created_at DESC',
    )
    .all() as Array<Omit<Account, 'password_hash' | 'username_key'>>;
}

// ── Remark42 session token ──────────────────────────────────────────────

export const SESSION_DAYS = 30;

/**
 * Remark42 user id for an account. Remark42 only accepts sessions whose id
 * starts with an enabled login provider, and the anonymous provider is the
 * one that is always on, so accounts use its `anonymous_<sha1>` shape. The
 * hash is of the account's private random id, not the name: a guest typing
 * the same name gets `anonymous_<sha1(name)>`, a different identity without
 * the verified badge.
 */
export const remarkUserId = (a: Account): string =>
  'anonymous_' + createHash('sha1').update(`www-commenter:${a.id}`).digest('hex');

const b64url = (b: Buffer | string): string =>
  Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/**
 * A Remark42 session token for `a`, in go-pkgz/auth's claim format. `jti`
 * doubles as the XSRF token Remark42 checks against the XSRF-TOKEN cookie.
 * `attrs.www` carries the account id + token_version for revocation.
 */
export function sessionToken(a: Account): { jwt: string; xsrf: string; maxAgeMs: number } {
  const secret = process.env.REMARK42_SECRET || '';
  if (!secret) throw new AccountError('not_configured', 'Comments sign-in is not configured.', 503);
  const site = process.env.REMARK42_SITE_ID || 'webworldwide';
  const now = Math.floor(Date.now() / 1000);
  const ttl = SESSION_DAYS * 24 * 60 * 60;
  const xsrf = randomBytes(20).toString('hex');
  const payload = {
    aud: site,
    exp: now + ttl,
    jti: xsrf,
    iat: now,
    nbf: now - 10,
    iss: 'remark42',
    user: {
      name: a.username,
      id: remarkUserId(a),
      picture: '',
      attrs: { www: `${a.id}:${a.token_version}` },
    },
  };
  const data = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`;
  const sig = createHmac('sha256', secret).update(data).digest();
  return { jwt: `${data}.${b64url(sig)}`, xsrf, maxAgeMs: ttl * 1000 };
}

/** Decode + verify one of our tokens; null if invalid, expired, or revoked. */
export function sessionAccount(jwt: string | undefined): Account | null {
  try {
    const secret = process.env.REMARK42_SECRET || '';
    const [h, p, s] = String(jwt || '').split('.');
    if (!h || !p || !s || !secret) return null;
    const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
    const actual = Buffer.from(s, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
    const [id, version] = String(claims.user?.attrs?.www || '').split(':');
    const acct = id ? findById(id) : undefined;
    if (!acct || String(acct.token_version) !== version) return null;
    return acct;
  } catch {
    return null;
  }
}
