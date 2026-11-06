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
    let mastodonReport = null;
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

    res.json({ ...result, bluesky: blueskyReport, mastodon: mastodonReport });
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
  const repo = process.env.GITHUB_REPO || 'WebWorldWide/webworldwide-website';
  const url = `https://api.github.com/repos/${repo}/actions/runs?head_sha=${sha}&per_page=20`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'wwwide-cms',
  };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  try {
    // 1. Is the commit actually ON main? `/commits/:sha` alone returns 200 for
    //    a commit on any pushed branch, which made a stranded feature-branch
    //    commit look "pending" forever.
    const cmp = await fetch(`https://api.github.com/repos/${repo}/compare/main...${sha}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (cmp.status === 404) return res.json({ status: 'not_pushed' });
    if (!cmp.ok) return res.json({ status: 'error', reason: `github_${cmp.status}` });
    const cmpData = await cmp.json();
    if (cmpData.status !== 'identical' && cmpData.status !== 'behind') {
      return res.json({ status: 'not_on_main' });
    }

    // 2. Find the Pages deploy run for this exact commit — matched by workflow
    //    FILE, never by falling back to whatever ran first (a green Quality run
    //    used to show up as "Live").
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.json({ status: 'error', reason: `github_${r.status}` });
    const data = await r.json();
    const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
    const deploy = runs.find((x) => String(x.path || '').endsWith('.github/workflows/deploy.yml'));
    if (!deploy) {
      // On main, but newer pushes can supersede (cancel-in-progress: false
      // still means a later run covers this content).
      return res.json({ status: cmpData.status === 'behind' ? 'superseded' : 'pending' });
    }
    res.json({
      status: deploy.status, // queued | in_progress | completed
      conclusion: deploy.conclusion, // success | failure | cancelled | null
      url: deploy.html_url,
      name: deploy.name,
    });
  } catch (err) {
    console.warn('[publish] deploy-status failed:', err.message);
    res.json({ status: 'error', reason: 'network' });
  }
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

export default router;
