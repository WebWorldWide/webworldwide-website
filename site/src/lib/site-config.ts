/**
 * Single source of truth for site.toml in component code.
 *
 * Read once at module init, exported as a typed object. Resolves the file
 * via process.cwd() (which during astro build/dev is the site/ directory),
 * sidestepping the import.meta.url bundling issue where Astro compiles
 * components into ./dist/chunks/.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import TOML from '@iarna/toml';

export interface SiteConfig {
  site: {
    url: string;
    title: string;
    description: string;
    tagline: string;
    author: string;
    copyright: string;
    locale: string;
    default_language: string;
  };
  blog: {
    posts_per_page: number;
    permalink: string;
    masthead_name: string;
    masthead_kicker: string;
  };
  social: {
    youtube: string;
    youtube_handle: string;
    github: string;
    twitter: string;
    bluesky: string;
    mastodon: string;
    reddit: string;
    instagram: string;
    threads: string;
    email?: string;
  };
  comments: { provider: string; url: string; url_dev?: string; site_id: string };
  analytics: { provider: string; url: string; site_id: string };
  rss: { url: string };
  fediverse: { enabled: boolean; handle_user: string };
  apps: { fileid: string; doc_finder: string };
}

let cache: SiteConfig | null = null;

export function getSiteConfig(): SiteConfig {
  if (cache) return cache;
  const path = join(process.cwd(), 'site.toml');
  const raw = readFileSync(path, 'utf-8');
  cache = TOML.parse(raw) as unknown as SiteConfig;
  return cache;
}

// Pre-warm the cache so the first component render is fast.
export const siteConfig = getSiteConfig();
