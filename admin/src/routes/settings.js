// @ts-check
/**
 * settings.js — site-settings + author-profile editor.
 *
 * GET  /api/settings                  → { hugo, author }
 * PATCH /api/settings/hugo            → { changes: { 'params.umamiSiteID': 'abc', … } }
 * PATCH /api/settings/author          → { name, bio, avatar, social: {...}, url }
 * GET  /api/settings/homepage         → normalized homepage model (see below)
 * PATCH /api/settings/homepage        → partial/full homepage model → updated model
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
import { getFileHistory, getFileAtCommit } from '../utils/git.js';
import { recordSnapshot, listSnapshots, getSnapshot } from '../services/snapshots.js';

const SITE_DIR = process.env.SITE_DIR || join(process.cwd(), '..', 'site');
// Astro replaced Hugo in Phase 3: user-editable params live in site.toml.
// `site/hugo.toml` no longer exists. The env-var fallback exists so a
// staging deployment can still point at a different file if needed.
const SETTINGS_TOML = process.env.SETTINGS_TOML || join(SITE_DIR, 'site.toml');
const AUTHOR_JSON = join(SITE_DIR, 'data', 'author.json');

// Revision-history keys for the homepage editor (mirrors the posts pattern).
// `SITE_TOML_RELPATH` is the repo-relative path git logs/shows; the snapshot
// key namespaces the homepage's local pre-save snapshots within site.toml.
const HOMEPAGE_SNAPSHOT_KEY = 'site.toml#homepage';
const SITE_TOML_RELPATH = 'site/site.toml';

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

/* ------------------------------------------------------------------ *
 * Homepage editor — normalized model over the [homepage.*] sections   *
 * of site.toml.                                                       *
 *                                                                     *
 * Model shape (the admin frontend is coded against exactly this):     *
 *   {                                                                 *
 *     hero: { words: string[], tagline: string },                     *
 *     apps: { items: [{ name, status, link, icon }, …] },             *
 *     videos: { episode: string, film_title: string },                *
 *     socials: { order: string[], hidden: string[] },                 *
 *     blog_cta: { kicker, title, title_accent, url },                 *
 *     sections: { hero, apps, videos, socials, blog_cta: boolean },   *
 *     section_order: string[]  // permutation of the 5 section ids    *
 *   }                                                                 *
 * ------------------------------------------------------------------ */

/** The five home-page sections, in default display order. */
const SECTION_IDS = ['hero', 'apps', 'videos', 'socials', 'blog_cta'];

/** The nine known social keys (matches site-config.ts `social`). */
const SOCIAL_KEYS = [
  'youtube',
  'github',
  'twitter',
  'bluesky',
  'mastodon',
  'reddit',
  'instagram',
  'threads',
  'email',
];

/** Default socials display order — the 8 tiles rendered today. */
const DEFAULT_SOCIAL_ORDER = SOCIAL_KEYS.filter((k) => k !== 'email');

/** Allowed app tile statuses. */
const APP_STATUSES = ['live', 'soon', 'lab'];

/** Top-level keys a PATCH /homepage body may carry. */
const HOMEPAGE_KEYS = [...SECTION_IDS, 'sections', 'section_order'];

/**
 * Coerce to string, falling back when `v` isn't one.
 *
 * @param {unknown} v
 * @param {string} [fallback]
 * @returns {string}
 */
const asString = (v, fallback = '') => (typeof v === 'string' ? v : fallback);

/**
 * Return `v` when it's an array of strings, else null.
 *
 * @param {unknown} v
 * @returns {string[] | null}
 */
const asStringArray = (v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null);

/**
 * Normalize the parsed site.toml into the complete homepage model,
 * filling defaults so an OLD site.toml (without any [homepage.*]
 * sections) still yields a full model. Legacy `[apps] fileid/doc_finder`
 * keys seed the default app tiles. Exported for tests.
 *
 * @param {Record<string, unknown> & { homepage?: any, site?: any, apps?: any }} parsed  output of toml-roundtrip parse()
 * @returns {{ hero: { words: string[], tagline: string, subtitle: string }, apps: { items: { name: string, status: string, link: string, icon: string }[] }, videos: { episode: string, film_title: string }, socials: { order: string[], hidden: string[] }, blog_cta: { kicker: string, title: string, title_accent: string, url: string, description: string }, sections: Record<string, boolean>, section_order: string[] }}
 */
