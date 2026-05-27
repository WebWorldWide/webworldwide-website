#!/usr/bin/env node
// @ts-check
/**
 * scripts/dev/check.mjs — Phase 5d.
 *
 * Pings each service in the dev stack and prints a status table. Exits
 * non-zero if any service is unreachable, so the script doubles as a
 * pre-test gate in CI.
 *
 * The list of services is exported as `SERVICES` so the Vitest suite can
 * drive `runCheck` with a `fetchFn` injected to simulate failures.
 */

import net from 'node:net';
import { loadDevEnv, makeLogger, c } from './_lib.mjs';

const log = makeLogger('check', c.blue);

/**
 * @typedef {{
 *   name: string,
 *   kind: 'http' | 'tcp',
 *   url?: string,
 *   expectStatus?: number,
 *   host?: string,
 *   port?: number,
 * }} ServiceSpec
 */

/** @type {ServiceSpec[]} */
export const SERVICES = [
  { name: 'Hugo', kind: 'http', url: 'http://localhost:1313/', expectStatus: 200 },
  { name: 'Admin', kind: 'http', url: 'http://localhost:3000/auth/status', expectStatus: 200 },
  { name: 'Remark42', kind: 'http', url: 'http://localhost:8081/api/v1/ping', expectStatus: 200 },
  { name: 'Umami', kind: 'http', url: 'http://localhost:3001/api/heartbeat', expectStatus: 200 },
  { name: 'Postgres', kind: 'tcp', host: 'localhost', port: 5433 },
];

const TIMEOUT_MS = 2000;

/**
 * Try a single TCP connect with a hard timeout. Resolves true on
 * success, false on any failure.
 *
 * @param {string} host
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export function tcpPing(host, port, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

/**
 * Issue an HTTP GET with a hard timeout via AbortController. Returns
 * `{ ok, status, error }` rather than throwing — callers turn that into
 * a row in the status table.
 *
 * @param {string} url
 * @param {number} expectStatus
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ ok: boolean, status: number | null, error?: string }>}
 */
export async function httpPing(url, expectStatus, fetchFn = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal });
    return { ok: res.status === expectStatus, status: res.status };
  } catch (err) {
    return { ok: false, status: null, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe every service. Returns an array of result rows; consumers may
 * print, or count `.filter(r => !r.ok).length` for an exit code.
 *
 * @param {{ services?: ServiceSpec[], fetchFn?: typeof fetch }} [opts]
 * @returns {Promise<Array<{ name: string, ok: boolean, detail: string }>>}
 */
export async function probeAll(opts = {}) {
  const services = opts.services || SERVICES;
  const fetchFn = opts.fetchFn || fetch;
  /** @type {Array<{ name: string, ok: boolean, detail: string }>} */
  const rows = [];
  for (const s of services) {
    if (s.kind === 'http') {
      const r = await httpPing(s.url, s.expectStatus ?? 200, fetchFn);
      rows.push({
        name: s.name,
        ok: r.ok,
        detail: r.ok ? `${r.status} ${s.url}` : `${r.error || r.status || 'down'} (${s.url})`,
      });
    } else {
      const ok = await tcpPing(s.host, s.port);
      rows.push({
        name: s.name,
        ok,
        detail: ok ? `tcp ${s.host}:${s.port}` : `unreachable ${s.host}:${s.port}`,
      });
    }
  }
  return rows;
}

/**
 * Pretty-print the table.
 *
 * @param {Array<{ name: string, ok: boolean, detail: string }>} rows
 */
export function printTable(rows) {
  const maxName = Math.max(...rows.map((r) => r.name.length), 8);
  console.log();
  console.log(`  ${c.bold('Service'.padEnd(maxName))}  ${c.bold('Status')}  Detail`);
  console.log(`  ${'-'.repeat(maxName)}  ${'-'.repeat(6)}  ${'-'.repeat(40)}`);
  for (const r of rows) {
    const status = r.ok ? c.green('OK  ') : c.red('DOWN');
    console.log(`  ${r.name.padEnd(maxName)}  ${status}    ${c.gray(r.detail)}`);
  }
  console.log();
}

/**
 * Entrypoint. Returns the array of rows so tests can assert on it.
 *
 * @param {{ services?: ServiceSpec[], fetchFn?: typeof fetch, silent?: boolean }} [opts]
 * @returns {Promise<{ rows: Array<{ name: string, ok: boolean, detail: string }>, allOk: boolean }>}
 */
export async function runCheck(opts = {}) {
  loadDevEnv();
  const rows = await probeAll(opts);
  if (!opts.silent) printTable(rows);
  const allOk = rows.every((r) => r.ok);
  if (!opts.silent) {
    log.info(
      allOk
        ? c.green(`all ${rows.length} services up`)
        : c.red(`${rows.filter((r) => !r.ok).length}/${rows.length} services down`),
    );
  }
  return { rows, allOk };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runCheck()
    .then(({ allOk }) => process.exit(allOk ? 0 : 1))
    .catch((err) => {
      log.error(err.stack || err.message);
      process.exit(2);
    });
}
