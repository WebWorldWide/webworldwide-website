// @ts-nocheck
/**
 * Phase 10 — Color-token contrast verification.
 *
 * Walks the documented design tokens in:
 *   - site/assets/css/screen.css   (public site, dark + light themes)
 *   - admin/public/css/admin.css   (admin SPA, dark + light + status tokens)
 *
 * For every foreground/background pair we ship to users — body copy,
 * dimmed labels, muted captions, accent text, status indicators, etc. —
 * compute the WCAG 2.x luminance ratio and assert:
 *
 *   - body / link text:  >= 4.5 : 1   (AA normal)
 *   - large headings:    >= 3.0 : 1   (AA large)
 *   - UI components:     >= 3.0 : 1   (1.4.11 non-text contrast)
 *
 * A single failure here means a token regression has slipped past axe.
 * If you're intentionally relaxing a token, update the table below
 * with a comment explaining why.
 */
import { describe, expect, it } from 'vitest';

/**
 * Parse a CSS hex color (#rgb / #rrggbb) into an [r, g, b] tuple of
 * 0-255 ints.
 * @param hex
 */
function hexToRgb(hex) {
  let h = String(hex || '').trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) {
    throw new Error(`Bad hex: ${hex}`);
  }
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * WCAG 2 relative luminance for a sRGB channel value 0–255.
 * @param c
 */
function channelLum(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channelLum(r) + 0.7152 * channelLum(g) + 0.0722 * channelLum(b);
}

/**
 * WCAG 2.x contrast ratio between two hex colors. Returns a number in [1, 21].
 * @param fg
 * @param bg
 */
