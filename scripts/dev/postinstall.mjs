#!/usr/bin/env node
// @ts-check
/**
 * scripts/dev/postinstall.mjs
 *
 * Cascades `npm install` into site/ and admin/ on a fresh clone, so
 * `git clone … && cd … && npm install` is sufficient before
 * `npm run dev`. Skipped in CI (workflows install each subpackage
 * explicitly with --ignore-scripts to control build behavior).
 *
 * Only runs when the subpackage's node_modules is missing — this keeps
 * subsequent root `npm install` calls fast and silent. To force a
 * re-install, delete the subpackage's node_modules first.
 *
 * Escape hatch: set WWWIDE_SKIP_POSTINSTALL=1 to skip entirely.
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { REPO_ROOT, c, makeLogger } from './_lib.mjs';

const log = makeLogger('postinstall', c.cyan);

if (process.env.CI === 'true' || process.env.WWWIDE_SKIP_POSTINSTALL === '1') {
  process.exit(0);
}

const SUBPACKAGES = ['site', 'admin'];

for (const sub of SUBPACKAGES) {
  const subPath = resolve(REPO_ROOT, sub);
  const nodeModules = resolve(subPath, 'node_modules');
  if (existsSync(nodeModules)) {
    continue;
  }
  if (!existsSync(resolve(subPath, 'package.json'))) {
    continue;
  }
  log.info(c.yellow(`installing ${sub}/ dependencies (first run)…`));
  // npm.cmd on Windows so spawn finds it via PATH; npm on POSIX. The
  // `shell: true` flag handles either without manual extension resolution.
  const result = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: subPath,
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    log.error(
      `${sub}/ install failed (exit ${result.status}). Run \`npm --prefix ${sub} install\` manually.`,
    );
    process.exit(result.status || 1);
  }
}
