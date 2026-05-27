// @ts-check
/**
 * code.js — Phase 5c source-file preview generation.
 *
 * Triggered for any upload whose extension matches the allowlist exposed
 * from `./index.js#isCodeFile`. The file is read as UTF-8; if it's
 * over `MAX_HIGHLIGHT_BYTES` we skip syntax highlighting and only
 * record line/char counts (Shiki on a 50 MB log file would happily
 * grind a worker thread for a long time and produce useless HTML).
 *
 * Outputs:
 *   - <basename>.preview.html — Shiki-rendered HTML with the
 *     `github-dark` theme, matching the admin UI's terminal aesthetic.
 *   - <basename>.preview.txt  — raw UTF-8 fallback (the same bytes the
 *     attachment renderer can drop into a <pre> for clients that
 *     prefer plaintext or for accessibility tools).
 *
 * conversions_json shape:
 *   {
 *     "preview-html": "/files/yyyy/mm/...preview.html",
 *     "preview-txt":  "/files/yyyy/mm/...preview.txt",
 *     "language":     "javascript",
 *     "line_count":   142,
 *     "char_count":   4738
 *   }
 *
 * The original upload is preserved at its canonical path; the preview
 * artifacts live alongside it.
 */

import { basename, extname, join } from 'path';
import { readFileSync, writeFileSync, statSync } from 'fs';

import { getHighlighter } from './codeHighlighter.js';

/**
 * Bytes — skip Shiki render above this threshold. 1 MB is roomy for
 * a typical source file; multi-megabyte uploads tend to be data
 * dumps anyway.
 */
export const MAX_HIGHLIGHT_BYTES = 1 * 1024 * 1024;

/**
 * Theme name. github-dark is bundled with Shiki and matches the
 * admin's dark terminal palette.
 */
const THEME = 'github-dark';

/**
 * Extension → Shiki language id. Kept small and explicit so the
 * highlighter only loads the grammars we use; Shiki's full grammar
 * registry is ~1 MB on disk.
 *
 * @type {Record<string, string>}
 */
const EXT_TO_LANG = {
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.java': 'java',
  '.c': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.json': 'json',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.md': 'markdown',
  '.txt': 'text',
  '.sh': 'bash',
  '.bash': 'bash',
  '.sql': 'sql',
  '.diff': 'diff',
  '.patch': 'diff',
};

/**
 * Drive the code preview pipeline for one media row.
 *
 * @param {{
 *   row: Record<string, any>,
 *   diskPath: string,
 *   urlBase: string,
 *   diskDir: string,
 *   enqueueFollowupJob?: (mediaId: string, type: string) => void,
 * }} ctx
 * @returns {Promise<{ conversions: Record<string, any>, mediaPatch: Record<string, any> }>}
 */
export async function processCode(ctx) {
  const { diskPath, urlBase, diskDir } = ctx;
  const size = safeSize(diskPath);
  const ext = extname(diskPath).toLowerCase();
  const language = Object.prototype.hasOwnProperty.call(EXT_TO_LANG, ext)
    ? EXT_TO_LANG[/** @type {keyof typeof EXT_TO_LANG} */ (ext)]
    : 'text';

  const baseName = stripExt(basename(diskPath));
  const htmlName = `${baseName}.preview.html`;
  const txtName = `${baseName}.preview.txt`;
  const htmlPath = join(diskDir, htmlName);
  const txtPath = join(diskDir, txtName);

  // Read the file. UTF-8 + replacement char so binary uploads that
  // sneaked through the extension filter don't blow up the worker.
  const raw = readFileSync(diskPath, 'utf8');
  const lineCount = countLines(raw);
  const charCount = raw.length;

  // Plaintext fallback always lands.
  writeFileSync(txtPath, raw, 'utf8');

  let html;
  if (size > MAX_HIGHLIGHT_BYTES) {
    // Oversize: emit a minimal HTML wrapper with the raw text inside
    // <pre>. Browsers handle it; the attachment renderer (Phase 6) can
    // still display the truncation note.
    html = renderPlainWrapper(raw, { language, oversize: true });
  } else {
    try {
      const highlighter = await getHighlighter(language, THEME);
      html = highlighter.codeToHtml(raw, { lang: language, theme: THEME });
    } catch (err) {
      // Unknown language or grammar load failure — fall back to plain
      // wrapper. We don't want a single weird upload to fail the job
      // when a fallback render is trivial.
      console.warn(`[conversion/code] shiki render failed (${language}):`, err.message || err);
      html = renderPlainWrapper(raw, { language, oversize: false });
    }
  }
  writeFileSync(htmlPath, html, 'utf8');

  return {
    conversions: {
      'preview-html': `${urlBase}/${htmlName}`,
      'preview-txt': `${urlBase}/${txtName}`,
      language,
      line_count: lineCount,
      char_count: charCount,
    },
    mediaPatch: {},
  };
}

/**
 * Minimal fallback wrapper. Escapes HTML special chars and drops the
 * source inside `<pre class="shiki">` so downstream CSS keys off the
 * same class shiki emits.
 *
 * @param {string} raw
 * @param {{ language: string, oversize: boolean }} opts
 */
function renderPlainWrapper(raw, opts) {
  const note = opts.oversize
    ? '<p class="shiki-note">File too large for syntax highlighting — showing raw text.</p>'
    : '';
  return `${note}<pre class="shiki" data-language="${escapeHtml(opts.language)}"><code>${escapeHtml(raw)}</code></pre>`;
}

/**
 * Minimal HTML escape suitable for `<pre>` interior.
 *
 * @param {string} s
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Count LF-delimited lines. A trailing newline does not add an extra
 * empty line — common-sense convention matching `wc -l`-ish behavior
 * for editors.
 *
 * @param {string} s
 */
function countLines(s) {
  if (!s) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  // Trim trailing-newline overcount so 'a\n' → 1 line, not 2.
  if (s.charCodeAt(s.length - 1) === 10) n--;
  return n;
}

/**
 * @param {string} path
 */
function safeSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * @param {string} name
 */
function stripExt(name) {
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

export const __internal = {
  EXT_TO_LANG,
  countLines,
  escapeHtml,
  renderPlainWrapper,
  THEME,
};
