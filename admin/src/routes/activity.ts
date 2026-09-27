// @ts-check
/**
 * activity.js — Phase 5e activity log API.
 *
 * GET /api/activity?limit=50&action=post.update&since=<epochMs>
 *   → { items: [...] }
 *
 * The writes happen elsewhere via `services/activity.js`. This route
 * is read-only — no delete, no edit. The dashboard widget and the
 * dedicated activity page both call this.
 */

import { Router } from 'express';
import { recentActivity } from '../services/activity.js';

const router = Router();

router.get('/', (req, res) => {
  try {
    const items = recentActivity({
      limit: Number(req.query.limit) || 50,
      action: req.query.action ? String(req.query.action) : undefined,
      since: req.query.since ? Number(req.query.since) : undefined,
    });
    res.json({ items });
  } catch (err) {
    console.error('[activity] list failed:', err);
    res.status(500).json({ error: 'Failed to read activity log' });
  }
});

export default router;
