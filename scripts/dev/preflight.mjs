#!/usr/bin/env node
// @ts-check
/**
 * scripts/dev/preflight.mjs
 *
 * Runs before `npm run dev` (site + admin) and `npm run dev:full`
 * (adds Docker — comments + analytics).
 *
 *   1. Ensure docker/.env.dev exists — auto-copy from .env.dev.example
 *      so a fresh clone never fails on the first dev run.
 *   2. Report Docker daemon status.
 *      - default (`npm run dev`): Docker is OPTIONAL. If it's down we
 *        print a friendly note and exit 0 — the public site (4321) and
 *        admin (3000) don't need it. Comments/analytics just won't run.
 *      - `--require-docker` (`npm run dev:full`): Docker is REQUIRED;
 *        exit 1 with a clear "start Docker" message if it's unreachable.
 *
 * Cross-platform: works on Windows (Docker Desktop), macOS (Docker
 * Desktop / OrbStack / Colima), and Linux (Docker Engine).
 */

import { existsSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { REPO_ROOT, c, makeLogger } from './_lib.mjs';

const log = makeLogger('preflight', c.cyan);
const requireDocker = process.argv.includes('--require-docker');

let fatal = 0;

// ── 1. .env.dev ──────────────────────────────────────────────────────
const envDevPath = resolve(REPO_ROOT, 'docker', '.env.dev');
const envDevExample = resolve(REPO_ROOT, 'docker', '.env.dev.example');
if (!existsSync(envDevPath)) {
  if (existsSync(envDevExample)) {
    copyFileSync(envDevExample, envDevPath);
    log.info(c.green('created docker/.env.dev from .env.dev.example (throwaway dev secrets)'));
  } else {
    log.warn('docker/.env.dev.example missing — skipping .env.dev auto-create');
  }
}

// ── 2. Docker daemon ─────────────────────────────────────────────────
let dockerUp;
try {
  execSync('docker info', { stdio: 'ignore', timeout: 5000 });
  dockerUp = true;
} catch {
  dockerUp = false;
}

if (dockerUp) {
  log.info(c.green('docker daemon reachable'));
} else if (requireDocker) {
  fatal += 1;
  log.error('docker daemon not reachable — required for `npm run dev:full`.');
  console.error('');
  console.error(
    `  ${c.bold('Start Docker')} (Docker Desktop on Win/Mac, or ${c.gray('sudo systemctl start docker')} on Linux) and retry,`,
  );
  console.error(
    `  or run ${c.bold('npm run dev')} to launch just the site + admin (no comments/analytics).`,
  );
  console.error('');
} else {
  // Default mode — Docker is optional. Don't block the site + admin.
  log.warn('docker not running — starting site + admin only (no comments/analytics).');
  console.error(
    `  ${c.gray('Comments (Remark42) + analytics (Umami) need Docker. Run')} ${c.bold('npm run dev:full')} ${c.gray('once Docker is up.')}`,
  );
}

// ── Summary ──────────────────────────────────────────────────────────
console.log('');
log.info(`${c.bold('Public site')} → ${c.cyan('http://localhost:4321')}`);
log.info(`${c.bold('Admin CMS')}   → ${c.cyan('http://localhost:3000')}`);
console.log('');

process.exit(fatal > 0 ? 1 : 0);
