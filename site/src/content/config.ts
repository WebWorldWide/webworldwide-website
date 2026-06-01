import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { postSchema } from './postSchema.mjs';

// Absolute file:// hrefs to the content dirs, resolved from THIS file. The
// glob loader resolves `base` via `new URL(base, config.root)`; a relative
// base ('./content/posts') therefore depends on Astro's inferred root, which
// differed on the Linux CI runner — the loader found zero posts there (while
// prebuild's readdir found all 23), so the blog collection was empty and every
// /blog/* route 404'd. An absolute file:// href ignores config.root entirely
// and is parsed safely on Windows (a bare `C:\…` path is mis-read as a URL
// scheme). Cross-platform and root-independent.
const postsBase = new URL('../../content/posts/', import.meta.url).href;
const contentBase = new URL('../../content/', import.meta.url).href;

/**
 * Posts collection — Markdown files at site/content/posts/*.md
 *
 * The schema lives in postSchema.mjs (plain ESM) so admin can import
 * it for pre-publish validation. Single source of truth — adding a field
 * means editing postSchema.mjs only.
 */
export { postSchema };

const posts = defineCollection({
  loader: glob({ pattern: '*.md', base: postsBase }),
  schema: postSchema,
});

const pages = defineCollection({
  loader: glob({ pattern: '*.md', base: contentBase }),
  schema: z
    .object({
      title: z.string(),
      date: z.coerce.date().optional(),
      slug: z.string().optional(),
      draft: z.boolean().default(false),
      type: z.string().optional(),
    })
    .passthrough(),
});

export const collections = { posts, pages };
