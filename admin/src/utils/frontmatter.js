import matter from 'gray-matter';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Single source of truth post schema + validator, defined in
 * site/src/content/postSchema.mjs and shared by Admin and Astro — adding a
 * field means editing postSchema.mjs only.
 *
 * postSchema.mjs is part of the site SOURCE tree, whose location relative to
 * this file differs by deployment: in the repo, admin/ and site/ are siblings;
 * in the Docker image the admin code lives at /app and site is mounted at
 * /app/site. Probe both source locations rather than hardcoding one (the old
 * fixed '../../../site' specifier resolved to /site and crash-looped the
 * container). It is resolved from the source tree, NOT from SITE_DIR, because
 * SITE_DIR may point at a content-only directory (e.g. a test fixture) that
 * does not carry the schema source.
 */
const here = dirname(fileURLToPath(import.meta.url));
const schemaCandidates = [
  join(here, '..', '..', '..', 'site', 'src', 'content', 'postSchema.mjs'), // repo: admin/ & site/ siblings
  join(here, '..', '..', 'site', 'src', 'content', 'postSchema.mjs'), // image: site under /app
];
const schemaPath = schemaCandidates.find((p) => existsSync(p)) ?? schemaCandidates[0];

const { validatePost: validatePostSchema, postSchema } = await import(
  pathToFileURL(schemaPath).href
);

export { postSchema, validatePostSchema };

/**
 * Parse frontmatter and content from a markdown string.
 * @param {string} fileContent - Raw markdown file content with optional YAML frontmatter.
 * @returns {{ data: Record<string, unknown>, content: string }} Parsed frontmatter and body.
 */
export function parsePost(fileContent) {
  const parsed = matter(fileContent);
  return {
    data: parsed.data, // Frontmatter object
    content: parsed.content, // Markdown body
  };
}

/**
 * Stringify frontmatter object and content back into a markdown string.
 *
 * Phase 9 fix: the previous shape (`{ engines: { yaml: { lineWidth: -1 } } }`)
 * REPLACED gray-matter's default yaml engine with a plain options
 * object, causing `engine.stringify is not a function`. Gray-matter
 * passes `options` straight through to `js-yaml.safeDump`, so the
 * correct way to set `lineWidth` is as a top-level option.
 *
 * @param {Record<string, any>} data - Frontmatter fields to serialize.
 * @param {string} content - Markdown body.
 * @returns {string} Combined markdown string with YAML frontmatter.
 */
export function serializePost(data, content) {
  // js-yaml options (passed through by gray-matter to safeDump):
  //   lineWidth: -1 — never wrap long strings (URLs in front-matter
  //     would otherwise fold across newlines and break parsers).
  return matter.stringify(content, data, /** @type {any} */ ({ lineWidth: -1 }));
}

/**
 * Validate a frontmatter object for publish. Drafts (data.draft === true)
 * always pass — the writer is mid-authoring and the editor handles
 * incomplete state. Non-drafts get the full Zod check; any failure
 * surfaces as a structured error list the editor can render.
 *
 * @param {Record<string, unknown>} data
 * @returns {{ ok: boolean, errors?: Array<{ path: string, message: string }> }}
 */
export function validateForPublish(data) {
  if (data && data.draft === true) {
    return { ok: true };
  }
  const result = validatePostSchema(data);
  if (result.ok) {
    return { ok: true };
  }
  return { ok: false, errors: result.errors };
}
