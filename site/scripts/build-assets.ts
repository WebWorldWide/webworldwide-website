/** Compile browser-only TypeScript assets that Astro copies from public/. */
import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [resolve(siteRoot, 'src/sw.ts')],
  outfile: resolve(siteRoot, 'public/sw.js'),
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
  logLevel: 'info',
});
