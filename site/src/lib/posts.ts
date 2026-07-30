/**
 * Posts loader — Vite's import.meta.glob over content/posts/*.md.
 *
 * We do NOT use an Astro content collection (getCollection): on the Linux CI /
 * GitHub Pages build it returned 0 entries even though the loader had filled the
 * data-store with all 23 posts — an Astro content-layer bug that survived every
 * workaround (canonical config, custom fs loader with inline render, explicit
 * astro sync, Astro 5 → 6). It builds fine on Windows, which hid it.
 *
 * import.meta.glob is resolved by Vite at build time and behaves identically on
 * every platform. The frontmatter is validated/coerced through the shared
 * postSchema (single source of truth, also used by the admin).
 */
import type { MarkdownInstance } from 'astro';

import { postSchema } from '../content/postSchema.mjs';
import { isPublished, sortByDateDesc, type PostEntry } from './post-utils';

type PostModule = MarkdownInstance<Record<string, unknown>>;

const modules = import.meta.glob<PostModule>('../../content/posts/*.md', { eager: true });

const idFromPath = (path: string): string => path.split('/').pop()!.replace(/\.md$/, '');

/**
 * All published posts, newest first. Plain data only (no Content component), so
 * the result is safe to pass through getStaticPaths props / paginate().
 */
export function getPosts(): PostEntry[] {
  return Object.entries(modules)
    .flatMap(([path, mod]) => {
      // safeParse, not parse: a single post with invalid/incomplete
      // frontmatter (e.g. a work-in-progress draft missing title/date) must
      // never throw here and take down the entire static build — every page
      // that lists posts (blog index, every post's getStaticPaths, rss.xml)
      // calls getPosts(). Skip the offending post instead.
      const result = postSchema.safeParse(mod.frontmatter);
      if (!result.success) {
        const issues = result.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
        console.warn(`[posts] skipping ${path}: invalid frontmatter (${issues})`);
        return [];
      }
      return [
        {
          id: idFromPath(path),
          data: result.data as PostEntry['data'],
          body: mod.rawContent(),
        },
      ];
    })
    .filter((post) => isPublished(post))
    .sort(sortByDateDesc);
}

/**
 * The rendered `<Content />` component for a post id. Kept out of getStaticPaths
 * props because an Astro component isn't serialisable; the detail page re-derives
 * it here from the same module map.
 */
export function getPostContent(id: string): PostModule['Content'] | undefined {
  for (const [path, mod] of Object.entries(modules)) {
    if (idFromPath(path) === id) return mod.Content;
  }
  return undefined;
}
