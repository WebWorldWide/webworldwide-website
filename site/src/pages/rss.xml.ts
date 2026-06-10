import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { siteConfig } from '@/lib/site-config';
import { getPosts } from '@/lib/posts';
import { postSlug } from '@/lib/post-utils';

const siteToml = siteConfig;

export async function GET(context: APIContext) {
  const posts = getPosts();

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
      };
    }),
    customData: `<language>en-US</language>`,
  });
}
