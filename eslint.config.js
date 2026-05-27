// @ts-check
/**
 * ESLint 9 flat config — root (admin / migrate / scripts).
 *
 * site/ has its own eslint.config.mjs because it ships React + Astro,
 * which need eslint-plugin-astro + eslint-plugin-react + eslint-plugin-jsx-a11y
 * not relevant outside site/. Root lint stays focused on:
 *
 *   - admin/**\/*.js           Node 20 + ES modules (admin Express backend)
 *   - admin/public/**\/*.js    Browser, IIFE-wrapped (admin frontend)
 *   - migrate/**\/*.js         Node 20 CLI tooling
 *   - scripts/**\/*.{js,mjs}   Node 20 dev/maintenance scripts
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

const sharedRules = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
  'no-undef': 'error',
  'prefer-const': 'error',
  eqeqeq: ['error', 'always'],
  'no-implicit-coercion': 'error',
  'security/detect-object-injection': 'warn'
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
      'admin/public/js/editor.bundle.js',
      'admin/public/js/editor.bundle.js.map',
      'Blog/**',
      '.planning/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '.lighthouseci/**',
      'docker/**',
      'dist/**'
    ]
  },

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
      globals: { ...globals.serviceworker }
    },
    rules: {
      ...sharedRules,
      'promise/catch-or-return': 'off',
      'promise/always-return': 'off',
      'promise/no-nesting': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/tag-lines': 'off'
    }
  },

  // Admin browser frontend (plain script IIFEs).
  {
    files: ['admin/public/js/**/*.js'],
    ignores: ['admin/public/js/editor.entry.js', 'admin/public/js/editor.bundle.js'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        SimpleWebAuthnBrowser: 'readonly',
        WWW: 'readonly'
      }
    },
    rules: {
      ...sharedRules,
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/tag-lines': 'off'
    }
  },

  // TipTap + CodeMirror bundle source (ES module input to esbuild).
  {
    files: ['admin/public/js/editor.entry.js'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser }
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
      'jsdoc/no-multi-asterisks': 'off'
    }
  },

  // Admin Express backend (Node ESM).
  {
    files: ['admin/**/*.js'],
    ignores: ['admin/public/**'],
    plugins: { security, n },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      ...sharedRules,
      'n/no-missing-import': 'off',
      'n/no-unpublished-import': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/tag-lines': 'off'
    }
  },

  // Migrate CLI.
  {
    files: ['migrate/**/*.js'],
    plugins: { security, n },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      ...sharedRules,
      'n/no-missing-import': 'off',
      'n/no-unpublished-import': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/tag-lines': 'off'
    }
  },

  // Root-level JS configs.
  {
    files: ['*.js', '*.mjs'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      ...sharedRules,
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/tag-lines': 'off'
    }
  },

  // scripts/ — Node CLI tooling (maintenance + dev experience).
  {
    files: ['scripts/**/*.{js,mjs}'],
    ignores: ['scripts/dev/__tests__/**'],
    plugins: { security, n },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      ...sharedRules,
      'n/no-missing-import': 'off',
      'n/no-unpublished-import': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/tag-lines': 'off',
      'jsdoc/no-undefined-types': 'off'
    }
  },

  // scripts/dev/__tests__ — Vitest.
  {
    files: ['scripts/dev/__tests__/**/*.{test,spec}.js'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      ...sharedRules,
      'security/detect-object-injection': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/tag-lines': 'off'
    }
  },

  // admin frontend Vitest tests.
  {
    files: ['admin/test/**/*.vitest.{test,spec}.js'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node }
    },
    rules: {
      ...sharedRules,
      'security/detect-object-injection': 'off',
      'promise/param-names': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/tag-lines': 'off'
    }
  },

  // admin backend node:test runner.
  {
    files: ['admin/test/**/*.test.js'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      ...sharedRules,
      'security/detect-object-injection': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/tag-lines': 'off'
    }
  },

  // Playwright e2e.
  {
    files: ['test/playwright/**/*.spec.js'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      ...sharedRules,
      'security/detect-object-injection': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/tag-lines': 'off'
    }
  }
];
