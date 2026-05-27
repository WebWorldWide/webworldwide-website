// @ts-check
/**
 * axe-core accessibility audit for the public site.
 *
 * Gate: zero serious/critical violations. Moderate/minor are reported
 * but don't fail the build (we want signal without churn on hue tweaks).
 *
 * Phase 10 expanded the page list to cover the homepage, the About
 * static page, a representative single post (`/bye-bye-dji/`), and a
 * tag-index page (`/tags/tech/`). Add a route here whenever a new
 * Hugo layout type goes live so axe sees the new surface.
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PAGES = ['/', '/about/', '/bye-bye-dji/', '/tags/tech/'];

for (const route of PAGES) {
  test(`a11y: ${route} has no serious/critical violations`, async ({ page }) => {
    await page.goto(route, { waitUntil: 'networkidle' });
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const blocking = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );

    if (blocking.length) {
      // Detailed report for the CI log
      console.error(`Accessibility violations on ${route}:`);
      for (const v of blocking) {
        console.error(`  [${v.impact}] ${v.id}: ${v.help}`);
        for (const node of v.nodes.slice(0, 3)) {
          console.error(`    target: ${node.target.join(' ')}`);
        }
      }
    }

    expect(blocking, `${route} should have no serious/critical a11y violations`).toEqual([]);
  });
}

// Phase 10: also re-scan with the Cmd+K palette open so an a11y
// regression in the search dialog doesn't slip past the baseline.
test('a11y: home with Cmd+K palette open — zero blocking violations', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.keyboard.press('Meta+K');
  await expect(page.locator('#cmdk')).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  if (blocking.length) {
    console.error('Cmd+K palette has violations:');
    for (const v of blocking) {
      console.error(`  [${v.impact}] ${v.id}: ${v.help}`);
      for (const node of v.nodes.slice(0, 3)) {
        console.error(`    target: ${node.target.join(' ')}`);
      }
    }
  }
  expect(blocking, 'Cmd+K palette should have no serious/critical a11y violations').toEqual([]);
});
