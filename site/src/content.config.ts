import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';

import { postSchema } from './content/postSchema.mjs';

// Astro 5 canonical content-config location is `src/content.config.ts`. The
// posts live OUTSIDE src/ (at site/content/posts/, managed by the admin CMS),
// so the glob loader needs an explicit base. We pass an absolute file:// href
// computed from THIS file: the loader resolves `base` via
// `new URL(base, config.root)`, and an absolute href ignores config.root, so
// it's root-independent and parses safely on Windows (a bare `C:\…` path would
// be mis-read as a URL scheme).
//
// NOTE: there is intentionally only ONE collection. A second `pages` collection
// previously globbed the PARENT dir (site/content/), whose base contains this
// collection's base (site/content/posts/) — nested collection bases broke
// content loading on the Linux CI/Pages build (the loader filled the data-store
// but `getCollection` returned nothing during page generation, so every
// /blog/* route 404'd). It was unused, so it's gone.
const postsBase = new URL('../content/posts/', import.meta.url).href;

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

export const collections = { posts };
