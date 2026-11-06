// @ts-nocheck
/**
 * ssrf.test.js — the SSRF-screened fetch used by the embed / OG-scrape paths.
 * No DB needed (pure logic + an injected fetch), so no skip guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateHost, ipIsPrivate, screenedFetch, assertPublicHost } from '../src/utils/ssrf.js';

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

test('assertPublicHost strips IPv6 brackets before resolving (a bare literal fails dns.lookup)', async () => {
  // new URL('http://[::1]/').hostname is '[::1]' WITH brackets — dns.lookup()
  // rejects that bracketed form outright (ENOTFOUND), which previously made
  // every IPv6-literal target fail this check, public or private alike.
  await assert.rejects(
    () => assertPublicHost('[::1]'),
    /private|non-public/,
    'private literal is still blocked, not just failed-to-resolve',
  );
  await assert.doesNotReject(
    () => assertPublicHost('[2606:4700:4700::1111]'),
    'a public IPv6 literal must resolve and pass now that brackets are stripped',
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

test('2026-11 hardening: CGNAT, NAT64, hex-mapped, 6to4, Teredo, numeric hosts are refused', () => {
  for (const ip of [
    '100.84.141.1', // Tailscale / CGNAT
    '198.18.0.1',
    '192.0.0.8',
    '192.0.2.1',
    '::ffff:7f00:1', // hex form of ::ffff:127.0.0.1
    '64:ff9b::a9fe:a9fe', // NAT64 → 169.254.169.254
    '2002:7f00:1::1', // 6to4 embedding 127.0.0.1
    '2001:0:4136:e378::1', // Teredo
    '::127.0.0.1', // IPv4-compatible
    'ff02::1',
    'fe80::1%eth0',
    'not-an-ip',
  ]) {
    assert.equal(ipIsPrivate(ip), true, `expected private: ${ip}`);
  }
  for (const ip of ['8.8.8.8', '2606:4700:4700::1111', '::ffff:1.1.1.1']) {
    assert.equal(ipIsPrivate(ip), false, `expected public: ${ip}`);
  }
  for (const h of [
    '2130706433',
    '0x7f.1',
    '127.1',
    'cms',
    'remark42',
    'router.lan',
    'x.home.arpa',
    '[::ffff:7f00:1]',
  ]) {
    assert.equal(isPrivateHost(h), true, `expected private host: ${h}`);
  }
  for (const h of ['0xfeed.example.com', 'a.b.example']) {
    assert.equal(isPrivateHost(h), false, `expected public host: ${h}`);
  }
});

test('screenedFetch refuses https→http downgrade redirects and credentialed URLs', async () => {
  const redirectTo = (location) => async () =>
    new Response(null, { status: 301, headers: { location } });
  await assert.rejects(
    () =>
      screenedFetch('https://a.example/', {
        screenDns: false,
        fetchImpl: redirectTo('http://b.example/'),
      }),
    /downgrade/,
  );
  await assert.rejects(
    () =>
      screenedFetch('https://user:pw@a.example/', {
        screenDns: false,
        fetchImpl: async () => new Response('x'),
      }),
    /credentials/,
  );
});

test('pinnedFetch refuses to connect when DNS answers a private address (rebinding)', async () => {
  const { pinnedFetch } = await import('../src/utils/ssrf.js');
  // localhost.example.invalid won't resolve; use a name that resolves to loopback.
  await assert.rejects(
    () => pinnedFetch('http://localhost/'),
    (err) => {
      const msg = String(err?.cause?.message || err?.message || err);
      return /private|ESSRF/i.test(msg) || err?.cause?.code === 'ESSRF';
    },
  );
});
