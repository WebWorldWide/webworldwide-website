import { readFile, readdir } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineCollection } from 'astro:content';
import type { Loader } from 'astro/loaders';
import matter from 'gray-matter';

import { postSchema } from './content/postSchema.mjs';

// Posts live at site/content/posts/*.md — outside src/, managed by the admin
// CMS. We deliberately do NOT use Astro's built-in glob() loader here:
//
// glob() stores markdown entries with DEFERRED rendering (it writes a module map
// to .astro/content-modules.mjs and renders lazily). On the Linux CI / GitHub
// Pages build that deferred path produced an empty collection — the loader
// filled node_modules/.astro/data-store.json with all 23 posts, but
// getCollection('posts') returned 0 during page generation, so only the home
// page built and every /blog/* route 404'd. It worked on Windows, which hid it.
//
// This hand-rolled loader reads the files with fs.readdir (identical on every
// platform — prebuild.mjs relies on the same) and renders each post INLINE via
// the loader context's renderMarkdown(), storing the HTML on the entry. That
// sidesteps the deferred module entirely. The schema stays single-sourced in
// postSchema.mjs (imported by the admin too).
const postsURL = new URL('../content/posts/', import.meta.url);

const postsLoader: Loader = {
  name: 'posts-fs',
  load: async ({ store, parseData, renderMarkdown, generateDigest, logger, config }) => {
    store.clear();
    const root = fileURLToPath(config.root);
    const dir = fileURLToPath(postsURL);
    const files = (await readdir(dir)).filter((file) => file.endsWith('.md'));
    for (const file of files) {
      const fileURL = new URL(file, postsURL);
      const absPath = fileURLToPath(fileURL);
      // Astro's data store requires filePath relative to the project root, posix.
      const filePath = relative(root, absPath).split(sep).join('/');
      // Normalise CRLF so frontmatter + body parse identically on every OS.
      const raw = (await readFile(absPath, 'utf-8')).replace(/\r\n/g, '\n');
      const { data: frontmatter, content: body } = matter(raw);
      const id = file.replace(/\.md$/, '');
      const data = await parseData({ id, data: frontmatter, filePath: absPath });
      const rendered = await renderMarkdown(body, { fileURL });
      store.set({
        id,
        data,
        body,
        filePath,
        digest: generateDigest(raw),
        rendered,
        assetImports: rendered.metadata?.imagePaths,
      });
    }
    logger.info(`posts-fs: loaded ${files.length} post(s)`);
  },
};

/**
 * Posts collection — Markdown files at site/content/posts/*.md
 *
 * The schema lives in postSchema.mjs (plain ESM) so admin can import it for
 * pre-publish validation. Single source of truth — adding a field means
 * editing postSchema.mjs only.
 */
export { postSchema };

const posts = defineCollection({ loader: postsLoader, schema: postSchema });

export const collections = { posts };
