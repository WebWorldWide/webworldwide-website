// @ts-check
/**
 * toml-roundtrip.js — preserve-comments TOML editor.
 *
 * Phase 5e: the site-settings editor reads `site/hugo.toml`, lets the
 * user tweak fields in a form, and writes the file back. We MUST keep
 * the hand-authored ordering + comment lines intact — otherwise every
 * save would scramble the canonical config that contributors read.
 *
 * Strategy:
 *
 *   1. `parse(src)`  — uses @iarna/toml to produce a fully-typed plain
 *      object. Comments are lost in the object but the original `src`
 *      stays available to `apply`. The parser also gives us field-typed
 *      values (numbers stay numbers, dates stay dates, etc.).
 *
 *   2. `apply(src, changes)` — surgical line edit. For each
 *      `{ section: "params", key: "umamiSiteID", value: "abc" }` change:
 *        - locate the `[params]` (or `[params.foo]`) header line
 *        - within that section's range, find the `key =` line
 *        - rewrite ONLY that line's right-hand side using TOML-safe
 *          serialization, keeping the original indentation and any
 *          trailing inline comment intact
 *        - if the key doesn't exist, append it as the last non-blank
 *          line of the section
 *      Top-level keys (no `section`) live above the first header.
 *
 *   3. Section creation: if `section` doesn't exist, append a new
 *      `[section]` block at EOF.
 *
 * Limitations (deliberate; documented for future maintainers):
 *
 *   - We don't support nested-table changes deeper than one dot in the
 *     `section` path (e.g. `[params.social.bluesky]` works, but four
 *     levels deep is untested). hugo.toml doesn't go that deep.
 *   - Array-of-tables (`[[foo]]`) is read-only; the editor surfaces
 *     them as JSON blobs and round-trips them with the array re-emitted
 *     in place from scratch. Since hugo.toml has no `[[…]]` rows today
 *     this only matters if we add some.
 *   - We DON'T attempt to preserve sub-comments inside arrays. If you
 *     hand-comment a single element of a multi-line array, that comment
 *     is dropped on write. The hugo.toml in this repo has no such
 *     comments today.
 *
 * Tests live in admin/test/settings.test.js — the canonical contract is
 * "a round-trip with no changes yields a byte-equal file" plus "changing
 * one key preserves every other line including comments and blanks".
 */

import TOML from '@iarna/toml';

/**
 * Parse a TOML string. Errors propagate so callers can return 400.
 *
 * @param {string} src
 * @returns {Record<string, any>}
 */
export function parse(src) {
  return /** @type {Record<string, any>} */ (TOML.parse(src));
}

/**
 * Serialize a JS value as a single TOML right-hand-side fragment
 * (the bit that goes after `key = `). Booleans, numbers, strings,
 * dates, and arrays of those are supported. Strings are double-quoted
 * with the canonical TOML escape set.
 *
 * @param {any} v
 * @returns {string}
 */
function serializeValue(v) {
  if (v === null || v === undefined) return '""';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('TOML: non-finite number');
    return String(v);
  }
  if (v instanceof Date) {
    // RFC 3339 — Hugo accepts this for time fields like publishDate.
    return v.toISOString();
  }
  if (Array.isArray(v)) {
    return `[${v.map(serializeValue).join(', ')}]`;
  }
  if (typeof v === 'object') {
    // Inline table: { a = 1, b = 2 }. Rare in hugo.toml but legal.
    const pairs = Object.entries(v).map(([k, val]) => `${k} = ${serializeValue(val)}`);
    return `{ ${pairs.join(', ')} }`;
  }
  // String — escape backslash, double-quote, control chars.
  const s = String(v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${s}"`;
}

/**
 * Match a `[section]` or `[section.sub]` header. Captures the dotted
 * path. Leading whitespace is allowed (Hugo's hugo.toml indents some
 * subsections with two spaces for readability).
 *
 * @type {RegExp}
 */
