#!/usr/bin/env node
// @ts-check
/**
 * run-lhci.mjs — `npm run test:lighthouse` entrypoint.
 *
 * lhci's healthcheck needs a Chrome binary and fails outright without
 * one. Dev machines here don't carry a system Chrome (all browser
 * testing goes through Playwright), so when CHROME_PATH isn't already
 * set, point lhci at Playwright's chromium. CI environments that
 * provide their own Chrome (or set CHROME_PATH) are untouched.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!process.env.CHROME_PATH) {
  try {
    const { chromium } = await import('@playwright/test');
    const candidate = chromium.executablePath();
    if (candidate && existsSync(candidate)) process.env.CHROME_PATH = candidate;
  } catch {
    // No Playwright available — fall through and let lhci's own
    // healthcheck report whatever Chrome it can (or can't) find.
  }
}

const res = spawnSync('lhci', ['autorun', '--config=lighthouserc.json'], {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});
process.exit(res.status ?? 1);
