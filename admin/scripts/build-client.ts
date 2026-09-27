/** Build every browser-delivered admin asset from TypeScript source. */
import { build, context, type BuildOptions } from 'esbuild';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const adminRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientRoot = resolve(adminRoot, 'client');
const publicRoot = resolve(adminRoot, 'public');
const jsOut = resolve(publicRoot, 'js');
const vendorOut = resolve(publicRoot, 'vendor');
const production = process.env.NODE_ENV === 'production';
const watch = process.argv.includes('--watch');

await rm(jsOut, { recursive: true, force: true });
await rm(vendorOut, { recursive: true, force: true });
await mkdir(jsOut, { recursive: true });

const clientEntries = (await readdir(clientRoot))
  .filter((name) => extname(name) === '.ts' && name !== 'editor.entry.ts')
  .map((name) => resolve(clientRoot, name));

const browserOptions: BuildOptions = {
  entryPoints: clientEntries,
  outdir: jsOut,
  outbase: clientRoot,
  bundle: false,
  format: 'iife',
  target: 'es2020',
  sourcemap: production ? false : 'external',
  minify: production,
  legalComments: 'none',
  logLevel: 'info',
};

const editorOptions: BuildOptions = {
  entryPoints: [resolve(clientRoot, 'editor.entry.ts')],
  outfile: resolve(jsOut, 'editor.bundle.js'),
  bundle: true,
  format: 'iife',
  globalName: 'TEEditor',
  target: 'es2020',
  sourcemap: production ? false : 'external',
  minify: production,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
  },
};

await Promise.all([
  cp(
    resolve(adminRoot, 'node_modules/katex/dist/katex.min.css'),
    resolve(vendorOut, 'katex/katex.min.css'),
    {
      recursive: true,
    },
  ),
  cp(
    resolve(adminRoot, 'node_modules/katex/dist/katex.min.js'),
    resolve(vendorOut, 'katex/katex.min.js'),
    {
      recursive: true,
    },
  ),
  cp(resolve(adminRoot, 'node_modules/katex/dist/fonts'), resolve(vendorOut, 'katex/fonts'), {
    recursive: true,
  }),
  cp(
    resolve(adminRoot, 'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js'),
    resolve(vendorOut, 'simplewebauthn-browser.umd.min.js'),
  ),
]);

if (watch) {
  const contexts = await Promise.all([context(browserOptions), context(editorOptions)]);
  await Promise.all(contexts.map((item) => item.watch()));
  process.stdout.write('[build-client] watching TypeScript browser sources\n');
  await new Promise(() => {});
} else {
  const results = await Promise.all([build(browserOptions), build(editorOptions)]);
  if (results.some((result) => result.errors.length > 0)) process.exitCode = 1;
  process.stdout.write(
    `[build-client] emitted ${clientEntries.length + 1} browser bundles from TypeScript\n`,
  );
}
