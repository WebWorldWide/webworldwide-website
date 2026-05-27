/**
 * Post helpers — slug, date, reading time, sort, etc.
 */
import type { CollectionEntry } from 'astro:content';

export type PostEntry = CollectionEntry<'posts'>;

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
 * Average adult reading speed is ~225 wpm. We use 220 as a slightly
 * conservative round number that matches Hugo's `.ReadingTime` default.
 * Frontmatter `read` (minutes) wins if present.
 */
export function readingTime(post: PostEntry, body: string): number {
  if (typeof post.data.read === 'number') return post.data.read;
  const words = body.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / 220));
}

export function sortByDateDesc(a: PostEntry, b: PostEntry): number {
  return b.data.date.getTime() - a.data.date.getTime();
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
    excerpt: post.data.excerpt ?? deriveExcerpt(body)
  };
}

/** Fallback excerpt: first ~180 chars of body, stripping markdown noise. */
export function deriveExcerpt(body: string): string {
  const stripped = body
    .replace(/^---[\s\S]+?---/, '') // frontmatter
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links → label
    .replace(/[`*_>#-]/g, '')
    .trim();
  const first = stripped.split(/\n\n+/)[0] ?? '';
  if (first.length <= 180) return first;
  return first.slice(0, 177).trimEnd() + '…';
}
