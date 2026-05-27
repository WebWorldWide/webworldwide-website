// @ts-check
/**
 * Public-site smoke tests: every published route returns 200, content surfaces
 * carry microformat classes, and the bye-bye-dji post page has valid JSON-LD.
 *
 * The hugo dev server is started via webServer in playwright.config.js.
 */

import { test, expect } from '@playwright/test';

const ROUTES = [
  '/',
  '/about/',
  '/bye-bye-dji/',
  '/tags/tech/',
  '/index.json',
  '/index.xml',
  '/sitemap.xml',
];

for (const route of ROUTES) {
  test(`GET ${route} returns 200`, async ({ request }) => {
    const res = await request.get(route);
    expect(res.status(), `route ${route}`).toBe(200);
  });
}

test('post page carries h-entry microformat surfaces', async ({ page }) => {
  await page.goto('/bye-bye-dji/');
  // h-entry root may be on <article> or the page wrapper
  await expect(page.locator('.h-entry').first()).toBeVisible();
  await expect(page.locator('.p-name').first()).toBeVisible();
  await expect(page.locator('.dt-published').first()).toBeVisible();
});

test('post page exposes parseable JSON-LD', async ({ page }) => {
  await page.goto('/bye-bye-dji/');
  const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(scripts.length, 'at least one JSON-LD block').toBeGreaterThan(0);
  for (const raw of scripts) {
    expect(() => JSON.parse(raw), 'JSON-LD parses without throwing').not.toThrow();
  }
});
