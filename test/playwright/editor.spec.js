// @ts-check
/**
 * Editor polish smoke tests — toolbar legibility + image alignment.
 *
 * Like admin.spec.js, this runs against the in-suite static server
 * (helpers/static-admin.js) so the TipTap bundle genuinely mounts: /api
 * and /auth answer 503, which every view degrades from. We assert the
 * rich toolbar renders legible controls (bigger hit areas, real SVG
 * icons) and that the contextual image-alignment group exists, plus the
 * right-rail side-panel count stays at 8.
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startStaticAdmin } from './helpers/static-admin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', '..', 'admin', 'public');

/** @type {{ url: string, close: () => Promise<void> }} */
let staticAdmin;
let editorUrl = '';

test.beforeAll(async () => {
  staticAdmin = await startStaticAdmin(PUBLIC_DIR);
  editorUrl = `${staticAdmin.url}/editor.html`;
});
test.afterAll(async () => {
  if (staticAdmin) await staticAdmin.close();
});

/**
 * Fail on unexpected console.error; ignore predictable backend-offline
 * noise (the static server answers /api|/auth with 503).
 * @param {import('@playwright/test').Page} page
 * @returns {string[]}
 */
function collectFatalConsoleErrors(page) {
  /** @type {string[]} */
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/fetch|XMLHttpRequest|net::ERR/i.test(text)) return;
    if (/503|Service Unavailable|backend offline/i.test(text)) return;
    if (/Failed to load (posts|resource)/i.test(text)) return;
    if (/Not authenticated/.test(text)) return;
    errors.push(text);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

test.describe('editor polish', () => {
  test('mounts the WYSIWYG surface and keeps 8 side panels', async ({ page }) => {
    const errors = collectFatalConsoleErrors(page);
    await page.goto(editorUrl);
    await expect(page.locator('#editor-root .ProseMirror')).toBeVisible();
    await expect(page.locator('#editor-fallback')).toBeHidden();
    // Right-rail frontmatter panels (Frontmatter, Schedule, Cover, Custom
    // CSS/JS, Draft preview, SEO, Media, Publish).
    await expect(page.locator('.ed-side details')).toHaveCount(8);
    expect(errors).toEqual([]);
  });

  test('renders a legible rich toolbar with real SVG icons', async ({ page }) => {
    await page.goto(editorUrl);
    const toolbar = page.locator('.te-editor-toolbar-rich');
    await expect(toolbar).toBeVisible();

    const buttons = toolbar.locator('button.te-tb-btn');
    expect(await buttons.count()).toBeGreaterThan(12);

    // Legibility: each control has a ~36px hit area (we set height:36px).
    const box = await page.locator('.te-tb-btn.te-tb-link').boundingBox();
    expect(box).not.toBeNull();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);

    // Cryptic glyphs were replaced with inline SVG icons.
    await expect(page.locator('.te-tb-link svg')).toBeVisible();
    await expect(page.locator('.te-tb-clear svg')).toHaveCount(1);
  });

  test('ships a contextual image options group', async ({ page }) => {
    await page.goto(editorUrl);
    const group = page.locator('.te-tb-image-group');
    await expect(group).toHaveCount(1);

    // Five alignment controls — left / center / right / full / reset — each a
    // real SVG-icon button.
    const alignButtons = group.locator('button.te-tb-img-align');
    await expect(alignButtons).toHaveCount(5);
    expect(await alignButtons.locator('svg').count()).toBe(5);
    for (const label of ['Center image', 'Full-width image', 'Reset image alignment']) {
      await expect(group.locator(`button[aria-label="${label}"]`)).toHaveCount(1);
    }

    // …plus the caption + alt-text editors: seven image controls in all.
    await expect(group.locator('button.te-tb-img-caption')).toHaveCount(1);
    await expect(group.locator('button.te-tb-img-alt')).toHaveCount(1);
    await expect(group.locator('button.te-tb-btn')).toHaveCount(7);

    // Hidden until an image node is selected (matches the table/code groups).
    await expect(group).toHaveClass(/is-hidden/);
  });

  test('hides every contextual divider when its group is hidden', async ({ page }) => {
    await page.goto(editorUrl);
    // Each contextual group (code/table/image/video) is preceded by its own
    // leading divider. With nothing selected the group is hidden — and its
    // divider must hide too, otherwise it renders as a stray "|" bar in the
    // toolbar (the "| |" regression this guards against).
    for (const cls of [
      'te-tb-code-group',
      'te-tb-table-group',
      'te-tb-image-group',
      'te-tb-video-group',
    ]) {
      const group = page.locator(`.${cls}`);
      await expect(group).toHaveClass(/is-hidden/);
      // The element immediately before the group is its leading divider.
      const divider = group.locator('xpath=preceding-sibling::*[1]');
      await expect(divider).toHaveClass(/te-tb-divider/);
      await expect(divider).toHaveClass(/is-hidden/);
    }
  });
});
