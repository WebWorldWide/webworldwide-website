// @ts-check
/**
 * redirects.js — Phase 5e site-wide redirect manager.
 *
 * Backing store: `site/data/redirects.json`, a flat array of
 * `{ id, from, to, code }`. The Astro build reads this at build time:
 * site/scripts/prebuild.ts merges these entries into
 * legacy-redirects.json, which astro.config.ts turns into
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
  invalidFromReason,
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
    if (invalidFromReason(normPath(r?.from))) {
      skipped += 1;
      continue;
    }
    const result = upsertRedirect(rows, r?.from, r?.to, 301);
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
  // GitHub Pages serves static meta-refresh pages: every redirect is a
  // permanent one, whatever status a client asks for.
  const code = 301;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const bad = invalidFromReason(from);
  if (bad) return res.status(400).json({ error: 'invalid_from', message: bad });
  if (from === to) {
    return res.status(400).json({
      error: 'self_redirect',
      message: 'from and to must differ (this would loop forever)',
    });
  }
  const rows = read();
  if (rows.some((r) => r.from === from)) {
    return res
      .status(409)
      .json({ error: 'duplicate', message: `Redirect from ${from} already exists` });
  }
  // Reject reciprocal loops (A→B then B→A) and chains (a row whose target is
  // itself a source, or whose source is some row's target): the build emits
  // meta-refresh pages, so a loop bounces a visitor forever and a chain double-hops.
  if (rows.some((r) => r.from === to || r.to === from)) {
    return res.status(409).json({
      error: 'chain_or_loop',
      message: 'This redirect would create a chain or loop with an existing redirect.',
    });
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
  // eslint-disable-next-line security/detect-object-injection -- idx is a numeric index from findIndex
  const from = normPath(req.body?.from || rows[idx].from);
  // eslint-disable-next-line security/detect-object-injection -- idx is a numeric index from findIndex
  const to = normPath(req.body?.to || rows[idx].to);
  const code = 301;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const badFrom = invalidFromReason(from);
  if (badFrom) return res.status(400).json({ error: 'invalid_from', message: badFrom });
  if (from === to) {
    return res.status(400).json({
      error: 'self_redirect',
      message: 'from and to must differ (this would loop forever)',
    });
  }
  // Mirror POST's duplicate-`from` guard (PUT lacked it) and the chain/loop guard.
  if (rows.some((r) => r.id !== id && r.from === from)) {
    return res
      .status(409)
      .json({ error: 'duplicate', message: `Redirect from ${from} already exists` });
  }
  if (rows.some((r) => r.id !== id && (r.from === to || r.to === from))) {
    return res.status(409).json({
      error: 'chain_or_loop',
      message: 'This redirect would create a chain or loop with an existing redirect.',
    });
  }
  // eslint-disable-next-line security/detect-object-injection -- idx verified above
  rows[idx] = { id, from, to, code };
  write(rows);
  logActivity({ req, action: 'redirect.update', target: from, meta: { to, code } });
  // eslint-disable-next-line security/detect-object-injection -- idx is a numeric index from findIndex
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
