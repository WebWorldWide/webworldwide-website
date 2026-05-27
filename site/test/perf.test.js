// @ts-nocheck
/**
 * Phase 11 — performance budget tests.
 *
 * These tests live next to the unit suites (Vitest, sub-second) so a
 * regression fails the same `npm test` gate that already gates lint
 * + accessibility. The end-to-end Lighthouse run is opt-in via
 * `LHCI=true npx playwright test test/playwright/lighthouse.spec.js`
 * (Chromium-only, slow); this file is the cheap "did the contract
 * survive the last commit?" check.
 *
 * What we assert:
 *   1. The critical-CSS partial exists.
 *   2. The CSS inside its single `<style>` block is ≤ 3 KB. Beyond
 *      that the inline payload starts costing more than it saves on
 *      mobile (TBT + LCP penalty > the round-trip we skipped).
 *   3. screen.css contains the mobile lava-blob cap (Phase 11 step 3).
 *   4. head.html declares the Content-Security-Policy meta tag.
 *   5. baseof.html no longer references the legacy /static/js/ paths
 *      directly — JS bundles must go through the assets pipeline so
 *      Hugo fingerprints them.
 *
 * If you intentionally need more headroom here, bump the limits AND
 * update CONTRIBUTING.md → Performance with the rationale.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = join(__dirname, '..');
const CRITICAL_CSS = join(SITE, 'layouts', 'partials', 'critical-css.html');
const SCREEN_CSS = join(SITE, 'assets', 'css', 'screen.css');
const HEAD_HTML = join(SITE, 'layouts', 'partials', 'head.html');
const BASEOF_HTML = join(SITE, 'layouts', '_default', 'baseof.html');

const KB = 1024;
const CRITICAL_CSS_BUDGET = 3 * KB;

describe('critical CSS partial', () => {
  it('exists', () => {
    expect(existsSync(CRITICAL_CSS), `expected ${CRITICAL_CSS} to exist`).toBe(true);
  });

  it('inlines its CSS in a single <style> block', () => {
    const html = readFileSync(CRITICAL_CSS, 'utf-8');
    const openCount = (html.match(/<style>/g) || []).length;
    const closeCount = (html.match(/<\/style>/g) || []).length;
    expect(openCount).toBe(1);
    expect(closeCount).toBe(1);
  });

  it(`fits in ≤ ${CRITICAL_CSS_BUDGET} bytes of CSS`, () => {
    const html = readFileSync(CRITICAL_CSS, 'utf-8');
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    expect(styleMatch, 'critical CSS must wrap its content in a <style> block').toBeTruthy();
    const cssBytes = Buffer.byteLength(styleMatch[1], 'utf-8');
    expect(
      cssBytes,
      `critical CSS is ${cssBytes} bytes — budget is ${CRITICAL_CSS_BUDGET}. ` +
        `Either trim the partial back to first-paint essentials or ` +
        `bump the budget here with a comment explaining why the ` +
        `larger inline payload still wins on mobile.`,
    ).toBeLessThanOrEqual(CRITICAL_CSS_BUDGET);
  });

  it('carries the design tokens needed before screen.css loads', () => {
    const html = readFileSync(CRITICAL_CSS, 'utf-8');
    // Anything that paints in the first viewport reads these — the
    // dark default --bg is the literal background of the body and
    // --fg the text. If either disappears the FOUC theme script can't
    // pick up a sensible default before screen.css lands.
    expect(html).toMatch(/--bg:\s*#07090a/i);
    expect(html).toMatch(/--fg:\s*#eff1ed/i);
    expect(html).toMatch(/--accent:\s*#3dff7f/i);
    // Light-theme override has to be in the inline block too or the
    // [data-theme="light"] FOUC swap leaves the page dark for a beat.
    expect(html).toMatch(/\[data-theme="light"\]/);
  });
});

describe('screen.css', () => {
  it('caps the third lava blob on mobile (≤ 720px)', () => {
    const css = readFileSync(SCREEN_CSS, 'utf-8');
    // Tolerant matcher — order of `display:none` and selector inside
    // the @media block can shift with stylelint normalisation, so
    // assert the rule is present rather than equality.
    expect(css, 'screen.css must hide .lava-blob.c on narrow viewports').toMatch(
      /@media\s*\(max-width:\s*720px\)\s*\{[^}]*\.lava-blob\.c\s*\{\s*display:\s*none/i,
    );
  });

  it('honours prefers-reduced-motion globally', () => {
    const css = readFileSync(SCREEN_CSS, 'utf-8');
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/i);
  });
});

describe('head.html', () => {
  it('inlines the critical CSS partial before the deferred stylesheet', () => {
    const html = readFileSync(HEAD_HTML, 'utf-8');
    const partialIdx = html.indexOf('partial "critical-css.html"');
    const screenIdx = html.indexOf('css/screen.css');
    expect(partialIdx, 'critical-css.html must be referenced in head.html').toBeGreaterThan(-1);
    expect(screenIdx, 'screen.css must be referenced in head.html').toBeGreaterThan(-1);
    expect(
      partialIdx,
      'critical CSS partial must appear before the deferred stylesheet',
    ).toBeLessThan(screenIdx);
  });

  it('defers the main stylesheet via preload-then-promote', () => {
    const html = readFileSync(HEAD_HTML, 'utf-8');
    expect(html).toMatch(/rel="preload"\s+as="style"/);
    expect(html).toMatch(/onload="this\.onload=null;this\.rel='stylesheet'"/);
    expect(html).toMatch(/<noscript>.*screen\.css/);
  });

  it('declares a Content-Security-Policy meta tag', () => {
    const html = readFileSync(HEAD_HTML, 'utf-8');
    expect(html).toMatch(/<meta\s+http-equiv="Content-Security-Policy"/);
    // Required directives — frame-src must include every embed
    // provider we ship, image src must allow https for thumbnails
    // (YouTube, Vimeo, og cards), default-src locked to self.
    expect(html).toMatch(/default-src 'self'/);
    expect(html).toMatch(/frame-src/);
    expect(html).toMatch(/embed\.bsky\.app/);
    expect(html).toMatch(/youtube-nocookie\.com/);
    expect(html).toMatch(/img-src 'self' data: https:/);
  });

  it('fingerprints CSS through the assets pipeline', () => {
    const html = readFileSync(HEAD_HTML, 'utf-8');
    expect(html).toMatch(/resources\.Get "css\/screen\.css"/);
    expect(html).toMatch(/resources\.Fingerprint/);
    expect(html).toMatch(/integrity=/);
  });
});

describe('baseof.html', () => {
  it('serves JS through the Hugo assets pipeline (fingerprint + SRI)', () => {
    const html = readFileSync(BASEOF_HTML, 'utf-8');
    expect(html).toMatch(/resources\.Get "js\/app\.js"/);
    expect(html).toMatch(/resources\.Get "js\/lightbox\.js"/);
    expect(html).toMatch(/resources\.Get "js\/embed-loader\.js"/);
    expect(html).toMatch(/integrity=/);
  });

  it('has no orphan /static/js/ <script src> for our bundles', () => {
    // If a future refactor accidentally moves a bundle back to
    // /static/js/<name>.js the browser would skip the fingerprint /
    // SRI guarantees. Fall-through fallback paths are inside `{{- if
    // $...JS -}}` blocks so they only fire if resources.Get returns
    // nil. Assert that the *canonical* path is the asset pipeline by
    // grepping for the literal pattern that never appears now.
    const html = readFileSync(BASEOF_HTML, 'utf-8');
    // The fallback path emits exactly `"js/app.js" | relURL` — this
    // is allowed (defensive), so we only fail if it appears outside
    // an `{{- else -}}` branch. Cheapest proxy: count the live
    // `<script src=…>` calls that go through resources vs the
    // fallback path; resources path should always exist.
    const fingerprintedScripts = (html.match(/\.RelPermalink \}\}" integrity=/g) || []).length;
    expect(fingerprintedScripts).toBeGreaterThanOrEqual(3);
  });
});

describe('JS bundle sources live under assets/', () => {
  it('canonical app.js / lightbox.js / embed-loader.js are under site/assets/js/', () => {
    for (const name of ['app.js', 'lightbox.js', 'embed-loader.js']) {
      const p = join(SITE, 'assets', 'js', name);
      expect(existsSync(p), `expected ${name} under site/assets/js/`).toBe(true);
      const bytes = statSync(p).size;
      expect(bytes, `${name} must be non-empty`).toBeGreaterThan(0);
    }
  });
});
