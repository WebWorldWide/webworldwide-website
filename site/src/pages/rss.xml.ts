import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';
import { siteConfig } from '@/lib/site-config';
import { isPublished, postSlug, sortByDateDesc } from '@/lib/post-utils';

const siteToml = siteConfig;

export async function GET(context: APIContext) {
  const posts = (await getCollection('posts', isPublished)).sort(sortByDateDesc);

  return rss({
    title: siteToml.site.title,
    description: siteToml.site.description,
    site: context.site ?? siteToml.site.url,
    items: posts.map((post) => {
      const slug = postSlug(post);
      return {
        title: post.data.title,
        link: `/blog/${slug}/`,
        pubDate: post.data.date,
        description: post.data.excerpt ?? '',
        categories: post.data.tags,
      };
    }),
    customData: `<language>en-US</language>`,
  });
}
