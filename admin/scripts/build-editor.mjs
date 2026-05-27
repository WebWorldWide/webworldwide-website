// @ts-check
/**
 * build-editor.mjs — esbuild config for the admin TipTap + CodeMirror bundle.
 *
 * Phase 3a: bundles admin/public/js/editor.entry.js into
 *   admin/public/js/editor.bundle.js (IIFE, ES2020, sourcemap external).
 *
 * Usage:
 *   node scripts/build-editor.mjs            # one-shot build
 *   node scripts/build-editor.mjs --watch    # rebuild on change
 *   NODE_ENV=production node scripts/...     # minified output
 *
 * The bundle attaches to window.TEEditor; admin/public/js/editor.js then
 * lifts that into window.TE.editor so consumers use the documented
 * `window.TE.editor.mount(...)` surface.
 *
 * The output is committed (alongside admin/node_modules) so the Pi can
 * deploy via plain `git clone` without running esbuild.
 */
import { build, context } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const isProd = process.env.NODE_ENV === 'production';

/** @type {import('esbuild').BuildOptions} */
const opts = {
  entryPoints: [resolve(ROOT, 'public/js/editor.entry.js')],
  outfile: resolve(ROOT, 'public/js/editor.bundle.js'),
  bundle: true,
  format: 'iife',
  globalName: 'TEEditor',
  target: 'es2020',
  sourcemap: 'external',
  minify: isProd,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(isProd ? 'production' : 'development'),
  },
};

if (process.argv.includes('--watch')) {
  const ctx = await context(opts);
  await ctx.watch();
  // Keep the process alive; esbuild's watcher logs rebuilds itself.
  process.stdout.write('[build-editor] watching for changes…\n');
} else {
  const result = await build(opts);
  if (result.errors?.length) {
    process.exitCode = 1;
  }
}
