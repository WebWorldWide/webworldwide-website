// @ts-check
/**
 * test/playwright/local-dev.spec.js — Phase 5d.
 *
 * End-to-end happy-path smoke for the local-dev stack. Gated by the
 * `DEV_STACK_RUNNING=true` env var so CI doesn't try to exercise a
 * non-existent Docker stack.
 *
 * To run locally:
 *   1. Terminal A:  npm run dev:all   # boots docker + hugo + admin
 *   2. Wait for `npm run dev:check` to print all green
 *   3. Terminal B:  DEV_STACK_RUNNING=true npx playwright test test/playwright/local-dev.spec.js
 *
 * Walks the quickstart path:
 *   - Public site at :1313 loads with the right <title>
 *   - Admin /login.html renders the password form
 *   - Submits admin/password, expects a session cookie + dashboard
 *   - Loads the media library and sees the seeded fixtures
 */

import { test, expect } from '@playwright/test';

const enabled = process.env.DEV_STACK_RUNNING === 'true';

test.describe('local-dev stack', () => {
  test.skip(!enabled, 'set DEV_STACK_RUNNING=true after `npm run dev:all` is up');

  test('public Hugo site is reachable on :1313', async ({ page }) => {
    const res = await page.goto('http://localhost:1313/');
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle(/Terminal Eighty/i);
  });

  test('admin login page renders the password form', async ({ page }) => {
    const res = await page.goto('http://localhost:3000/login.html');
    expect(res?.status()).toBe(200);
    // The login.html shell has both a setup-panel and a login-panel;
    // after seed has run, the login panel should be the active one.
    await expect(page.locator('#login-panel')).toHaveCount(1);
  });

  test('password login admin/password reaches the dashboard', async ({ page, context }) => {
    await page.goto('http://localhost:3000/login.html');
    // The shell uses fetch() against /auth/login/password — we drive it
    // directly so we don't depend on the (still-iterating) form markup.
    const loginRes = await page.evaluate(async () => {
      const r = await fetch('/auth/login/password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'password' }),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.success).toBe(true);

    // Cookie is set; the dashboard should now load.
    const cookies = await context.cookies('http://localhost:3000');
    expect(cookies.some((c) => c.name === 'session')).toBe(true);

    const home = await page.goto('http://localhost:3000/');
    expect(home?.status()).toBe(200);
  });

  test('media library lists the five seeded fixtures', async ({ page }) => {
    // Authenticate first so /api/media accepts the request.
    await page.goto('http://localhost:3000/login.html');
    await page.evaluate(async () => {
      await fetch('/auth/login/password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'password' }),
      });
    });
    const list = await page.evaluate(async () => {
      const r = await fetch('/api/media', { credentials: 'same-origin' });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    });
    expect(list.status).toBe(200);
    // The seed inserts exactly five fixtures; assert ≥ 5 in case the
    // developer added more by uploading after the seed.
    const items = Array.isArray(list.body) ? list.body : list.body.items || [];
    expect(items.length).toBeGreaterThanOrEqual(5);
    const filenames = items.map((m) => m.filename || m.original_name);
    expect(filenames.some((n) => /fixture-/.test(n))).toBe(true);
  });
});
