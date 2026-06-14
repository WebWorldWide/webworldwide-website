# Cloudflare Tunnel — required public hostname routes

**Status (2026-06):** `comments.webworldwide.online` and
`analytics.webworldwide.online` are **unreachable** (DNS `NXDOMAIN`, HTTPS
`000`). The live blog's **comment widget** (remark42) and **analytics
tracker** (Umami) therefore can't load. `admin.webworldwide.online` works.

## Why

The tunnel is **token-managed** (`cloudflared … tunnel run` with
`TUNNEL_TOKEN`/`CLOUDFLARE_TUNNEL_TOKEN` in `docker/.env`). With a token tunnel
the **ingress routes live in the Cloudflare Zero Trust dashboard**, not in a
local config file — and Cloudflare auto-creates the proxied DNS record **only**
for hostnames that have a Public Hostname route.

Only `admin.` has a route, so only `admin.` got a DNS record. `comments.` and
`analytics.` have no route → no DNS → dead. Everything downstream is healthy:
locally `curl -H 'Host: comments.webworldwide.online' http://127.0.0.1/ping`
returns `pong` and the analytics `/script.js` returns `200`, so the **only**
missing piece is the two dashboard routes.

> The device IP is **not** the cause. `eth0` is still static `192.168.4.88` and
> a token tunnel is outbound (IP-independent). Adding the routes is all that's
> needed.

## Fix (Cloudflare Zero Trust dashboard — ~2 minutes)

1. **Cloudflare Zero Trust** → **Networks → Tunnels** → open the WWWide tunnel
   (the one showing **HEALTHY** with connections to `ord/stl`).
2. **Public Hostname** tab → **Add a public hostname**. Add **two** entries —
   both point at the same Caddy listener that already serves `admin.`:

   | Subdomain    | Domain                  | Service (Type / URL)   |
   | ------------ | ----------------------- | ---------------------- |
   | `comments`   | `webworldwide.online`   | **HTTP** `caddy:80`    |
   | `analytics`  | `webworldwide.online`   | **HTTP** `caddy:80`    |

   (In the UI the service is Type **HTTP**, URL **`caddy:80`** — i.e.
   `http://caddy:80`. Same target as the existing `admin.` route.)
3. **Save**. Cloudflare auto-creates the proxied `CNAME` for each. DNS
   propagates in seconds to a minute.

### Why `caddy:80` (not remark42/umami directly)

Caddy is the single ingress and routes by `Host` header
(`docker/Caddyfile`): `DOMAIN_ADMIN → cms:3000`,
`DOMAIN_COMMENTS → remark42:8080`, `DOMAIN_ANALYTICS → umami:3000`. cloudflared
preserves the Host header, so pointing both new hostnames at `caddy:80` lets
Caddy fan them out to the right backend (and keeps compression/TLS-termination
consistent with `admin.`).

## Verify (after saving)

```bash
# DNS now resolves and HTTPS answers:
curl -sI https://comments.webworldwide.online/ping            # → 200
curl -s  https://comments.webworldwide.online/ping            # → pong
curl -sI https://analytics.webworldwide.online/script.js      # → 200
# Then load any live post and confirm the comment box mounts and the
# Umami beacon fires (Network tab → script.js + /api/send).
```

All three should return `200`/`pong`. If they still 000 after a minute, confirm
the routes saved and the tunnel shows HEALTHY.
