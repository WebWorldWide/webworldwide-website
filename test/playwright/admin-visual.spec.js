// @ts-check
/**
 * admin-visual.spec.js — guards against empty / broken status UI in the admin.
 *
 * Born from the reported "empty oval next to the article state" bug:
 * `#deploy-status` (.ed-deploy) and `#publish-at-badge` (.ed-publish-badge)
 * each declared their own `display`, which defeats the UA `[hidden]` rule, so
 * an empty bordered pill rendered on every editor load — before any publish.
 *
 * These tests turn "looks empty" into a hard assertion: any pill/badge that is
 * actually visible MUST carry a text label or a rendered ::before dot, and the
 * not-yet-meaningful badges must be hidden (display:none), not empty ovals.
 * They also confirm the removed first-run guide left nothing behind.
 *
 * Runs against the no-backend static harness (helpers/static-admin.js): the
 * admin SPA boots over a real http origin with /api|/auth stubbed.
 */
import { test, expect } from '@playwright/test';
import { startStaticAdmin } from './helpers/static-admin.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', '..', 'admin', 'public');

/** @type {{ url: string, close: () => Promise<void> }} */
let staticAdmin;
test.beforeAll(async () => {
  staticAdmin = await startStaticAdmin(PUBLIC_DIR);
});
test.afterAll(async () => {
  if (staticAdmin) await staticAdmin.close();
});
const url = (name) => `${staticAdmin.url}/${name}`;

// The SPA fires /api fetches that 503 under the static harness; that's expected
// and handled — keep the fixture quiet.
function mute(page) {
  page.on('console', () => {});
  page.on('pageerror', () => {});
}

// Pill/badge classes that render as bordered or filled chips. A *visible* one
// with neither a text label nor a rendered ::before dot is the empty-oval bug.
const PILL_SELECTORS = ['.ed-pill', '.ed-deploy', '.ed-publish-badge', '.r-pill'];

/**
 * Returns identifiers for any visible pill/badge that has no content at all.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} selectors
 * @returns {Promise<string[]>}
 */
function findEmptyPills(page, selectors) {
  return page.evaluate((sels) => {
    /** @type {string[]} */
    const empties = [];
    for (const el of Array.from(document.querySelectorAll(sels.join(',')))) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const text = (el.textContent || '').trim();
      const before = getComputedStyle(el, '::before');
      const hasBeforeDot = before.content !== 'none' && before.content !== 'normal';
      if (!text && !hasBeforeDot) {
        empties.push(`${el.tagName.toLowerCase()}#${el.id || '?'}.${el.className}`);
      }
    }
    return empties;
  }, selectors);
}

test.describe('admin visual integrity', () => {
  test('editor head: status pill is labelled, deploy oval stays hidden until publish', async ({
    page,
  }) => {
    mute(page);
    await page.goto(url('editor.html'), { waitUntil: 'networkidle' });
    // The post-state pill is always labelled.
    await expect(page.locator('#ed-status-pill')).toHaveText(/DRAFT|PUBLISHED/);
    // The deploy pill has no label until a publish runs — it must be HIDDEN
    // (display:none), never a visible empty bordered oval. This is the
    // regression guard for the reported bug.
    await expect(page.locator('#deploy-status')).toBeHidden();
    const empties = await findEmptyPills(page, PILL_SELECTORS);
    expect(empties, `visible-but-empty pills: ${empties.join(', ')}`).toEqual([]);
  });

  test('editor sidebar: publish-at badge hidden when no schedule is set', async ({ page }) => {
    mute(page);
    await page.goto(url('editor.html'), { waitUntil: 'networkidle' });
    // Expand every collapsible panel so the badge would render if it could.
    await page.evaluate(() => {
      document.querySelectorAll('details').forEach((d) => {
        /** @type {HTMLDetailsElement} */ (d).open = true;
      });
    });
    await expect(page.locator('#publish-at-badge')).toBeHidden();
    const empties = await findEmptyPills(page, PILL_SELECTORS);
    expect(empties, `visible-but-empty pills (panels open): ${empties.join(', ')}`).toEqual([]);
  });

  test('dashboard: the removed first-run guide leaves nothing behind', async ({ page }) => {
    mute(page);
    await page.goto(url('index.html'), { waitUntil: 'networkidle' });
    await expect(page.locator('#ov-getting-started')).toHaveCount(0);
    await expect(page.locator('.ov-guide')).toHaveCount(0);
    await expect(page.locator('.ov-guide-reopen')).toHaveCount(0);
    await expect(page.locator('.te-template-hint')).toHaveCount(0);
  });
});
