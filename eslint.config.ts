// @ts-check
/**
 * ESLint 9 flat config — root (admin / migrate / scripts).
 *
 * site/ has its own eslint.config.ts because it ships React + Astro,
 * which need eslint-plugin-astro + eslint-plugin-react + eslint-plugin-jsx-a11y
 * not relevant outside site/. Root lint stays focused on:
 *
 *   - admin/**\/*.ts           Node 22 + ES modules (admin and browser source)
 *   - migrate/**\/*.ts         Node 22 CLI tooling
 *   - scripts/**\/*.ts         Node 22 dev/maintenance scripts
 *   - test/playwright/**       Playwright e2e suites
 *
 * Test files get vitest/node-test globals so describe/it/expect resolve.
 */

import js from '@eslint/js';
import promise from 'eslint-plugin-promise';
import security from 'eslint-plugin-security';
import n from 'eslint-plugin-n';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const sharedRules = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
  'no-undef': 'error',
  'prefer-const': 'error',
  eqeqeq: ['error', 'always'],
  'no-implicit-coercion': 'error',
  'security/detect-object-injection': 'warn',
};

export default [
  // Global ignores. site/ is excluded because it has its own eslint config.
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      'site/**',
      'admin/data/**',
      'admin/uploads/**',
      // Browser output is generated from admin/client TypeScript.
      'admin/public/js/**',
      // Vendored third-party assets (self-hosted CDN replacements).
      'admin/public/vendor/**',
      'Blog/**',
      '.planning/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '.lighthouseci/**',
      'docker/**',
      '**/dist/**',
    ],
  },

  js.configs.recommended,
  promise.configs['flat/recommended'],
  jsdoc.configs['flat/recommended'],

  // Admin browser frontend (plain script IIFEs).
  {
    files: ['admin/client/**/*.ts'],
    ignores: ['admin/client/editor.entry.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin, security },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        SimpleWebAuthnBrowser: 'readonly',
        // window.TE — the admin frontend namespace seeded by icons.js and
        // extended by common.js (TE.icon/escape/openModal/…). WWW is the
        // legacy alias kept until the last reference is renamed.
        TE: 'readonly',
        WWW: 'readonly',
      },
    },
    rules: {
      ...sharedRules,
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/tag-lines': 'off',
    },
  },

  // TipTap + CodeMirror bundle source (ES module input to esbuild).
  {
    files: ['admin/client/editor.entry.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin, security },
    languageOptions: {
      parser: tseslint.parser,
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

  // Admin Express backend (Node ESM).
  {
    files: ['admin/server.ts', 'admin/src/**/*.ts', 'admin/scripts/**/*.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin, security, n },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: './admin/tsconfig.json' },
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...sharedRules,
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'n/no-missing-import': 'off',
      'n/no-unpublished-import': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/tag-lines': 'off',
    },
  },

  // Migrate CLI.
  {
    files: ['migrate/**/*.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin, security, n },
    languageOptions: {
      parser: tseslint.parser,
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

  // Root-level TypeScript configs.
  {
    files: ['*.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin, security },
    languageOptions: {
      parser: tseslint.parser,
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

  // scripts/ — Node CLI tooling (maintenance + dev experience).
  {
    files: ['scripts/**/*.ts'],
    ignores: ['scripts/dev/__tests__/**'],
    plugins: { '@typescript-eslint': tseslint.plugin, security, n },
    languageOptions: {
      parser: tseslint.parser,
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

  // scripts/dev/__tests__ — Vitest.
  {
    files: ['scripts/dev/__tests__/**/*.{test,spec}.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin, security },
    languageOptions: {
      parser: tseslint.parser,
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

  // admin frontend Vitest tests.
  {
    files: ['admin/test/**/*.vitest.{test,spec}.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin, security },
    languageOptions: {
      parser: tseslint.parser,
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

  // admin backend node:test runner.
  {
    files: ['admin/test/**/*.test.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin, security },
    languageOptions: {
      parser: tseslint.parser,
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

  // Playwright e2e.
  {
    files: ['test/playwright/**/*.spec.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin, security },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2024,
      sourceType: 'module',
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
