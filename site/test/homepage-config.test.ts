/**
 * site/test/homepage-config.test.ts
 *
 * Covers `normalizeHomepage` — the defaulting layer that turns whatever
 * homepage-related keys site.toml has (possibly none) into the full model
 * the home-page components consume. The contract under test: an OLD
 * site.toml that predates [homepage]/[hero]/[videos]/items still yields
 * exactly today's homepage (same sections, same four app tiles, same hero
 * text), with the legacy [apps] fileid/doc_finder URLs feeding the first
 * two tiles.
 */

import { describe, it, expect } from 'vitest';
import TOML from '@iarna/toml';
import { normalizeHomepage, type SiteConfig } from '../src/lib/site-config';

const parse = (toml: string): Partial<SiteConfig> =>
  TOML.parse(toml) as unknown as Partial<SiteConfig>;

/** Pre-homepage-editor site.toml: only legacy keys, no [homepage] at all. */
const OLD_TOML = `
[site]
url = "https://webworldwide.online"
title = "Web World Wide"

[social]
youtube = "https://www.youtube.com/@web_world_wide"

[apps]
fileid = "https://example.com/fileid"
doc_finder = ""
`;

describe('normalizeHomepage', () => {
  it('expands an old site.toml (no homepage sections) to the full default model', () => {
    const hp = normalizeHomepage(parse(OLD_TOML));

    expect(hp).toEqual({
      section_order: ['hero', 'apps', 'videos', 'socials', 'blog_cta'],
      sections: { hero: true, apps: true, videos: true, socials: true, blog_cta: true },
      hero: { words: ['Web', 'World', 'Wide'], tagline: 'W · W · W', subtitle: '' },
      apps: {
        items: [
          {
            name: 'FileID',
            status: 'live',
            link: 'https://example.com/fileid',
            icon: '/assets/fileid.png',
          },
          { name: 'Document Finder', status: 'soon', link: '', icon: '/assets/doc-finder.png' },
          { name: 'Untitled', status: 'lab', link: '', icon: '' },
          { name: 'Untitled', status: 'lab', link: '', icon: '' },
        ],
      },
      videos: { episode: 'EP. 001', film_title: 'First video — coming soon' },
      socials: {
        order: [
          'youtube',
          'github',
          'twitter',
          'bluesky',
          'mastodon',
          'reddit',
          'instagram',
          'threads',
        ],
        hidden: [],
      },
      blog_cta: {
        kicker: 'Latest',
        title: 'The Web World Wide',
        title_accent: 'Blog',
        url: '/blog/',
        description: '',
      },
    });
  });

  it('returns full defaults from a completely empty config', () => {
    const hp = normalizeHomepage({});
    expect(hp.hero.words).toEqual(['Web', 'World', 'Wide']);
    expect(hp.apps.items).toHaveLength(4);
    expect(hp.apps.items[0]).toEqual({
      name: 'FileID',
      status: 'live',
      link: '', // no legacy [apps] table → no URL to fall back to
      icon: '/assets/fileid.png',
    });
    expect(hp.sections.blog_cta).toBe(true);
  });

  it('prefers the nested [homepage.*] tables the admin editor writes', () => {
    const hp = normalizeHomepage(
      parse(`
[apps]
fileid = "https://legacy.example/ignored"

[homepage]
section_order = ["apps", "hero"]

[homepage.sections]
videos = false

[homepage.hero]
words = ["Hello", "Wide", "Web", "Of", "Mine"]
tagline = "H · W · W"

[homepage.apps]
items = [ { name = "Solo", status = "live", link = "https://solo.example", icon = "/assets/solo.png" } ]

[homepage.videos]
episode = "EP. 002"
film_title = "Second video"

[homepage.socials]
order = ["github", "youtube"]
hidden = ["threads"]

[homepage.blog_cta]
kicker = "Fresh"
title = "Read the"
title_accent = "Posts"
url = "/posts/"
`),
    );

    expect(hp.section_order).toEqual(['apps', 'hero']);
    expect(hp.sections).toEqual({
      hero: true,
      apps: true,
      videos: false,
      socials: true,
      blog_cta: true,
    });
    expect(hp.hero).toEqual({
      words: ['Hello', 'Wide', 'Web', 'Of', 'Mine'],
      tagline: 'H · W · W',
      subtitle: '',
    });
    expect(hp.apps.items).toEqual([
      { name: 'Solo', status: 'live', link: 'https://solo.example', icon: '/assets/solo.png' },
    ]);
    expect(hp.videos).toEqual({ episode: 'EP. 002', film_title: 'Second video' });
    expect(hp.socials).toEqual({ order: ['github', 'youtube'], hidden: ['threads'] });
    expect(hp.blog_cta).toEqual({
      kicker: 'Fresh',
      title: 'Read the',
      title_accent: 'Posts',
      url: '/posts/',
      description: '',
    });
  });

  it('accepts the top-level [hero]/[videos]/[apps] items aliases', () => {
    const hp = normalizeHomepage(
      parse(`
[hero]
words = ["Two", "Words"]
tagline = "T · W"

[videos]
episode = "EP. 010"
film_title = "Tenth"

[apps]
items = [ { name = "OnlyApp", status = "soon", link = "", icon = "" } ]
`),
    );

    expect(hp.hero).toEqual({ words: ['Two', 'Words'], tagline: 'T · W', subtitle: '' });
    expect(hp.videos).toEqual({ episode: 'EP. 010', film_title: 'Tenth' });
    expect(hp.apps.items).toEqual([{ name: 'OnlyApp', status: 'soon', link: '', icon: '' }]);
  });

  it('fills missing fields inside partially-specified app items', () => {
    const hp = normalizeHomepage({
      homepage: { apps: { items: [{ name: 'Bare' }] } },
    });
    expect(hp.apps.items).toEqual([{ name: 'Bare', status: 'soon', link: '', icon: '' }]);
  });

  it('ignores empty arrays so a half-written config cannot blank the page', () => {
    const hp = normalizeHomepage({
      homepage: { section_order: [], hero: { words: [] }, socials: { order: [], hidden: [] } },
    });
    expect(hp.section_order).toEqual(['hero', 'apps', 'videos', 'socials', 'blog_cta']);
    expect(hp.hero.words).toEqual(['Web', 'World', 'Wide']);
    expect(hp.socials.order).toHaveLength(8);
  });
});