const HEADER_RE = /^(\s*)\[([A-Za-z0-9_\-.]+)\]\s*(#.*)?$/;

/**
 * Match a `key = value` line, capturing leading indent, key name,
 * everything between `=` and any trailing inline comment, and the
 * inline-comment tail itself.
 *
 * We're permissive about the value side because we never modify it
 * structurally — `apply` only rewrites the value half of lines we
 * deliberately target.
 *
 * @type {RegExp}
 */
const KEY_RE = /^(\s*)([A-Za-z0-9_-]+)\s*=\s*(.*?)(\s*#.*)?$/;

/**
 * Build an index of the TOML source: for each `[section]` header, what
 * line range does the section span? Top-level keys (above the first
 * header) live under the synthetic key `""`.
 *
 * @param {string[]} lines
 * @returns {Map<string, { headerLine: number, start: number, end: number }>}
 */
function indexSections(lines) {
  /** @type {Map<string, { headerLine: number, start: number, end: number }>} */
  const sections = new Map();
  sections.set('', { headerLine: -1, start: 0, end: lines.length });

  let current = '';
  for (let i = 0; i < lines.length; i++) {
    // eslint-disable-next-line security/detect-object-injection -- bounded loop index
    const m = lines[i].match(HEADER_RE);
    if (m) {
      // Close out previous section's `end` if we hadn't yet.
      const prev = sections.get(current);
      if (prev && prev.end > i) prev.end = i;
      current = m[2];
      sections.set(current, { headerLine: i, start: i + 1, end: lines.length });
    }
  }
  return sections;
}

/**
 * Find the line index of `key` within a section's range, or -1.
 *
 * @param {string[]} lines
 * @param {{ start: number, end: number }} range
 * @param {string} key
 * @returns {number}
 */
function findKeyLine(lines, range, key) {
  for (let i = range.start; i < range.end; i++) {
    // eslint-disable-next-line security/detect-object-injection -- bounded loop index
    const m = lines[i].match(KEY_RE);
    if (m && m[2] === key) return i;
  }
  return -1;
}

/**
 * @typedef {object} Change
 * @property {string} [section]    Dotted path: '' for top-level, 'params' for `[params]`, 'params.social' for `[params.social]`.
 * @property {string} key          Front-matter key name (RHS of `=`).
 * @property {any} value           JS value; serialized via serializeValue.
 */

/**
 * Apply a list of `{ section, key, value }` changes to a TOML source
 * string, returning the rewritten source. Original ordering, comments,
 * and blank lines are preserved for every key we don't touch.
 *
 * @param {string} src
 * @param {Change[]} changes
 * @returns {string}
 */
export function apply(src, changes) {
  if (!Array.isArray(changes) || !changes.length) return src;

  // Normalize EOL handling: edit using LF internally, restore the
  // original style at the end if the file used CRLF.
  const usesCrlf = /\r\n/.test(src) && !/[^\r]\n/.test(src);
  const lines = src.split(/\r?\n/);
  const sections = indexSections(lines);

  // Process changes in order. After each insertion we re-index so
  // subsequent lookups land on the right line.
  for (const change of changes) {
    const section = String(change.section ?? '');
    const key = String(change.key);
    if (!key) continue;

    const range = sections.get(section);
    if (!range) {
      // Section doesn't exist — append a blank line + new header + new
      // line at EOF. Then re-index.
      if (lines[lines.length - 1] !== '') lines.push('');
      lines.push(`[${section}]`);
      lines.push(`${key} = ${serializeValue(change.value)}`);
      const refreshed = indexSections(lines);
      sections.clear();
      for (const [k, v] of refreshed) sections.set(k, v);
      continue;
    }

    const lineIdx = findKeyLine(lines, range, key);
    if (lineIdx === -1) {
      // Key doesn't exist in the section — insert a new line just
      // before the next section's header (or at the end of the file
      // for the last section).
      const insertAt = range.end;
      const newLine = `${key} = ${serializeValue(change.value)}`;
      lines.splice(insertAt, 0, newLine);
      const refreshed = indexSections(lines);
      sections.clear();
      for (const [k, v] of refreshed) sections.set(k, v);
      continue;
    }

    // Rewrite the value portion of the existing line, preserving the
    // original indent and any trailing inline comment.
    // eslint-disable-next-line security/detect-object-injection -- lineIdx is a verified array index
    const orig = lines[lineIdx];
    const m = orig.match(KEY_RE);
    if (!m) continue; // pathological; should match by construction
    const indent = m[1] || '';
    const k = m[2];
    const tail = m[4] || '';
    // eslint-disable-next-line security/detect-object-injection -- lineIdx is a verified array index
    lines[lineIdx] = `${indent}${k} = ${serializeValue(change.value)}${tail}`;
  }

  const out = lines.join('\n');
  return usesCrlf ? out.replace(/\n/g, '\r\n') : out;
}

/**
 * Convenience: turn a flat `{ "section.key": value }` change-map (which
 * is what the HTTP layer naturally receives from a form) into an array
 * of `Change` objects. Top-level keys (no dot) are treated as section=''.
 *
 * @param {Record<string, any>} flat
 * @returns {Change[]}
 */
export function flatToChanges(flat) {
  /** @type {Change[]} */
  const out = [];
  for (const [path, value] of Object.entries(flat || {})) {
    const dot = path.lastIndexOf('.');
    if (dot === -1) {
      out.push({ section: '', key: path, value });
    } else {
      out.push({ section: path.slice(0, dot), key: path.slice(dot + 1), value });
    }
  }
  return out;
}

export default { parse, apply, flatToChanges };
