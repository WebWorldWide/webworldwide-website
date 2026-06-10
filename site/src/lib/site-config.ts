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

/** One tile in the home-page Apps section. */
export interface AppItem {
  name: string;
  /** 'live' | 'soon' | 'lab' — drives the status pip text + data-status. */
  status: string;
  /** Destination URL; empty = tile is a no-op "coming soon" card. */
  link: string;
  /** Icon image path; empty = placeholder card (label/colors set in Apps.astro). */
  icon: string;
}

/** Raw (possibly partial) homepage-related keys as they appear in site.toml. */
interface HeroRaw {
  words?: string[];
  tagline?: string;
}
interface VideosRaw {
  episode?: string;
  film_title?: string;
}
export type HomeSectionKey = 'hero' | 'apps' | 'videos' | 'socials' | 'blog_cta';

interface HomepageRaw {
  section_order?: string[];
  sections?: Partial<Record<HomeSectionKey, boolean>>;
  hero?: HeroRaw;
  apps?: { items?: Partial<AppItem>[] };
  videos?: VideosRaw;
  socials?: { order?: string[]; hidden?: string[] };
  blog_cta?: { kicker?: string; title?: string; title_accent?: string; url?: string };
}

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
  /** Legacy fileid/doc_finder keys kept as fallbacks for old site.toml files. */
  apps?: { fileid?: string; doc_finder?: string; items?: Partial<AppItem>[] };
  /** Top-level aliases for the nested [homepage.*] tables (older shape). */
  hero?: HeroRaw;
  videos?: VideosRaw;
  homepage?: HomepageRaw;
}

/** Fully-defaulted homepage model — what components actually consume. */
export interface HomepageConfig {
  section_order: string[];
  sections: Record<HomeSectionKey, boolean>;
  hero: { words: string[]; tagline: string };
  apps: { items: AppItem[] };
  videos: { episode: string; film_title: string };
  socials: { order: string[]; hidden: string[] };
  blog_cta: { kicker: string; title: string; title_accent: string; url: string };
}

let cache: SiteConfig | null = null;

export function getSiteConfig(): SiteConfig {
  if (cache) return cache;
  const path = join(process.cwd(), 'site.toml');
  const raw = readFileSync(path, 'utf-8');
  cache = TOML.parse(raw) as unknown as SiteConfig;
  return cache;
}

const DEFAULT_SECTION_ORDER: HomeSectionKey[] = ['hero', 'apps', 'videos', 'socials', 'blog_cta'];
const DEFAULT_SOCIAL_ORDER = [
  'youtube',
  'github',
  'twitter',
  'bluesky',
  'mastodon',
  'reddit',
  'instagram',
  'threads',
];

const isNonEmptyStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string');

const isNonEmptyArray = <T>(v: T[] | undefined): v is T[] => Array.isArray(v) && v.length > 0;

/**
 * Normalize the homepage-related slices of site.toml into a fully-populated
 * model. An OLD site.toml (no [homepage], [hero], [videos], or [apps].items)
 * yields exactly today's hardcoded homepage: defaults below mirror the values
 * that used to live inline in the Astro components, with the legacy
 * `[apps] fileid` / `doc_finder` URLs feeding the first two app tiles.
 *
 * Reads the nested `[homepage.*]` tables first (what the admin homepage
 * editor writes), falling back to top-level `[hero]`/`[videos]`/`[apps] items`
 * aliases, then to the defaults.
 */
export function normalizeHomepage(cfg: Partial<SiteConfig>): HomepageConfig {
  const hp: HomepageRaw = cfg.homepage ?? {};
  const hero = hp.hero ?? cfg.hero ?? {};
  const videos = hp.videos ?? cfg.videos ?? {};
  const socials = hp.socials ?? {};
  const cta = hp.blog_cta ?? {};

  const rawItems = hp.apps?.items ?? cfg.apps?.items;
  const items: AppItem[] = isNonEmptyArray(rawItems)
    ? rawItems.map((it) => ({
        name: typeof it.name === 'string' ? it.name : 'Untitled',
        status: typeof it.status === 'string' ? it.status : 'soon',
        link: typeof it.link === 'string' ? it.link : '',
        icon: typeof it.icon === 'string' ? it.icon : '',
      }))
    : [
        {
          name: 'FileID',
          status: 'live',
          link: cfg.apps?.fileid ?? '',
          icon: '/assets/fileid.png',
        },
        {
          name: 'Document Finder',
          status: 'soon',
          link: cfg.apps?.doc_finder ?? '',
          icon: '/assets/doc-finder.png',
        },
        { name: 'Untitled', status: 'lab', link: '', icon: '' },
        { name: 'Untitled', status: 'lab', link: '', icon: '' },
      ];

  return {
    section_order: isNonEmptyStringArray(hp.section_order)
      ? hp.section_order
      : [...DEFAULT_SECTION_ORDER],
    sections: {
      hero: hp.sections?.hero !== false,
      apps: hp.sections?.apps !== false,
      videos: hp.sections?.videos !== false,
      socials: hp.sections?.socials !== false,
      blog_cta: hp.sections?.blog_cta !== false,
    },
    hero: {
      words: isNonEmptyStringArray(hero.words) ? hero.words : ['Web', 'World', 'Wide'],
      tagline: hero.tagline || 'W · W · W',
    },
    apps: { items },
    videos: {
      episode: videos.episode || 'EP. 001',
      film_title: videos.film_title || 'First video — coming soon',
    },
    socials: {
      order: isNonEmptyStringArray(socials.order) ? socials.order : [...DEFAULT_SOCIAL_ORDER],
      hidden: isNonEmptyStringArray(socials.hidden) ? socials.hidden : [],
    },
    blog_cta: {
      kicker: cta.kicker || 'Latest',
      title: cta.title || 'The Web World Wide',
      title_accent: cta.title_accent ?? 'Blog',
      url: cta.url || '/blog/',
    },
  };
}

// Pre-warm the cache so the first component render is fast.
export const siteConfig = getSiteConfig();

// Normalized homepage model — the only thing homepage components should read.
export const homepage: HomepageConfig = normalizeHomepage(siteConfig);