export function normalizeHomepage(parsed) {
  const p = parsed || {};
  const hp = p.homepage || {};

  const words = asStringArray(hp.hero?.words);
  const hero = {
    words: words && words.length ? words : ['Web', 'World', 'Wide'],
    tagline: asString(hp.hero?.tagline, asString(p.site?.tagline, 'W · W · W')),
    subtitle: asString(hp.hero?.subtitle, ''),
  };

  let items = Array.isArray(hp.apps?.items) ? hp.apps.items : null;
  if (!items) {
    // Old toml: derive tiles from the legacy [apps] fileid/doc_finder keys.
    // MUST mirror normalizeHomepage in site/src/lib/site-config.ts — a
    // mismatch means loading + saving a legacy toml here silently changes
    // what the site renders (it persists this default as the new truth).
    items = [
      {
        name: 'FileID',
        status: 'live',
        link: asString(p.apps?.fileid),
        icon: '/assets/fileid.png',
      },
      {
        name: 'Document Finder',
        status: 'soon',
        link: asString(p.apps?.doc_finder),
        icon: '/assets/doc-finder.png',
      },
      { name: 'Untitled', status: 'lab', link: '', icon: '' },
      { name: 'Untitled', status: 'lab', link: '', icon: '' },
    ];
  }
  const apps = {
    items: items.map((it) => ({
      name: asString(it?.name),
      status: APP_STATUSES.includes(it?.status) ? it.status : 'soon',
      link: asString(it?.link),
      icon: asString(it?.icon),
    })),
  };

  const videos = {
    episode: asString(hp.videos?.episode, 'EP. 001'),
    film_title: asString(hp.videos?.film_title, 'First video — coming soon'),
  };

  const order = asStringArray(hp.socials?.order);
  const hidden = asStringArray(hp.socials?.hidden);
  const socials = {
    order:
      order && order.length
        ? order.filter((k) => SOCIAL_KEYS.includes(k))
        : [...DEFAULT_SOCIAL_ORDER],
    hidden: hidden ? hidden.filter((k) => SOCIAL_KEYS.includes(k)) : [],
  };

  const blog_cta = {
    kicker: asString(hp.blog_cta?.kicker, 'Latest'),
    title: asString(hp.blog_cta?.title, 'The Web World Wide'),
    title_accent: asString(hp.blog_cta?.title_accent, 'Blog'),
    url: asString(hp.blog_cta?.url) || '/blog/',
    description: asString(hp.blog_cta?.description, ''),
  };

  /** @type {Record<string, boolean>} */
  const sections = {};
  for (const id of SECTION_IDS) {
    // eslint-disable-next-line security/detect-object-injection -- id from the SECTION_IDS constant
    sections[id] = typeof hp.sections?.[id] === 'boolean' ? hp.sections[id] : true;
  }

  const rawOrder = asStringArray(hp.section_order);
  const isPermutation =
    rawOrder &&
    rawOrder.length === SECTION_IDS.length &&
    SECTION_IDS.every((id) => rawOrder.includes(id));
  const section_order = isPermutation ? rawOrder : [...SECTION_IDS];

  return { hero, apps, videos, socials, blog_cta, sections, section_order };
}

/**
 * True when `v` starts with http://, https://, or `/` (site-relative).
 *
 * @param {string} v
 * @returns {boolean}
 */
const isLink = (v) => /^https?:\/\//.test(v) || v.startsWith('/');

/**
 * Validate a FULL homepage model (after merging a partial PATCH body
 * over the current state). Returns human-readable problem strings;
 * empty array means valid.
 *
 * @param {ReturnType<typeof normalizeHomepage>} m
 * @returns {string[]}
 */
