// @ts-check
/**
 * redirects-store.js — shared read/normalize/write for the site-wide
 * redirect table (`site/data/redirects.json`).
 *
 * Used by BOTH the redirects admin route (`routes/redirects.js`) and the
 * post-rename flow (`routes/posts.js`): renaming a post auto-adds an
 * old→new redirect so the public URL change never 404s. Centralizing the
 * store keeps both writers consistent and the table loop/chain-free.
 *
 * The build reads this file at build time: `site/scripts/prebuild.mjs`
 * merges it into legacy-redirects.json, which astro.config.mjs turns into
 * meta-refresh redirect pages.
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { nanoid } from 'nanoid';
import { writeFileAtomic } from '../utils/atomicWrite.js';

const SITE_DIR = process.env.SITE_DIR || join(process.cwd(), '..', 'site');
const REDIRECTS_JSON = join(SITE_DIR, 'data', 'redirects.json');

/**
 * Normalize a path: ensure it starts with `/`, drop trailing slashes
 * (except the root). `from` is always on our own domain; `to` may be an
 * absolute URL (left intact apart from a trailing-slash trim).
 *
 * @param {string} p
 * @returns {string}
 */
export function normPath(p) {
  let s = String(p || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, '');
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

/**
 * Read the redirect table, coercing every row to a clean shape. Returns
 * [] if the file is missing or unparseable (never throws).
 *
 * @returns {Array<{ id: string, from: string, to: string, code: number }>}
 */
export function readRedirects() {
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

/**
 * Persist the redirect table atomically (so a torn write can't corrupt
 * the build input).
 *
 * @param {Array<{ id: string, from: string, to: string, code: number }>} rows
 */
export function writeRedirects(rows) {
  mkdirSync(dirname(REDIRECTS_JSON), { recursive: true });
  writeFileAtomic(REDIRECTS_JSON, JSON.stringify(rows, null, 2) + '\n');
}

/**
 * Upsert a redirect into `rows` (mutated in place), keeping the table
 * loop- and chain-free:
 *   - no-op when from === to (would redirect to itself),
 *   - collapse chains: any row whose `to` was the old location is
 *     re-pointed at the new target (so A→B then B→C yields A→C, not A→B→C),
 *   - drop any row whose `from` equals the new target (that URL is a live
 *     page again — it must not redirect away),
 *   - update an existing row with the same `from`, else append a new one.
 *
 * @param {Array<{ id: string, from: string, to: string, code: number }>} rows
 * @param {string} fromRaw
 * @param {string} toRaw
 * @param {number} [code]
 * @returns {{ from: string, to: string } | null} the normalized pair, or null if skipped
 */
export function upsertRedirect(rows, fromRaw, toRaw, code = 301) {
  const from = normPath(fromRaw);
  const to = normPath(toRaw);
  if (!from || !to || from === to) return null;

  // The target is now a live page — it must not also be a redirect source.
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].from === to) rows.splice(i, 1);
  }
  // Collapse chains that pointed at the old location.
  for (const r of rows) {
    if (r.to === from) r.to = to;
  }
  // Collapsing can produce a self-redirect (e.g. A→B then add B→A turns the
  // A→B row into A→A). Drop any row that now points at itself.
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].from === rows[i].to) rows.splice(i, 1);
  }
  // Upsert the from→to row.
  const existing = rows.find((r) => r.from === from);
  if (existing) {
    existing.to = to;
    existing.code = code;
  } else {
    rows.push({ id: nanoid(), from, to, code });
  }
  return { from, to };
}
