// sample.js — fixture for the Phase 5c code preview pipeline.
// The test asserts the Shiki render contains "function add" and the
// preview-txt round-trips byte-for-byte.

function add(a, b) {
  return a + b;
}

function multiply(a, b) {
  return a * b;
}

export { add, multiply };
