#!/usr/bin/env node
// @ts-check
/**
 * generate-og-image.mjs — render the default social-share card.
 *
 * BaseLayout.astro falls back to /og-image.png for every page without a
 * cover image (home, blog listing, posts without covers), so the file
 * must exist in site/public/. This script renders it from the brand
 * pieces: sky-blue field, the globe mark, and the VT323 wordmark with
 * the site's hard pixel shadow.
 *
 * The PNG is committed — rerun this only when the brand changes:
 *
 *   node scripts/generate-og-image.mjs   (cwd: site/)
 *
 * Text renders through fontconfig, so VT323 must be installed locally
 * (e.g. ~/.fonts/VT323-Regular.ttf from google/fonts); otherwise the
 * wordmark silently falls back to a generic monospace.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = resolve(HERE, '..', 'public');

const W = 1200;
const H = 630;

// Palette — keep in lockstep with src/styles/tokens.css.
const SKY = '#1e68f0';
const INK = '#0e2960';
const PAPER = '#ffffff';

// Hard two-layer text = the site's `text-shadow: 4px 4px 0 var(--ink)`
// pixel look. SVG has no text-shadow, so draw the shadow as its own text.
const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="${SKY}"/>
  <g font-family="VT323" text-anchor="middle">
    <text x="${W / 2 + 6}" y="398" font-size="150" fill="${INK}">WEB WORLD WIDE</text>
    <text x="${W / 2}" y="392" font-size="150" fill="${PAPER}">WEB WORLD WIDE</text>
    <text x="${W / 2}" y="494" font-size="44" fill="${PAPER}" opacity="0.92">webworldwide.online</text>
  </g>
</svg>`;

// Globe mark, centered above the wordmark.
const GLOBE_SIZE = 170;
const globe = await sharp(resolve(PUB, 'assets', 'globe.png'))
  .resize(GLOBE_SIZE, GLOBE_SIZE)
  .png()
  .toBuffer();

const out = resolve(PUB, 'og-image.png');
await sharp(Buffer.from(svg))
  .composite([{ input: globe, left: Math.round((W - GLOBE_SIZE) / 2), top: 98 }])
  .png({ compressionLevel: 9, palette: true })
  .toFile(out);

const meta = await sharp(out).metadata();
console.log(`[generate-og-image] wrote ${out} (${meta.width}x${meta.height})`);
