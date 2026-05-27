// @ts-check
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'http://localhost/',
        pretendToBeVisual: true,
      },
    },
    globals: false,
    setupFiles: ['site/test/setup.js'],
    include: [
      'site/test/**/*.{test,spec}.js',
      // Phase 2: admin frontend Vitest tests. The node:test runner
      // under admin/test/auth.test.js stays the place for integration
      // tests that talk to SQLite; admin frontend modules use the
      // `*.vitest.test.js` suffix to keep the boundary explicit.
      'admin/test/**/*.vitest.{test,spec}.js',
      // Phase 5d: dev-experience scripts (seed/reset/check). These
      // touch real SQLite and the local filesystem, so they live under
      // scripts/dev/__tests__/ rather than admin/test/.
      'scripts/dev/__tests__/**/*.test.js',
    ],
    exclude: [
      'node_modules/**',
      '**/node_modules/**',
      'test/playwright/**',
      // node:test runner handles this one (admin/package.json scripts).
      'admin/test/auth.test.js',
      'Blog/**',
      'site/public/**',
      'site/test/setup.js',
    ],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Phase 11: JS bundles moved from site/static/js/ → site/assets/js/
      // so Hugo can fingerprint + SRI them. Coverage still covers both
      // paths (admin keeps its own static path; nothing should remain
      // under site/static/js/ but we leave the entry in case a future
      // ESM-only asset goes there).
      include: ['site/assets/js/**/*.js', 'site/static/js/**/*.js', 'admin/public/js/**/*.js'],
      exclude: ['site/assets/js/**/*.test.js', 'site/static/js/**/*.test.js'],
    },
  },
});
