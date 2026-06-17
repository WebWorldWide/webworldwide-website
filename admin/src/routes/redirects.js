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
import { nanoid } from 'nanoid';
import { logActivity } from '../services/activity.js';
import {
  readRedirects as read,
  writeRedirects as write,
  upsertRedirect,
  normPath,
} from '../services/redirects-store.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(read());
});

// Bulk import (CSV from the admin). Each row is upserted via the shared
// store so duplicates update in place and chains stay collapsed; an invalid
// row is skipped, not fatal. Returns a per-row tally.
router.post('/import', (req, res) => {
  const incoming = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!incoming) return res.status(400).json({ error: 'rows[] required' });
  if (incoming.length > 2000) {
    return res
      .status(400)
      .json({ error: 'batch_too_large', message: 'Maximum 2000 redirects per import.' });
  }
  const rows = read();
  let imported = 0;
  let skipped = 0;
  for (const r of incoming) {
    const code = Number(r?.code || 301);
    const safeCode = [301, 302, 307, 308].includes(code) ? code : 301;
    const result = upsertRedirect(rows, r?.from, r?.to, safeCode);
    if (result) imported += 1;
    else skipped += 1;
  }
  write(rows);
  logActivity({
    req,
    action: 'redirect.import',
    target: `${imported} imported`,
    meta: { skipped },
  });
  res.json({ imported, skipped, total: rows.length });
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
