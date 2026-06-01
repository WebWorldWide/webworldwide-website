import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

import { postSchema } from './content/postSchema.mjs';

// Astro 5 canonical content-config location is `src/content.config.ts`. The
// legacy `src/content/config.ts` location was not being picked up on the Linux
// CI runner, so the collections were never defined and every /blog/* route
// 404'd (tinyglobby found all 23 posts there, but Astro never invoked the
// loader). See git history for the long debugging trail.
//
// Absolute file:// hrefs to the content dirs (the posts live OUTSIDE src/, at
// site/content/posts/). The glob loader resolves `base` via
// `new URL(base, config.root)`; an absolute href ignores config.root entirely,
// so it's root-independent and parses safely on Windows (a bare `C:\…` path is
// mis-read as a URL scheme).
const postsBase = new URL('../content/posts/', import.meta.url).href;
const contentBase = new URL('../content/', import.meta.url).href;

// TEMP DEBUG — remove once CI content loading is fixed.
{
  const { existsSync, readdirSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  let info = '';
  try {
    const p = fileURLToPath(postsBase);
    info = `exists=${existsSync(p)} md=${existsSync(p) ? readdirSync(p).filter((f) => f.endsWith('.md')).length : 'NA'}`;
  } catch (e) {
    info = `err=${e instanceof Error ? e.message : String(e)}`;
  }
  // eslint-disable-next-line no-console
  console.error(
    `[cfg-debug] import.meta.url=${import.meta.url} cwd=${process.cwd()} postsBase=${postsBase} ${info}`,
  );
}

/**
 * Posts collection — Markdown files at site/content/posts/*.md
 *
 * The schema lives in postSchema.mjs (plain ESM) so admin can import it for
 * pre-publish validation. Single source of truth — adding a field means
 * editing postSchema.mjs only.
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
