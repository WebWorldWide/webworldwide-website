import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { siteConfig } from '@/lib/site-config';
import { getPostHtml, getPosts } from '@/lib/posts';
import { postSlug, deriveExcerpt } from '@/lib/post-utils';

const siteToml = siteConfig;

export async function GET(context: APIContext) {
  const posts = getPosts();
  const site = String(context.site ?? siteToml.site.url).replace(/\/$/, '');
  const newest = posts[0]?.data.date ? new Date(posts[0].data.date) : new Date();

  const items = await Promise.all(
    posts.map(async (post) => {
      const slug = postSlug(post);
      return {
        title: post.data.title,
        link: `/blog/${slug}/`,
        pubDate: post.data.date,
        // Same fallback as the post page's meta description: most posts have
        // no frontmatter excerpt, and @astrojs/rss omits <description>
        // entirely for a falsy value.
        description: post.data.excerpt || deriveExcerpt(post.body) || '',
        // Full post, so readers can read it in their feed app.
        content: await getPostHtml(post.id, site),
      };
    }),
  );

  return rss({
    title: siteToml.site.title,
    description: siteToml.site.description,
    site,
    xmlns: { atom: 'http://www.w3.org/2005/Atom' },
    items,
    customData: [
      '<language>en-US</language>',
      `<lastBuildDate>${newest.toUTCString()}</lastBuildDate>`,
      // Validators (and some readers) expect the feed to name its own URL.
      `<atom:link href="${site}/rss.xml" rel="self" type="application/rss+xml"/>`,
    ].join(''),
  });
}
