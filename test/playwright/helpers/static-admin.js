// @ts-check
/**
 * static-admin.js — serve admin/public over a real http origin for
 * Playwright.
 *
 * Under file:// the admin's absolute asset paths (/js/*, /css/*) can't
 * resolve, so none of the SPA's JavaScript ever runs and specs can only
 * assert static markup. This tiny static server gives the suite a real
 * origin with zero backend: /api/* and /auth/* return 503 JSON, which
 * the frontend handles as "backend offline" (every view degrades).
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.md': 'text/markdown',
};

/**
 * Start the server. Resolves with `{ url, close }`.
 * @param {string} publicDir absolute path to admin/public
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startStaticAdmin(publicDir) {
  const server = createServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0];
    // Fake the session so auth.js doesn't bounce pages around — the
    // suite tests the shell, not auth. Requests coming FROM login.html
    // get an unauthenticated answer (else auth.js would redirect the
    // login page to /index.html); everywhere else is authenticated.
    if (path === '/auth/status') {
      const fromLogin = (req.headers.referer || '').includes('login.html');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ setupComplete: true, authenticated: !fromLogin, hasPasskey: false }),
      );
      return;
    }
    if (path.startsWith('/api/') || path.startsWith('/auth/')) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'backend offline (static test server)' }));
      return;
    }
    const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    const file = normalize(join(publicDir, rel));
    if (!file.startsWith(publicDir)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
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
