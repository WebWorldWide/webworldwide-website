/**
 * Real client IP for rate limiting and audit logs.
 *
 * Forwarding headers are only trusted when the TCP peer is a proxy we run:
 * Caddy on the private Docker network (RFC 1918 / loopback / ULA). Any other
 * peer is the client itself, and its self-reported CF-Connecting-IP or
 * X-Forwarded-For is ignored — in 2026-11 Caddy was briefly published on
 * 0.0.0.0 and a spoofed CF-Connecting-IP gave every request a fresh
 * rate-limit bucket (unlimited password guessing).
 *
 * Behind Cloudflare Tunnel, cloudflared → Caddy → cms: Cloudflare overwrites
 * any client-supplied CF-Connecting-IP at its edge, so the header is
 * authoritative when it arrives via that path.
 */
import type { Request } from 'express';

const stripMapped = (ip: string) => (ip.startsWith('::ffff:') ? ip.slice(7) : ip);

/** True for loopback, RFC 1918, link-local, and IPv6 ULA/loopback addresses. */
export function isPrivatePeer(raw: string | undefined | null): boolean {
  if (!raw) return false;
  const ip = stripMapped(String(raw).trim().toLowerCase());
  if (ip === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true; // fc00::/7 ULA
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

const isPlausibleIp = (v: string) => /^[0-9a-f:.]{2,45}$/i.test(v);

/** Best-effort real client IP (never throws). */
export function getClientIp(req: Request): string {
  const peer = stripMapped(req.socket?.remoteAddress || '');
  if (!isPrivatePeer(peer)) return peer;
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf && isPlausibleIp(cf)) return stripMapped(cf);
  // Caddy appends the peer it saw to X-Forwarded-For; the LAST entry is the
  // one our own proxy vouches for (earlier entries are client-controlled).
  const xff = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const last = xff[xff.length - 1];
  if (last && isPlausibleIp(last)) return stripMapped(last);
  return peer;
}
