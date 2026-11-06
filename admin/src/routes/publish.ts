// @ts-check
/**
 * publish.js — Git publish trigger.
 *
 * Phase 9: after the git push succeeds, cross-post any
 * newly-published / -updated posts to Bluesky. The cross-post hook is
 * wrapped in a try/catch so a BSky outage NEVER fails the user's
 * publish. On success, the resulting `at://` URI is written back to
 * the post's front-matter and a follow-up commit pushes that change.
 */

import { getDeployStatus, waitForDeploy } from '../services/deploy-status.js';
import { Router } from 'express';
import {
  publishChanges,
  getGitStatus,
  commitAndPush,
  getPublishState,
  PublishError,
} from '../utils/git.js';
import { crossPostChangedPosts } from '../services/bluesky-crosspost.js';
import { crossPostChangedPosts as mastodonCrossPost } from '../services/mastodon-crosspost.js';
import * as bluesky from '../services/bluesky.js';
import * as mastodon from '../services/mastodon.js';
import { logActivity } from '../services/activity.js';

const router = Router();

/**
 * Map a raw git/publish error to a SAFE, actionable client code + message.
 * Never echoes the raw git output (it can carry absolute Pi paths / tokens);
 * the full detail is console.error'd by the caller. Each branch covers a
 * real failure mode we've actually hit on the Pi.
 *
 * @param {unknown} err
 * @returns {{ code: string, message: string }}
 */
const PUBLISH_ERROR_MESSAGES: Record<string, string> = {
  merge_conflict:
    'Your changes conflict with newer changes on GitHub. Reload the editor to see the latest version, then re-apply your edit.',
  non_site_changes:
    'The server checkout has code changes that are not on main, so publishing was stopped to avoid shipping them. The server needs to be realigned with main.',
  forbidden_paths:
    'Publishing was stopped because build or dependency files were about to be committed. This is a server setup issue (site/.gitignore).',
  checkout_diverged:
    "The server's copy of the site is on a different branch or has its own commits, so publishing was stopped to avoid losing edits. The server checkout needs to be realigned with main.",
  push_unverified:
    'GitHub did not confirm the update, so the site was NOT published. Try again; if it repeats, check the server logs.',
};

function classifyPublishError(err) {
  if (err instanceof PublishError) {
    return {
      code: err.code,
      message:
        PUBLISH_ERROR_MESSAGES[err.code] ||
        (err.code === 'network_error'
          ? "Couldn't reach GitHub — check the server's internet connection and try again."
          : err.code === 'push_rejected'
            ? 'GitHub kept changing while publishing. Try again in a moment.'
            : err.message),
    };
  }
  const e = /** @type {any} */ err;
  const raw = `${(e && e.message) || ''} ${(e && e.cause && e.cause.message) || ''}`;
  const m = raw.toLowerCase();
  if (m.includes('dubious ownership') || m.includes('safe.directory')) {
    return {
      code: 'git_ownership',
      message:
        'The server lost access to the repository. This is a server setup issue — try again in a moment or contact your hosting provider.',
    };
  }
  if (m.includes('insufficient permission') || m.includes('failed to insert into database')) {
    return {
      code: 'git_permission',
      message:
        "The server can't write to the repository. This is a server setup issue — contact your hosting provider.",
    };
  }
  if (m.includes('certificate') || m.includes('ssl') || m.includes('cafile')) {
    return {
      code: 'tls_error',
      message:
        "Couldn't establish a secure connection to GitHub. This is a server setup issue — contact your hosting provider.",
    };
  }
  if (
    m.includes('authentication failed') ||
    m.includes('could not read username') ||
    m.includes('invalid username or password') ||
    m.includes('403') ||
    m.includes('permission denied')
  ) {
    return {
      code: 'auth_failed',
      message:
        "GitHub rejected the publish. The server's credentials may have expired — contact your hosting provider.",
    };
  }
  if (m.includes('non-fast-forward') || m.includes('rejected') || m.includes('fetch first')) {
    return {
      code: 'push_rejected',
      message: 'Publish was blocked because the site was updated elsewhere. Try publishing again.',
    };
  }
  if (m.includes('another cms backup, deploy, or publish operation is active')) {
    return {
      code: 'operation_locked',
      message:
        'Another CMS operation (backup, deploy, or scheduled publish) was running. Try publishing again in a minute.',
    };
  }
  if (
    m.includes('timeout') ||
    m.includes('could not resolve host') ||
    m.includes('connection') ||
    m.includes('network')
  ) {
    return {
      code: 'network_error',
      message: "Couldn't reach GitHub — check your internet connection and try again.",
    };
  }
  return {
    code: 'internal_error',
    message:
      'Publish failed. Try again in a moment; if it keeps happening, contact your hosting provider.',
  };
}

