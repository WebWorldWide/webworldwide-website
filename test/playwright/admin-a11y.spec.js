// @ts-check
/**
 * Phase 10 — admin SPA accessibility audit.
 *
 * Targets every static surface the admin shell exposes:
 *   - /login.html
 *   - /index.html (dashboard, plus #media #comments #settings
 *                  #redirects #activity hash routes)
 *   - /editor.html
 *
 * Gate: zero serious/critical violations per page.
 *
 * The admin SPA depends on Express for /api/* — exactly like
 * admin.spec.js we load the HTML via file:// so the test harness
 * doesn't need a live server. The page's own JS may fire fetch()
 * for /auth/status etc.; those reject with net::ERR_FAILED, the
 * SPA handles them gracefully, and axe runs against whatever DOM
 * is present once 'networkidle' resolves.
 *
 * Some axe rules deliberately don't fit the admin context — we
 * disable them with one-line justifications. Keep this list short
 * and document every entry: if you add another, the team needs to
 * see why in the PR.
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startStaticAdmin } from './helpers/static-admin.js';
import { loginDevAdmin } from './helpers/login.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', '..', 'admin', 'public');

// Serve over a real http origin so the SPA's absolute asset paths
// resolve and the hash router truly swaps views before axe runs.
// /api|/auth answer 503 (plus a fake authed /auth/status) — every view
// renders its degraded state, which is exactly what we audit.
/** @type {{ url: string, close: () => Promise<void> }} */
let staticAdmin;
test.beforeAll(async () => {
  staticAdmin = await startStaticAdmin(PUBLIC_DIR);
});
test.afterAll(async () => {
  if (staticAdmin) await staticAdmin.close();
});
const fileUrl = (name) => `${staticAdmin.url}/${name}`;

/**
 * Configure an AxeBuilder with the WCAG 2.0/2.1 AA tag set and the
 * admin-context exception list.
 *
 * Rule justifications:
 *
 *  - `region`: the admin sidebar / topbar use container `<aside>` and
 *    `<header>` landmarks but some panels are content-only `<div>` for
 *    layout. axe flags those as "content not in landmarks". Since the
 *    admin is a single-purpose admin shell (not a public document)
 *    we accept this rather than wrap every panel in another landmark.
 *
 *  - `page-has-heading-one`: some routed views (homepage editor,
 *    analytics) render their H1 from JS after a fetch settles; axe can
 *    run against the pre-paint empty-state. The H1s exist (covered by
 *    admin.spec.js DOM assertions) — not a real defect.
 * @param page
 */
function buildAxe(page) {
  return new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .disableRules(['region', 'page-has-heading-one']);
}

/**
 * Filter to the actionable blockers.
 * @param violations
 */
