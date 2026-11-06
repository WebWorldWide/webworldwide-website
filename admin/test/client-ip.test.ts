// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getClientIp, isPrivatePeer } from '../src/utils/clientIp.js';

const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

test('forwarding headers are ignored from a public peer (direct-to-origin spoofing)', () => {
  assert.equal(
    getClientIp(req('198.51.100.7', { 'cf-connecting-ip': '203.0.113.1' })),
    '198.51.100.7',
  );
  assert.equal(
    getClientIp(req('::ffff:198.51.100.7', { 'x-forwarded-for': '1.2.3.4' })),
    '198.51.100.7',
  );
});

test('CF-Connecting-IP is honoured from our proxy on the docker network', () => {
  assert.equal(
    getClientIp(req('172.19.0.8', { 'cf-connecting-ip': '203.0.113.1' })),
    '203.0.113.1',
  );
  assert.equal(
    getClientIp(req('::ffff:172.19.0.8', { 'cf-connecting-ip': '2001:db8::1' })),
    '2001:db8::1',
  );
});

test('X-Forwarded-For: only the proxy-appended (last) hop is trusted', () => {
  assert.equal(
    getClientIp(req('172.19.0.8', { 'x-forwarded-for': '6.6.6.6, 198.51.100.9' })),
    '198.51.100.9',
  );
});

test('garbage header values fall back to the peer', () => {
  assert.equal(getClientIp(req('172.19.0.8', { 'cf-connecting-ip': '<script>' })), '172.19.0.8');
});

test('isPrivatePeer classifies ranges', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.4.20',
    '::1',
    'fd00::1',
  ])
    assert.equal(isPrivatePeer(ip), true, ip);
  for (const ip of ['172.32.0.1', '100.84.141.1', '8.8.8.8', '107.211.210.105', '2001:db8::1', ''])
    assert.equal(isPrivatePeer(ip), false, ip);
});
