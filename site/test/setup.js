// @ts-nocheck
/**
 * Vitest setup file — runs once per worker before tests.
 *
 * Node 26 ships an experimental top-level `localStorage` that shadows
 * the jsdom window.localStorage in test files. We polyfill a minimal
 * Storage on window if jsdom didn't install one.
 */

// Silence app.js's optional fetch('/index.json') when no per-test mock is installed.
// Tests that exercise the palette install their own mock fetch in beforeEach.
if (typeof globalThis.fetch === 'function') {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (typeof url === 'string' && url.startsWith('/')) {
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  };
}

if (typeof window !== 'undefined' && !window.localStorage) {
  /** @type {Map<string, string>} */
  const store = new Map();
  const fakeStorage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.has(String(key)) ? store.get(String(key)) : null;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(String(key));
    },
    key(i) {
      return Array.from(store.keys())[i] ?? null;
    },
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: fakeStorage,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: fakeStorage,
  });
}
