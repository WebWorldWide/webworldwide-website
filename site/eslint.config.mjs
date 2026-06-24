// @ts-check
/**
 * site/ ESLint config — Astro + React + TypeScript.
 *
 * Covers:
 *   - .astro pages, layouts, components
 *   - .tsx React islands
 *   - .ts content schema + endpoint code
 *   - .mjs build scripts
 *   - vitest tests under src/__tests__ and test/
 *
 * Rules emphasize:
 *   - jsx-a11y — accessibility (every interactive element needs labels,
 *     no missing alt, role correctness, keyboard equivalents). Critical
 *     for the project's WCAG 2.2 AA gate.
 *   - react-hooks — exhaustive-deps and rules-of-hooks.
 *   - typescript-eslint recommended.
 */

import js from '@eslint/js';
import astroPlugin from 'eslint-plugin-astro';
// astro-eslint-parser v2 dropped its default export; the module namespace
// (with parseForESLint) is the parser object now.
import * as astroParser from 'astro-eslint-parser';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

const sharedRules = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
  'no-undef': 'error',
  'prefer-const': 'error',
  eqeqeq: ['error', 'always'],
};

const a11yRules = {
  ...jsxA11y.configs.strict.rules,
  // We do use a custom href="#" pattern in cmd-K results — they're real navigation
  // wrapped in onClick to call openPost. But still want anchor-is-valid to catch
  // bare # links without onClick.
  'jsx-a11y/anchor-is-valid': ['error', { specialLink: ['onClick'] }],
  'jsx-a11y/no-autofocus': 'warn',
};

export default [
  {
    ignores: [
      'dist/**',
      '.astro/**',
      'node_modules/**',
      '.legacy/**',
      'scripts/legacy-redirects.json',
      'src/env.d.ts', // Astro-generated (triple-slash reference is intentional)
    ],
  },

  js.configs.recommended,

  // Service worker (browser SW context — `self`, `caches`, `fetch`, etc.)
  {
    files: ['**/sw.js'],
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.browser },
    },
  },

  // Astro
  {
    files: ['**/*.astro'],
    plugins: { astro: astroPlugin, 'jsx-a11y': jsxA11y },
    languageOptions: {
      parser: astroParser,
      parserOptions: { parser: tsParser, extraFileExtensions: ['.astro'] },
      globals: { ...globals.browser, ...globals.node, Astro: 'readonly' },
    },
    rules: {
      ...sharedRules,
      ...astroPlugin.configs.recommended.rules,
      ...a11yRules,
    },
  },

  // TSX (React islands)
  {
    files: ['src/components/islands/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}'],
    plugins: {
      '@typescript-eslint': tsPlugin,
      react,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2024, sourceType: 'module', ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    settings: { react: { version: '18.3' } },
    rules: {
      ...sharedRules,
      ...tsPlugin.configs.recommended.rules,
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      ...a11yRules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      // New in eslint-plugin-react-hooks v7. It flags setState in effects as a
      // perf smell, but the islands use it deliberately and correctly (reset
      // state when the ⌘K palette closes; clamp the active index when the
      // result list shrinks). These are tested by the e2e/a11y suite. Off
      // rather than refactor working, covered components for an opinionated rule.
      'react-hooks/set-state-in-effect': 'off',
      // TypeScript itself resolves identifiers/types; `no-undef` only yields
      // false positives here (e.g. the `JSX`/`React` type namespaces).
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // TS endpoints, content config, scripts
  {
    files: ['src/**/*.ts', 'scripts/**/*.{mjs,ts}', '*.{ts,mjs}'],
    ignores: ['src/components/islands/**/*.{ts,tsx}', 'src/components/**/*.tsx'],
    plugins: { '@typescript-eslint': tsPlugin },
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2024, sourceType: 'module' },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...sharedRules,
      ...tsPlugin.configs.recommended.rules,
      // TypeScript resolves identifiers/types; `no-undef` only false-positives.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // Vitest
  {
    files: ['src/__tests__/**/*.{test,spec}.{ts,tsx}', 'test/**/*.{test,spec}.{ts,tsx}'],
    plugins: {
      '@typescript-eslint': tsPlugin,
      react,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2024, sourceType: 'module', ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      ...sharedRules,
      'react/react-in-jsx-scope': 'off',
      'jsx-a11y/click-events-have-key-events': 'off',
      'jsx-a11y/no-static-element-interactions': 'off',
    },
  },
];
