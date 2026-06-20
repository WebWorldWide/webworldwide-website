// @ts-nocheck
/**
 * ssrf.test.js — the SSRF-screened fetch used by the embed / OG-scrape paths.
 * No DB needed (pure logic + an injected fetch), so no skip guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateHost, ipIsPrivate, screenedFetch } from '../src/utils/ssrf.js';

test('isPrivateHost flags loopback / private / link-local / reserved', () => {
  for (const h of [
    'localhost',
    'foo.local',
    'svc.internal',
    '127.0.0.1',
    '10.1.2.3',
    '192.168.4.1',
    '172.16.0.1',
    '172.31.255.1',
    '169.254.169.254',
    '::1',
    'fc00::1',
    'fe80::1',
  ]) {
    assert.equal(isPrivateHost(h), true, `expected private: ${h}`);
  }
  for (const h of ['example.com', 'webworldwide.online', '8.8.8.8', '172.15.0.1', '172.32.0.1']) {
    assert.equal(isPrivateHost(h), false, `expected public: ${h}`);
  }
});

test('ipIsPrivate flags private resolved IPs incl. IPv4-mapped IPv6', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.5',
    '192.168.1.1',
    '169.254.1.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:192.168.1.1',
  ]) {
    assert.equal(ipIsPrivate(ip), true, `expected private: ${ip}`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '::ffff:8.8.8.8']) {
    assert.equal(ipIsPrivate(ip), false, `expected public: ${ip}`);
  }
});

test('screenedFetch rejects a non-http(s) scheme', async () => {
  await assert.rejects(
    () =>
      screenedFetch('file:///etc/passwd', {
        screenDns: false,
        fetchImpl: async () => new Response('x'),
      }),
    /non-http/,
  );
});

test('screenedFetch rejects a lexically-private start host', async () => {
  await assert.rejects(
    () =>
      screenedFetch('http://127.0.0.1/', {
        screenDns: false,
        fetchImpl: async () => new Response('x'),
      }),
    /private/,
  );
});

test('screenedFetch follows a redirect to a PUBLIC host', async () => {
  let calls = 0;
  const fake = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://other.example/final' },
      });
    }
    return new Response('ok', { status: 200 });
  };
  const res = await screenedFetch('https://start.example/', { screenDns: false, fetchImpl: fake });
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
});

test('screenedFetch BLOCKS a redirect to a PRIVATE host (the SSRF fix)', async () => {
  const fake = async () =>
    new Response(null, {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    });
  await assert.rejects(
    () => screenedFetch('https://innocent.example/', { screenDns: false, fetchImpl: fake }),
    /private/,
  );
});

test('screenedFetch caps redirect chains', async () => {
  const fake = async () =>
    new Response(null, { status: 302, headers: { location: 'https://loop.example/next' } });
  await assert.rejects(
    () =>
      screenedFetch('https://loop.example/', {
        screenDns: false,
        fetchImpl: fake,
        maxRedirects: 3,
      }),
    /too many redirects/,
  );
});
