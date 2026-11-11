/**
 * youtube-latest.ts — fetch the channel's newest video for the homepage's
 * Videos section (run by prebuild; never fails the build).
 *
 * Source: the channel's public RSS feed
 *   https://www.youtube.com/feeds/videos.xml?channel_id=<[social].youtube_channel_id>
 * (no API key; Shorts are skipped). Writes:
 *   - src/data/youtube-latest.json   read by components/sections/Videos.astro
 *   - public/youtube-latest.json     published, so the sync workflow
 *                                    (.github/workflows/youtube-sync.yml) can
 *                                    tell whether the live site is current
 *   - public/youtube/latest.webp     the thumbnail, self-hosted: visitors
 *                                    never load anything from YouTube
 * All three are gitignored build outputs.
 *
 * If YouTube can't be reached, the last version the live site published is
 * reused, so a flaky fetch during a deploy never reverts the section to
 * "coming soon".
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import TOML from '@iarna/toml';
import sharp from 'sharp';

export type LatestVideo = {
  id: string;
  title: string;
  url: string;
  published: string;
  /** Path of the self-hosted thumbnail, or null if it couldn't be fetched. */
  thumbnail: string | null;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_OUT = resolve(ROOT, 'src/data/youtube-latest.json');
const PUBLIC_OUT = resolve(ROOT, 'public/youtube-latest.json');
const THUMB_OUT = resolve(ROOT, 'public/youtube/latest.webp');
const THUMB_PATH = '/youtube/latest.webp';
const TIMEOUT_MS = 8000;

const log = (msg: string): void => console.log(`[youtube-latest] ${msg}`);

async function get(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': 'webworldwide-site-build' },
      });
      if (res.ok) return res;
      if (res.status === 404) return null;
    } catch {
      /* retry once */
    }
  }
  return null;
}

const decode = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** Newest non-Short video in the feed, or null if the channel has none. */
export function parseFeed(xml: string): Omit<LatestVideo, 'thumbnail'> | null {
  for (const entry of xml.split('<entry>').slice(1)) {
    const id = entry.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/)?.[1];
    const link = entry.match(/<link rel="alternate" href="([^"]+)"/)?.[1] || '';
    if (!id || link.includes('/shorts/')) continue;
    return {
      id,
      title: decode(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || ''),
      url: `https://www.youtube.com/watch?v=${id}`,
      published: entry.match(/<published>([^<]+)<\/published>/)?.[1] || '',
    };
  }
  return null;
}

async function thumbnail(id: string): Promise<string | null> {
  for (const name of ['maxresdefault', 'sddefault', 'hqdefault']) {
    const res = await get(`https://i.ytimg.com/vi/${id}/${name}.jpg`);
    if (!res) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    // YouTube serves a 120×90 grey placeholder for missing sizes.
    const meta = await sharp(buf).metadata();
    if ((meta.width || 0) < 400) continue;
    await mkdir(dirname(THUMB_OUT), { recursive: true });
    await sharp(buf).resize(1280, 720, { fit: 'cover' }).webp({ quality: 78 }).toFile(THUMB_OUT);
    return THUMB_PATH;
  }
  return null;
}

async function main(): Promise<void> {
  const toml = TOML.parse(await readFile(resolve(ROOT, 'site.toml'), 'utf8')) as {
    site?: { url?: string };
    social?: { youtube_channel_id?: string };
  };
  const channel = toml.social?.youtube_channel_id || '';
  const siteUrl = (toml.site?.url || 'https://webworldwide.online').replace(/\/$/, '');
  let latest: LatestVideo | null = null;
  let source = 'none';

  const feed = channel
    ? await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`)
    : null;
  if (feed) {
    const v = parseFeed(await feed.text());
    latest = v ? { ...v, thumbnail: await thumbnail(v.id) } : null;
    source = 'feed';
  } else {
    // Feed unreachable: keep what the live site shows (thumbnail included).
    const live = await get(`${siteUrl}/youtube-latest.json`);
    if (live) {
      latest = (await live.json().catch(() => null)) as LatestVideo | null;
      if (latest?.thumbnail) {
        const img = await get(`${siteUrl}${latest.thumbnail}`);
        if (img) {
          await mkdir(dirname(THUMB_OUT), { recursive: true });
          await writeFile(THUMB_OUT, Buffer.from(await img.arrayBuffer()));
        } else latest.thumbnail = null;
      }
      source = 'live site (feed unreachable)';
    }
  }

  const json = JSON.stringify(latest, null, 2) + '\n';
  await mkdir(dirname(DATA_OUT), { recursive: true });
  await writeFile(DATA_OUT, json);
  await writeFile(PUBLIC_OUT, json);
  log(
    latest
      ? `latest video "${latest.title}" (${latest.id}) from ${source}`
      : `no videos yet (${source})`,
  );
}

main().catch(async (err) => {
  // Never fail the build over this section: fall back to "coming soon".
  log(`failed (${err instanceof Error ? err.message : err}); showing the placeholder`);
  await mkdir(dirname(DATA_OUT), { recursive: true }).catch(() => {});
  await writeFile(DATA_OUT, 'null\n').catch(() => {});
  await writeFile(PUBLIC_OUT, 'null\n').catch(() => {});
});