function contrastRatio(fg, bg) {
  const Lf = relativeLuminance(fg);
  const Lb = relativeLuminance(bg);
  const lighter = Math.max(Lf, Lb);
  const darker = Math.min(Lf, Lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// ────────────────────────────────────────────────────────────────
// Public site tokens (mirrors site/assets/css/screen.css §1 TOKENS)
// ────────────────────────────────────────────────────────────────
const PUBLIC_DARK = {
  bg: '#07090a',
  bgElev: '#0e1214',
  bgCard: '#0b0f11',
  fg: '#eff1ed',
  fgDim: '#9ca29f',
  fgMute: '#8a9491',
  accent: '#3dff7f',
  accentOn: '#001a0a',
  line: '#1e2528',
  lineStrong: '#2e363a',
};

const PUBLIC_LIGHT = {
  bg: '#f3f4f1',
  bgElev: '#fbfbf7',
  bgCard: '#ffffff',
  fg: '#0a0c09',
  fgDim: '#3f423d',
  fgMute: '#5f6359',
  accent: '#048037',
  accentOn: '#ffffff',
  line: '#dde0d9',
  lineStrong: '#b5bab1',
};

// ────────────────────────────────────────────────────────────────
// Admin tokens (mirrors admin/public/css/admin.css §1 TOKENS)
// Public tokens above are the same values; admin adds status tokens.
// ────────────────────────────────────────────────────────────────
const ADMIN_DARK_STATUS = {
  bg: '#07090a',
  warn: '#ffd166', // expect >= 4.5 on dark
  danger: '#ff6b6b', // expect >= 4.5 on dark
};

const ADMIN_LIGHT_STATUS = {
  bg: '#f3f4f1',
  warn: '#8c5a0a',
  danger: '#b83434',
};

/**
 * Each pair documents a foreground used by a real surface against the
 * background it sits on. `min` is the floor — AA normal text is 4.5,
 * AA large / UI is 3. If a real surface uses a token combination that
 * isn't in this table, add it (otherwise the next regression will slip).
 */
const PAIRS = [
  // ── Public site / DARK ──────────────────────────────────────
  { name: 'public dark · fg on bg (body text)', fg: PUBLIC_DARK.fg, bg: PUBLIC_DARK.bg, min: 4.5 },
  { name: 'public dark · fg on bg-elev', fg: PUBLIC_DARK.fg, bg: PUBLIC_DARK.bgElev, min: 4.5 },
  { name: 'public dark · fg-dim on bg', fg: PUBLIC_DARK.fgDim, bg: PUBLIC_DARK.bg, min: 4.5 },
  { name: 'public dark · fg-mute on bg', fg: PUBLIC_DARK.fgMute, bg: PUBLIC_DARK.bg, min: 4.5 },
  // accent text is used at >=11px font-size, so still must clear 4.5 for AA.
  { name: 'public dark · accent on bg', fg: PUBLIC_DARK.accent, bg: PUBLIC_DARK.bg, min: 4.5 },
  {
    name: 'public dark · accent on bg-elev',
    fg: PUBLIC_DARK.accent,
    bg: PUBLIC_DARK.bgElev,
    min: 4.5,
  },
  // .feat .tag-chip-active background fills with --accent and text uses --accent-on
  {
    name: 'public dark · accent-on on accent (chips, tags)',
    fg: PUBLIC_DARK.accentOn,
    bg: PUBLIC_DARK.accent,
    min: 4.5,
  },
  // --line-strong is decorative-only (hover borders, dashed dividers).
  // WCAG 1.4.11 excludes purely decorative elements, but we still want a
  // 1.5:1 baseline so the line is visible at all. If you wire --line-strong
  // into a state-bearing UI component (input border, toggle outline,
  // pressed state), promote this to >= 3:1.
  {
    name: 'public dark · line-strong vs bg (decorative)',
    fg: PUBLIC_DARK.lineStrong,
    bg: PUBLIC_DARK.bg,
    min: 1.4,
  },

  // ── Public site / LIGHT ─────────────────────────────────────
  { name: 'public light · fg on bg', fg: PUBLIC_LIGHT.fg, bg: PUBLIC_LIGHT.bg, min: 4.5 },
  { name: 'public light · fg on bg-elev', fg: PUBLIC_LIGHT.fg, bg: PUBLIC_LIGHT.bgElev, min: 4.5 },
  { name: 'public light · fg-dim on bg', fg: PUBLIC_LIGHT.fgDim, bg: PUBLIC_LIGHT.bg, min: 4.5 },
  { name: 'public light · fg-mute on bg', fg: PUBLIC_LIGHT.fgMute, bg: PUBLIC_LIGHT.bg, min: 4.5 },
  { name: 'public light · accent on bg', fg: PUBLIC_LIGHT.accent, bg: PUBLIC_LIGHT.bg, min: 4.5 },
  {
    name: 'public light · accent on bg-elev',
    fg: PUBLIC_LIGHT.accent,
    bg: PUBLIC_LIGHT.bgElev,
    min: 4.5,
  },
  {
    name: 'public light · accent-on on accent (chips, tags)',
    fg: PUBLIC_LIGHT.accentOn,
    bg: PUBLIC_LIGHT.accent,
    min: 4.5,
  },
  // Decorative-only — see comment above.
  {
    name: 'public light · line-strong vs bg (decorative)',
    fg: PUBLIC_LIGHT.lineStrong,
    bg: PUBLIC_LIGHT.bg,
    min: 1.4,
  },

  // ── Admin status colors ─────────────────────────────────────
  {
    name: 'admin dark · warn on bg',
    fg: ADMIN_DARK_STATUS.warn,
    bg: ADMIN_DARK_STATUS.bg,
    min: 4.5,
  },
  {
    name: 'admin dark · danger on bg',
    fg: ADMIN_DARK_STATUS.danger,
    bg: ADMIN_DARK_STATUS.bg,
    min: 4.5,
  },
  {
    name: 'admin light · warn on bg',
    fg: ADMIN_LIGHT_STATUS.warn,
    bg: ADMIN_LIGHT_STATUS.bg,
    min: 4.5,
  },
  {
    name: 'admin light · danger on bg',
    fg: ADMIN_LIGHT_STATUS.danger,
    bg: ADMIN_LIGHT_STATUS.bg,
    min: 4.5,
  },
];

describe('design token contrast ratios', () => {
  for (const { name, fg, bg, min } of PAIRS) {
    it(`${name} >= ${min}:1`, () => {
      const ratio = contrastRatio(fg, bg);
      // Round to 2 decimals for stable assertion messages, but compare full.
      const display = Math.round(ratio * 100) / 100;
      expect(
        ratio,
        `Token pair "${name}" measured ${display}:1, needs >= ${min}:1. ` +
          `If you changed the foreground token, update site/assets/css/screen.css ` +
          `or admin/public/css/admin.css — and the corresponding entry here. ` +
          `Bumping the floor here without the CSS fix is a regression.`,
      ).toBeGreaterThanOrEqual(min);
    });
  }
});

describe('contrastRatio helper', () => {
  it('returns 21 for pure black on pure white', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 1);
  });

  it('returns 1 for identical colors', () => {
    expect(contrastRatio('#3dff7f', '#3dff7f')).toBeCloseTo(1, 2);
  });

  it('throws on bad hex input', () => {
    expect(() => contrastRatio('nope', '#000')).toThrow();
  });
});
