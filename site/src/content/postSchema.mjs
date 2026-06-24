// @ts-check
/**
 * Plain ESM module — single source of truth for post frontmatter shape.
 * Re-exported by site/src/content/config.ts (which adds the Astro
 * `defineCollection` wrapper) and imported by admin/src/utils/frontmatter.js
 * for pre-publish validation.
 *
 * Schema is a LOOSE SUPERSET (`.passthrough()`) — the admin can add new
 * fields without breaking the build, and partial drafts pass validation
 * during authoring. We deliberately avoid strict validators (.url(),
 * .nonempty()) — the admin commits drafts.
 *
 * Adding a field? Add it here ONLY. Both the Astro build and admin
 * validation pick it up automatically.
 */

import { z } from 'zod';

export const postSchema = z
  .object({
    title: z.string(),
    date: z.coerce.date(),
    slug: z.string().optional(),
    draft: z.boolean().default(false),
    series: z.string().optional(),
    publish_at: z.coerce.date().optional(),
    cover: z.string().optional(),
    cover_alt: z.string().optional(),
    excerpt: z.string().optional(),
    read: z.number().int().optional(),
    bluesky_uri: z.string().optional(),
    canonical_url: z.string().optional(),
    type: z.string().optional(),
  })
  .loose();

/**
 * Validate a frontmatter object against the post schema.
 * Returns either { ok: true, data } or { ok: false, errors: [{path, message}, ...] }.
 *
 * Designed for admin pre-publish use: callers can surface `errors` as
 * editor callouts without throwing.
 *
 * @param {unknown} data
 * @returns {{ ok: boolean, data?: import('zod').infer<typeof postSchema>, errors?: Array<{ path: string, message: string }> }}
 */
export function validatePost(data) {
  const result = postSchema.safeParse(data);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  const errors = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
  return { ok: false, errors };
}
