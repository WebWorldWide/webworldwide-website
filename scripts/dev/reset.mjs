#!/usr/bin/env node
// @ts-check
/**
 * scripts/dev/reset.mjs — Phase 5d.
 *
 * Nuke the local dev SQLite DB (auth, media, conversion_jobs) and any
 * dev-uploaded files, then re-run the seed. Behind a `Y/n` prompt
 * unless `--yes` is passed.
 *
 * Safety:
 *   - Only touches AUTH_DB_PATH and `*-dev-*` files under
 *     site/static/{images,files}. Real assets the repo tracks are left
 *     alone.
 *   - Errors loud if it can't delete the DB (probably because
 *     `npm run dev:all` is still running and holding a WAL lock).
 */

import { existsSync, rmSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadDevEnv, repoPath, makeLogger, c, hasFlag } from './_lib.mjs';
import { runSeed } from './seed.mjs';

const log = makeLogger('reset', c.magenta);

/** Files to nuke; relative-to-DB-path siblings the SQLite WAL writes. */
const DB_SIDECARS = ['', '-wal', '-shm', '-journal'];

/**
 * Delete the dev SQLite DB and its WAL/SHM siblings. Returns the list of
 * paths that were actually removed (for tests).
 *
 * @param {string} dbPath
 * @returns {string[]}
 */
export function purgeDb(dbPath) {
  const removed = [];
  for (const suffix of DB_SIDECARS) {
    const p = `${dbPath}${suffix}`;
    if (existsSync(p)) {
      rmSync(p, { force: true });
      removed.push(p);
    }
  }
  return removed;
}

/**
 * Delete dev-uploaded files under `dir`. Only files containing `-dev-`
 * or prefixed `fixture-` are removed — anything else is treated as a
 * committed asset and skipped.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function purgeDevUploads(dir) {
  const removed = [];
  if (!existsSync(dir)) return removed;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    let stat;
    try {
      stat = statSync(p);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (!/(^fixture-|-dev-)/.test(entry)) continue;
    try {
      unlinkSync(p);
      removed.push(p);
    } catch (err) {
      log.warn(`could not delete ${p}: ${err.message}`);
    }
  }
  return removed;
}

/**
 * Y/n prompt. Resolves true on Y/yes/empty (default Yes), false
 * otherwise. Bypassed by --yes.
 *
 * @returns {Promise<boolean>}
 */
async function confirm() {
  if (hasFlag('--yes', '-y')) return true;
  if (!stdin.isTTY) {
    log.warn('non-TTY input and no --yes flag — aborting');
    return false;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (
    await rl.question(
      `${c.yellow('[reset]')} Wipe dev DB + dev uploads and re-seed? ${c.bold('[Y/n]')} `,
    )
  )
    .trim()
    .toLowerCase();
  rl.close();
  return answer === '' || answer === 'y' || answer === 'yes';
}

/**
 * Entrypoint. Exported as `runReset` for tests; takes an options bag so
 * the test can inject a custom dbPath and skip the prompt.
 *
 * @param {{ confirmFn?: () => Promise<boolean>, dbPath?: string }} [opts]
 * @returns {Promise<{ db: string[], uploads: string[], seeded: Awaited<ReturnType<typeof runSeed>> | null }>}
 */
export async function runReset(opts = {}) {
  loadDevEnv();
  const dbPath =
    opts.dbPath ||
    (process.env.AUTH_DB_PATH
      ? repoPath(process.env.AUTH_DB_PATH)
      : repoPath('admin/data/auth-dev.db'));

  log.warn('Make sure `npm run dev:all` is not running — the DB will be locked.');

  const ok = opts.confirmFn ? await opts.confirmFn() : await confirm();
  if (!ok) {
    log.info('aborted.');
    return { db: [], uploads: [], seeded: null };
  }

  const db = purgeDb(dbPath);
  log.info(`removed ${db.length} DB file(s)`);

  const uploads = [
    ...purgeDevUploads(repoPath('site/static/images')),
    ...purgeDevUploads(repoPath('site/static/files')),
  ];
  log.info(`removed ${uploads.length} dev-uploaded file(s)`);

  // Re-point AUTH_DB_PATH so the seed lands in the same place.
  process.env.AUTH_DB_PATH = dbPath;
  const seeded = await runSeed();

  log.info(c.green('reset complete'));
  return { db, uploads, seeded };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runReset().catch((err) => {
    log.error(err.stack || err.message);
    process.exit(1);
  });
}
