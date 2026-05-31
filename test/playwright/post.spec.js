// @ts-check
/**
 * Post detail + ⌘K palette smoke tests.
 *
 * The Astro dev server is started via webServer in playwright.config.js.
 */

import { test, expect } from '@playwright/test';

const POST = '/blog/bye-bye-dji/';

test('post page renders title, body, meta, and next-post', async ({ page }) => {
  await page.goto(POST);
  // Title keeps its full text in aria-label even while the typewriter runs.
  await expect(page.locator('.post-title')).toHaveAttribute('aria-label', /.+/);
  await expect(page.locator('.post-body')).toBeVisible();
  await expect(page.locator('.post-body')).not.toBeEmpty();
  // Meta is just the date now (reading-time removed).
  await expect(page.locator('.post-meta')).toContainText(/\d{4}/);
  await expect(page.locator('.next-post .next-title')).not.toBeEmpty();
});

test('back-to-posts link returns to the listing', async ({ page }) => {
  await page.goto(POST);
  const back = page.locator('.back-btn');
  await expect(back).toHaveAttribute('href', '/blog/');
});

test('comments section mounts under a Comments header', async ({ page }) => {
  await page.goto(POST);
  await expect(page.locator('.comments-title')).toContainText('Comments');
  // CommentForm is client:visible — scroll it into view, then the Remark42
  // container (or its fallback) should mount.
  await page.locator('.comments').scrollIntoViewIfNeeded();
  await expect(page.locator('.remark42-wrap, .comments-empty')).toBeVisible();
});

test('search pill opens the palette, filters, and closes (no keybind)', async ({ page }) => {
  await page.goto('/blog/');
  const palette = page.locator('.cmdk');
  // The palette island is client:idle — retry the click until hydration has
  // attached the document listener. There is intentionally NO ⌘K shortcut.
  await expect(async () => {
    await page.locator('.search-pill').click();
    await expect(palette).toBeVisible({ timeout: 800 });
  }).toPass({ timeout: 10_000 });
  await page.locator('.cmdk-input input').fill('dji');
  await expect(page.locator('.cmdk-row').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
});

test('there is no ⌘K / Ctrl+K search keybind', async ({ page }) => {
  await page.goto('/blog/');
  // Give the island time to hydrate, then confirm the shortcut does nothing.
  await page.locator('.search-pill').waitFor();
  await page.keyboard.press('Control+k');
  await expect(page.locator('.cmdk')).toBeHidden();
});
