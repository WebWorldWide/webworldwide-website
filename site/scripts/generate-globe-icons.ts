/**
 * generate-globe-icons.ts — render the favicons and app icons from the same
 * pixel globe the nav and hero draw (src/lib/pixel-globe.ts), turned to the
 * Americas like the original logo artwork.
 *
 * The PNGs are committed — rerun when the globe or world map changes:
 *
 *   npx tsx scripts/generate-globe-icons.ts   (cwd: site/)
 *
 * then `npx tsx scripts/generate-og-image.ts` for the social card, which
 * uses public/assets/globe.png.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { globeIcon, type IconOpts } from '../src/lib/pixel-globe.ts';

const PUB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// The logo view: both Americas face you, North America tipped slightly
// toward the viewer. These static files are the fallback; in the browser,
// scripts/local-favicon.ts turns the favicon to the visitor's side of the
// world.
const VIEW_LAT = 12;
const START_LON = -75;

type Icon = IconOpts & { file: string };

const ICONS: Icon[] = [
  { file: 'favicon-32.png', size: 32, pixels: 16 },
  { file: 'favicon-48.png', size: 48, pixels: 24 },
  { file: 'favicon.png', size: 256, pixels: 32 },
  { file: 'apple-touch-icon.png', size: 180, pixels: 32, scale: 0.84, background: [255, 255, 255] },
  { file: 'icons/icon-192.png', size: 192, pixels: 32 },
  { file: 'icons/icon-512.png', size: 512, pixels: 48 },
  { file: 'assets/globe.png', size: 1000, pixels: 64 },
  // The CMS favicon + brand mark (also the homepage preview's nav globe).
  { file: '../../admin/public/logo.png', size: 512, pixels: 32 },
];

async function render(icon: Icon): Promise<Buffer> {
  const { size: S, pixels: n } = icon;
  const out = globeIcon(icon, START_LON, VIEW_LAT);
  const png = await sharp(out, { raw: { width: S, height: S, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const file = resolve(PUB, icon.file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png);
  console.log(`[generate-globe-icons] ${icon.file} (${S}px, ${n} globe px)`);
  return png;
}

const pngs = new Map<string, Buffer>();
for (const icon of ICONS) pngs.set(icon.file, await render(icon));

/**
 * favicon.ico — browsers, crawlers and RSS readers request /favicon.ico
 * whatever the page links. 16 / 32 / 48 px, each a PNG inside the ICO
 * container (supported by every browser since IE).
 */
const ico16 = await render({ file: '.ico-16.tmp.png', size: 16, pixels: 16 });
const entries: Array<[number, Buffer]> = [
  [16, ico16],
  [32, pngs.get('favicon-32.png')!],
  [48, pngs.get('favicon-48.png')!],
];
const header = Buffer.alloc(6 + 16 * entries.length);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach(([size, png], i) => {
  const o = 6 + i * 16;
  header.writeUInt8(size, o); // width
  header.writeUInt8(size, o + 1); // height
  header.writeUInt8(0, o + 2); // palette colours
  header.writeUInt8(0, o + 3); // reserved
  header.writeUInt16LE(1, o + 4); // colour planes
  header.writeUInt16LE(32, o + 6); // bits per pixel
  header.writeUInt32LE(png.length, o + 8);
  header.writeUInt32LE(offset, o + 12);
  offset += png.length;
});
writeFileSync(resolve(PUB, 'favicon.ico'), Buffer.concat([header, ...entries.map(([, p]) => p)]));
rmSync(resolve(PUB, '.ico-16.tmp.png'));
console.log('[generate-globe-icons] favicon.ico (16/32/48)');
