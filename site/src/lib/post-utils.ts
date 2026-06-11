/**
 * Post helpers — slug, date, reading time, sort, etc.
 */

// Posts are loaded from content/posts/*.md via Vite's import.meta.glob (see
// lib/posts.ts), NOT Astro content collections — getCollection() returned 0
// entries on the Linux build. PostEntry is therefore a structural type whose
// data shape is inferred from postSchema.mjs (type-only import — no runtime
// dependency, no zod in the client bundle).
export type PostData = import('zod').infer<typeof import('../content/postSchema.mjs').postSchema>;

export interface PostEntry {
  id: string;
  data: PostData;
  body: string;
}

export function postSlug(post: PostEntry): string {
  return post.data.slug ?? post.id.replace(/\.md$/, '');
}

export function postUrl(post: PostEntry): string {
  return `/blog/${postSlug(post)}/`;
}

export function fmtDate(date: Date | string | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  return d
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    .toUpperCase();
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 250 wpm — keep in lockstep with the admin editor's computeMetrics()
 * so every surface quotes the same minutes for the same post.
 * Frontmatter `read` (minutes) wins if present.
 */
export function readingTime(post: PostEntry, body: string): number {
  if (typeof post.data.read === 'number') return post.data.read;
  const words = body.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / 250));
}

export function sortByDateDesc(a: PostEntry, b: PostEntry): number {
  return b.data.date.getTime() - a.data.date.getTime();
}

/**
 * Single source of truth for "is this post live?". Used by the blog listing,
 * the post detail route, and the RSS feed so the three surfaces never drift.
 * A post is published unless it's a draft or scheduled for a future date
 * (`publish_at` — a latent schema field the admin writes for scheduled posts).
 */
export function isPublished(post: PostEntry, now: Date = new Date()): boolean {
  if (post.data.draft) return false;
  if (post.data.publish_at && post.data.publish_at.getTime() > now.getTime()) return false;
  return true;
}

/** Slim post summary shape passed to the ⌘K palette island. */
export interface PostSummary {
  title: string;
  slug: string;
  url: string;
  date: string;
  read: number;
  excerpt: string;
}

export function toSummary(post: PostEntry, body: string): PostSummary {
  const slug = postSlug(post);
  return {
    title: post.data.title,
    slug,
    url: `/blog/${slug}/`,
    date: post.data.date.toISOString(),
    read: readingTime(post, body),
    excerpt: post.data.excerpt ?? deriveExcerpt(body),
  };
}

/** An image reference pulled from a post (frontmatter cover or first body image). */
export interface PostImage {
  src: string;
  alt: string;
}

/** First markdown image in the body, or null if the post has none. */
export function firstImage(body: string): PostImage | null {
  const m = body.match(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/);
  if (!m) return null;
  return { src: m[2], alt: (m[1] ?? '').trim() };
}

/**
 * The lead image for a post: frontmatter `cover` if set, otherwise the first
 * image found in the body. Returns null when the post has no images at all.
 */
export function coverImage(post: PostEntry, body: string): PostImage | null {
  if (post.data.cover) {
    return { src: post.data.cover, alt: post.data.cover_alt ?? post.data.title };
  }
  return firstImage(body);
}

/**
 * Fallback excerpt: the first prose paragraph, trimmed to a sensible length on
 * a complete-sentence (or at worst word) boundary — never cut mid-word. Returns
 * '' when the post opens with no prose (e.g. just an image), so callers can omit
 * the line rather than show a nonsensical fragment.
 */
export function deriveExcerpt(body: string): string {
  const cleaned = body
    .replace(/^---[\s\S]+?---/, '') // frontmatter
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links → label
    .replace(/[`*_>#]/g, '') // md noise (keep hyphens/dashes in prose)
    .trim();
  // First non-empty paragraph, whitespace collapsed to single spaces.
  const para = (cleaned.split(/\n\n+/).find((p) => p.trim()) ?? '').replace(/\s+/g, ' ').trim();
  if (!para) return '';
  const LIMIT = 180;
  if (para.length <= LIMIT) return para;
  const window = para.slice(0, LIMIT);
  const sentenceEnd = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
  );
  if (sentenceEnd >= 80) return window.slice(0, sentenceEnd + 1);
  const wordEnd = window.lastIndexOf(' ');
  return (wordEnd > 0 ? window.slice(0, wordEnd) : window).trimEnd() + '…';
}