function validateHomepage(m) {
  /** @type {string[]} */
  const errors = [];

  // hero
  const words = m.hero?.words;
  if (
    !Array.isArray(words) ||
    words.length < 1 ||
    words.length > 5 ||
    !words.every((w) => typeof w === 'string' && w.trim().length > 0 && w.length <= 24)
  ) {
    errors.push('hero.words must be 1-5 non-empty strings of at most 24 characters each');
  }
  if (typeof m.hero?.tagline !== 'string' || m.hero.tagline.length > 80) {
    errors.push('hero.tagline must be a string of at most 80 characters');
  }
  if (typeof m.hero?.subtitle !== 'string' || m.hero.subtitle.length > 120) {
    errors.push('hero.subtitle must be a string of at most 120 characters');
  }

  // apps
  const items = m.apps?.items;
  if (!Array.isArray(items) || items.length > 8) {
    errors.push('apps.items must be an array of at most 8 entries');
  } else {
    items.forEach((it, i) => {
      if (!it || typeof it !== 'object' || Array.isArray(it)) {
        errors.push(`apps.items[${i}] must be an object`);
        return;
      }
      if (typeof it.name !== 'string' || it.name.length < 1 || it.name.length > 40) {
        errors.push(`apps.items[${i}].name is required (1-40 characters)`);
      }
      if (!APP_STATUSES.includes(it.status)) {
        errors.push(`apps.items[${i}].status must be one of: ${APP_STATUSES.join(', ')}`);
      }
      for (const field of ['link', 'icon']) {
        // eslint-disable-next-line security/detect-object-injection -- field from a constant list
        const v = it[field] ?? '';
        if (typeof v !== 'string' || (v !== '' && !isLink(v))) {
          errors.push(`apps.items[${i}].${field} must be empty, http(s)://…, or /-relative`);
        }
      }
    });
  }

  // videos
  for (const field of ['episode', 'film_title']) {
    // eslint-disable-next-line security/detect-object-injection -- field from a constant list
    const v = m.videos?.[field];
    if (typeof v !== 'string' || v.length > 80) {
      errors.push(`videos.${field} must be a string of at most 80 characters`);
    }
  }

  // socials
  for (const field of ['order', 'hidden']) {
    // eslint-disable-next-line security/detect-object-injection -- field from a constant list
    const list = m.socials?.[field];
    if (!Array.isArray(list)) {
      errors.push(`socials.${field} must be an array`);
      continue;
    }
    const unknown = list.filter((k) => !SOCIAL_KEYS.includes(k));
    if (unknown.length) {
      errors.push(
        `socials.${field} contains unknown key(s): ${unknown.join(', ')} (known: ${SOCIAL_KEYS.join(', ')})`,
      );
    }
    if (new Set(list).size !== list.length) {
      errors.push(`socials.${field} contains duplicate keys`);
    }
  }

  // blog_cta
  for (const field of ['kicker', 'title', 'title_accent']) {
    // eslint-disable-next-line security/detect-object-injection -- field from a constant list
    const v = m.blog_cta?.[field];
    if (typeof v !== 'string' || v.length > 80) {
      errors.push(`blog_cta.${field} must be a string of at most 80 characters`);
    }
  }
  const url = m.blog_cta?.url;
  if (
    typeof url !== 'string' ||
    url.length === 0 ||
    url.length > 80 ||
    !(url.startsWith('/') || /^https:\/\//.test(url))
  ) {
    errors.push('blog_cta.url is required and must be /-relative or https://…');
  }
  if (typeof m.blog_cta?.description !== 'string' || m.blog_cta.description.length > 160) {
    errors.push('blog_cta.description must be a string of at most 160 characters');
  }

  // sections
  if (!m.sections || typeof m.sections !== 'object' || Array.isArray(m.sections)) {
    errors.push('sections must be an object of booleans');
  } else {
    for (const [id, v] of Object.entries(m.sections)) {
      if (!SECTION_IDS.includes(id)) {
        errors.push(`sections.${id} is not a known section id (known: ${SECTION_IDS.join(', ')})`);
      } else if (typeof v !== 'boolean') {
        errors.push(`sections.${id} must be a boolean`);
      }
    }
  }

  // section_order
  const so = m.section_order;
  const isPermutation =
    Array.isArray(so) &&
    so.length === SECTION_IDS.length &&
    SECTION_IDS.every((id) => so.includes(id));
  if (!isPermutation) {
    errors.push(`section_order must be a permutation of: ${SECTION_IDS.join(', ')}`);
  }

  return errors;
}

/**
 * Merge a partial PATCH body over the current full model. Only fields
 * present in the body override; everything else keeps current values.
 *
 * @param {ReturnType<typeof normalizeHomepage>} current
 * @param {Record<string, any>} body
 * @returns {ReturnType<typeof normalizeHomepage>}
 */
function mergeHomepage(current, body) {
  const merged = structuredClone(current);
  if (body.hero) {
    if ('words' in body.hero) merged.hero.words = body.hero.words;
    if ('tagline' in body.hero) merged.hero.tagline = body.hero.tagline;
    if ('subtitle' in body.hero) merged.hero.subtitle = body.hero.subtitle;
  }
  if (body.apps && 'items' in body.apps) merged.apps.items = body.apps.items;
  if (body.videos) {
    if ('episode' in body.videos) merged.videos.episode = body.videos.episode;
    if ('film_title' in body.videos) merged.videos.film_title = body.videos.film_title;
  }
  if (body.socials) {
    if ('order' in body.socials) merged.socials.order = body.socials.order;
    if ('hidden' in body.socials) merged.socials.hidden = body.socials.hidden;
  }
  if (body.blog_cta) {
    for (const field of ['kicker', 'title', 'title_accent', 'url', 'description']) {
      // eslint-disable-next-line security/detect-object-injection -- field from a constant list
      if (field in body.blog_cta) merged.blog_cta[field] = body.blog_cta[field];
    }
  }
  if (body.sections) merged.sections = { ...merged.sections, ...body.sections };
  if ('section_order' in body) merged.section_order = body.section_order;
  return merged;
}

/**
 * Build toml-roundtrip changes for ONLY the fields the PATCH body
 * touched, taking the (validated) values from the merged model. App
 * items are re-shaped to exactly { name, status, link, icon } so junk
 * keys never reach the toml file.
 *
 * @param {Record<string, any>} body
 * @param {ReturnType<typeof normalizeHomepage>} merged
 * @returns {import('../utils/toml-roundtrip.js').Change[]}
 */
function homepageChanges(body, merged) {
  /** @type {import('../utils/toml-roundtrip.js').Change[]} */
  const changes = [];
  // [homepage] first so creating sections in an old toml keeps the
  // super-table header above its sub-tables.
  if ('section_order' in body) {
    changes.push({ section: 'homepage', key: 'section_order', value: merged.section_order });
  }
  if (body.sections) {
    for (const id of Object.keys(body.sections)) {
      // eslint-disable-next-line security/detect-object-injection -- validated against SECTION_IDS
      changes.push({ section: 'homepage.sections', key: id, value: merged.sections[id] });
    }
  }
  if (body.hero) {
    if ('words' in body.hero) {
      changes.push({ section: 'homepage.hero', key: 'words', value: merged.hero.words });
    }
    if ('tagline' in body.hero) {
      changes.push({ section: 'homepage.hero', key: 'tagline', value: merged.hero.tagline });
    }
    if ('subtitle' in body.hero) {
      changes.push({ section: 'homepage.hero', key: 'subtitle', value: merged.hero.subtitle });
    }
  }
  if (body.apps && 'items' in body.apps) {
    const items = merged.apps.items.map((it) => ({
      name: it.name,
      status: it.status,
      link: it.link ?? '',
      icon: it.icon ?? '',
    }));
    changes.push({ section: 'homepage.apps', key: 'items', value: items });
  }
  if (body.videos) {
    if ('episode' in body.videos) {
      changes.push({ section: 'homepage.videos', key: 'episode', value: merged.videos.episode });
    }
    if ('film_title' in body.videos) {
      changes.push({
        section: 'homepage.videos',
        key: 'film_title',
        value: merged.videos.film_title,
      });
    }
  }
  if (body.socials) {
    if ('order' in body.socials) {
      changes.push({ section: 'homepage.socials', key: 'order', value: merged.socials.order });
    }
    if ('hidden' in body.socials) {
      changes.push({ section: 'homepage.socials', key: 'hidden', value: merged.socials.hidden });
    }
  }
  if (body.blog_cta) {
    for (const field of ['kicker', 'title', 'title_accent', 'url', 'description']) {
      if (field in body.blog_cta) {
        // eslint-disable-next-line security/detect-object-injection -- field from a constant list
        changes.push({ section: 'homepage.blog_cta', key: field, value: merged.blog_cta[field] });
      }
    }
  }
  return changes;
}

router.get('/homepage', (req, res) => {
  try {
    const { parsed } = readSettings();
    res.json(normalizeHomepage(parsed));
  } catch (err) {
    console.error('[settings] homepage read failed:', err);
    res.status(500).json({ error: 'read_failed', message: err.message });
  }
});

router.patch('/homepage', (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res
        .status(400)
        .json({ error: 'validation_failed', message: 'body must be a homepage model object' });
    }
    const unknown = Object.keys(body).filter((k) => !HOMEPAGE_KEYS.includes(k));
    if (unknown.length) {
      return res.status(400).json({
        error: 'validation_failed',
        message: `unknown field(s): ${unknown.join(', ')} (known: ${HOMEPAGE_KEYS.join(', ')})`,
      });
    }
    // Container-shape check: provided top-level fields must be the
    // right kind of value, otherwise a junk payload would silently no-op.
    for (const k of [...SECTION_IDS, 'sections']) {
      // eslint-disable-next-line security/detect-object-injection -- k from a constant list
      const v = body[k];
      if (v !== undefined && (!v || typeof v !== 'object' || Array.isArray(v))) {
        return res
          .status(400)
          .json({ error: 'validation_failed', message: `${k} must be an object` });
      }
    }

    const src = readFileSync(SETTINGS_TOML, 'utf-8');
    const current = normalizeHomepage(parseToml(src));
    const merged = mergeHomepage(current, body);
    const errors = validateHomepage(merged);
    if (errors.length) {
      return res
        .status(400)
        .json({ error: 'validation_failed', message: errors.join('; '), errors });
    }

    const changes = homepageChanges(body, merged);
    if (!changes.length) {
      return res.json(current); // nothing to write — empty PATCH is a no-op
    }
    const next = applyToml(src, changes);
    // Validate the result still parses before persisting — same guard
    // as PATCH /hugo.
    try {
      parseToml(next);
    } catch (parseErr) {
      return res.status(400).json({ error: 'invalid_toml_after_edit', message: parseErr.message });
    }
    // Snapshot the PREVIOUS homepage state before we overwrite site.toml, so
    // the History panel can roll back recent saves (mirrors how posts
    // snapshot before overwrite). Best effort — recordSnapshot swallows its
    // own errors and never throws.
    recordSnapshot(HOMEPAGE_SNAPSHOT_KEY, { title: 'Homepage', data: current, content: src });
    writeFileSync(SETTINGS_TOML, next);
    logActivity({
      req,
      action: 'settings.homepage',
      target: 'site.toml',
      meta: { keys: changes.map((c) => `${c.section ? c.section + '.' : ''}${c.key}`) },
    });
    res.json(normalizeHomepage(parseToml(next)));
  } catch (err) {
    console.error('[settings] homepage patch failed:', err);
    res.status(500).json({ error: 'write_failed', message: err.message });
  }
});

