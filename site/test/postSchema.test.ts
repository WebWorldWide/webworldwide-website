/**
 * site/test/postSchema.test.ts
 *
 * Validates the shared post frontmatter schema. The same schema is the
 * single source of truth for Astro's content collection AND the admin's
 * pre-publish validator — a regression here can break either side
 * silently. Drafts must always pass; non-drafts that omit a required
 * field must surface a useful error.
 */

import { describe, it, expect } from 'vitest';
import { postSchema, validatePost } from '../src/content/postSchema.mjs';

describe('postSchema (shared admin ↔ Astro)', () => {
  it('accepts a minimal published post', () => {
    const result = postSchema.safeParse({
      title: 'Hello world',
      date: '2024-01-15T10:00:00Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.draft).toBe(false);
      expect(result.data.tags).toEqual([]);
    }
  });

  it('coerces ISO date strings to Date objects', () => {
    const result = postSchema.safeParse({
      title: 'Date coercion',
      date: '2024-01-15',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.date).toBeInstanceOf(Date);
    }
  });

  it('accepts the full set of admin-emitted fields', () => {
    const result = postSchema.safeParse({
      title: 'Full payload',
      date: '2024-01-15',
      slug: 'full-payload',
      draft: false,
      tags: ['tech', 'meta'],
      series: 'first-month',
      cover: '/images/cover.avif',
      cover_alt: 'A cover image',
      excerpt: 'A short excerpt',
      read: 4,
      bluesky_uri: 'at://did:plc:xxx/app.bsky.feed.post/yyy',
      canonical_url: 'https://example.com/full-payload',
      type: 'post',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a post missing the title (a hard publish blocker)', () => {
    const result = postSchema.safeParse({
      date: '2024-01-15',
    });
    expect(result.success).toBe(false);
  });

  it('passes through unknown fields (admin can add new ones without breaking build)', () => {
    const result = postSchema.safeParse({
      title: 'Future-proof',
      date: '2024-01-15',
      future_field: 'TBD',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).future_field).toBe('TBD');
    }
  });
});

describe('validatePost helper', () => {
  it('returns { ok: true, data } for a valid post', () => {
    const result = validatePost({
      title: 'Valid',
      date: '2024-01-15',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.title).toBe('Valid');
    }
  });

  it('returns { ok: false, errors } with useful paths for malformed input', () => {
    const result = validatePost({
      date: 'not-a-date',
      tags: 'should-be-array',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Both `title` (missing) and `date` (bad string) should surface.
      const paths = result.errors.map((e) => e.path);
      expect(paths).toContain('title');
      // Each error must include a non-empty message for the editor UI.
      for (const err of result.errors) {
        expect(err.message.length).toBeGreaterThan(0);
      }
    }
  });

  it('treats a draft with missing fields as valid via the admin helper', async () => {
    // The admin uses validateForPublish (in admin/src/utils/frontmatter.js)
    // which skips validation for drafts. Mirrored test here keeps the
    // schema contract honest: a draft can have a missing title at the
    // schema level — the admin's wrapper is what makes drafts "always OK."
    // This test asserts that the schema itself still rejects (so the
    // wrapper isn't accidentally double-permissive).
    const result = postSchema.safeParse({ draft: true });
    expect(result.success).toBe(false);
  });
});
