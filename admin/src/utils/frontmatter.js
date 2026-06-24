import matter from 'gray-matter';
import jsYaml from 'js-yaml';
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
 * gray-matter bundles js-yaml 3, which carries a moderate ReDoS advisory
 * (GHSA-h67p-54hq-rp68) and is unmaintained. Drive its YAML through js-yaml 4
 * instead: `load`/`dump` are the v4 names for v3's `safeLoad`/`safeDump` and
 * emit byte-compatible output, so existing post frontmatter serializes
 * unchanged. The package override pins gray-matter's js-yaml to 4.x so the
 * vulnerable 3.x leaves the dependency tree entirely.
 *
 *   lineWidth: -1 — never wrap long strings; front-matter URLs would otherwise
 *   fold across newlines and break parsers.
 */
const yamlEngine = {
  parse: (/** @type {string} */ str) => jsYaml.load(str),
  stringify: (/** @type {any} */ obj) => jsYaml.dump(obj, { lineWidth: -1 }),
};
const matterOpts = /** @type {any} */ ({ engines: { yaml: yamlEngine }, language: 'yaml' });

/**
 * Parse frontmatter and content from a markdown string.
 * @param {string} fileContent - Raw markdown file content with optional YAML frontmatter.
 * @returns {{ data: Record<string, unknown>, content: string }} Parsed frontmatter and body.
 */
export function parsePost(fileContent) {
  const parsed = matter(fileContent, matterOpts);
  return {
    data: parsed.data, // Frontmatter object
    content: parsed.content, // Markdown body
  };
}

/**
 * Stringify frontmatter object and content back into a markdown string.
 *
 * @param {Record<string, any>} data - Frontmatter fields to serialize.
 * @param {string} content - Markdown body.
 * @returns {string} Combined markdown string with YAML frontmatter.
 */
export function serializePost(data, content) {
  return matter.stringify(content, data, matterOpts);
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
