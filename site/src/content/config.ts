import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { postSchema } from './postSchema.mjs';

/**
 * Posts collection — Markdown files at site/content/posts/*.md
 *
 * The schema lives in postSchema.mjs (plain ESM) so admin can import
 * it for pre-publish validation. Single source of truth — adding a field
 * means editing postSchema.mjs only.
 */
export { postSchema };

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
