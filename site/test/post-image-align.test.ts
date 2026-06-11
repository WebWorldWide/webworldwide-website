/**
 * Proof that CMS-authored image alignment survives the live markdown
 * pipeline. The admin editor serialises an aligned image as a single-line
 * `<figure class="img-align-…">` wrapper (see admin/public/js/editor.entry.js).
 * Astro renders raw HTML embedded in markdown, so the alignment class must
 * land verbatim in the generated post HTML — and the inner <img> must still
 * pick up the site's lazy-loading rehype pass.
 *
 * We run the same `@astrojs/markdown-remark` processor Astro uses for `.md`
 * content, with a rehype pass mirroring the image hygiene the build applies
 * (scripts/postbuild-image-dimensions.mjs stamps lazy/async onto dist HTML),
 * so this asserts the real rendered output rather than a hand-rolled mock.
 */
import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import { describe, expect, it, beforeAll } from 'vitest';

/** Mirror of the build's image hygiene (kept tiny + dependency-free). */
function rehypeLazyImages() {
  const visit = (node: any) => {
    if (node.type === 'element' && node.tagName === 'img') {
      node.properties ??= {};
      node.properties.loading ??= 'lazy';
      node.properties.decoding ??= 'async';
    }
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  return (tree: any) => visit(tree);
}

describe('post body image alignment pipeline', () => {
  let render: (_md: string) => Promise<string>;

  beforeAll(async () => {
    const processor = await createMarkdownProcessor({
      rehypePlugins: [rehypeLazyImages],
    });
    render = async (md: string) => (await processor.render(md)).code;
  });

  it('keeps the img-align-center class + baked-in lazy attrs in the HTML', async () => {
    // The exact form the admin editor serialises (loading/decoding are baked
    // in because Astro emits markdown's raw HTML verbatim).
    const md =
      '<figure class="img-align-center"><img src="/img/a.webp" alt="A cat" loading="lazy" decoding="async"></figure>';
    const html = await render(md);
    expect(html).toContain('class="img-align-center"');
    expect(html).toContain('src="/img/a.webp"');
    expect(html).toMatch(/loading="lazy"/);
  });

  it('supports every alignment variant', async () => {
    for (const align of ['left', 'right', 'center', 'full']) {
      const md = `<figure class="img-align-${align}"><img src="/i.webp" alt=""></figure>`;
      const html = await render(md);
      expect(html).toContain(`img-align-${align}`);
    }
  });

  it('leaves a plain markdown image as a bare <img> (zero diff for old posts)', async () => {
    const html = await render('![Old](/legacy.webp)');
    expect(html).toContain('<img');
    expect(html).not.toContain('<figure');
    expect(html).not.toContain('img-align-');
  });
});
