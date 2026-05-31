/**
 * site/test/post-utils.test.ts
 *
 * Covers the lead-image helpers added for the blog redesign: `firstImage`
 * (pull the first markdown image out of a post body) and `coverImage`
 * (prefer frontmatter `cover`, else fall back to the first body image).
 * These drive the featured-post hero on the blog listing, so a regression
 * here means posts silently lose their image.
 */

import { describe, it, expect } from 'vitest';
import { firstImage, coverImage } from '../src/lib/post-utils';

type AnyPost = Parameters<typeof coverImage>[0];
const makePost = (data: Record<string, unknown>): AnyPost => ({ data }) as unknown as AnyPost;

describe('firstImage', () => {
  it('extracts the first markdown image (src + alt)', () => {
    const img = firstImage('Intro paragraph.\n\n![A grey cat](/images/cat.png)\n\nMore text.');
    expect(img).toEqual({ src: '/images/cat.png', alt: 'A grey cat' });
  });

  it('keeps the src and drops a trailing title', () => {
    const img = firstImage('![Logo](/logo.png "Brand logo")');
    expect(img).toEqual({ src: '/logo.png', alt: 'Logo' });
  });

  it('handles an empty alt', () => {
    expect(firstImage('![](/x.png)')).toEqual({ src: '/x.png', alt: '' });
  });

  it('returns the FIRST image when several are present', () => {
    expect(firstImage('![one](/1.png) and ![two](/2.png)')?.src).toBe('/1.png');
  });

  it('returns null when the body has no image', () => {
    expect(firstImage('Just prose with a [link](/somewhere) but no image.')).toBeNull();
  });
});

describe('coverImage', () => {
  it('prefers the frontmatter cover and its cover_alt', () => {
    const img = coverImage(
      makePost({ title: 'T', cover: '/c.png', cover_alt: 'Cover alt' }),
      '![body](/b.png)',
    );
    expect(img).toEqual({ src: '/c.png', alt: 'Cover alt' });
  });

  it('falls back to the post title when cover_alt is missing', () => {
    const img = coverImage(makePost({ title: 'My Title', cover: '/c.png' }), '');
    expect(img).toEqual({ src: '/c.png', alt: 'My Title' });
  });

  it('uses the first body image when there is no cover frontmatter', () => {
    const img = coverImage(makePost({ title: 'T' }), 'intro ![lead image](/lead.png)');
    expect(img).toEqual({ src: '/lead.png', alt: 'lead image' });
  });

  it('returns null when there is neither a cover nor a body image', () => {
    expect(coverImage(makePost({ title: 'T' }), 'no images here at all')).toBeNull();
  });
});
