// @ts-check
/**
 * publish.js — Git publish trigger.
 *
 * Phase 6: before committing, refreshes `site/data/media.json` so the
 * Hugo `attachment` shortcode can resolve media ids from the data tree.
 * The write is best-effort — a serialisation failure logs a warning but
 * doesn't block the publish (a stale `media.json` is still a valid
 * state, attachments just won't pick up the latest uploads).
 *
 * Phase 9: after the git push succeeds, cross-post any
 * newly-published / -updated posts to Bluesky. The cross-post hook is
 * wrapped in a try/catch so a BSky outage NEVER fails the user's
 * publish. On success, the resulting `at://` URI is written back to
 * the post's front-matter and a follow-up commit pushes that change.
 */

import { Router } from 'express';
import { publishChanges, getGitStatus, commitAndPush } from '../utils/git.js';
import { writeMediaData } from '../services/publish-media-data.js';
import { crossPostChangedPosts } from '../services/bluesky-crosspost.js';
import * as bluesky from '../services/bluesky.js';
import { logActivity } from '../services/activity.js';

const router = Router();

// Trigger publish (commit + push)
router.post('/', async (req, res) => {
  try {
    // Phase 6: refresh the media data file before staging. Failures are
    // logged but never block the publish — the data file is a cache
    // layer over the DB, and a stale write is preferable to a missed
    // commit of the user's actual content.
    try {
      const stats = writeMediaData();
      console.log(
        `[publish] media.json: ${stats.count} entries (${stats.skipped} skipped, ${stats.total} total)`,
      );
    } catch (err) {
      console.warn('[publish] media.json refresh failed (continuing):', err.message);
    }
    const result = await publishChanges();

    // Phase 9: Bluesky cross-post hook. Best-effort; logs but never
    // throws. The publish response still reflects the git outcome —
    // the cross-post report is folded in as `bluesky` for clients that
    // care (the admin UI surfaces it in the activity log).
    let blueskyReport = null;
    if (result.changed && Array.isArray(result.changedPosts) && result.changedPosts.length > 0) {
      if (!bluesky.isConfigured()) {
        console.log('[publish] Bluesky cross-post skipped — BLUESKY_* env not set');
      } else {
        try {
          blueskyReport = await crossPostChangedPosts(result.changedPosts);
          console.log(
            `[publish] Bluesky: posted=${blueskyReport.posted.length}` +
              ` skipped=${blueskyReport.skipped.length}` +
              ` errors=${blueskyReport.errors.length}`,
          );
          // If we wrote any bluesky_uri back into front-matter, push a
          // follow-up commit so the on-disk content stays the source
          // of truth.
          if (blueskyReport.posted.length > 0) {
            const followup = await commitAndPush(
              `Update Bluesky URIs (${blueskyReport.posted.length} post${blueskyReport.posted.length === 1 ? '' : 's'})`,
            );
            if (!followup.success) {
              console.warn('[publish] Bluesky followup commit failed:', followup.message);
            }
          }
        } catch (err) {
          // Safety net — `crossPostChangedPosts` itself never throws,
          // but the followup commit / sign-in path could.
          console.warn('[publish] Bluesky cross-post crashed (continuing):', err.message);
          logActivity({
            user: 'system',
            action: 'bluesky.crosspost_crashed',
            meta: { error: err.message },
          });
        }
      }
    }

    res.json({ ...result, bluesky: blueskyReport });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get publish status (uncommitted changes, etc.)
router.get('/status', async (req, res) => {
  try {
    const status = await getGitStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
