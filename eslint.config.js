// @ts-check
/**
 * ESLint 9 flat config for Terminal Eighty.
 *
 * Three lint surfaces:
 *   - admin/**\/*.js           Node 20 + ES modules ("type": "module" in admin)
 *   - site/assets/js/*.js     Browser, IIFE-wrapped (Phase 11: moved
 *                              from static/js/ so Hugo can fingerprint
 *                              + SRI through the resources pipeline).
 *                              site/static/js/ pattern remains so any
 *                              legacy file would still be linted.
 *   - migrate/**\/*.js         Node 20 CLI tooling
 *
 * Test files get vitest/node-test globals so describe/it/expect resolve.
 */

import js from '@eslint/js';
import promise from 'eslint-plugin-promise';
import security from 'eslint-plugin-security';
import n from 'eslint-plugin-n';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';

const sharedRules = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
  'no-undef': 'error',
  'prefer-const': 'error',
  eqeqeq: ['error', 'always'],
  'no-implicit-coercion': 'error',
  'security/detect-object-injection': 'warn',
};

export default [
  // Global ignores
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      'site/public/**',
      'site/resources/**',
      'admin/data/**',
      // admin/public/ lints below as a browser-IIFE block (Phase 2).
      // The bundled editor (Phase 3a) is generated; we lint its
      // source (admin/public/js/editor.entry.js) instead.
      'admin/public/js/editor.bundle.js',
      'admin/public/js/editor.bundle.js.map',
      'Blog/**',
      '.planning/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '.lighthouseci/**',
      'docker/**',
    ],
  },

  // Base recommended
  js.configs.recommended,
  promise.configs['flat/recommended'],
  jsdoc.configs['flat/recommended'],

  // Admin service worker — separate globals from browser frontend.
  {
    files: ['admin/public/sw.js'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { ...globals.serviceworker },
    },
    rules: {
      ...sharedRules,
      'promise/catch-or-return': 'off',
      'promise/always-return': 'off',
      'promise/no-nesting': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/tag-lines': 'off',
    },
  },

  // Admin browser frontend (Phase 2 — plain script IIFEs).
  // editor.entry.js is the Phase 3a bundle source and is *not* an
  // IIFE — esbuild consumes it as an ES module — so it gets its own
  // block below.
  {
    files: ['admin/public/js/**/*.js'],
    ignores: ['admin/public/js/editor.entry.js', 'admin/public/js/editor.bundle.js'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // CDN-loaded library; auth.js guards against `undefined`.
        SimpleWebAuthnBrowser: 'readonly',
        // common.js publishes to window.TE; other modules consume it.
        TE: 'readonly',
      },
    },
    rules: {
      ...sharedRules,
      // The /* global TE */ comment at the top of each module is the
      // canonical way to declare consumption. No further config needed.
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/tag-lines': 'off',
    },
  },

  // Phase 3a TipTap + CodeMirror bundle source. ES module input to
  // esbuild; bundled into editor.bundle.js (linted-out).
  {
    files: ['admin/public/js/editor.entry.js'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      ...sharedRules,
      'security/detect-object-injection': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-param': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/tag-lines': 'off',
      'jsdoc/no-multi-asterisks': 'off',
    },
  },

  // Admin (Node, ESM)
  {
    files: ['admin/**/*.js'],
    ignores: ['admin/public/**'],
    plugins: { security, n },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...sharedRules,
      'n/no-missing-import': 'off', // Node ESM + bare specifiers
      'n/no-unpublished-import': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/tag-lines': 'off',
    },
  },

  // Site browser JS (Phase 11: canonical path is site/assets/js/ —
  // the static/js/ glob is kept so a stale file in the legacy location
  // would still be linted, never silently shipped.)
  {
    files: ['site/assets/js/**/*.js', 'site/static/js/**/*.js'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: {
      ...sharedRules,
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/tag-lines': 'off',
    },
  },

  // Migrate CLI
  {
    files: ['migrate/**/*.js'],
    plugins: { security, n },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...sharedRules,
      'n/no-missing-import': 'off',
      'n/no-unpublished-import': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/tag-lines': 'off',
    },
  },

  // Root-level JS configs (eslint.config.js, vitest.config.js, playwright.config.js)
  {
    files: ['*.js'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...sharedRules,
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/tag-lines': 'off',
    },
  },

  // Phase 8.5 maintenance script — top-level Node ESM CLI under scripts/.
  // Picks up scripts/*.mjs only (no recursion into scripts/dev/).
  {
    files: ['scripts/*.mjs'],
    plugins: { security, n },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...sharedRules,
      'n/no-missing-import': 'off',
      'n/no-unpublished-import': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/tag-lines': 'off',
    },
  },

  // Phase 5d dev scripts — Node ESM CLI tools under scripts/dev/.
  // Test files in scripts/dev/__tests__/ are picked up by the Vitest
  // block below via the explicit pattern; this entry covers the
  // executable .mjs scripts and the shared _lib.mjs module.
  {
    files: ['scripts/dev/**/*.{js,mjs}'],
    ignores: ['scripts/dev/__tests__/**'],
    plugins: { security, n },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...sharedRules,
      'n/no-missing-import': 'off',
      'n/no-unpublished-import': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/tag-lines': 'off',
      'jsdoc/no-undefined-types': 'off',
    },
  },

  // Phase 5d dev-script Vitest tests.
  {
    files: ['scripts/dev/__tests__/**/*.{test,spec}.js'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...sharedRules,
      'security/detect-object-injection': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/tag-lines': 'off',
    },
  },

  // Tests — Vitest (site + admin frontend) + their setup helpers
  {
    files: ['site/test/**/*.js', 'admin/test/**/*.vitest.{test,spec}.js'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      ...sharedRules,
      'security/detect-object-injection': 'off',
      'promise/param-names': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/tag-lines': 'off',
    },
  },

  // Tests — Node built-in test runner (admin backend)
  {
    files: ['admin/test/**/*.test.js'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...sharedRules,
      'security/detect-object-injection': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/tag-lines': 'off',
    },
  },

  // Playwright tests
  {
    files: ['test/playwright/**/*.spec.js'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // Playwright callbacks that run inside page.evaluate execute in
      // the browser context, so we need browser globals (window,
      // document) alongside Node globals (process, etc.).
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...sharedRules,
      'security/detect-object-injection': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/tag-lines': 'off',
    },
  },
];
