/**
 * generate-globe-icons.ts — render the favicons and app icons from the same
 * pixel globe the nav and hero draw (src/lib/pixel-globe.ts), at rest
 * (the Atlantic facing you, like the page's first frame).
 *
 * The PNGs are committed — rerun when the globe or world map changes:
 *
 *   npx tsx scripts/generate-globe-icons.ts   (cwd: site/)
 *
 * then `npx tsx scripts/generate-og-image.ts` for the social card, which
 * uses public/assets/globe.png.
 */
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PALETTE, globeSampler } from '../src/lib/pixel-globe.ts';

const PUB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Same view as scripts/globe-nav.ts at rest.
const VIEW_LAT = 5;
const START_LON = -30;

type Icon = {
  file: string;
  size: number;
  /** Globe pixels across: fewer = chunkier, which reads better small. */
  pixels: number;
  /** Globe diameter as a share of the canvas. */
  scale?: number;
  /** Solid background (iOS fills transparency with black). */
  background?: readonly [number, number, number];
};

const ICONS: Icon[] = [
  { file: 'favicon-48.png', size: 48, pixels: 24 },
  { file: 'favicon.png', size: 256, pixels: 32 },
  { file: 'apple-touch-icon.png', size: 180, pixels: 32, scale: 0.84, background: [255, 255, 255] },
  { file: 'icons/icon-192.png', size: 192, pixels: 32 },
  { file: 'icons/icon-512.png', size: 512, pixels: 40 },
  { file: 'assets/globe.png', size: 1000, pixels: 48 },
  // The CMS favicon + brand mark (also the homepage preview's nav globe).
  { file: '../../admin/public/logo.png', size: 512, pixels: 32 },
];

/**
 * One icon: each output pixel takes the colour of the globe pixel it falls
 * in (hard pixel-art edges inside), and the disc's rim is anti-aliased from
 * 4×4 coverage samples so the circle itself is smooth.
 */
async function render(icon: Icon): Promise<void> {
  const { size: S, pixels: n } = icon;
  const D = S * (icon.scale ?? 1);
  const off = (S - D) / 2;
  const cls = globeSampler(n, VIEW_LAT)(START_LON);
  const out = new Uint8Array(S * S * 4);
  const R = D / 2;
  const c = off + R;
  const A = 4;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let cover = 0;
      for (let sy = 0; sy < A; sy++) {
        for (let sx = 0; sx < A; sx++) {
          const dx = x + (sx + 0.5) / A - c;
          const dy = y + (sy + 0.5) / A - c;
          if (dx * dx + dy * dy <= R * R) cover++;
        }
      }
      const a = cover / (A * A);
      const gi = Math.min(n - 1, Math.max(0, Math.floor(((x + 0.5 - off) / D) * n)));
      const gj = Math.min(n - 1, Math.max(0, Math.floor(((y + 0.5 - off) / D) * n)));
      const [r, g, b] = PALETTE[cls[gj * n + gi]];
      const o = (y * S + x) * 4;
      if (icon.background) {
        const [br, bg, bb] = icon.background;
        out[o] = Math.round(r * a + br * (1 - a));
        out[o + 1] = Math.round(g * a + bg * (1 - a));
        out[o + 2] = Math.round(b * a + bb * (1 - a));
        out[o + 3] = 255;
      } else {
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = Math.round(a * 255);
      }
    }
  }
  const file = resolve(PUB, icon.file);
  mkdirSync(dirname(file), { recursive: true });
  await sharp(out, { raw: { width: S, height: S, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(file);
  console.log(`[generate-globe-icons] ${icon.file} (${S}px, ${n} globe px)`);
}

for (const icon of ICONS) await render(icon);
