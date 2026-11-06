# Host-local Caddy sites

Files matching `*.caddy` in this directory are imported by `docker/Caddyfile`
and are **git-ignored**: use them for routes that belong to this host rather
than to Web World Wide (for example a homelab service exposed through the
host's own `cloudflared` tunnel, which reaches Caddy at `http://127.0.0.1:80`).

Rules:

- Caddy is published on loopback only. Do not add public listeners, `https://`
  site addresses, or anything that needs inbound ports 80/443 from the
  internet. Public ingress goes through Cloudflare Tunnel.
- Upstream containers must share a network with Caddy. `immich_server` joins
  the dedicated `wwwide-immich-edge` network; it is never attached to the
  Web World Wide application network.

Example (`immich.caddy`):

```caddyfile
http://immich.example.com {
  encode zstd gzip
  reverse_proxy immich_server:2283
}
```
