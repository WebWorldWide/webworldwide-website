// @ts-check
/**
 * Shared helpers for scripts/dev/*.mjs — Phase 5d local dev experience.
 *
 * No runtime deps: ANSI escape codes for colors, a tiny dotenv parser
 * (we already pull `dotenv` transitively but importing it from a script
 * adds a hard top-level dep we don't otherwise need), and a couple of
 * path helpers so each script can find the repo root regardless of CWD.
 *
 * Keep this file dependency-free so `node scripts/dev/<x>.mjs` works on
 * a fresh clone before `npm install` even finishes.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repo root (parent of scripts/dev/). */
export const REPO_ROOT = resolve(__dirname, '..', '..');

/** ANSI color helpers. */
const ansi = (open, close) => (s) =>
  process.stdout.isTTY ? `[${open}m${s}[${close}m` : String(s);

export const c = {
  green: ansi(32, 39),
  red: ansi(31, 39),
  yellow: ansi(33, 39),
  blue: ansi(34, 39),
  cyan: ansi(36, 39),
  magenta: ansi(35, 39),
  gray: ansi(90, 39),
  bold: ansi(1, 22),
  dim: ansi(2, 22),
};

/**
 * Build a tag-prefixed colored logger. Used by every dev script so the
 * `npm run dev:all` interleaved output is parseable at a glance.
 *
 * @param {string} tag
 * @param {(s: string) => string} color
 * @returns {{ info: (msg: string) => void, warn: (msg: string) => void, error: (msg: string) => void }}
 */
export function makeLogger(tag, color = c.cyan) {
  const prefix = color(`[${tag}]`);
  return {
    info: (msg) => console.log(`${prefix} ${msg}`),
    warn: (msg) => console.warn(`${prefix} ${c.yellow(msg)}`),
    error: (msg) => console.error(`${prefix} ${c.red(msg)}`),
  };
}

/**
 * Minimal `.env` parser — no quote interpolation, no expansion, no
 * comments-on-the-same-line. Mutates `process.env` and returns the
 * parsed map for tests.
 *
 * Searches docker/.env.dev → docker/.env.dev.example → .env, taking the
 * first one that exists. Returning `{}` is fine: every var has a default
 * in the consuming code.
 *
 * @param {string[]} [extraPaths]
 * @returns {Record<string, string>}
 */
export function loadDevEnv(extraPaths = []) {
  const candidates = [
    resolve(REPO_ROOT, 'docker', '.env.dev'),
    resolve(REPO_ROOT, 'docker', '.env.dev.example'),
    resolve(REPO_ROOT, '.env'),
    ...extraPaths,
  ];
  /** @type {Record<string, string>} */
  const parsed = {};
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!(key in parsed)) parsed[key] = value;
      if (!(key in process.env)) process.env[key] = value;
    }
    break;
  }
  return parsed;
}

/**
 * Resolve a path that the dev .env may have specified relative to the
 * repo root. Absolute paths pass through untouched.
 *
 * @param {string} p
 * @returns {string}
 */
export function repoPath(p) {
  return resolve(REPO_ROOT, p);
}

/**
 * Lightweight CLI flag detector. Returns true if `--name` or `-x`
 * appears in argv. Doesn't support `--name=value` (none of our scripts
 * need it).
 *
 * @param {string[]} names
 * @returns {boolean}
 */
export function hasFlag(...names) {
  return process.argv.some((a) => names.includes(a));
}
