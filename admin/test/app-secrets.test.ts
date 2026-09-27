// @ts-nocheck
/**
 * app-secrets.test.js — the encrypted UI-credential store.
 * Skips transparently when better-sqlite3 won't load (mirrors the others).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir;
let secrets;
let skipReason = false;
const skipOpts = () => ({
  get skip() {
    return skipReason;
  },
});

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-secrets-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth.db');
  process.env.SESSION_SECRET = 'test-secret-abc';
  try {
    const Database = (await import('better-sqlite3')).default;
    new Database(':memory:').close();
  } catch (err) {
    skipReason = `better-sqlite3 failed: ${err.message.split('\n')[0]}`;
    return;
  }
  secrets = await import('../src/services/app-secrets.js');
});

after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('set + get round-trips a value', skipOpts(), () => {
  secrets.setSecret('k1', 'hunter2');
  assert.equal(secrets.getSecret('k1'), 'hunter2');
  assert.equal(secrets.hasSecret('k1'), true);
});

test('stored value is encrypted — plaintext never hits the DB', skipOpts(), async () => {
  secrets.setSecret('k2', 'super-secret-token');
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(process.env.AUTH_DB_PATH, { readonly: true });
  const row = db.prepare('SELECT value FROM app_secrets WHERE key = ?').get('k2');
  db.close();
  assert.ok(row && row.value, 'row exists');
  assert.ok(
    !String(row.value).includes('super-secret-token'),
    'ciphertext must not contain plaintext',
  );
});

test('empty value deletes the key', skipOpts(), () => {
  secrets.setSecret('k3', 'x');
  secrets.setSecret('k3', '');
  assert.equal(secrets.getSecret('k3'), null);
  assert.equal(secrets.hasSecret('k3'), false);
});

test(
  'a changed SESSION_SECRET makes prior values undecryptable (null, no throw)',
  skipOpts(),
  () => {
    secrets.setSecret('k4', 'value4');
    assert.equal(secrets.getSecret('k4'), 'value4');
    const orig = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'a-totally-different-secret';
    assert.equal(secrets.getSecret('k4'), null); // GCM auth fails -> graceful null
    process.env.SESSION_SECRET = orig;
    assert.equal(secrets.getSecret('k4'), 'value4'); // restored
  },
);

test('hasSecret is false for an unset key', skipOpts(), () => {
  assert.equal(secrets.hasSecret('never-set'), false);
  assert.equal(secrets.getSecret('never-set'), null);
});
