-- 005_embed_cache.sql — Phase 7 paste-to-embed cache.
--
-- The embed route (`admin/src/routes/embed.js`) calls into a registry of
-- oEmbed providers (YouTube, Vimeo, Bluesky, Mastodon, TikTok, CodePen,
-- SoundCloud, Spotify) and a generic Open Graph scraper for everything
-- else. Each successful upstream lookup is cached here for 24h so a
-- second paste of the same URL is served from disk without re-hitting
-- the network.
--
-- Cache key is the trimmed input URL (https-only inputs only, so case
-- of the scheme is normalised by the route). The payload column is the
-- JSON shape returned to the editor: `{ provider, id, shortcode, html,
-- thumbnail, title, author, width, height, type }`.
--
-- The expires index lets a lightweight sweeper (future phase) garbage
-- collect old rows in a single ranged DELETE.

CREATE TABLE IF NOT EXISTS embed_cache (
  url TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  shortcode TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embed_cache_expires ON embed_cache(expires_at);
