import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { siteConfig } from '@/lib/site-config';
import { getPosts } from '@/lib/posts';
import { postSlug, deriveExcerpt } from '@/lib/post-utils';

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
        // Same fallback as the post page's meta description — most posts have
        // no frontmatter excerpt, and @astrojs/rss omits <description> entirely
        // for a falsy value, so an empty string here silently ships item-less feed entries.
        description: post.data.excerpt || deriveExcerpt(post.body) || '',
      };
    }),
    customData: `<language>en-US</language>`,
  });
}
