// @ts-check
/**
 * Public-site smoke tests: core routes return 200 and the blog listing surfaces
 * its masthead, post cards, and pager.
 *
 * The Astro dev server is started via webServer in playwright.config.js.
 */

import { test, expect } from '@playwright/test';

// request.get() follows redirects, so the legacy `/bye-bye-dji/` path resolves
// through its 301 to the canonical `/blog/bye-bye-dji/` and lands on 200.
// Note: the sitemap (/sitemap-index.xml) is emitted at build time by
// @astrojs/sitemap and is intentionally absent under `astro dev`, so it's not
// part of this dev-server smoke list.
const ROUTES = ['/', '/blog/', '/blog/2/', '/blog/bye-bye-dji/', '/bye-bye-dji/', '/rss.xml'];

for (const route of ROUTES) {
  test(`GET ${route} returns 200`, async ({ request }) => {
    const res = await request.get(route);
    expect(res.status(), `route ${route}`).toBe(200);
  });
}

test('blog listing renders masthead, cards, and pager (no featured card)', async ({ page }) => {
  await page.goto('/blog/');
  // Masthead title carries the full text (server-rendered for SEO/no-JS).
  await expect(page.locator('.masthead .mast-title')).toHaveAttribute(
    'aria-label',
    'Web World Wide',
  );
  // No special "featured" card — all posts paginate evenly (6 per page).
  await expect(page.locator('.card.featured')).toHaveCount(0);
  await expect(page.locator('.card.post-card')).toHaveCount(6);
  await expect(page.locator('.pager .count')).toContainText('PAGE 01');
});

test('Blog nav link is last and marked current on /blog/', async ({ page }) => {
  await page.goto('/blog/');
  const links = page.locator('.topbar-pill a.nav-link');
  await expect(links.last()).toHaveText('Blog');
  await expect(links.last()).toHaveAttribute('aria-current', 'page');
});

test('older/newer pagination navigates between listing pages', async ({ page }) => {
  await page.goto('/blog/2/');
  await expect(page.locator('.pager .count')).toContainText('PAGE 02');
  // Page 2 still shows post cards.
  await expect(page.locator('.card.post-card').first()).toBeVisible();
});

test('home page loads its animations (globes/spinners/clouds) with no uncaught errors', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // Let the lazy (client:idle) globe + spinner scripts boot.
  await page.waitForTimeout(1500);
  expect(errors, errors.join('\n')).toHaveLength(0);
});
