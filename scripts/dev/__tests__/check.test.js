// @ts-nocheck
/**
 * scripts/dev/__tests__/check.test.js — Phase 5d.
 *
 * Drives check.mjs with an injected fetch + a tiny temp TCP server so we
 * can assert allOk transitions without any network dependency.
 */

import { describe, it, expect } from 'vitest';
import net from 'node:net';

/**
 * Spin up a throwaway TCP server on an ephemeral port. Returns the
 * port plus a `close` fn.
 *
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
function startEphemeralTcpServer() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => sock.end());
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({
        port,
        close: () =>
          new Promise((resolve) => {
            srv.close(() => resolve());
          }),
      });
    });
  });
}

describe('check.mjs', () => {
  it('probeAll returns allOk when fetch resolves 200s and tcp connects', async () => {
    const { probeAll, tcpPing } = await import('../check.mjs');
    const srv = await startEphemeralTcpServer();
    try {
      const ok = await tcpPing('127.0.0.1', srv.port);
      expect(ok).toBe(true);

      const fetchFn = async () => new Response('ok', { status: 200 });
      const rows = await probeAll({
        services: [
          { name: 'A', kind: 'http', url: 'http://example.test/', expectStatus: 200 },
          { name: 'B', kind: 'tcp', host: '127.0.0.1', port: srv.port },
        ],
        fetchFn,
      });
      expect(rows.every((r) => r.ok)).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('marks HTTP services down when fetch returns the wrong status', async () => {
    const { probeAll } = await import('../check.mjs');
    const fetchFn = async () => new Response('err', { status: 500 });
    const rows = await probeAll({
      services: [{ name: 'A', kind: 'http', url: 'http://example.test/', expectStatus: 200 }],
      fetchFn,
    });
    expect(rows[0].ok).toBe(false);
    expect(rows[0].detail).toMatch(/500/);
  });

  it('marks HTTP services down when fetch throws', async () => {
    const { probeAll } = await import('../check.mjs');
    const fetchFn = async () => {
      throw new Error('ECONNREFUSED');
    };
    const rows = await probeAll({
      services: [{ name: 'A', kind: 'http', url: 'http://example.test/', expectStatus: 200 }],
      fetchFn,
    });
    expect(rows[0].ok).toBe(false);
    expect(rows[0].detail).toMatch(/ECONNREFUSED/);
  });

  it('tcpPing returns false for a closed port within timeout', async () => {
    const { tcpPing } = await import('../check.mjs');
    // Port 1 is reserved + closed on every sane host; if your dev box
    // is running tcpmux this test will fail and you have bigger
    // problems than Phase 5d.
    const ok = await tcpPing('127.0.0.1', 1, 500);
    expect(ok).toBe(false);
  });

  it('runCheck returns allOk=false when any service is down', async () => {
    const { runCheck } = await import('../check.mjs');
    const fetchFn = async (url) => {
      if (String(url).includes('good')) return new Response('ok', { status: 200 });
      return new Response('err', { status: 500 });
    };
    const { allOk, rows } = await runCheck({
      services: [
        { name: 'Good', kind: 'http', url: 'http://good.test/', expectStatus: 200 },
        { name: 'Bad', kind: 'http', url: 'http://bad.test/', expectStatus: 200 },
      ],
      fetchFn,
      silent: true,
    });
    expect(allOk).toBe(false);
    expect(rows.find((r) => r.name === 'Good').ok).toBe(true);
    expect(rows.find((r) => r.name === 'Bad').ok).toBe(false);
  });
});