function blocking(violations) {
  return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

/**
 * Reusable a11y check.
 * @param page
 * @param label
 */
async function assertCleanAxe(page, label) {
  const res = await buildAxe(page).analyze();
  const bad = blocking(res.violations);
  if (bad.length) {
    console.error(`Accessibility violations on ${label}:`);
    for (const v of bad) {
      console.error(`  [${v.impact}] ${v.id}: ${v.help}`);
      for (const node of v.nodes.slice(0, 3)) {
        console.error(`    target: ${node.target.join(' ')}`);
      }
    }
  }
  expect(bad, `${label} should have no serious/critical a11y violations`).toEqual([]);
}

// Suppress predictable file:// fetch failures so the test fixture stays
// quiet. Mirrors admin.spec.js — we only care about a11y here, not
// runtime behavior the SPA already handles gracefully.
function muteExpectedConsole(page) {
  page.on('console', (msg) => {
    if (
      msg.type() === 'error' &&
      /fetch|XMLHttpRequest|net::ERR|Not authenticated/i.test(msg.text())
    ) {
      // expected when running under file://
    }
  });
  page.on('pageerror', () => {
    /* swallow — see admin.spec.js for the rationale */
  });
}

test.describe('admin a11y', () => {
  test('login.html — zero blocking violations', async ({ page }) => {
    muteExpectedConsole(page);
    await page.goto(fileUrl('login.html'), { waitUntil: 'networkidle' });
    await assertCleanAxe(page, 'login.html');
  });

  test('index.html dashboard — zero blocking violations', async ({ page }) => {
    muteExpectedConsole(page);
    await page.goto(fileUrl('index.html'), { waitUntil: 'networkidle' });
    await assertCleanAxe(page, 'index.html#dashboard');
  });

  // Hash routes — the router swaps view-* visibility based on
  // window.location.hash. Each test navigates with the hash already
  // in the URL so the SPA shows the right view on boot. Most views
  // render a "Loading…" placeholder under file:// (no /api/*), which
  // is still fully audit-able by axe.
  const HASH_ROUTES = [
    { hash: '#overview', label: 'overview' },
    { hash: '#posts', label: 'posts' },
    { hash: '#homepage', label: 'homepage editor' },
    { hash: '#analytics', label: 'analytics' },
    { hash: '#system', label: 'system' },
    { hash: '#media', label: 'media library' },
    { hash: '#comments', label: 'comments moderation' },
    { hash: '#settings', label: 'settings' },
    { hash: '#redirects', label: 'redirects' },
    { hash: '#activity', label: 'activity feed' },
  ];

  for (const { hash, label } of HASH_ROUTES) {
    test(`index.html${hash} — ${label} — zero blocking violations`, async ({ page }) => {
      muteExpectedConsole(page);
      await page.goto(fileUrl('index.html') + hash, { waitUntil: 'networkidle' });
      // Give the router one microtask to swap views — the SPA reads
      // location.hash on DOMContentLoaded. networkidle already implies
      // DOMContentLoaded, but we await any deferred microtasks too.
      await page.waitForTimeout(50);
      await assertCleanAxe(page, `index.html${hash}`);
    });
  }

  test('editor.html — zero blocking violations', async ({ page }) => {
    muteExpectedConsole(page);
    await page.goto(fileUrl('editor.html'), { waitUntil: 'networkidle' });
    await assertCleanAxe(page, 'editor.html');
  });

  // The next two tests require window.TE to be populated. Under
  // file:// the admin scripts are referenced via absolute paths
  // (`/js/common.js`) which the browser can't resolve — so we gate
  // those scenarios on DEV_STACK_RUNNING=1, which the developer sets
  // when `npm run dev:all` is up. CI runs against the static surface
  // only; the live-server scenario is documented in CONTRIBUTING.md.
  const stackUp = process.env.DEV_STACK_RUNNING === 'true' || process.env.DEV_STACK_RUNNING === '1';
  const liveAdminUrl = process.env.ADMIN_ORIGIN || 'http://127.0.0.1:3000';

  test.describe('with live admin (DEV_STACK_RUNNING=1)', () => {
    test.skip(
      !stackUp,
      'Set DEV_STACK_RUNNING=1 (and ADMIN_ORIGIN if not the default) to run these.',
    );

    test('index.html with Cmd+K palette open — zero blocking violations', async ({ page }) => {
      muteExpectedConsole(page);
      await loginDevAdmin(page, liveAdminUrl);
      await page.goto(`${liveAdminUrl}/index.html`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => Boolean(/** @type {any} */ (window).TE));
      await page.evaluate(() => /** @type {any} */ (window).TE.__test.openPalette());
      await expect(page.locator('#cmdk')).toBeVisible();
      await assertCleanAxe(page, 'index.html (Cmd+K open)');
      await page.evaluate(() => /** @type {any} */ (window).TE.__test.closePalette());
    });

    test('index.html with New Post modal open — zero blocking violations', async ({ page }) => {
      muteExpectedConsole(page);
      await loginDevAdmin(page, liveAdminUrl);
      await page.goto(`${liveAdminUrl}/index.html`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => Boolean(/** @type {any} */ (window).TE));
      await page.evaluate(() => /** @type {any} */ (window).TE.openModal('template-modal'));
      await expect(page.locator('#template-modal')).not.toHaveAttribute('aria-hidden', 'true');
      await assertCleanAxe(page, 'index.html (template modal)');
    });
  });
});
