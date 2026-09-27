// @ts-check
import { defineConfig } from 'vitest/config';

/**
 * Root Vitest config — runs tests OUTSIDE site/.
 *
 *   - admin frontend tests (.vitest.test.ts suffix to distinguish from
 *     node:test backend tests)
 *   - scripts/dev/ tests (seed/reset/check helpers)
 *
 * site/ has its own vitest config (site/vitest.config.ts) for Astro
 * components, React islands, and the content schema.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'http://localhost/', pretendToBeVisual: true },
    },
    globals: false,
    include: ['admin/test/**/*.vitest.{test,spec}.ts', 'scripts/dev/__tests__/**/*.test.ts'],
    exclude: [
      'node_modules/**',
      '**/node_modules/**',
      'test/playwright/**',
      'admin/test/auth.test.ts',
      'site/**',
      'Blog/**',
    ],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['admin/client/**/*.ts', 'admin/src/**/*.ts', 'scripts/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts'],
    },
  },
});
