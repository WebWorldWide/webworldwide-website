/**
 * Account security — mounted at /api/account (behind the session gate).
 *
 *   GET    /                     → username, passkeys, sessions, login policy
 *   PATCH  /passkeys/:id         → { name } rename
 *   DELETE /passkeys/:id         → remove (needs a recent sign-in)
 *   POST   /password             → { current, next } change password
 *   DELETE /sessions/:id         → revoke one session
 *   POST   /sessions/revoke-others → sign out every other session
 */
import { Router } from 'express';
import bcrypt from 'bcrypt';
import {
  db,
  isRecentAuth,
  listSessions,
  passkeyCount,
  passwordLoginAllowed,
  revokeOtherSessions,
  revokeSession,
} from './auth.js';
import { logActivity } from '../services/activity.js';
import { getClientIp } from '../utils/clientIp.js';

const router = Router();
const MIN_PASSWORD_LENGTH = 12;

router.get('/', (req, res) => {
  const u = req.user;
  const passkeys = db
    .prepare(
      'SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at',
    )
    .all(u.userId);
  const sessions = listSessions(u.userId).map((s: any) => ({
    ...s,
    current: s.id === u.sessionId,
  }));
  res.json({
    username: u.username,
    passkeys,
    sessions,
    passwordLogin: passwordLoginAllowed(u.userId),
    breakGlass: process.env.ALLOW_PASSWORD_LOGIN === '1',
    recentAuth: isRecentAuth(u),
  });
});

router.patch('/passkeys/:id', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 60) : '';
  if (!name) return res.status(400).json({ error: 'name_required' });
  const r = db
    .prepare('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?')
    .run(name, String(req.params.id), req.user.userId);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ success: true });
});

router.delete('/passkeys/:id', (req, res) => {
  if (!isRecentAuth(req.user)) {
    return res.status(403).json({
      error: 'reauth_required',
      message: 'Sign out and sign in again (within 15 minutes) before removing a passkey.',
    });
  }
  const id = String(req.params.id);
  const row = db
    .prepare('SELECT name FROM passkeys WHERE id = ? AND user_id = ?')
    .get(id, req.user.userId) as any;
  if (!row) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(id, req.user.userId);
  logActivity({
    req,
    action: 'auth.passkey_removed',
    target: row.name || id,
    meta: { remaining: passkeyCount(req.user.userId), ip: getClientIp(req) },
  });
  res.json({ success: true, remaining: passkeyCount(req.user.userId) });
});

router.post('/password', async (req, res) => {
  const { current, next } = req.body || {};
  if (typeof current !== 'string' || typeof next !== 'string') {
    return res.status(400).json({ error: 'current_and_next_required' });
  }
  if (next.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      error: 'password_too_short',
      message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
    });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId) as any;
  if (!user || !(await bcrypt.compare(current, user.password_hash || ''))) {
    logActivity({ req, action: 'auth.password_change_failed', meta: { ip: getClientIp(req) } });
    return res.status(403).json({ error: 'wrong_password', message: 'Current password is wrong.' });
  }
  const hash = await bcrypt.hash(next, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  // A password change ends every other session.
  const revoked = revokeOtherSessions(user.id, req.user.sessionId);
  logActivity({ req, action: 'auth.password_changed', meta: { revoked, ip: getClientIp(req) } });
  res.json({ success: true, revokedSessions: revoked });
});

router.delete('/sessions/:id', (req, res) => {
  const ok = revokeSession(req.user.userId, String(req.params.id));
  if (!ok) return res.status(404).json({ error: 'not_found' });
  logActivity({ req, action: 'auth.session_revoked', meta: { ip: getClientIp(req) } });
  res.json({ success: true, current: req.params.id === req.user.sessionId });
});

router.post('/sessions/revoke-others', (req, res) => {
  const revoked = revokeOtherSessions(req.user.userId, req.user.sessionId);
  logActivity({ req, action: 'auth.sessions_revoked', meta: { revoked, ip: getClientIp(req) } });
  res.json({ success: true, revoked });
});

export default router;
