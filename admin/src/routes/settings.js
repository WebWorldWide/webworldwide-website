// @ts-check
/**
 * settings.js — site-settings + author-profile editor.
 *
 * GET  /api/settings                  → { hugo, author }
 * PATCH /api/settings/hugo            → { changes: { 'params.umamiSiteID': 'abc', … } }
 * PATCH /api/settings/author          → { name, bio, avatar, social: {...}, url }
 *
 * Migration note: the file we edit is now `site/site.toml` (user-editable
 * params for the Astro site), not the old `site/hugo.toml`. We keep the
 * API field name `hugo` and the activity-log action `settings.hugo` to
 * avoid a breaking change for the admin frontend / database constraint.
 * Writes go through `toml-roundtrip.apply` so comments + ordering survive.
 * `author` lives in `site/data/author.json`. That file is created on
 * first PATCH if missing.
 */

import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { parse as parseToml, apply as applyToml, flatToChanges } from '../utils/toml-roundtrip.js';
import { logActivity } from '../services/activity.js';

const SITE_DIR = process.env.SITE_DIR || join(process.cwd(), '..', 'site');
// Astro replaced Hugo in Phase 3: user-editable params live in site.toml.
// `site/hugo.toml` no longer exists. The env-var fallback exists so a
// staging deployment can still point at a different file if needed.
const SETTINGS_TOML = process.env.SETTINGS_TOML || join(SITE_DIR, 'site.toml');
const AUTHOR_JSON = join(SITE_DIR, 'data', 'author.json');

const router = Router();

/**
 * Read `site/data/author.json`, or return a sensible default if absent.
 * Always returns the same shape so the form UI doesn't have to feature-detect.
 */
function readAuthor() {
  if (!existsSync(AUTHOR_JSON)) {
    return {
      name: '',
      bio: '',
      avatar: '',
      url: '',
      social: { bluesky: '', mastodon: '', github: '', youtube: '', email: '' },
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(AUTHOR_JSON, 'utf-8'));
    return {
      name: parsed.name || '',
      bio: parsed.bio || '',
      avatar: parsed.avatar || '',
      url: parsed.url || '',
      social: {
        bluesky: parsed?.social?.bluesky || '',
        mastodon: parsed?.social?.mastodon || '',
        github: parsed?.social?.github || '',
        youtube: parsed?.social?.youtube || '',
        email: parsed?.social?.email || '',
        ...parsed.social,
      },
    };
  } catch (err) {
    console.warn('[settings] author.json parse failed; returning empty shape:', err.message);
    return { name: '', bio: '', avatar: '', url: '', social: {} };
  }
}

/**
 * Read + parse site.toml. Surface a 500 when the file is broken — the
 * settings UI is read-only until the user fixes it by hand.
 */
function readSettings() {
  const src = readFileSync(SETTINGS_TOML, 'utf-8');
  return { src, parsed: parseToml(src) };
}

router.get('/', (req, res) => {
  try {
    const { parsed } = readSettings();
    // Field name stays `hugo` for API compatibility — the admin frontend
    // still references res.json.hugo.* paths everywhere.
    res.json({ hugo: parsed, author: readAuthor() });
  } catch (err) {
    console.error('[settings] read failed:', err);
    res.status(500).json({ error: 'read_failed', message: err.message });
  }
});

router.patch('/hugo', (req, res) => {
  try {
    const changes = req.body && req.body.changes;
    if (!changes || typeof changes !== 'object') {
      return res.status(400).json({ error: 'changes object required' });
    }
    const src = readFileSync(SETTINGS_TOML, 'utf-8');
    const flat = flatToChanges(changes);
    if (!flat.length) {
      return res.json({ ok: true, changed: 0 });
    }
    const next = applyToml(src, flat);
    // Validate the result still parses before persisting — catches bad
    // values like unbalanced quotes early.
    try {
      parseToml(next);
    } catch (parseErr) {
      return res.status(400).json({ error: 'invalid_toml_after_edit', message: parseErr.message });
    }
    writeFileSync(SETTINGS_TOML, next);
    logActivity({
      req,
      action: 'settings.hugo',
      target: 'site.toml',
      meta: { keys: flat.map((c) => `${c.section ? c.section + '.' : ''}${c.key}`) },
    });
    res.json({ ok: true, changed: flat.length });
  } catch (err) {
    console.error('[settings] site.toml patch failed:', err);
    res.status(500).json({ error: 'write_failed', message: err.message });
  }
});

router.patch('/author', (req, res) => {
  try {
    const body = req.body || {};
    const current = readAuthor();
    const next = {
      name: typeof body.name === 'string' ? body.name : current.name,
      bio: typeof body.bio === 'string' ? body.bio : current.bio,
      avatar: typeof body.avatar === 'string' ? body.avatar : current.avatar,
      url: typeof body.url === 'string' ? body.url : current.url,
      social: { ...current.social, ...(body.social || {}) },
    };
    mkdirSync(dirname(AUTHOR_JSON), { recursive: true });
    writeFileSync(AUTHOR_JSON, JSON.stringify(next, null, 2) + '\n');
    logActivity({ req, action: 'settings.author', target: 'author.json' });
    res.json({ ok: true, author: next });
  } catch (err) {
    console.error('[settings] author patch failed:', err);
    res.status(500).json({ error: 'write_failed', message: err.message });
  }
});

export default router;
