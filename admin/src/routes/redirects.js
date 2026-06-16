// @ts-check
/**
 * redirects.js — Phase 5e site-wide redirect manager.
 *
 * Backing store: `site/data/redirects.json`, a flat array of
 * `{ id, from, to, code }`. The Astro build reads this at build time:
 * site/scripts/prebuild.mjs merges these entries into
 * legacy-redirects.json, which astro.config.mjs turns into
 * meta-refresh redirect pages.
 *
 * This manager is for site-wide / one-off redirects (typos, deleted
 * posts, vanity URLs).
 *
 * Endpoints:
 *   GET    /api/redirects
 *   POST   /api/redirects        { from, to, code? }
 *   PUT    /api/redirects/:id    { from, to, code? }
 *   DELETE /api/redirects/:id
 */

import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { nanoid } from 'nanoid';
import { logActivity } from '../services/activity.js';

const SITE_DIR = process.env.SITE_DIR || join(process.cwd(), '..', 'site');
const REDIRECTS_JSON = join(SITE_DIR, 'data', 'redirects.json');

const router = Router();

function read() {
  if (!existsSync(REDIRECTS_JSON)) return [];
  try {
    const parsed = JSON.parse(readFileSync(REDIRECTS_JSON, 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((r) => ({
      id: String(r.id || ''),
      from: String(r.from || ''),
      to: String(r.to || ''),
      code: Number(r.code || 301),
    }));
  } catch (err) {
    console.warn('[redirects] parse failed; treating as empty:', err.message);
    return [];
  }
}

function write(rows) {
  mkdirSync(dirname(REDIRECTS_JSON), { recursive: true });
  writeFileSync(REDIRECTS_JSON, JSON.stringify(rows, null, 2) + '\n');
}

/**
 * Normalize a path: ensure it starts with `/`, drop trailing slashes
 * (except for the root). `from` lives on our own domain; `to` may be
 * an absolute URL.
 *
 * @param {string} p
 * @returns {string}
 */
function normPath(p) {
  let s = String(p || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, '');
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

router.get('/', (_req, res) => {
  res.json(read());
});

router.post('/', (req, res) => {
  const from = normPath(req.body?.from);
  const to = normPath(req.body?.to);
  const code = Number(req.body?.code || 301);
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  if (from === to) {
    return res.status(400).json({
      error: 'self_redirect',
      message: 'from and to must differ (this would loop forever)',
    });
  }
  if (![301, 302, 307, 308].includes(code)) {
    return res.status(400).json({ error: 'code must be 301/302/307/308' });
  }
  const rows = read();
  if (rows.some((r) => r.from === from)) {
    return res
      .status(409)
      .json({ error: 'duplicate', message: `Redirect from ${from} already exists` });
  }
  const id = nanoid();
  rows.push({ id, from, to, code });
  write(rows);
  logActivity({ req, action: 'redirect.create', target: from, meta: { to, code } });
  res.json({ id, from, to, code });
});

router.put('/:id', (req, res) => {
  const id = String(req.params.id);
  const rows = read();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'not_found' });
  const from = normPath(req.body?.from || rows[idx].from);
  const to = normPath(req.body?.to || rows[idx].to);
  const code = Number(req.body?.code || rows[idx].code || 301);
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  if (from === to) {
    return res.status(400).json({
      error: 'self_redirect',
      message: 'from and to must differ (this would loop forever)',
    });
  }
  // eslint-disable-next-line security/detect-object-injection -- idx verified above
  rows[idx] = { id, from, to, code };
  write(rows);
  logActivity({ req, action: 'redirect.update', target: from, meta: { to, code } });
  res.json(rows[idx]);
});

router.delete('/:id', (req, res) => {
  const id = String(req.params.id);
  const rows = read();
  const before = rows.length;
  const after = rows.filter((r) => r.id !== id);
  if (after.length === before) return res.status(404).json({ error: 'not_found' });
  write(after);
  logActivity({ req, action: 'redirect.delete', target: id });
  res.status(204).end();
});

export default router;
