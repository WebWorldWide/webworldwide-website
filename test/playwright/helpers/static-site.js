// @ts-check
/**
 * static-site.js — serve the built site (site/dist) over a real http
 * origin for Playwright.
 *
 * The Lighthouse budget spec audits the production build (same artifact
 * the canonical `npm run test:lighthouse` LHCI gate serves from
 * `staticDistDir`), not the Astro dev server — dev output is unminified
 * and unbundled, so perf scores there are meaningless.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Start the server. Resolves with `{ url, close }`.
 * @param {string} distDir absolute path to site/dist
 * @returns {Promise<{ url: string, close: () => Promise<void> }>} origin URL + shutdown
 */
export function startStaticSite(distDir) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url || '/').split('?')[0]);
    // Astro emits directory indexes: /blog/ -> blog/index.html.
    const rel = path.endsWith('/') ? join(path.slice(1), 'index.html') : path.replace(/^\/+/, '');
    const file = normalize(join(distDir, rel));
    if (!file.startsWith(distDir)) {
      res.writeHead(403).end();
      return;
    }
    try {
      let body = await readFile(file);
      const type = MIME[extname(file)] || 'application/octet-stream';
      const headers = {
        'Content-Type': type,
        'Cache-Control': 'public, max-age=600',
      };
      // GitHub Pages (prod host for the public site) compresses text;
      // mirror that so Lighthouse transfer sizes match production.
      const compressible = /^(text\/|application\/(javascript|json|xml))/.test(type);
      if (compressible && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        body = gzipSync(body);
        headers['Content-Encoding'] = 'gzip';
      }
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
      });
    });
  });
}
