import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';
import { readFileSync } from 'node:fs';
import TOML from '@iarna/toml';

const siteToml = TOML.parse(
  readFileSync(new URL('../../site.toml', import.meta.url), 'utf-8')
) as unknown as {
  site: { title: string; description: string; url: string };
};

export async function GET(context: APIContext) {
  const posts = (await getCollection('posts'))
    .filter((p) => !p.data.draft)
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime());

  return rss({
    title: siteToml.site.title,
    description: siteToml.site.description,
    site: context.site ?? siteToml.site.url,
    items: posts.map((post) => {
      const slug = post.data.slug ?? post.id.replace(/\.md$/, '');
      return {
        title: post.data.title,
        link: `/blog/${slug}/`,
        pubDate: post.data.date,
        description: post.data.excerpt ?? '',
        categories: post.data.tags
      };
    }),
    customData: `<language>en-US</language>`
  });
}
