import matter from 'gray-matter';

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
  // Ensure tags are an array
  if (typeof data.tags === 'string') {
    data.tags = data.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  // js-yaml options (passed through by gray-matter to safeDump):
  //   lineWidth: -1 — never wrap long strings (URLs in front-matter
  //     would otherwise fold across newlines and break Hugo's parser).
  return matter.stringify(content, data, /** @type {any} */ ({ lineWidth: -1 }));
}