/**
 * GET /api/settings/homepage/history
 *
 * Revision history for the homepage editor's History panel: published
 * versions of site.toml from git (newest first) plus recent local pre-save
 * snapshots. Both are restorable via the version endpoint below. Mirrors
 * GET /api/posts/:filename/history. Registered AFTER the exact `/homepage`
 * routes above; `/homepage/history` is a distinct (longer) path so Express
 * never routes it into the exact `/homepage` handler — no shadowing.
 */
router.get('/homepage/history', async (req, res) => {
  try {
    const [git, snapshots] = await Promise.all([
      getFileHistory(SITE_TOML_RELPATH),
      Promise.resolve(listSnapshots(HOMEPAGE_SNAPSHOT_KEY)),
    ]);
    res.json({ git, snapshots });
  } catch (err) {
    console.error('[settings] homepage history failed:', err);
    res.status(500).json({ error: 'history_failed', message: err.message });
  }
});

/**
 * GET /api/settings/homepage/version/:source/:ref
 *
 * The normalized homepage MODEL of a historical version — `source` is `git`
 * (ref = commit hash; site.toml from that commit is parsed + normalized) or
 * `snapshot` (ref = snapshot id; its stored model is returned as-is). The
 * editor loads the result as unsaved changes so a restore is always
 * reviewed before it becomes current (never a silent server-side overwrite).
 * Mirrors GET /api/posts/:filename/version/:source/:ref.
 */
router.get('/homepage/version/:source/:ref', async (req, res) => {
  try {
    const { source, ref } = req.params;
    if (source === 'git') {
      const raw = await getFileAtCommit(SITE_TOML_RELPATH, ref);
      if (!raw) return res.status(404).json({ error: 'version_not_found' });
      return res.json(normalizeHomepage(parseToml(raw)));
    }
    if (source === 'snapshot') {
      const snap = getSnapshot(ref);
      if (!snap) return res.status(404).json({ error: 'version_not_found' });
      return res.json(snap.data);
    }
    return res.status(400).json({ error: 'unknown_source' });
  } catch (err) {
    console.error('[settings] homepage version fetch failed:', err);
    res.status(500).json({ error: 'version_failed', message: err.message });
  }
});

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