// Trigger publish (commit + push)
router.post('/', async (req, res) => {
  try {
    const result = await publishChanges();
    logActivity({
      req,
      action: result.changed ? 'site.publish' : 'site.publish_noop',
      target: result.commitHash ? result.commitHash.slice(0, 12) : null,
      meta: result.changed
        ? { files: (result.files || []).slice(0, 50).map((f) => `${f.status} ${f.path}`) }
        : undefined,
    });

    // Cross-post only once GitHub Pages has the new page (and its cover
    // image) live — posting immediately produced cards with no image, or a
    // 404 for a brand-new post. Runs in the background; the editor already
    // shows deploy progress, and the activity log records the outcome.
    const syndicate =
      result.changed && Array.isArray(result.changedPosts) && result.changedPosts.length > 0;
    if (syndicate && (bluesky.isConfigured() || mastodon.isConfigured())) {
      void crossPostWhenLive(result);
    }
    res.json({ ...result, syndication: syndicate ? 'after_deploy' : null });
  } catch (err) {
    // Don't leak git/fs internals (absolute Pi paths, library detail) to
    // the client — log the detail, return a SAFE, actionable code + message
    // so the editor can tell the user what actually went wrong.
    console.error('[publish] publish failed:', err);
    const { code, message } = classifyPublishError(err);
    logActivity({ req, action: 'site.publish_failed', meta: { code } });
    res.status(code === 'merge_conflict' ? 409 : 500).json({ error: code, message });
  }
});

/**
 * Live deploy status for a pushed commit — lets the editor show "Building…
 * → Live ✓" after a publish so the user can see the GitHub Action actually
 * fire. Read-only proxy to the Actions API (behind the /api auth gate).
 * Node's fetch uses Node's own bundled CA, so this works even when the
 * system trust store is missing (unlike git over HTTPS).
 */
router.get('/deploy/:sha', async (req, res) => {
  const sha = String(req.params.sha || '');
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return res.status(400).json({ error: 'bad_sha' });
  res.json(await getDeployStatus(sha));
});

/**
 * What would be published right now + whether the server checkout is healthy
 * (on main). Drives the "unpublished changes" badge in every editor view.
 */
router.get('/state', async (_req, res) => {
  res.json(await getPublishState());
});

// Get publish status (uncommitted changes, etc.)
router.get('/status', async (req, res) => {
  try {
    const status = await getGitStatus();
    res.json(status);
  } catch (err) {
    console.error('[publish] status failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * Wait for the Pages deploy of `result.commitHash`, then cross-post the
 * changed posts to Bluesky / Mastodon (each best-effort, never throws).
 *
 * @param {{ commitHash?: string, changedPosts?: string[] }} result
 */
async function crossPostWhenLive(result) {
  const live = result.commitHash ? await waitForDeploy(result.commitHash) : false;
  if (!live) {
    console.warn('[publish] deploy not confirmed live — skipping cross-posts this time');
    logActivity({
      user: 'system',
      action: 'syndication.skipped',
      meta: { reason: 'deploy_not_live', commit: result.commitHash },
    });
    return;
  }
  let blueskyReport = null;
  let mastodonReport = null;
  // Phase 9: Bluesky cross-post hook. Best-effort; logs but never
  // throws. The publish response still reflects the git outcome —
  // the cross-post report is folded in as `bluesky` for clients that
  // care (the admin UI surfaces it in the activity log).
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
            result.changedPosts.map((f) => `site/content/posts/${f}`),
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

  // Mastodon cross-post hook — same best-effort contract as Bluesky above,
  // posting directly to the configured account. Independent of Bridgy Fed.
  if (result.changed && Array.isArray(result.changedPosts) && result.changedPosts.length > 0) {
    if (!mastodon.isConfigured()) {
      console.log('[publish] Mastodon cross-post skipped — MASTODON_* not set');
    } else {
      try {
        mastodonReport = await mastodonCrossPost(result.changedPosts);
        console.log(
          `[publish] Mastodon: posted=${mastodonReport.posted.length}` +
            ` skipped=${mastodonReport.skipped.length}` +
            ` errors=${mastodonReport.errors.length}`,
        );
        if (mastodonReport.posted.length > 0) {
          const followup = await commitAndPush(
            `Update Mastodon URIs (${mastodonReport.posted.length} post${mastodonReport.posted.length === 1 ? '' : 's'})`,
            result.changedPosts.map((f) => `site/content/posts/${f}`),
          );
          if (!followup.success) {
            console.warn('[publish] Mastodon followup commit failed:', followup.message);
          }
        }
      } catch (err) {
        console.warn('[publish] Mastodon cross-post crashed (continuing):', err.message);
        logActivity({
          user: 'system',
          action: 'mastodon.crosspost_crashed',
          meta: { error: err.message },
        });
      }
    }
  }

  logActivity({
    user: 'system',
    action: 'syndication.done',
    meta: {
      bluesky: blueskyReport && blueskyReport.posted.length,
      mastodon: mastodonReport && mastodonReport.posted.length,
    },
  });
}

export default router;
