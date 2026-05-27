import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * Posts collection — Markdown files at site/content/posts/*.md
 *
 * Schema is a LOOSE SUPERSET of what the admin's posts route
 * (admin/src/routes/posts.js) emits. We use .passthrough() so the admin
 * can add new frontmatter fields without breaking builds. We deliberately
 * avoid strict validators (.url(), .nonempty()) — the admin produces
 * partial drafts during authoring.
 *
 * IMPORTANT: this schema is imported by the admin at runtime
 * (see admin/src/routes/posts.js) so pre-publish validation matches
 * what Astro will accept. Single source of truth.
 */
export const postSchema = z
  .object({
    title: z.string(),
    date: z.coerce.date(),
    slug: z.string().optional(),
    draft: z.boolean().default(false),
    tags: z.array(z.string()).default([]),
    series: z.string().optional(),
    publish_at: z.coerce.date().optional(),
    cover: z.string().optional(),
    cover_alt: z.string().optional(),
    excerpt: z.string().optional(),
    read: z.number().int().optional(),
    bluesky_uri: z.string().optional(),
    canonical_url: z.string().optional(),
    type: z.string().optional()
  })
  .passthrough();

const posts = defineCollection({
  // `base` is relative to the project root (site/), not src/content/.
  loader: glob({ pattern: '*.md', base: './content/posts' }),
  schema: postSchema
});

const pages = defineCollection({
  loader: glob({ pattern: '*.md', base: './content' }),
  schema: z
    .object({
      title: z.string(),
      date: z.coerce.date().optional(),
      slug: z.string().optional(),
      draft: z.boolean().default(false),
      type: z.string().optional()
    })
    .passthrough()
});

export const collections = { posts, pages };
