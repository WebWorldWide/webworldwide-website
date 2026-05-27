// @ts-nocheck
/**
 * editor.entry.js — bundle entry for the Phase 3 admin editor.
 *
 * Bundled by `admin/scripts/build-editor.mjs` (esbuild, IIFE,
 * globalName="TEEditor") into `admin/public/js/editor.bundle.js`.
 *
 * What this exposes
 * -----------------
 *   window.TEEditor.mount(rootEl, initialMarkdown, options) → instance
 *
 * Each instance is a façade that *looks* like the textarea it replaces.
 * Consumers (editor.js, media.js) read/write `.value`, listen for
 * `input` events, and treat `.selectionStart`/`.selectionEnd` as
 * character offsets into the Markdown string — exactly as they did
 * with `<textarea id="editor-fallback">` in Phase 2.
 *
 *   instance.value                 ← current Markdown string
 *   instance.value = '...'         ← replace contents
 *   instance.selectionStart/End    ← cursor position in Markdown
 *   instance.addEventListener('input', fn)
 *   instance.setMode('wysiwyg' | 'source')
 *   instance.getMode()
 *   instance.focus()
 *   instance.destroy()
 *
 * Round-trip stability
 * --------------------
 * `parse(markdown)` and `serialize(doc)` are designed so that a second
 * round-trip is a fixed point (`serialize(parse(serialize(parse(s)))) ===
 * serialize(parse(s))`). The first round-trip may normalise whitespace
 * or bullet markers, but switching WYSIWYG ↔ Source ↔ WYSIWYG never
 * drifts further.
 *
 * Phase 3b adds: rich toolbar (marks, blocks, lists, insert, history),
 * `@tiptap/suggestion`-driven slash menu, custom keymap (Cmd+K link
 * dialog, Cmd+S → editor-save event, Cmd+Enter → editor-publish event,
 * Cmd+Shift+U underline), and an underline mark that round-trips via
 * `<u>...</u>` HTML pass-through.
 *
 * Phase 3c will layer tables / math / callouts / footnotes onto the
 * slash menu's placeholder rows; Phase 3d adds find/replace, TOC
 * sidebar, and autosave hooks.
 */
import { Editor, Extension, Node, mergeAttributes, InputRule } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
// StarterKit v3 ships the Underline mark out of the box; we no longer
// need to import it explicitly. The mark is wired into the schema by
// the StarterKit.configure() call below.
import { TaskList, TaskItem } from '@tiptap/extension-list';
import Suggestion from '@tiptap/suggestion';
// Phase 3c: tables (4 extensions), code-block syntax-highlight, lowlight.
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { createLowlight } from 'lowlight';
// Only 13 grammars — keep bundle lean. Phase 11 may swap in dynamic
// language registration if more languages are needed.
import jsLang from 'highlight.js/lib/languages/javascript';
import tsLang from 'highlight.js/lib/languages/typescript';
import pyLang from 'highlight.js/lib/languages/python';
import goLang from 'highlight.js/lib/languages/go';
import rustLang from 'highlight.js/lib/languages/rust';
import xmlLang from 'highlight.js/lib/languages/xml';
import cssLang from 'highlight.js/lib/languages/css';
import jsonLang from 'highlight.js/lib/languages/json';
import bashLang from 'highlight.js/lib/languages/bash';
import mdLang from 'highlight.js/lib/languages/markdown';
import yamlLang from 'highlight.js/lib/languages/yaml';
import sqlLang from 'highlight.js/lib/languages/sql';
import diffLang from 'highlight.js/lib/languages/diff';
import { MarkdownParser, MarkdownSerializer } from 'prosemirror-markdown';
import MarkdownIt from 'markdown-it';
import mdContainer from 'markdown-it-container';
import mdFootnote from 'markdown-it-footnote';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { markdown as cmMarkdown } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
// Phase 3d: CodeMirror search facets/commands for the source-mode side
// of the find/replace modal. We don't render CM's built-in search panel —
// our modal drives the search/replace state via `setSearchQuery` and the
// `findNext`/`replaceNext`/`replaceAll` commands.
import {
  SearchQuery,
  setSearchQuery,
  findNext as cmFindNext,
  findPrevious as cmFindPrev,
  replaceNext as cmReplaceNext,
  replaceAll as cmReplaceAll,
  search as cmSearch,
} from '@codemirror/search';
// Phase 3d: ProseMirror plugin for the WYSIWYG side of find/replace —
// imported as a peer dep through @tiptap/pm. TextSelection is also used
// by the TOC sidebar's gotoHeading.
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration as PMDecoration, DecorationSet as PMDecorationSet } from '@tiptap/pm/view';
// Phase 3d: drag handle (block reorder). The extension renders a single
// floating handle anchored on hover over the nearest top-level block.
import GlobalDragHandle from 'tiptap-extension-global-drag-handle';

// Phase 3c: shared lowlight instance used by both the code-block
// extension and the language picker UI.
const lowlight = createLowlight();
lowlight.register('javascript', jsLang);
lowlight.register('js', jsLang);
lowlight.register('typescript', tsLang);
lowlight.register('ts', tsLang);
lowlight.register('python', pyLang);
lowlight.register('py', pyLang);
lowlight.register('go', goLang);
lowlight.register('rust', rustLang);
lowlight.register('rs', rustLang);
lowlight.register('html', xmlLang);
lowlight.register('xml', xmlLang);
lowlight.register('css', cssLang);
lowlight.register('json', jsonLang);
lowlight.register('bash', bashLang);
lowlight.register('sh', bashLang);
lowlight.register('shell', bashLang);
lowlight.register('markdown', mdLang);
lowlight.register('md', mdLang);
lowlight.register('yaml', yamlLang);
lowlight.register('yml', yamlLang);
lowlight.register('sql', sqlLang);
lowlight.register('diff', diffLang);

// Canonical labels shown in the language picker — only one entry per
// physical grammar to avoid alias duplicates polluting the dropdown.
const CODE_LANGUAGES = [
  { value: '', label: 'Plain text' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'json', label: 'JSON' },
  { value: 'bash', label: 'Bash' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'yaml', label: 'YAML' },
  { value: 'sql', label: 'SQL' },
  { value: 'diff', label: 'Diff' },
];

// ─────────────────────────────────────────────────────────────────
// Markdown round-trip: parser/serializer keyed on TipTap node names.
// ─────────────────────────────────────────────────────────────────
//
// prosemirror-markdown ships defaults that target its own schema
// (`bullet_list`, `code_block`, `hard_break`, …). TipTap's StarterKit
// uses camelCase node names (`bulletList`, `codeBlock`, `hardBreak`,
// …) plus `taskList`/`taskItem`. We build a parser/serializer pair
// whose *output* node names match TipTap so the round-trip lands the
// document straight into the live schema with no rename pass.

// Underline is the only mark with no native CommonMark syntax; we keep
// HTML pass-through enabled so `<u>...</u>` parses into the underline
// mark and serialises back to `<u>...</u>`. All other inline HTML is
// still ignored.
//
// Phase 3c adds:
//   - `table` rule enabled (GFM table syntax)
//   - `markdown-it-container` for callouts (info/tip/warn/danger)
//   - `markdown-it-footnote` for `[^id]` references + `[^id]:` definitions
const tokenizer = MarkdownIt('commonmark', { html: true })
  .enable('table')
  .use(mdContainer, 'info')
  .use(mdContainer, 'tip')
  .use(mdContainer, 'warn')
  .use(mdContainer, 'danger')
  .use(mdFootnote);

// Post-process the token stream so that:
//   - thead/tbody wrappers are dropped (TipTap's table has no thead/tbody
//     node — header status is implied by the cell type per row);
//   - inline content inside th/td is wrapped in a paragraph_open /
//     paragraph_close pair so it matches the tableCell/tableHeader
//     `content: 'block+'` constraint;
//   - hidden inner paragraphs inside footnote definitions are flattened
//     so a single-paragraph footnote produces a clean text container.
function preprocessTokens(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === 'thead_open' || tok.type === 'thead_close') continue;
    if (tok.type === 'tbody_open' || tok.type === 'tbody_close') continue;
    // markdown-it-footnote emits a render-only `footnote_anchor` token
    // inside each definition. It has no Markdown form, so drop it
    // before prosemirror-markdown sees it.
    if (tok.type === 'footnote_anchor') continue;
    if (tok.type === 'th_open' || tok.type === 'td_open') {
      out.push(tok);
      // Synthesise paragraph_open so the inline that follows lands
      // inside a valid block child of the cell.
      const pOpen = new tok.constructor('paragraph_open', 'p', 1);
      pOpen.block = true;
      out.push(pOpen);
      continue;
    }
    if (tok.type === 'th_close' || tok.type === 'td_close') {
      const pClose = new tok.constructor('paragraph_close', 'p', -1);
      pClose.block = true;
      out.push(pClose);
      out.push(tok);
      continue;
    }
    out.push(tok);
  }
  return out;
}

/** Return whether a markdown-it list is "tight" (no blank lines between items). */
function listIsTight(tokens, i) {
  while (++i < tokens.length) {
    if (tokens[i].type !== 'list_item_open') return tokens[i].hidden;
  }
  return false;
}

/** Markdown-it token → TipTap node/mark spec. */
const tokenSpec = {
  blockquote: { block: 'blockquote' },
  paragraph: { block: 'paragraph' },
  list_item: { block: 'listItem' },
  bullet_list: {
    block: 'bulletList',
    getAttrs: (_, tokens, i) => ({ tight: listIsTight(tokens, i) }),
  },
  ordered_list: {
    block: 'orderedList',
    getAttrs: (tok, tokens, i) => ({
      start: Number(tok.attrGet('start')) || 1,
      tight: listIsTight(tokens, i),
    }),
  },
  heading: { block: 'heading', getAttrs: (tok) => ({ level: Number(tok.tag.slice(1)) }) },
  code_block: { block: 'codeBlock', getAttrs: () => ({ language: null }), noCloseToken: true },
  fence: {
    block: 'codeBlock',
    getAttrs: (tok) => ({ language: tok.info?.trim() || null }),
    noCloseToken: true,
  },
  hr: { node: 'horizontalRule' },
  image: {
    node: 'image',
    getAttrs: (tok) => ({
      src: tok.attrGet('src'),
      title: tok.attrGet('title') || null,
      alt: (tok.children && tok.children[0] && tok.children[0].content) || null,
    }),
  },
  hardbreak: { node: 'hardBreak' },
  em: { mark: 'italic' },
  strong: { mark: 'bold' },
  s: { mark: 'strike' },
  link: {
    mark: 'link',
    getAttrs: (tok) => ({
      href: tok.attrGet('href'),
      title: tok.attrGet('title') || null,
    }),
  },
  code_inline: { mark: 'code', noCloseToken: true },
  // HTML pass-through for the underline mark. markdown-it emits
  // `html_inline` tokens for raw inline HTML when `html: true`. We map
  // `<u>` open/close pairs onto the underline mark; everything else
  // falls through as plain text.
  html_inline: { mark: 'underline', noCloseToken: true, getAttrs: () => ({}) },
  // Phase 3c: tables. The preprocessor strips thead/tbody and injects
  // paragraph wrappers around inline content in th/td cells.
  table: { block: 'table' },
  tr: { block: 'tableRow' },
  th: { block: 'tableHeader' },
  td: { block: 'tableCell' },
  // Phase 3c: callouts (info / tip / warn / danger).
  container_info: { block: 'callout', getAttrs: () => ({ type: 'info' }) },
  container_tip: { block: 'callout', getAttrs: () => ({ type: 'tip' }) },
  container_warn: { block: 'callout', getAttrs: () => ({ type: 'warn' }) },
  container_danger: { block: 'callout', getAttrs: () => ({ type: 'danger' }) },
  // Phase 3c: footnotes. The ref is inline (label points back to the
  // definition); the block wraps one or more definitions at the end.
  footnote_ref: {
    node: 'footnoteRef',
    getAttrs: (tok) => ({ label: (tok.meta && tok.meta.label) || '' }),
  },
  footnote_block: { block: 'footnoteBlock' },
  footnote: {
    block: 'footnoteItem',
    getAttrs: (tok) => ({ label: (tok.meta && tok.meta.label) || '' }),
  },
  // footnote_anchor is purely a render-time decoration; the
  // preprocessor drops it before prosemirror-markdown sees the token
  // stream, so no spec is needed here.
};

/**
 * Build a MarkdownParser bound to the given TipTap schema. We can't
 * construct it eagerly (the schema only exists after `new Editor(...)`
 * builds it), so this helper takes the live schema.
 *
 * Underline pass-through: prosemirror-markdown's mapping requires
 * matching open/close tokens, but markdown-it emits the same
 * `html_inline` type for both. We post-process the token stream so
 * `<u>` becomes a synthetic `u_open` token and `</u>` becomes `u_close`,
 * then map both to the underline mark.
 *
 * @param {import('prosemirror-model').Schema} schema
 */
function buildParser(schema) {
  const hasUnderline = Boolean(schema.marks.underline);
  const hasMath = Boolean(schema.nodes.mathInline && schema.nodes.mathBlock);
  const hasTable = Boolean(schema.nodes.table);
  const hasCallout = Boolean(schema.nodes.callout);
  const hasFootnote = Boolean(schema.nodes.footnoteRef);
  const spec = { ...tokenSpec };
  if (hasUnderline) {
    spec.u = { mark: 'underline' };
  } else {
    delete spec.html_inline;
    delete spec.u;
  }
  if (!hasTable) {
    delete spec.table;
    delete spec.tr;
    delete spec.th;
    delete spec.td;
  }
  if (!hasCallout) {
    delete spec.container_info;
    delete spec.container_tip;
    delete spec.container_warn;
    delete spec.container_danger;
  }
  if (!hasFootnote) {
    delete spec.footnote_ref;
    delete spec.footnote_block;
    delete spec.footnote;
  }
  if (hasMath) {
    spec.math_inline = {
      node: 'mathInline',
      getAttrs: (tok) => ({ formula: tok.content || '' }),
    };
    spec.math_block = {
      node: 'mathBlock',
      getAttrs: (tok) => ({ formula: tok.content || '' }),
    };
  }
  // Inline `$...$` / block `$$...$$` math detection. We don't ship a
  // markdown-it plugin for this — there isn't a stable lightweight one —
  // so we walk the token stream and split text runs ourselves. This
  // keeps math entirely a *parser* concern; the serializer just emits
  // `$...$` / `$$\n...\n$$` from the live nodes.
  const MATH_INLINE = /\$([^\s$][^$\n]*?[^\s$]|\S)\$/;
  function splitMath(children, TokCtor) {
    const out = [];
    for (let i = 0; i < children.length; i++) {
      const t = children[i];
      if (t.type !== 'text' || !t.content || t.content.indexOf('$') < 0) {
        out.push(t);
        continue;
      }
      // Split text on the next `$x$` token.
      let rest = t.content;
      while (rest.length) {
        const m = MATH_INLINE.exec(rest);
        if (!m) {
          if (rest) {
            const textTok = new TokCtor('text', '', 0);
            textTok.content = rest;
            textTok.level = t.level;
            out.push(textTok);
          }
          break;
        }
        if (m.index > 0) {
          const textTok = new TokCtor('text', '', 0);
          textTok.content = rest.slice(0, m.index);
          textTok.level = t.level;
          out.push(textTok);
        }
        const mathTok = new TokCtor('math_inline', '', 0);
        mathTok.content = m[1];
        mathTok.level = t.level;
        out.push(mathTok);
        rest = rest.slice(m.index + m[0].length);
      }
    }
    return out;
  }
  // Detect block-level math: `paragraph_open / inline($$...$$) /
  // paragraph_close` → math_block token. We treat the *entire*
  // paragraph as math if and only if its single inline child is a
  // text run bracketed by `$$`.
  function detectBlockMath(tokens, TokCtor) {
    if (!hasMath) return tokens;
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const next = tokens[i + 1];
      const after = tokens[i + 2];
      if (
        tok &&
        tok.type === 'paragraph_open' &&
        next &&
        next.type === 'inline' &&
        after &&
        after.type === 'paragraph_close' &&
        next.content &&
        /^\$\$([\s\S]+)\$\$$/.test(next.content.trim())
      ) {
        const inner = next.content.trim().slice(2, -2).trim();
        const mathTok = new TokCtor('math_block', '', 0);
        mathTok.content = inner;
        mathTok.block = true;
        out.push(mathTok);
        i += 2;
        continue;
      }
      out.push(tok);
    }
    return out;
  }
  const tokenize = (text, env) => {
    let tokens = tokenizer.parse(text || '', env || {});
    let TokCtor = null;
    // Walk inline children and remap `<u>` / `</u>` html_inline tokens
    // to a synthetic `u_open` / `u_close` pair the parser can recognise.
    function remap(children) {
      if (!children) return children;
      const out = [];
      for (let i = 0; i < children.length; i++) {
        const t = children[i];
        TokCtor = TokCtor || t.constructor;
        if (t.type === 'html_inline' && hasUnderline) {
          const m = /^<\s*(\/?)\s*u\s*>$/i.exec(t.content || '');
          if (m) {
            const open = m[1] !== '/';
            const synth = new t.constructor(open ? 'u_open' : 'u_close', 'u', open ? 1 : -1);
            synth.markup = '';
            synth.nesting = open ? 1 : -1;
            synth.level = t.level;
            out.push(synth);
            continue;
          }
        }
        out.push(t);
      }
      return out;
    }
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      if (!TokCtor) TokCtor = tk.constructor;
      if (tk.children) tk.children = remap(tk.children);
      if (hasMath && tk.children && tk.type === 'inline') {
        tk.children = splitMath(tk.children, tk.constructor);
      }
    }
    if (hasMath && TokCtor) {
      tokens = detectBlockMath(tokens, TokCtor);
    }
    if (hasTable) {
      tokens = preprocessTokens(tokens);
    }
    return tokens;
  };
  // MarkdownParser's `parse()` calls `tokenizer.parse(...)`. We pass a
  // wrapper that mimics that interface so the remap happens transparently.
  const wrappedTokenizer = {
    parse: tokenize,
  };
  return new MarkdownParser(schema, wrappedTokenizer, spec);
}

// ─────────────────────────────────────────────────────────────────
// Serializer
// ─────────────────────────────────────────────────────────────────

const nodeSerializers = {
  blockquote(state, node) {
    state.wrapBlock('> ', null, node, () => state.renderContent(node));
  },
  codeBlock(state, node) {
    const backticks = node.textContent.match(/`{3,}/gm);
    const fence = backticks ? backticks.sort().slice(-1)[0] + '`' : '```';
    state.write(fence + (node.attrs.language || '') + '\n');
    state.text(node.textContent, false);
    state.write('\n');
    state.write(fence);
    state.closeBlock(node);
  },
  heading(state, node) {
    // ATX headings only — never Setext.
    state.write(state.repeat('#', node.attrs.level) + ' ');
    state.renderInline(node, false);
    state.closeBlock(node);
  },
  horizontalRule(state, node) {
    state.write('---');
    state.closeBlock(node);
  },
  bulletList(state, node) {
    // Spec: bullets use "-" (not "*" / "+").
    state.renderList(node, '  ', () => '- ');
  },
  orderedList(state, node) {
    // Spec: default start = 1.
    const start = node.attrs.start || 1;
    const maxW = String(start + node.childCount - 1).length;
    const space = state.repeat(' ', maxW + 2);
    state.renderList(node, space, (i) => {
      const nStr = String(start + i);
      return state.repeat(' ', maxW - nStr.length) + nStr + '. ';
    });
  },
  listItem(state, node) {
    state.renderContent(node);
  },
  taskList(state, node) {
    // Each task item renders its own "- [ ]" / "- [x]" prefix; we just
    // wrap them as a tight bullet list.
    state.renderList(node, '  ', () => '');
  },
  taskItem(state, node) {
    const checked = node.attrs.checked ? '[x]' : '[ ]';
    state.write(`- ${checked} `);
    state.renderContent(node);
  },
  paragraph(state, node) {
    state.renderInline(node);
    state.closeBlock(node);
  },
  image(state, node) {
    state.write(
      '![' +
        state.esc(node.attrs.alt || '') +
        '](' +
        (node.attrs.src || '').replace(/[()]/g, '\\$&') +
        (node.attrs.title ? ' "' + node.attrs.title.replace(/"/g, '\\"') + '"' : '') +
        ')',
    );
  },
  hardBreak(state, node, parent, index) {
    for (let i = index + 1; i < parent.childCount; i++) {
      if (parent.child(i).type !== node.type) {
        // Spec: hardBreak serialises as bare `\n` (not "\\\n" or "<br>")
        // so the round-trip stays stable through CommonMark's
        // softbreak-as-text re-parse.
        state.write('\n');
        return;
      }
    }
  },
  text(state, node) {
    state.text(node.text, !state.inAutolink);
  },
  // ── Phase 3c: tables (GFM) ───────────────────────────────
  //
  // We emit a header row + alignment row + body rows in one closeBlock
  // sweep. The default ProseMirror serializer doesn't understand table
  // structure so we walk it ourselves: row 0 is the header (its cells
  // are tableHeader), the rest are body rows (tableCell).
  table(state, node) {
    const rows = [];
    node.forEach((row) => {
      const cells = [];
      row.forEach((cell) => {
        cells.push(serializeCellInline(state, cell));
      });
      rows.push(cells);
    });
    if (!rows.length) {
      state.closeBlock(node);
      return;
    }
    const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
    // Pad short rows with empty cells.
    rows.forEach((r) => {
      while (r.length < colCount) r.push('');
    });
    // Header row — if the first row is all tableHeader cells, use it;
    // otherwise emit a synthetic blank header (GFM requires one).
    const firstRow = node.firstChild;
    const hasHeader =
      firstRow &&
      firstRow.childCount > 0 &&
      Array.from(firstRow.content.content).every((c) => c.type.name === 'tableHeader');
    const headerCells = hasHeader ? rows[0] : new Array(colCount).fill('');
    const bodyRows = hasHeader ? rows.slice(1) : rows;
    state.write('| ' + headerCells.map((c) => c || ' ').join(' | ') + ' |\n');
    state.write('| ' + new Array(colCount).fill('---').join(' | ') + ' |');
    bodyRows.forEach((r) => {
      state.write('\n| ' + r.map((c) => c || ' ').join(' | ') + ' |');
    });
    state.closeBlock(node);
  },
  // tableRow / tableCell / tableHeader are never called directly —
  // table() walks the children itself. Provide stubs so prosemirror-
  // markdown doesn't throw if a stray row appears at the top level.
  tableRow(state, node) {
    state.renderContent(node);
  },
  tableCell(state, node) {
    state.renderContent(node);
  },
  tableHeader(state, node) {
    state.renderContent(node);
  },
  // ── Phase 3c: math ───────────────────────────────────────
  mathInline(state, node) {
    // Inline math: `$formula$`. The formula text is held in the
    // `formula` attribute (not as child text) so we never expose the
    // raw `$` to mark serialisation.
    state.write('$' + (node.attrs.formula || '') + '$');
  },
  mathBlock(state, node) {
    state.write('$$\n' + (node.attrs.formula || '') + '\n$$');
    state.closeBlock(node);
  },
  // ── Phase 3c: callouts ───────────────────────────────────
  callout(state, node) {
    const type = node.attrs.type || 'info';
    state.write(':::' + type + '\n');
    state.renderContent(node);
    // Ensure the closing fence sits on its own line.
    state.flushClose(1);
    state.write(':::');
    state.closeBlock(node);
  },
  // ── Phase 3c: footnotes ──────────────────────────────────
  footnoteRef(state, node) {
    state.write('[^' + (node.attrs.label || '') + ']');
  },
  footnoteBlock(state, node) {
    state.renderContent(node);
  },
  footnoteItem(state, node) {
    state.write('[^' + (node.attrs.label || '') + ']: ');
    // Footnote definitions render their content inline; we use a
    // dedicated rendering path so newlines inside multi-paragraph
    // footnotes get the 4-space continuation indent.
    state.renderInline(node.firstChild || node, false);
    state.closeBlock(node);
  },
};

/**
 * Serialize a single tableCell / tableHeader node to its Markdown
 * inline form (pipe-separated cell content). GFM tables can't contain
 * arbitrary block content per cell — only inline content per row —
 * so we flatten one paragraph and pipe-escape any literal `|`.
 */
function serializeCellInline(state, cell) {
  const para = cell.firstChild;
  if (!para) return '';
  // Re-use the existing serializer state to render inline content into
  // a temporary buffer. We swap out the `out` field, render, then
  // restore — exactly how prosemirror-markdown's internal helpers work.
  const oldOut = state.out;
  const oldAtBlank = state.atBlank;
  state.out = '';
  state.atBlank = true;
  state.renderInline(para, false);
  const inline = state.out
    // Pipe must be escaped inside a cell.
    .replace(/\|/g, '\\|')
    // Newlines aren't permitted inside a cell either.
    .replace(/\n+/g, ' ')
    .trim();
  state.out = oldOut;
  state.atBlank = oldAtBlank;
  return inline;
}

const markSerializers = {
  italic: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
  bold: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
  strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
  // Markdown has no native underline syntax. We pass through as raw
  // HTML; markdown-it's `html: true` + the parser's `u_open`/`u_close`
  // remap pulls it back into the same mark on the next round-trip.
  underline: {
    open: '<u>',
    close: '</u>',
    mixable: true,
    expelEnclosingWhitespace: true,
  },
  link: {
    open(state, _mark) {
      state.inAutolink = false;
      return '[';
    },
    close(_state, mark) {
      const href = (mark.attrs.href || '').replace(/[()"]/g, '\\$&');
      const title = mark.attrs.title ? ` "${mark.attrs.title.replace(/"/g, '\\"')}"` : '';
      return `](${href}${title})`;
    },
    mixable: false,
    expelEnclosingWhitespace: true,
  },
  code: {
    open(_state, _mark, parent, index) {
      return backticksFor(parent.child(index), -1);
    },
    close(_state, _mark, parent, index) {
      return backticksFor(parent.child(index - 1), 1);
    },
    escape: false,
  },
};

function backticksFor(node, side) {
  const ticks = /`+/g;
  let m;
  let len = 0;
  if (node.isText) while ((m = ticks.exec(node.text))) len = Math.max(len, m[0].length);
  let result = len > 0 && side > 0 ? ' `' : '`';
  for (let i = 0; i < len; i++) result += '`';
  if (len > 0 && side < 0) result += ' ';
  return result;
}

const serializer = new MarkdownSerializer(nodeSerializers, markSerializers, {
  hardBreakNodeName: 'hardBreak',
});

export { buildParser, serializer };

// ─────────────────────────────────────────────────────────────────
// Link URL validation
// ─────────────────────────────────────────────────────────────────
//
// Used by both the Link button and the Cmd+K dialog. We allow:
//   - http / https / mailto / tel (with full or bare host)
//   - relative URLs (start with "/", "#", or "?")
//   - bare paths like "page.html"
// and reject `javascript:`, `data:`, `vbscript:` and anything that
// looks like a control-character URL.
const FORBIDDEN_SCHEME = /^\s*(javascript|data|vbscript)\s*:/i;
const SAFE_SCHEME = /^(https?|mailto|tel):/i;

export function isSafeLinkUrl(raw) {
  if (typeof raw !== 'string') return false;
  const url = raw.trim();
  if (!url) return false;
  if (FORBIDDEN_SCHEME.test(url)) return false;
  // Strip control chars; CommonMark forbids them in link destinations.
  // Use a char-code scan so we don't embed literal control chars in a
  // regex (eslint's no-control-regex blocks `/[\x00-\x1f]/`).
  for (let i = 0; i < url.length; i++) {
    if (url.charCodeAt(i) <= 0x1f) return false;
  }
  if (SAFE_SCHEME.test(url)) return true;
  // Relative / fragment / query / bare path.
  if (/^[/#?]/.test(url)) return true;
  // Schemeless absolute (e.g., "example.com/page") — treat as relative.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return true;
  // Unknown scheme — deny.
  return false;
}

// ─────────────────────────────────────────────────────────────────
// Phase 7 — paste-to-embed helpers
// ─────────────────────────────────────────────────────────────────
//
// A "single bare URL" paste is the standard cue for embeds. The
// regex below is intentionally strict: we require https:// + a host
// + nothing more than printable URL characters, and the whole text
// must be the URL (otherwise the user pasted a URL inside a sentence
// and we treat it as plain text — TipTap's autolink handles that).
const SINGLE_URL_PASTE = /^https:\/\/[\w\-.]+(?::\d+)?(?:\/[^\s]*)?$/i;

export function looksLikeSingleUrlPaste(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 2000) return false;
  if (/\s/.test(trimmed)) return false;
  return SINGLE_URL_PASTE.test(trimmed);
}

/**
 * Fallback when the host page didn't wire `te-slash-embed`. Prompts for
 * a URL inline, calls /api/embed, and inserts the returned shortcode.
 */
function triggerEmbedPrompt(editor) {
  const url = window.prompt('Embed URL (YouTube, Bluesky, Spotify, …)');
  if (!url) return;
  if (!/^https:\/\//i.test(url)) {
    alert('Only https:// URLs are supported.');
    return;
  }
  resolveEmbed(url)
    .then((shortcode) => {
      if (shortcode) {
        editor
          .chain()
          .focus()
          .insertContent(shortcode + '\n')
          .run();
      }
      return null;
    })
    .catch((err) => {
      console.warn('[embed] resolve failed', err);
      alert('Could not resolve that URL.');
    });
}

/**
 * Call /api/embed and resolve with the shortcode string, or `null` if
 * the upstream returned an error. The editor's host page is also free
 * to call this directly (it's exported on the namespace).
 *
 * @param {string} url
 * @returns {Promise<string | null>}
 */
export async function resolveEmbed(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const res = await fetch('/api/embed?url=' + encodeURIComponent(url.trim()), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || typeof body.shortcode !== 'string') return null;
    return body.shortcode;
  } catch (err) {
    console.warn('[embed] /api/embed failed', err);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Slash-menu command catalogue
// ─────────────────────────────────────────────────────────────────
//
// Each entry has a stable `id` (for aria-activedescendant), a
// human-readable `label`, a short `hint`, an optional `disabled` flag
// for Phase-future placeholders, and a `run(editor, range)` that takes
// the live editor and the range covering the `/query` to delete before
// running its chain command.
const SLASH_ITEMS = [
  {
    id: 'h1',
    label: 'Heading 1',
    hint: 'Large section heading',
    group: 'Headings',
    keywords: ['h1', 'heading', 'title', 'one'],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleHeading({ level: 1 }).run(),
  },
  {
    id: 'h2',
    label: 'Heading 2',
    hint: 'Medium section heading',
    group: 'Headings',
    keywords: ['h2', 'heading', 'two'],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run(),
  },
  {
    id: 'h3',
    label: 'Heading 3',
    hint: 'Small section heading',
    group: 'Headings',
    keywords: ['h3', 'heading', 'three'],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleHeading({ level: 3 }).run(),
  },
  {
    id: 'bullet',
    label: 'Bullet list',
    hint: 'Unordered list with •',
    group: 'Lists',
    keywords: ['bullet', 'list', 'ul', 'unordered'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    id: 'ordered',
    label: 'Ordered list',
    hint: 'Numbered list',
    group: 'Lists',
    keywords: ['ordered', 'list', 'ol', 'number'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    id: 'task',
    label: 'Task list',
    hint: 'Checkable to-do list',
    group: 'Lists',
    keywords: ['task', 'todo', 'check', 'list'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    id: 'quote',
    label: 'Blockquote',
    hint: 'Quote or callout',
    group: 'Block',
    keywords: ['quote', 'blockquote', 'callout'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    id: 'code',
    label: 'Code block',
    hint: 'Fenced source code',
    group: 'Block',
    keywords: ['code', 'fence', 'pre', 'block'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    id: 'hr',
    label: 'Divider',
    hint: 'Horizontal rule',
    group: 'Block',
    keywords: ['divider', 'hr', 'horizontal', 'rule', 'separator'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  {
    id: 'image',
    label: 'Image',
    hint: 'Insert image (Phase 4)',
    group: 'Insert',
    keywords: ['image', 'photo', 'picture'],
    placeholder: true,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      // Phase 4 will replace this with the media picker. For now we
      // dispatch a DOM event so editor.js can wire its existing
      // sidebar uploader as a quick stop-gap.
      try {
        editor.view.dom.dispatchEvent(new CustomEvent('te-slash-image', { bubbles: true }));
      } catch (_) {
        /* ignore */
      }
    },
  },
  {
    id: 'file',
    label: 'File attachment',
    hint: 'Insert any file with rich preview',
    group: 'Insert',
    keywords: ['file', 'attachment', 'upload', 'pdf', 'video', 'audio', 'zip'],
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      // Phase 6: dispatch a DOM event so editor.js can open the media
      // library and insert an `{{< attachment id="..." >}}` shortcode on
      // selection. Keeping the dispatch here (instead of doing it inline)
      // mirrors the `te-slash-image` pattern and avoids re-importing the
      // media client into the bundle.
      try {
        editor.view.dom.dispatchEvent(new CustomEvent('te-slash-attachment', { bubbles: true }));
      } catch (_) {
        /* ignore */
      }
    },
  },
  {
    id: 'embed',
    label: 'Embed',
    hint: 'YouTube / Bluesky / Spotify / link card',
    group: 'Insert',
    keywords: ['embed', 'video', 'tweet', 'iframe', 'youtube', 'bluesky', 'mastodon', 'spotify'],
    run: (editor, range) => {
      // Phase 7: drop the `/embed` marker, then prompt for a URL and
      // hand off to the page-level wiring (which calls the admin's
      // /api/embed lookup and inserts the resulting shortcode). If the
      // host page didn't wire a handler, fall back to an inline prompt
      // so the slash item still does something coherent.
      editor.chain().focus().deleteRange(range).run();
      const dom = editor.view.dom;
      const evt = new CustomEvent('te-slash-embed', { bubbles: true, cancelable: true });
      const handled = !dom.dispatchEvent(evt);
      if (!handled) {
        triggerEmbedPrompt(editor);
      }
    },
  },
  {
    id: 'table',
    label: 'Table',
    hint: 'Insert a 3×3 table',
    group: 'Insert',
    keywords: ['table', 'grid', 'rows', 'columns'],
    run: (editor, range) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run();
    },
  },
  {
    id: 'math-block',
    label: 'Math block',
    hint: 'KaTeX display equation',
    group: 'Insert',
    keywords: ['math', 'equation', 'formula', 'latex', 'katex', 'tex'],
    run: (editor, range) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({ type: 'mathBlock', attrs: { formula: '' } })
        .run();
    },
  },
  {
    id: 'math-inline',
    label: 'Inline math',
    hint: '$x^2$ at cursor',
    group: 'Insert',
    keywords: ['math', 'inline', 'equation', 'latex'],
    run: (editor, range) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({ type: 'mathInline', attrs: { formula: '' } })
        .run();
    },
  },
  {
    id: 'callout-info',
    label: 'Info callout',
    hint: ':::info',
    group: 'Callout',
    keywords: ['callout', 'admonition', 'info', 'note'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setCallout('info').run(),
  },
  {
    id: 'callout-tip',
    label: 'Tip callout',
    hint: ':::tip',
    group: 'Callout',
    keywords: ['callout', 'tip', 'hint'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setCallout('tip').run(),
  },
  {
    id: 'callout-warn',
    label: 'Warning callout',
    hint: ':::warn',
    group: 'Callout',
    keywords: ['callout', 'warn', 'warning', 'caution'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setCallout('warn').run(),
  },
  {
    id: 'callout-danger',
    label: 'Danger callout',
    hint: ':::danger',
    group: 'Callout',
    keywords: ['callout', 'danger', 'error', 'critical'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setCallout('danger').run(),
  },
  {
    id: 'footnote',
    label: 'Footnote',
    hint: 'Insert a numbered footnote',
    group: 'Insert',
    keywords: ['footnote', 'note', 'reference', 'cite'],
    run: (editor, range) => insertFootnote(editor, range),
  },
];

function filterSlashItems(query) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  // Phase 3c bumped the limit from 10 to 14 to accommodate callout + math
  // + footnote rows without forcing the user to type a filter to find
  // them. The list view scrolls if more rows exist past the visible
  // height.
  if (!q) return SLASH_ITEMS.slice(0, 14);
  return SLASH_ITEMS.filter((item) => {
    const hay = (item.label + ' ' + (item.keywords || []).join(' ')).toLowerCase();
    return hay.includes(q);
  }).slice(0, 14);
}

// ─────────────────────────────────────────────────────────────────
// Phase 7 — paste-to-embed floating UI + URL splice helpers
// ─────────────────────────────────────────────────────────────────
//
// The UI is a tiny absolutely-positioned card with three buttons:
//   1. Insert embed   — calls /api/embed and replaces the URL line
//   2. Insert link    — leaves the auto-linked URL in place
//   3. Cancel (ESC)   — leaves the URL but dismisses the picker
//
// We don't render a server-side preview thumbnail in this iteration —
// the placeholder shortcode already renders a thumb on the published
// page, and an extra round-trip just to preview in the editor would
// double the latency. We do show the resolved provider name once the
// embed succeeds (the shortcode itself is human-readable).
function createEmbedPasteUI() {
  const root = document.createElement('div');
  root.className = 'te-embed-paste';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Convert pasted link to embed');
  root.style.position = 'absolute';
  root.style.zIndex = '320';
  root.style.display = 'none';
  root.innerHTML =
    '<div class="te-embed-paste-row">' +
    '  <span class="te-embed-paste-msg">Pasted URL detected.</span>' +
    '  <button type="button" class="te-embed-paste-btn primary" data-action="embed">Insert embed</button>' +
    '  <button type="button" class="te-embed-paste-btn" data-action="link">Insert link instead</button>' +
    '  <button type="button" class="te-embed-paste-btn ghost" data-action="cancel" aria-label="Dismiss (ESC)">×</button>' +
    '</div>';
  document.body.appendChild(root);

  let handlers = {};
  let onDocKey = null;

  function setBusy(busy) {
    const btns = root.querySelectorAll('button');
    btns.forEach((b) => {
      b.disabled = Boolean(busy);
    });
    const primary = root.querySelector('[data-action="embed"]');
    if (primary) {
      primary.textContent = busy ? 'Resolving…' : 'Insert embed';
    }
  }

  function show(opts) {
    handlers = opts || {};
    setBusy(false);
    root.style.display = 'block';
    positionNearSelection();
    onDocKey = (e) => {
      if (e.key === 'Escape') {
        hide();
        try {
          handlers.onCancel && handlers.onCancel();
        } catch (_) {
          /* ignore */
        }
      }
    };
    document.addEventListener('keydown', onDocKey, true);
  }
  function hide() {
    root.style.display = 'none';
    if (onDocKey) document.removeEventListener('keydown', onDocKey, true);
    onDocKey = null;
    handlers = {};
  }
  function positionNearSelection() {
    // Best-effort: place under the current text-selection rect. If we
    // can't read a selection rect (jsdom, off-screen), fall back to the
    // top-left of the editor root.
    let rect = null;
    try {
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        rect = r.getBoundingClientRect();
      }
    } catch (_) {
      /* ignore */
    }
    const docTop = window.scrollY || 0;
    const docLeft = window.scrollX || 0;
    const top = ((rect && rect.bottom) || 100) + docTop + 6;
    const left = ((rect && rect.left) || 50) + docLeft;
    root.style.top = top + 'px';
    root.style.left = left + 'px';
  }
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || t.tagName !== 'BUTTON') return;
    const action = t.getAttribute('data-action');
    if (action === 'embed' && handlers.onEmbed) handlers.onEmbed();
    else if (action === 'link' && handlers.onLink) handlers.onLink();
    else if (action === 'cancel' && handlers.onCancel) handlers.onCancel();
  });
  return {
    show,
    hide,
    setBusy,
    element: root,
    destroy() {
      hide();
      try {
        root.remove();
      } catch (_) {
        /* ignore */
      }
    },
  };
}

/**
 * Find the most recently inserted instance of `url` in the document and
 * replace it (plus any auto-link mark) with the given shortcode block.
 * We scan from the current selection backwards because the paste just
 * happened — the URL is essentially always at or before the cursor.
 *
 * @param {import('@tiptap/core').Editor} editor
 * @param {string} url
 * @param {string} shortcode
 */
function replacePastedUrlWith(editor, url, shortcode) {
  const { state } = editor;
  const { doc, selection } = state;
  let from = -1;
  let to = -1;
  // Walk the doc text and pick the last match that ends at or before
  // the cursor. We use nodesBetween so we get text-node ranges with
  // correct ProseMirror positions.
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const text = node.text || '';
    let idx = text.indexOf(url);
    while (idx !== -1) {
      const start = pos + idx;
      const end = start + url.length;
      // Prefer the latest match at or before the selection head.
      if (end <= selection.from + 1) {
        from = start;
        to = end;
      }
      idx = text.indexOf(url, idx + 1);
    }
    return true;
  });
  if (from < 0) {
    // Fallback: just insert at cursor — better than losing the embed.
    editor
      .chain()
      .focus()
      .insertContent('\n' + shortcode + '\n')
      .run();
    return;
  }
  // Delete the URL text (and any link mark that covers it) and insert
  // the shortcode literal as a fresh paragraph.
  editor
    .chain()
    .focus()
    .setTextSelection({ from, to })
    .deleteSelection()
    .insertContent(shortcode + '\n')
    .run();
}

// ─────────────────────────────────────────────────────────────────
// Slash menu floating UI
// ─────────────────────────────────────────────────────────────────
//
// We render a plain absolutely-positioned <ul role="listbox"> against
// the document body. Selection is owned by the keyboard logic — the
// menu items are <button>s but they're never focused; the editor keeps
// focus and we use `aria-activedescendant` on the editor surface to
// announce the highlighted row to assistive tech.

function createSlashMenu() {
  const root = document.createElement('div');
  root.className = 'te-slash-menu';
  root.setAttribute('role', 'presentation');
  root.style.position = 'absolute';
  root.style.zIndex = '300';
  root.style.display = 'none';

  const list = document.createElement('ul');
  list.className = 'te-slash-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Insert block');
  list.id = 'te-slash-list-' + Math.random().toString(36).slice(2, 8);
  root.appendChild(list);

  const empty = document.createElement('div');
  empty.className = 'te-slash-empty';
  empty.textContent = 'No matching blocks';
  empty.hidden = true;
  root.appendChild(empty);

  document.body.appendChild(root);

  let items = [];
  let activeIndex = 0;
  let onSelect = () => {};

  function rowId(index) {
    return list.id + '-row-' + index;
  }

  function render(nextItems) {
    items = nextItems || [];
    list.innerHTML = '';
    if (!items.length) {
      list.hidden = true;
      empty.hidden = false;
      return;
    }
    list.hidden = false;
    empty.hidden = true;
    let lastGroup = null;
    items.forEach((item, idx) => {
      if (item.group && item.group !== lastGroup) {
        const sep = document.createElement('li');
        sep.className = 'te-slash-group';
        sep.setAttribute('role', 'presentation');
        sep.textContent = item.group;
        list.appendChild(sep);
        lastGroup = item.group;
      }
      const li = document.createElement('li');
      li.setAttribute('role', 'presentation');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'te-slash-item';
      if (item.placeholder) btn.classList.add('is-placeholder');
      btn.dataset.index = String(idx);
      btn.id = rowId(idx);
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', idx === activeIndex ? 'true' : 'false');
      btn.tabIndex = -1;
      btn.innerHTML =
        '<span class="te-slash-label">' +
        escapeHtml(item.label) +
        '</span>' +
        '<span class="te-slash-hint">' +
        escapeHtml(item.hint || '') +
        '</span>';
      // Use mousedown so the editor doesn't lose focus before we run
      // the command (click would fire after focus is lost).
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        activeIndex = idx;
        onSelect(item);
      });
      btn.addEventListener('mousemove', () => {
        if (activeIndex !== idx) {
          activeIndex = idx;
          updateAria();
        }
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
    updateAria();
  }

  function updateAria() {
    const buttons = list.querySelectorAll('.te-slash-item');
    buttons.forEach((b, i) => {
      b.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
      b.classList.toggle('is-active', i === activeIndex);
    });
    const activeBtn = buttons[activeIndex];
    if (activeBtn && typeof activeBtn.scrollIntoView === 'function') {
      try {
        activeBtn.scrollIntoView({ block: 'nearest' });
      } catch (_) {
        /* ignore */
      }
    }
  }

  function show(rect) {
    root.style.display = 'block';
    positionAt(rect);
  }

  function positionAt(rect) {
    if (!rect) return;
    const docTop = window.scrollY || window.pageYOffset || 0;
    const docLeft = window.scrollX || window.pageXOffset || 0;
    const top = (rect.bottom || rect.top || 0) + docTop + 6;
    const left = (rect.left || 0) + docLeft;
    root.style.top = top + 'px';
    root.style.left = left + 'px';
    // Clamp into viewport horizontally.
    const maxLeft = (window.innerWidth || 0) - root.offsetWidth - 8;
    if (root.offsetWidth && left + docLeft > maxLeft + docLeft) {
      root.style.left = Math.max(8 + docLeft, maxLeft + docLeft) + 'px';
    }
  }

  function hide() {
    root.style.display = 'none';
  }

  function move(delta) {
    if (!items.length) return;
    activeIndex = (activeIndex + delta + items.length) % items.length;
    updateAria();
  }

  function getActive() {
    return items[activeIndex] || null;
  }

  function getActiveDescendantId() {
    return items.length ? rowId(activeIndex) : '';
  }

  function destroy() {
    try {
      root.remove();
    } catch (_) {
      /* ignore */
    }
  }

  return {
    render,
    show,
    hide,
    move,
    positionAt,
    getActive,
    getActiveDescendantId,
    setActiveIndex(i) {
      activeIndex = Math.max(0, Math.min(items.length - 1, i | 0));
      updateAria();
    },
    setOnSelect(fn) {
      onSelect = typeof fn === 'function' ? fn : () => {};
    },
    destroy,
    listId: list.id,
    element: root,
  };
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────────────────────────
// Slash extension wiring @tiptap/suggestion
// ─────────────────────────────────────────────────────────────────

function buildSlashExtension(menu) {
  return Extension.create({
    name: 'teSlashMenu',
    addOptions() {
      return {
        suggestion: {
          char: '/',
          // Permissive: trigger anywhere (not just empty paragraphs).
          startOfLine: false,
          allowSpaces: false,
          allow({ state, range }) {
            // Don't trigger inside code blocks.
            const $from = state.doc.resolve(range.from);
            for (let d = $from.depth; d > 0; d--) {
              const node = $from.node(d);
              if (node.type.name === 'codeBlock') return false;
            }
            return true;
          },
          command: ({ editor, range, props }) => {
            if (props && typeof props.run === 'function') {
              props.run(editor, range);
            }
          },
          items: ({ query }) => filterSlashItems(query),
          render: () => {
            let currentRange = null;
            let currentEditor = null;
            return {
              onStart(props) {
                currentRange = props.range;
                currentEditor = props.editor;
                menu.render(props.items || []);
                menu.setActiveIndex(0);
                menu.setOnSelect((item) => {
                  if (!currentEditor || !currentRange) return;
                  props.command(item);
                });
                const rect = props.clientRect && props.clientRect();
                menu.show(rect);
                announce(currentEditor, menu);
              },
              onUpdate(props) {
                currentRange = props.range;
                currentEditor = props.editor;
                menu.render(props.items || []);
                menu.setActiveIndex(0);
                menu.setOnSelect((item) => {
                  if (!currentEditor || !currentRange) return;
                  props.command(item);
                });
                const rect = props.clientRect && props.clientRect();
                menu.positionAt(rect);
                announce(currentEditor, menu);
              },
              onKeyDown(props) {
                const e = props.event;
                if (!e) return false;
                if (e.key === 'ArrowDown') {
                  menu.move(1);
                  announce(currentEditor, menu);
                  return true;
                }
                if (e.key === 'ArrowUp') {
                  menu.move(-1);
                  announce(currentEditor, menu);
                  return true;
                }
                if (e.key === 'Enter') {
                  const active = menu.getActive();
                  if (active) {
                    props.command(active);
                    return true;
                  }
                }
                if (e.key === 'Escape') {
                  menu.hide();
                  return true;
                }
                return false;
              },
              onExit() {
                menu.hide();
                if (currentEditor && currentEditor.view && currentEditor.view.dom) {
                  currentEditor.view.dom.removeAttribute('aria-activedescendant');
                }
                currentRange = null;
                currentEditor = null;
              },
            };
          },
        },
      };
    },
    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          ...this.options.suggestion,
        }),
      ];
    },
  });
}

function announce(editor, menu) {
  if (!editor || !editor.view || !editor.view.dom) return;
  const id = menu.getActiveDescendantId();
  if (id) editor.view.dom.setAttribute('aria-activedescendant', id);
  else editor.view.dom.removeAttribute('aria-activedescendant');
  // Owner: also announce the listbox itself so screen-reader cursor
  // can locate the options.
  editor.view.dom.setAttribute('aria-controls', menu.listId);
  editor.view.dom.setAttribute('aria-expanded', 'true');
}

// ─────────────────────────────────────────────────────────────────
// Editor instance
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
// Phase 3c: custom TipTap nodes — math, callout, footnote
// ─────────────────────────────────────────────────────────────────
//
// Each node is small enough to keep inline here rather than splitting
// into separate files. The shape is intentionally minimal — we hold a
// `formula` / `type` / `label` attribute and render a single
// representative DOM node; rendering of the math itself happens via a
// `nodeView` in the math nodes only.

/**
 * Inline math node `$x^2$`. The formula is held in the `formula` attr,
 * not as text content — the node has no children. A node view replaces
 * the contents with a KaTeX render once the math module loads.
 */
const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      formula: { default: '' },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-math-inline]',
        getAttrs: (el) => ({ formula: el.getAttribute('data-formula') || el.textContent || '' }),
      },
    ];
  },
  renderHTML({ HTMLAttributes, node }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-math-inline': 'true',
        'data-formula': node.attrs.formula || '',
        class: 'te-math te-math-inline',
      }),
      // The visible fallback while KaTeX hasn't yet rendered.
      `$${node.attrs.formula || ''}$`,
    ];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => mathNodeView(node, getPos, editor, 'inline');
  },
});

/** Block math `$$ ... $$`. Same shape but rendered as a block. */
const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  defining: true,
  addAttributes() {
    return {
      formula: { default: '' },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-math-block]',
        getAttrs: (el) => ({ formula: el.getAttribute('data-formula') || el.textContent || '' }),
      },
    ];
  },
  renderHTML({ HTMLAttributes, node }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-math-block': 'true',
        'data-formula': node.attrs.formula || '',
        class: 'te-math te-math-block',
      }),
      `$$\n${node.attrs.formula || ''}\n$$`,
    ];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => mathNodeView(node, getPos, editor, 'block');
  },
  addInputRules() {
    // Type `$$ ` on its own line to convert into an empty math block.
    return [
      new InputRule({
        find: /^\$\$ $/,
        handler: ({ range, commands }) => {
          commands.command(({ tr }) => {
            tr.replaceRangeWith(range.from, range.to, this.type.create({ formula: '' }));
            return true;
          });
        },
      }),
    ];
  },
});

/** Callout (admonition) — block container with a `type` attribute. */
const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      type: {
        default: 'info',
        parseHTML: (el) => {
          const m = (el.className || '').match(/callout-(info|tip|warn|danger)/);
          return m ? m[1] : el.getAttribute('data-callout-type') || 'info';
        },
        renderHTML: (attrs) => ({ 'data-callout-type': attrs.type || 'info' }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'aside.callout' }, { tag: 'div.callout' }];
  },
  renderHTML({ HTMLAttributes, node }) {
    const type = node.attrs.type || 'info';
    return [
      'aside',
      mergeAttributes(HTMLAttributes, {
        class: `callout callout-${type}`,
        role: 'note',
      }),
      ['span', { class: 'callout-label', contenteditable: 'false' }, type.toUpperCase()],
      ['div', { class: 'callout-body' }, 0],
    ];
  },
  addCommands() {
    return {
      setCallout:
        (type = 'info') =>
        ({ commands }) =>
          commands.wrapIn(this.name, { type }),
      toggleCallout:
        (type = 'info') =>
        ({ editor, commands }) => {
          if (editor.isActive(this.name)) return commands.lift(this.name);
          return commands.wrapIn(this.name, { type });
        },
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },
});

/** Inline footnote reference. Renders as a superscript `[label]` anchor. */
const FootnoteRef = Node.create({
  name: 'footnoteRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { label: { default: '1' } };
  },
  parseHTML() {
    return [
      {
        tag: 'sup.footnote-ref',
        getAttrs: (el) => ({ label: el.getAttribute('data-label') || el.textContent || '' }),
      },
    ];
  },
  renderHTML({ HTMLAttributes, node }) {
    return [
      'sup',
      mergeAttributes(HTMLAttributes, {
        class: 'footnote-ref',
        'data-label': node.attrs.label || '',
      }),
      ['a', { href: `#fn-${node.attrs.label}` }, `[${node.attrs.label}]`],
    ];
  },
});

/**
 * Footnote item — a single `[^label]: ...` definition. Holds one
 * paragraph of inline content.
 */
const FootnoteItem = Node.create({
  name: 'footnoteItem',
  group: 'footnoteItem',
  content: 'paragraph',
  defining: true,
  addAttributes() {
    return { label: { default: '1' } };
  },
  parseHTML() {
    return [
      {
        tag: 'li[data-footnote-item]',
        getAttrs: (el) => ({ label: el.getAttribute('data-label') || '' }),
      },
    ];
  },
  renderHTML({ HTMLAttributes, node }) {
    return [
      'li',
      mergeAttributes(HTMLAttributes, {
        'data-footnote-item': 'true',
        'data-label': node.attrs.label || '',
        id: `fn-${node.attrs.label}`,
      }),
      0,
    ];
  },
});

/**
 * Footnote container — collects footnote items at the end of the
 * document. There is only ever zero or one of these.
 */
const FootnoteBlock = Node.create({
  name: 'footnoteBlock',
  group: 'block',
  content: 'footnoteItem+',
  defining: true,
  isolating: true,
  parseHTML() {
    return [{ tag: 'ol.footnote-list' }, { tag: 'section.footnotes' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'ol',
      mergeAttributes(HTMLAttributes, {
        class: 'footnote-list',
        'aria-label': 'Footnotes',
      }),
      0,
    ];
  },
});

// ─────────────────────────────────────────────────────────────────
// Math node view + lazy KaTeX loader
// ─────────────────────────────────────────────────────────────────
//
// We load KaTeX (JS + CSS) from a CDN with subresource integrity the
// first time a math node is mounted. This keeps the bundle ~250 KB
// smaller; the trade-off is one network request on the first math node
// ever rendered in a session. Subsequent renders re-use the cached
// module + CSS.
//
// SRI hashes are pinned to KaTeX 0.16.11 (matches the dependency we
// installed; if you bump the version, regenerate these hashes).
const KATEX_CDN_BASE = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist';
const KATEX_JS_SRI = 'sha256-rzgIjudPpzaP4WT9HrkmaDxDsBpYHC2VqGuOJTb6BiM=';
const KATEX_CSS_SRI = 'sha256-bgC0/wn7sV6sdK0NB4tCYibTu0YqEcZL9Vi8YGmFkRk=';
let katexPromise = null;
function loadKatex() {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (window.katex) return Promise.resolve(window.katex);
  if (katexPromise) return katexPromise;
  katexPromise = new Promise((resolve) => {
    // Inject the stylesheet first.
    if (!document.querySelector('link[data-te-katex]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${KATEX_CDN_BASE}/katex.min.css`;
      link.crossOrigin = 'anonymous';
      link.integrity = KATEX_CSS_SRI;
      link.dataset.teKatex = 'css';
      document.head.appendChild(link);
    }
    const script = document.createElement('script');
    script.src = `${KATEX_CDN_BASE}/katex.min.js`;
    script.crossOrigin = 'anonymous';
    script.integrity = KATEX_JS_SRI;
    script.async = true;
    script.dataset.teKatex = 'js';
    script.onload = () => resolve(window.katex || null);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
  return katexPromise;
}

function mathNodeView(node, getPos, editor, kind) {
  const dom = document.createElement(kind === 'inline' ? 'span' : 'div');
  dom.className = kind === 'inline' ? 'te-math te-math-inline' : 'te-math te-math-block';
  dom.dataset.formula = node.attrs.formula || '';
  dom.setAttribute('contenteditable', 'false');
  let editing = false;
  let textarea = null;
  function renderFormula(formula) {
    if (editing) return;
    dom.innerHTML = '';
    loadKatex()
      .then((katex) => {
        if (editing) return null;
        if (katex && typeof katex.render === 'function') {
          try {
            katex.render(formula || '', dom, {
              throwOnError: false,
              displayMode: kind === 'block',
            });
            return null;
          } catch (_err) {
            /* fall through to text fallback */
          }
        }
        // Fallback: show the raw source so the doc stays editable even
        // if the CDN is unreachable.
        dom.textContent = kind === 'inline' ? `$${formula || ''}$` : `$$\n${formula || ''}\n$$`;
        return null;
      })
      .catch(() => {
        dom.textContent = kind === 'inline' ? `$${formula || ''}$` : `$$\n${formula || ''}\n$$`;
      });
  }
  function enterEdit() {
    if (editing || !editor || !editor.options.editable) return;
    editing = true;
    dom.classList.add('is-editing');
    dom.innerHTML = '';
    textarea = document.createElement('textarea');
    textarea.className = 'te-math-input';
    textarea.value = node.attrs.formula || '';
    textarea.rows = kind === 'block' ? 3 : 1;
    textarea.setAttribute('aria-label', 'Math formula');
    textarea.addEventListener('blur', commit);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commit();
      }
    });
    dom.appendChild(textarea);
    textarea.focus();
    textarea.select();
  }
  function commit() {
    if (!editing) return;
    const next = textarea ? textarea.value : node.attrs.formula || '';
    editing = false;
    dom.classList.remove('is-editing');
    if (typeof getPos === 'function' && editor) {
      const pos = getPos();
      if (typeof pos === 'number') {
        const tr = editor.state.tr.setNodeMarkup(pos, undefined, { formula: next });
        editor.view.dispatch(tr);
      }
    }
    renderFormula(next);
  }
  function cancel() {
    editing = false;
    dom.classList.remove('is-editing');
    renderFormula(node.attrs.formula || '');
  }
  dom.addEventListener('click', enterEdit);
  renderFormula(node.attrs.formula || '');
  return {
    dom,
    update(updated) {
      if (updated.type !== node.type) return false;
      const f = updated.attrs.formula || '';
      if (!editing) renderFormula(f);
      dom.dataset.formula = f;
      return true;
    },
    selectNode() {
      dom.classList.add('te-math-selected');
    },
    deselectNode() {
      dom.classList.remove('te-math-selected');
    },
    stopEvent(event) {
      // While editing, the textarea owns all events.
      return editing && event.target === textarea;
    },
    destroy() {
      if (textarea) textarea.removeEventListener('blur', commit);
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// Slash menu helpers exposed for the new items
// ─────────────────────────────────────────────────────────────────
//
// Insert a fresh `[^N]` reference at the cursor *and* append a new
// `footnoteBlock`/`footnoteItem` definition at the end of the doc.
// Picks the next free integer label so multiple refs don't collide.
function insertFootnote(editor, range) {
  const { schema } = editor;
  if (!schema.nodes.footnoteRef) return;
  // Find used labels.
  const used = new Set();
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'footnoteRef' || node.type.name === 'footnoteItem') {
      if (node.attrs.label) used.add(String(node.attrs.label));
    }
  });
  let n = 1;
  while (used.has(String(n))) n += 1;
  const label = String(n);
  const refNode = schema.nodes.footnoteRef.create({ label });
  const para = schema.nodes.paragraph.create(null, schema.text('Footnote text…'));
  const item = schema.nodes.footnoteItem.create({ label }, para);

  let tr = editor.state.tr;
  if (range) {
    tr = tr.deleteRange(range.from, range.to);
  }
  // Insert the inline ref at the (post-delete) cursor.
  tr = tr.replaceSelectionWith(refNode, false);
  // Append the definition to the existing footnoteBlock, or create a
  // new one at the end of the document.
  let blockPos = -1;
  let blockNode = null;
  tr.doc.descendants((node, pos) => {
    if (node.type.name === 'footnoteBlock') {
      blockPos = pos;
      blockNode = node;
      return false;
    }
    return true;
  });
  if (blockNode && blockPos >= 0) {
    const insertAt = blockPos + blockNode.nodeSize - 1;
    tr = tr.insert(insertAt, item);
  } else {
    const block = schema.nodes.footnoteBlock.create(null, item);
    tr = tr.insert(tr.doc.content.size, block);
  }
  editor.view.dispatch(tr);
}

function buildExtensions(slashExt) {
  const exts = [
    StarterKit.configure({
      // StarterKit already gives us paragraph, heading, blockquote,
      // bulletList, orderedList, listItem, codeBlock, hardBreak,
      // horizontalRule, image, bold, italic, strike, code, history,
      // dropcursor, gapcursor. We override link to keep it
      // openOnClick=false in the admin (avoids navigating away).
      // Phase 3c: disable the built-in codeBlock — CodeBlockLowlight
      // below replaces it so syntax-highlighting decorations render
      // inside the WYSIWYG view.
      link: false,
      codeBlock: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
    }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      protocols: ['http', 'https', 'mailto'],
      HTMLAttributes: { rel: 'noopener noreferrer' },
    }),
    Image.configure({ inline: true, allowBase64: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    // Phase 3c: tables. The TableHeader extension applies `scope="col"`
    // on the rendered `<th>` for a11y; the table itself gets a
    // `role="table"` + aria counts via HTMLAttributes.
    Table.configure({
      resizable: false,
      allowTableNodeSelection: true,
      HTMLAttributes: { class: 'te-table' },
    }),
    TableRow,
    TableHeader.configure({
      HTMLAttributes: { scope: 'col' },
    }),
    TableCell,
    // Phase 3c: code blocks with lowlight syntax-highlight decorations.
    CodeBlockLowlight.configure({
      lowlight,
      HTMLAttributes: { class: 'te-code-block hljs' },
    }),
    // Phase 3c: math (inline + block) — node views lazy-load KaTeX.
    MathInline,
    MathBlock,
    // Phase 3c: callouts.
    Callout,
    // Phase 3c: footnotes.
    FootnoteRef,
    FootnoteItem,
    FootnoteBlock,
    // Phase 3d: drag-handle for block reorder. A floating handle shows
    // on hover over the nearest top-level block; drag to reorder.
    // Configured to leave a 24px gutter on the left of each block so the
    // handle sits in the margin (the CSS in editor.css positions it).
    GlobalDragHandle.configure({
      dragHandleWidth: 22,
      scrollTreshold: 100,
    }),
    // Phase 3d: find/replace decoration plugin. The actual UI lives in
    // createFindReplaceModal() — this extension just makes the plugin
    // available so transactions can carry our decorations metadata.
    Extension.create({
      name: 'teFindReplace',
      addProseMirrorPlugins() {
        return [buildFindPlugin()];
      },
      addKeyboardShortcuts() {
        return {
          // Alt+Shift+ArrowUp/Down: move the current top-level block.
          // We expose these as the keyboard alternative to drag-and-drop
          // (per the Phase 3d a11y spec). Falls back gracefully if no
          // top-level block is selected.
          'Alt-Shift-ArrowUp': () => moveBlock(this.editor, -1),
          'Alt-Shift-ArrowDown': () => moveBlock(this.editor, 1),
        };
      },
    }),
  ];
  if (slashExt) exts.push(slashExt);
  return exts;
}

/**
 * Phase 3d: move the top-level block containing the current selection up
 * or down. Returns true on success so TipTap's keymap stops the event.
 */
function moveBlock(editor, dir) {
  if (!editor || !editor.state) return false;
  const { state, view } = editor;
  const { selection, doc, tr } = state;
  // Find the top-level node index containing the selection.
  const $from = selection.$from;
  // The topmost node ancestor whose parent is the doc.
  if ($from.depth < 1) return false;
  const topIndex = $from.index(0);
  if (dir < 0 && topIndex === 0) return false;
  if (dir > 0 && topIndex >= doc.childCount - 1) return false;
  const a = doc.child(topIndex);
  const b = doc.child(topIndex + dir);
  // Compute the absolute offsets for the two blocks at the top level.
  let posA = 0;
  for (let i = 0; i < topIndex; i++) posA += doc.child(i).nodeSize;
  const posB = dir > 0 ? posA + a.nodeSize : posA - b.nodeSize;
  const aSize = a.nodeSize;
  const bSize = b.nodeSize;
  const nextTr = tr;
  if (dir > 0) {
    // Replace [posA, posA+aSize+bSize] with b then a.
    nextTr.replaceWith(posA, posA + aSize + bSize, [b, a]);
  } else {
    // dir < 0: posB ends at posA. Replace [posB, posA+aSize] with a then b.
    nextTr.replaceWith(posB, posA + aSize, [a, b]);
  }
  // Keep the selection inside the moved block.
  const newSelPos = dir > 0 ? posA + bSize + 1 : posB + 1;
  try {
    const $newPos = nextTr.doc.resolve(Math.min(newSelPos, nextTr.doc.content.size));
    nextTr.setSelection(TextSelection.near($newPos));
  } catch (_) {
    /* ignore selection placement errors */
  }
  view.dispatch(nextTr);
  return true;
}

// ─────────────────────────────────────────────────────────────────
// Phase 3d: Find & Replace
// ─────────────────────────────────────────────────────────────────
//
// A pinned modal toolbar at the top of the editor pane (not browser
// native find). Two surfaces:
//
//   - WYSIWYG mode: ProseMirror decoration plugin tags every match with
//     the `te-find-match` class and the *current* match with
//     `te-find-match-active`. We walk `state.doc.descendants` for every
//     text node and run the query (literal or regex) against the
//     plain-text content.
//
//   - Source mode: we drive CodeMirror's built-in `@codemirror/search`
//     facet by dispatching `setSearchQuery` on each input change. The
//     CM6 search commands (`findNext`, `replaceNext`, `replaceAll`) own
//     the heavy lifting; we only need to relay match counts back to the
//     status display.

const FIND_PLUGIN_KEY = new PluginKey('teFindReplace');

/** Build the ProseMirror plugin that decorates find-matches in the doc. */
function buildFindPlugin() {
  return new Plugin({
    key: FIND_PLUGIN_KEY,
    state: {
      init() {
        return {
          query: '',
          caseSensitive: false,
          wholeWord: false,
          regex: false,
          activeIndex: 0,
          matches: [],
          decorations: PMDecorationSet.empty,
        };
      },
      apply(tr, prev) {
        const meta = tr.getMeta(FIND_PLUGIN_KEY);
        // If a find-update is being signalled (e.g., after typing in the
        // query box), the caller stuffs the full next-state into the meta.
        if (meta) {
          // Map decorations through the transaction so they survive
          // intervening edits without re-scanning.
          const mapped = prev.decorations.map(tr.mapping, tr.doc);
          return { ...prev, ...meta, decorations: meta.decorations || mapped };
        }
        if (tr.docChanged && prev.matches.length) {
          // The doc changed under us; clear matches — caller can re-run.
          return {
            ...prev,
            matches: [],
            decorations: PMDecorationSet.empty,
            activeIndex: 0,
          };
        }
        return prev;
      },
    },
    props: {
      decorations(state) {
        return this.getState(state).decorations;
      },
    },
  });
}

/**
 * Escape a literal query into a regex source. We always go through a
 * RegExp so case-sensitive / whole-word / regex options can be combined.
 */
function buildFindRegex(query, opts) {
  if (!query) return null;
  let src;
  if (opts.regex) {
    src = query;
  } else {
    src = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  if (opts.wholeWord) {
    // Wrap in non-capturing word boundaries. Caller still gets a single
    // capture group via the outer `()` if they need it.
    src = `\\b(?:${src})\\b`;
  }
  const flags = opts.caseSensitive ? 'g' : 'gi';
  try {
    return new RegExp(src, flags);
  } catch (_err) {
    return null;
  }
}

/** Scan the doc for matches; return {from, to} for each hit. */
function scanProseMirrorMatches(doc, query, opts) {
  const re = buildFindRegex(query, opts);
  if (!re) return [];
  const matches = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const text = node.text || '';
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m[0] === '') {
        re.lastIndex += 1;
        continue;
      }
      const from = pos + m.index;
      const to = from + m[0].length;
      matches.push({ from, to });
      if (matches.length > 10000) return false;
    }
  });
  return matches;
}

function buildFindDecorations(doc, matches, activeIndex) {
  if (!matches.length) return PMDecorationSet.empty;
  const decos = matches.map((m, i) =>
    PMDecoration.inline(m.from, m.to, {
      class: i === activeIndex ? 'te-find-match te-find-match-active' : 'te-find-match',
    }),
  );
  return PMDecorationSet.create(doc, decos);
}

/**
 * Build the find/replace modal DOM, expose handlers that wire it to the
 * given editor instance and CodeMirror getter. The modal is appended
 * inside the editor root so it scrolls with the pane.
 */
function createFindReplaceModal(rootEl, editor, getCM, getMode) {
  const modal = document.createElement('div');
  modal.className = 'te-find-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'false');
  modal.setAttribute('aria-label', 'Find and replace');
  modal.hidden = true;
  modal.innerHTML =
    '<div class="te-find-row te-find-row-q">' +
    '<input class="te-find-input" id="te-find-q" type="text" placeholder="Find" aria-label="Find" autocomplete="off" spellcheck="false" />' +
    '<span class="te-find-count" id="te-find-count" aria-live="polite" aria-atomic="true">0 of 0</span>' +
    '<button type="button" class="te-find-btn" data-act="prev" aria-label="Previous match" title="Previous (Shift+Enter)">▲</button>' +
    '<button type="button" class="te-find-btn" data-act="next" aria-label="Next match" title="Next (Enter)">▼</button>' +
    '<button type="button" class="te-find-btn te-find-close" data-act="close" aria-label="Close find" title="Close (Esc)">×</button>' +
    '</div>' +
    '<div class="te-find-row te-find-row-r">' +
    '<input class="te-find-input" id="te-find-r" type="text" placeholder="Replace" aria-label="Replace" autocomplete="off" spellcheck="false" />' +
    '<button type="button" class="te-find-btn" data-act="replace" title="Replace (Alt+Enter)">Replace</button>' +
    '<button type="button" class="te-find-btn" data-act="replaceAll" title="Replace all">All</button>' +
    '</div>' +
    '<div class="te-find-row te-find-row-opts">' +
    '<label class="te-find-opt"><input type="checkbox" id="te-find-cs" /> <span>Aa</span></label>' +
    '<label class="te-find-opt"><input type="checkbox" id="te-find-ww" /> <span>W</span></label>' +
    '<label class="te-find-opt"><input type="checkbox" id="te-find-re" /> <span>.*</span></label>' +
    '<span class="te-find-err" id="te-find-err" role="alert" hidden></span>' +
    '</div>';
  rootEl.appendChild(modal);

  const qInput = modal.querySelector('#te-find-q');
  const rInput = modal.querySelector('#te-find-r');
  const countEl = modal.querySelector('#te-find-count');
  const errEl = modal.querySelector('#te-find-err');
  const cs = modal.querySelector('#te-find-cs');
  const ww = modal.querySelector('#te-find-ww');
  const re = modal.querySelector('#te-find-re');

  const state = {
    matches: [],
    activeIndex: 0,
    prevFocus: null,
  };

  function readOpts() {
    return {
      caseSensitive: cs.checked,
      wholeWord: ww.checked,
      regex: re.checked,
    };
  }

  function setError(msg) {
    if (!msg) {
      errEl.hidden = true;
      errEl.textContent = '';
      qInput.removeAttribute('aria-invalid');
      return;
    }
    errEl.textContent = msg;
    errEl.hidden = false;
    qInput.setAttribute('aria-invalid', 'true');
  }

  function renderCount() {
    const n = state.matches.length;
    countEl.textContent = n ? `${state.activeIndex + 1} of ${n}` : '0 of 0';
  }

  function applyDecorations() {
    if (getMode() !== 'wysiwyg') return;
    const view = editor.view;
    const tr = view.state.tr.setMeta(FIND_PLUGIN_KEY, {
      matches: state.matches,
      activeIndex: state.activeIndex,
      decorations: buildFindDecorations(view.state.doc, state.matches, state.activeIndex),
    });
    view.dispatch(tr);
  }

  function clearDecorations() {
    if (!editor || !editor.view) return;
    const tr = editor.view.state.tr.setMeta(FIND_PLUGIN_KEY, {
      matches: [],
      activeIndex: 0,
      decorations: PMDecorationSet.empty,
    });
    editor.view.dispatch(tr);
  }

  function refresh() {
    const query = qInput.value || '';
    const opts = readOpts();
    setError('');
    if (!query) {
      state.matches = [];
      state.activeIndex = 0;
      applyDecorations();
      renderCount();
      // Also clear the CM query.
      const cm = getCM();
      if (cm) cm.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
      return;
    }
    if (opts.regex) {
      try {
        new RegExp(query); // validation
      } catch (err) {
        setError('Invalid regex: ' + (err && err.message ? err.message : 'unknown'));
        state.matches = [];
        renderCount();
        applyDecorations();
        return;
      }
    }
    // WYSIWYG mode: scan the live doc for decorations + counter.
    state.matches = scanProseMirrorMatches(editor.state.doc, query, opts);
    if (state.activeIndex >= state.matches.length) state.activeIndex = 0;
    applyDecorations();
    renderCount();
    // Source mode: hand the query to CodeMirror.
    const cm = getCM();
    if (cm) {
      const sq = new SearchQuery({
        search: query,
        caseSensitive: opts.caseSensitive,
        wholeWord: opts.wholeWord,
        regexp: opts.regex,
        replace: rInput.value || '',
      });
      cm.dispatch({ effects: setSearchQuery.of(sq) });
    }
  }

  function goto(delta) {
    if (getMode() === 'source') {
      const cm = getCM();
      if (!cm) return;
      if (delta > 0) cmFindNext(cm);
      else cmFindPrev(cm);
      return;
    }
    if (!state.matches.length) return;
    state.activeIndex = (state.activeIndex + delta + state.matches.length) % state.matches.length;
    applyDecorations();
    renderCount();
    // Scroll into view.
    try {
      const m = state.matches[state.activeIndex];
      const dom = editor.view.domAtPos(m.from);
      if (dom && dom.node && dom.node.parentElement) {
        dom.node.parentElement.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    } catch (_) {
      /* ignore */
    }
  }

  function replaceCurrent() {
    if (getMode() === 'source') {
      const cm = getCM();
      if (!cm) return;
      cmReplaceNext(cm);
      return;
    }
    if (!state.matches.length) return;
    const m = state.matches[state.activeIndex];
    if (!m) return;
    const replacement = rInput.value || '';
    const tr = editor.view.state.tr.insertText(replacement, m.from, m.to);
    editor.view.dispatch(tr);
    // Re-scan after a microtask so doc state is settled.
    queueMicrotask(refresh);
  }

  function replaceAll() {
    if (getMode() === 'source') {
      const cm = getCM();
      if (!cm) return;
      cmReplaceAll(cm);
      return;
    }
    if (!state.matches.length) return;
    const replacement = rInput.value || '';
    let tr = editor.view.state.tr;
    // Apply in reverse so earlier offsets stay valid.
    for (let i = state.matches.length - 1; i >= 0; i--) {
      const m = state.matches[i];
      tr = tr.insertText(replacement, m.from, m.to);
    }
    editor.view.dispatch(tr);
    queueMicrotask(refresh);
  }

  function open() {
    modal.hidden = false;
    modal.classList.add('is-open');
    state.prevFocus = document.activeElement;
    // Pre-populate from current selection (if any).
    try {
      const { from, to, empty } = editor.state.selection;
      if (!empty) {
        const sel = editor.state.doc.textBetween(from, to, ' ');
        if (sel && sel.length < 200) qInput.value = sel;
      }
    } catch (_) {
      /* ignore */
    }
    queueMicrotask(() => {
      qInput.focus();
      qInput.select();
      refresh();
    });
  }

  function close() {
    modal.classList.remove('is-open');
    modal.hidden = true;
    clearDecorations();
    if (state.prevFocus && typeof state.prevFocus.focus === 'function') {
      try {
        state.prevFocus.focus();
      } catch (_) {
        /* ignore */
      }
    } else if (editor && editor.commands && editor.commands.focus) {
      try {
        editor.commands.focus();
      } catch (_) {
        /* ignore */
      }
    }
  }

  function toggle() {
    if (modal.hidden) open();
    else close();
  }

  // Wire input events.
  qInput.addEventListener('input', refresh);
  rInput.addEventListener('input', refresh);
  cs.addEventListener('change', refresh);
  ww.addEventListener('change', refresh);
  re.addEventListener('change', refresh);

  modal.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'next') goto(1);
    else if (act === 'prev') goto(-1);
    else if (act === 'replace') replaceCurrent();
    else if (act === 'replaceAll') replaceAll();
    else if (act === 'close') close();
  });

  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Enter') {
      if (e.altKey) {
        e.preventDefault();
        replaceCurrent();
        return;
      }
      e.preventDefault();
      goto(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'Tab') {
      const focusables = Array.from(
        modal.querySelectorAll('input, button, [tabindex]:not([tabindex="-1"])'),
      ).filter((n) => !n.disabled && !n.hidden && n.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  return {
    element: modal,
    open,
    close,
    toggle,
    refresh,
    isOpen: () => !modal.hidden,
    _state: state,
    _qInput: qInput,
    _rInput: rInput,
    _countEl: countEl,
  };
}

// ─────────────────────────────────────────────────────────────────
// Phase 3d: TOC sidebar
// ─────────────────────────────────────────────────────────────────
//
// Walks the TipTap doc for every heading node, builds a `<nav>` of
// indented anchor links, and scrolls the matching block into view +
// moves the selection on click. Subscribed to the editor's `transaction`
// event with a 100ms trailing throttle so big edits don't thrash.

function buildTocController(editor, tocContainer, tocEmpty) {
  if (!tocContainer) return null;

  const state = {
    nodes: [], // [{level, text, pos, id}]
    activeId: null,
    timer: null,
    scheduled: false,
  };

  function slugify(s, used) {
    const base =
      String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)+/g, '')
        .slice(0, 64) || 'section';
    let id = base;
    let n = 1;
    while (used.has(id)) {
      n += 1;
      id = base + '-' + n;
    }
    used.add(id);
    return id;
  }

  function scan() {
    if (!editor || !editor.state) return;
    const used = new Set();
    const list = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        const text = node.textContent.trim();
        list.push({
          level: node.attrs.level || 1,
          text: text || '(Untitled section)',
          pos,
          id: slugify(text || 'section-' + (list.length + 1), used),
        });
      }
    });
    state.nodes = list;
    render();
  }

  function render() {
    if (!tocContainer) return;
    if (!state.nodes.length) {
      tocContainer.innerHTML = '';
      if (tocEmpty) {
        tocContainer.appendChild(tocEmpty);
        tocEmpty.hidden = false;
      }
      return;
    }
    if (tocEmpty) tocEmpty.hidden = true;
    const frag = document.createDocumentFragment();
    const list = document.createElement('ol');
    list.className = 'ed-toc-list';
    list.setAttribute('role', 'list');
    state.nodes.forEach((h, idx) => {
      const li = document.createElement('li');
      li.className = 'ed-toc-item ed-toc-level-' + h.level;
      li.dataset.level = String(h.level);
      const a = document.createElement('a');
      a.className = 'ed-toc-link';
      a.href = '#' + h.id;
      a.textContent = h.text;
      a.dataset.idx = String(idx);
      a.dataset.pos = String(h.pos);
      a.dataset.id = h.id;
      if (h.id === state.activeId) {
        a.setAttribute('aria-current', 'location');
        a.classList.add('is-current');
      }
      a.addEventListener('click', (e) => {
        e.preventDefault();
        gotoHeading(idx);
      });
      li.appendChild(a);
      list.appendChild(li);
    });
    frag.appendChild(list);
    tocContainer.innerHTML = '';
    tocContainer.appendChild(frag);
  }

  function gotoHeading(idx) {
    const h = state.nodes[idx];
    if (!h) return;
    if (!editor || !editor.view) return;
    const view = editor.view;
    try {
      // Move the selection into the heading then scroll into view.
      // TextSelection.near is the safe way to land a cursor inside a
      // heading; it stays resilient even when the heading is empty.
      const $pos = view.state.doc.resolve(Math.min(h.pos + 1, view.state.doc.content.size));
      const sel = TextSelection.near($pos);
      const tr = view.state.tr.setSelection(sel);
      view.dispatch(tr);
    } catch (_err) {
      // Fallback: use editor command API.
      try {
        editor.commands.setTextSelection(h.pos + 1);
      } catch (_) {
        /* ignore */
      }
    }
    state.activeId = h.id;
    render();
    try {
      const dom = view.domAtPos(h.pos + 1);
      const el = dom && dom.node && (dom.node.nodeType === 1 ? dom.node : dom.node.parentElement);
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    } catch (_) {
      /* ignore */
    }
    try {
      editor.commands.focus();
    } catch (_) {
      /* ignore */
    }
  }

  function setActiveFromSelection() {
    if (!editor || !editor.state) return;
    const { from } = editor.state.selection;
    let current = null;
    for (let i = 0; i < state.nodes.length; i++) {
      if (state.nodes[i].pos <= from) current = state.nodes[i];
      else break;
    }
    const nextId = current ? current.id : null;
    if (nextId !== state.activeId) {
      state.activeId = nextId;
      render();
    }
  }

  function schedule() {
    if (state.scheduled) return;
    state.scheduled = true;
    state.timer = setTimeout(() => {
      state.scheduled = false;
      state.timer = null;
      scan();
    }, 100);
  }

  function destroy() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  // Initial render.
  scan();

  return {
    schedule,
    rescan: scan,
    setActiveFromSelection,
    destroy,
    getNodes: () => state.nodes.slice(),
    gotoHeading,
  };
}

/**
 * Mount a dual-mode editor inside `rootEl`. The returned instance is a
 * textarea-compatible façade — see file docblock.
 *
 * @param {HTMLElement} rootEl
 * @param {string} [initialMarkdown]
 * @param {{
 *   placeholder?: string,
 *   onModeChange?: (mode: 'wysiwyg' | 'source') => void,
 * }} [options]
 */
export function mount(rootEl, initialMarkdown, options) {
  if (!rootEl) throw new Error('TEEditor.mount: rootEl is required');
  const opts = options || {};
  const md0 = typeof initialMarkdown === 'string' ? initialMarkdown : '';

  // Clean the root and build our chrome.
  rootEl.innerHTML = '';
  rootEl.classList.add('te-editor');

  const toolbar = document.createElement('div');
  toolbar.className = 'te-editor-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Editor formatting');

  const modeGroup = document.createElement('div');
  modeGroup.className = 'te-editor-mode-toggle';
  modeGroup.setAttribute('role', 'group');
  modeGroup.setAttribute('aria-label', 'Editor mode');

  const btnWysiwyg = document.createElement('button');
  btnWysiwyg.type = 'button';
  btnWysiwyg.className = 'te-editor-mode-btn active';
  btnWysiwyg.dataset.mode = 'wysiwyg';
  btnWysiwyg.setAttribute('aria-pressed', 'true');
  btnWysiwyg.textContent = 'Rich';

  const btnSource = document.createElement('button');
  btnSource.type = 'button';
  btnSource.className = 'te-editor-mode-btn';
  btnSource.dataset.mode = 'source';
  btnSource.setAttribute('aria-pressed', 'false');
  btnSource.textContent = 'Markdown';

  modeGroup.appendChild(btnWysiwyg);
  modeGroup.appendChild(btnSource);
  toolbar.appendChild(modeGroup);

  // Rich toolbar — built after the editor exists so commands can bind
  // to the live instance.
  const richToolbar = document.createElement('div');
  richToolbar.className = 'te-editor-toolbar-rich';
  richToolbar.setAttribute('role', 'group');
  richToolbar.setAttribute('aria-label', 'Formatting');
  toolbar.appendChild(richToolbar);

  // Flex spacer so the mode toggle floats right.
  const toolbarSpacer = document.createElement('div');
  toolbarSpacer.className = 'te-editor-toolbar-spacer';
  toolbar.appendChild(toolbarSpacer);

  const stack = document.createElement('div');
  stack.className = 'te-editor-stack';

  const wysiwygMount = document.createElement('div');
  wysiwygMount.className = 'te-editor-wysiwyg';

  const sourceMount = document.createElement('div');
  sourceMount.className = 'te-editor-source';
  sourceMount.hidden = true;

  stack.appendChild(wysiwygMount);
  stack.appendChild(sourceMount);

  rootEl.appendChild(toolbar);
  rootEl.appendChild(stack);

  // ── Slash menu UI ─────────────────────────────────────────
  const slashMenu = createSlashMenu();
  const slashExt = buildSlashExtension(slashMenu);

  // ── Cmd+S / Cmd+Enter / Cmd+K keymap ──────────────────────
  // We expose these as custom DOM events on `rootEl` so the page-level
  // wiring (editor.js) can map them to its existing save/publish flow
  // without coupling the bundle to the page.
  const keymapExt = Extension.create({
    name: 'teKeymap',
    addKeyboardShortcuts() {
      return {
        'Mod-s': () => {
          rootEl.dispatchEvent(new CustomEvent('editor-save', { bubbles: true }));
          return true;
        },
        'Mod-Enter': () => {
          rootEl.dispatchEvent(new CustomEvent('editor-publish', { bubbles: true }));
          return true;
        },
        'Mod-k': () => {
          openLinkDialog();
          return true;
        },
        'Mod-Shift-u': () => this.editor.chain().focus().toggleUnderline().run(),
        // Phase 3d: Cmd+F opens the in-editor find modal. The handler is
        // hooked to the rootEl find-modal instance further down; we
        // dispatch the same custom event so source-mode and WYSIWYG share
        // a single open path.
        'Mod-f': () => {
          rootEl.dispatchEvent(new CustomEvent('editor-find', { bubbles: true }));
          return true;
        },
      };
    },
  });

  // ── TipTap WYSIWYG ────────────────────────────────────────
  const extensions = buildExtensions(slashExt);
  extensions.push(keymapExt);
  const editor = new Editor({
    element: wysiwygMount,
    extensions,
    content: '',
    autofocus: false,
    editable: true,
  });

  const parser = buildParser(editor.schema);

  // ── Phase 7: paste-to-embed ──────────────────────────────────
  //
  // If the user pastes exactly one URL into the WYSIWYG view, we
  // hijack the paste, insert the URL as plain text (so the user can
  // see what's happening), and float a small action bar offering
  // "Insert embed" / "Insert link instead" / cancel. "Insert embed"
  // calls /api/embed and replaces the URL line with the returned
  // shortcode. "Insert link" leaves the auto-linked URL in place
  // (TipTap's Link extension handles auto-linking).
  //
  // We do NOT touch paste events in source (CodeMirror) mode — the
  // user there is intentionally editing the shortcode literal.
  const embedPasteUI = createEmbedPasteUI();
  wysiwygMount.addEventListener('paste', (e) => {
    if (mode !== 'wysiwyg') return;
    const text = (e.clipboardData && (e.clipboardData.getData('text/plain') || '').trim()) || '';
    if (!looksLikeSingleUrlPaste(text)) return;
    // Let TipTap's autolink + paste handlers run first — the URL ends
    // up as a clickable link the user can see. We then offer the
    // embed swap via the floating UI.
    queueMicrotask(() => offerEmbedSwap(text));
  });

  function offerEmbedSwap(url) {
    embedPasteUI.show({
      url,
      onEmbed: async () => {
        embedPasteUI.setBusy(true);
        let shortcode = null;
        try {
          shortcode = await resolveEmbed(url);
        } catch (err) {
          console.warn('[embed] resolve failed', err);
        }
        embedPasteUI.hide();
        if (!shortcode) {
          alert('Could not resolve that URL for embed.');
          return;
        }
        // Replace the just-pasted URL (and any auto-link wrapper) with
        // the shortcode. The auto-linked text node still says the URL,
        // so we walk back from the cursor and remove text matching it
        // before inserting the shortcode.
        replacePastedUrlWith(editor, url, shortcode);
      },
      onLink: () => embedPasteUI.hide(),
      onCancel: () => embedPasteUI.hide(),
    });
  }
  // Cleanup wiring: tear down the floating UI when the editor is
  // destroyed.
  const embedPasteCleanup = () => embedPasteUI.destroy();

  // Setting "content" with a string treats it as HTML; for round-trip
  // safety we parse Markdown → ProseMirror doc and apply it directly.
  function applyMarkdownToEditor(md, emit) {
    let doc;
    try {
      doc = parser.parse(md || '');
    } catch (_err) {
      // Fall back to a plain paragraph if the parser throws on weird
      // input; we never want a mount() call to crash the editor.
      doc = editor.schema.node('doc', null, [editor.schema.node('paragraph', null, [])]);
    }
    const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content);
    tr.setMeta('addToHistory', false);
    editor.view.dispatch(tr);
    if (emit !== false) instance.dispatchEvent(new Event('input'));
  }

  function getMarkdownFromEditor() {
    return serializer.serialize(editor.state.doc);
  }

  // ── CodeMirror source view ────────────────────────────────
  let cmView = null;
  function ensureSourceView(initial) {
    if (cmView) return cmView;
    const state = EditorState.create({
      doc: initial || '',
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        cmMarkdown(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((v) => {
          if (v.docChanged) {
            // Source-mode edits flow through the façade so the hidden
            // textarea stays in sync. We *don't* round-trip back into
            // TipTap here — that happens on mode switch to avoid jitter
            // during typing.
            updateFromSource();
          }
        }),
        // Source-mode shortcuts mirror the rich-mode keymap so users
        // get consistent Save/Publish behaviour regardless of mode.
        // Phase 3d adds Cmd+F to open the editor's find modal (we route
        // through the same DOM event the rich mode uses).
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              rootEl.dispatchEvent(new CustomEvent('editor-save', { bubbles: true }));
              return true;
            },
          },
          {
            key: 'Mod-Enter',
            run: () => {
              rootEl.dispatchEvent(new CustomEvent('editor-publish', { bubbles: true }));
              return true;
            },
          },
          {
            key: 'Mod-f',
            run: () => {
              rootEl.dispatchEvent(new CustomEvent('editor-find', { bubbles: true }));
              return true;
            },
          },
        ]),
        // Phase 3d: enable @codemirror/search so our modal can drive
        // findNext / replaceNext / replaceAll. We pass `top: false`
        // because we render our own UI; CM's built-in panel never
        // appears.
        cmSearch({ top: false }),
        EditorView.theme(
          {
            '&': { height: '100%', fontSize: '14px' },
            '.cm-scroller': { fontFamily: 'var(--mono, ui-monospace, monospace)' },
            '.cm-content': { padding: '8px 0' },
          },
          { dark: document.documentElement.getAttribute('data-theme') === 'dark' },
        ),
      ],
    });
    cmView = new EditorView({ state, parent: sourceMount });
    // line numbers / active line are intentionally off per spec —
    // the source view is a prose editor, not a code editor.
    // Phase 3d will optionally re-enable these for power users.
    return cmView;
  }

  // ── Hidden façade textarea (single source of truth) ───────
  //
  // Both modes write into `hidden` so consumers can keep reading
  // `instance.value` (which proxies to `hidden.value`) regardless of
  // mode. The façade itself is an EventTarget so it dispatches the
  // 'input' event consumers already listen for.
  const hidden = document.createElement('textarea');
  hidden.id = 'editor-fallback';
  hidden.hidden = true;
  hidden.setAttribute('aria-hidden', 'true');
  hidden.tabIndex = -1;
  hidden.value = md0;
  rootEl.appendChild(hidden);

  // Keep an internal selection model so consumers (media.bindUploader)
  // can splice content at a cursor position. WYSIWYG mode reports
  // best-effort offsets via getResolvedPos; source mode uses CM6's
  // selection state.
  let selectionStart = md0.length;
  let selectionEnd = md0.length;
  let mode = 'wysiwyg';
  let suppressInput = false;

  function emitInput() {
    if (suppressInput) return;
    instance.dispatchEvent(new Event('input'));
  }

  function updateFromEditor() {
    const md = getMarkdownFromEditor();
    if (hidden.value !== md) {
      hidden.value = md;
      selectionStart = selectionEnd = md.length;
      emitInput();
    }
  }

  function updateFromSource() {
    if (!cmView) return;
    const md = cmView.state.doc.toString();
    if (hidden.value !== md) {
      hidden.value = md;
      const sel = cmView.state.selection.main;
      selectionStart = sel.from;
      selectionEnd = sel.to;
      emitInput();
    }
  }

  editor.on('update', updateFromEditor);
  editor.on('selectionUpdate', () => {
    // TipTap selections are document positions, not Markdown offsets.
    // We can't get a precise Markdown offset without re-serialising,
    // so we approximate by setting both endpoints to the *current*
    // Markdown length — meaning "insert at the end". Phase 3b's slash
    // menu and Phase 3d's find/replace will provide proper anchors.
    // For media insertion the existing UX expects cursor-at-end when
    // the rich editor doesn't have keyboard focus.
    selectionStart = selectionEnd = hidden.value.length;
    refreshToolbarState();
  });
  editor.on('transaction', () => {
    refreshToolbarState();
  });

  // ── Mode switching ────────────────────────────────────────
  function setMode(next) {
    if (next === mode) return;
    if (next === 'source') {
      // Always serialise from the live TipTap state — `hidden.value`
      // may be stale during in-flight updates.
      const md = getMarkdownFromEditor();
      suppressInput = true;
      hidden.value = md;
      suppressInput = false;
      ensureSourceView(md);
      if (cmView.state.doc.toString() !== md) {
        cmView.dispatch({
          changes: { from: 0, to: cmView.state.doc.length, insert: md },
        });
      }
      wysiwygMount.hidden = true;
      sourceMount.hidden = false;
      btnWysiwyg.classList.remove('active');
      btnSource.classList.add('active');
      btnWysiwyg.setAttribute('aria-pressed', 'false');
      btnSource.setAttribute('aria-pressed', 'true');
      mode = 'source';
      richToolbar.setAttribute('aria-disabled', 'true');
      richToolbar.classList.add('is-disabled');
      // Defer focus so the view's DOM has settled.
      queueMicrotask(() => {
        if (cmView) cmView.focus();
      });
    } else {
      const md = cmView ? cmView.state.doc.toString() : hidden.value;
      suppressInput = true;
      hidden.value = md;
      applyMarkdownToEditor(md, false);
      suppressInput = false;
      sourceMount.hidden = true;
      wysiwygMount.hidden = false;
      btnSource.classList.remove('active');
      btnWysiwyg.classList.add('active');
      btnSource.setAttribute('aria-pressed', 'false');
      btnWysiwyg.setAttribute('aria-pressed', 'true');
      mode = 'wysiwyg';
      richToolbar.removeAttribute('aria-disabled');
      richToolbar.classList.remove('is-disabled');
      queueMicrotask(() => {
        editor.commands.focus();
        refreshToolbarState();
      });
    }
    refreshToolbarState();
    if (typeof opts.onModeChange === 'function') {
      try {
        opts.onModeChange(mode);
      } catch (_) {
        /* swallow consumer errors */
      }
    }
  }

  btnWysiwyg.addEventListener('click', () => setMode('wysiwyg'));
  btnSource.addEventListener('click', () => setMode('source'));

  // ── Rich toolbar buttons ─────────────────────────────────
  //
  // Each entry produces a real <button> with aria-label, title (tooltip
  // including the shortcut), and an `update()` callback that re-reads
  // the live editor state and toggles aria-pressed / aria-disabled.
  const toolbarButtons = [];
  function tbBtn(spec) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'te-tb-btn';
    if (spec.className) btn.classList.add(spec.className);
    btn.setAttribute('aria-label', spec.label);
    btn.title = spec.shortcut ? `${spec.label} (${spec.shortcut})` : spec.label;
    if (spec.glyph) {
      const g = document.createElement('span');
      g.className = 'te-tb-glyph';
      g.setAttribute('aria-hidden', 'true');
      g.textContent = spec.glyph;
      btn.appendChild(g);
    }
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('mousedown', (e) => {
      // Prevent the editor from losing focus on click — keeps marks
      // anchored to the current selection.
      e.preventDefault();
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (btn.getAttribute('aria-disabled') === 'true') return;
      spec.run();
      refreshToolbarState();
    });
    btn._update = () => {
      const active = Boolean(spec.active && spec.active());
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.classList.toggle('is-active', active);
      const disabled = mode === 'source' || (spec.canRun && !spec.canRun());
      btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      if (disabled) btn.setAttribute('tabindex', '-1');
      else btn.removeAttribute('tabindex');
    };
    toolbarButtons.push(btn);
    return btn;
  }
  function tbGroup(label) {
    const g = document.createElement('div');
    g.className = 'te-tb-group';
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', label);
    return g;
  }
  function tbDivider() {
    const d = document.createElement('span');
    d.className = 'te-tb-divider';
    d.setAttribute('aria-hidden', 'true');
    return d;
  }

  const mod = isMacLike() ? '⌘' : 'Ctrl';
  const shift = '⇧';
  const alt = isMacLike() ? '⌥' : 'Alt';

  // Group: inline marks
  const gMarks = tbGroup('Inline formatting');
  gMarks.appendChild(
    tbBtn({
      label: 'Bold',
      shortcut: `${mod}+B`,
      glyph: 'B',
      className: 'te-tb-bold',
      active: () => editor.isActive('bold'),
      run: () => editor.chain().focus().toggleBold().run(),
    }),
  );
  gMarks.appendChild(
    tbBtn({
      label: 'Italic',
      shortcut: `${mod}+I`,
      glyph: 'I',
      className: 'te-tb-italic',
      active: () => editor.isActive('italic'),
      run: () => editor.chain().focus().toggleItalic().run(),
    }),
  );
  gMarks.appendChild(
    tbBtn({
      label: 'Underline',
      shortcut: `${mod}+${shift}+U`,
      glyph: 'U',
      className: 'te-tb-underline',
      active: () => editor.isActive('underline'),
      run: () => editor.chain().focus().toggleUnderline().run(),
    }),
  );
  gMarks.appendChild(
    tbBtn({
      label: 'Strikethrough',
      shortcut: `${mod}+${shift}+X`,
      glyph: 'S',
      className: 'te-tb-strike',
      active: () => editor.isActive('strike'),
      run: () => editor.chain().focus().toggleStrike().run(),
    }),
  );
  gMarks.appendChild(
    tbBtn({
      label: 'Inline code',
      shortcut: `${mod}+E`,
      glyph: '</>',
      className: 'te-tb-code',
      active: () => editor.isActive('code'),
      run: () => editor.chain().focus().toggleCode().run(),
    }),
  );
  gMarks.appendChild(
    tbBtn({
      label: 'Link',
      shortcut: `${mod}+K`,
      glyph: '⇒',
      className: 'te-tb-link',
      active: () => editor.isActive('link'),
      run: () => openLinkDialog(),
    }),
  );
  richToolbar.appendChild(gMarks);
  richToolbar.appendChild(tbDivider());

  // Group: block type
  const gBlock = tbGroup('Block type');
  gBlock.appendChild(
    tbBtn({
      label: 'Heading 1',
      shortcut: `${mod}+${alt}+1`,
      glyph: 'H1',
      active: () => editor.isActive('heading', { level: 1 }),
      run: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
    }),
  );
  gBlock.appendChild(
    tbBtn({
      label: 'Heading 2',
      shortcut: `${mod}+${alt}+2`,
      glyph: 'H2',
      active: () => editor.isActive('heading', { level: 2 }),
      run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    }),
  );
  gBlock.appendChild(
    tbBtn({
      label: 'Heading 3',
      shortcut: `${mod}+${alt}+3`,
      glyph: 'H3',
      active: () => editor.isActive('heading', { level: 3 }),
      run: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    }),
  );
  gBlock.appendChild(
    tbBtn({
      label: 'Paragraph',
      shortcut: `${mod}+${alt}+0`,
      glyph: '¶',
      active: () => editor.isActive('paragraph') && !editor.isActive('heading'),
      run: () => editor.chain().focus().setParagraph().run(),
    }),
  );
  gBlock.appendChild(
    tbBtn({
      label: 'Blockquote',
      shortcut: `${mod}+${shift}+B`,
      glyph: '“”',
      active: () => editor.isActive('blockquote'),
      run: () => editor.chain().focus().toggleBlockquote().run(),
    }),
  );
  richToolbar.appendChild(gBlock);
  richToolbar.appendChild(tbDivider());

  // Group: lists
  const gLists = tbGroup('Lists');
  gLists.appendChild(
    tbBtn({
      label: 'Bullet list',
      shortcut: `${mod}+${shift}+8`,
      glyph: '•',
      active: () => editor.isActive('bulletList'),
      run: () => editor.chain().focus().toggleBulletList().run(),
    }),
  );
  gLists.appendChild(
    tbBtn({
      label: 'Ordered list',
      shortcut: `${mod}+${shift}+7`,
      glyph: '1.',
      active: () => editor.isActive('orderedList'),
      run: () => editor.chain().focus().toggleOrderedList().run(),
    }),
  );
  gLists.appendChild(
    tbBtn({
      label: 'Task list',
      shortcut: `${mod}+${shift}+9`,
      glyph: '☑',
      active: () => editor.isActive('taskList'),
      run: () => editor.chain().focus().toggleTaskList().run(),
    }),
  );
  gLists.appendChild(
    tbBtn({
      label: 'Decrease indent',
      shortcut: `${shift}+Tab`,
      glyph: '⇤',
      canRun: () => editor.can().liftListItem('listItem') || editor.can().liftListItem('taskItem'),
      active: () => false,
      run: () => {
        // Try both list-item types; whichever applies will succeed.
        if (!editor.chain().focus().liftListItem('taskItem').run()) {
          editor.chain().focus().liftListItem('listItem').run();
        }
      },
    }),
  );
  gLists.appendChild(
    tbBtn({
      label: 'Increase indent',
      shortcut: 'Tab',
      glyph: '⇥',
      canRun: () => editor.can().sinkListItem('listItem') || editor.can().sinkListItem('taskItem'),
      active: () => false,
      run: () => {
        if (!editor.chain().focus().sinkListItem('taskItem').run()) {
          editor.chain().focus().sinkListItem('listItem').run();
        }
      },
    }),
  );
  richToolbar.appendChild(gLists);
  richToolbar.appendChild(tbDivider());

  // Group: insert
  const gInsert = tbGroup('Insert');
  gInsert.appendChild(
    tbBtn({
      label: 'Horizontal rule',
      shortcut: `${mod}+${shift}+H`,
      glyph: '―',
      active: () => false,
      run: () => editor.chain().focus().setHorizontalRule().run(),
    }),
  );
  gInsert.appendChild(
    tbBtn({
      label: 'Image',
      shortcut: '',
      glyph: '▣',
      active: () => false,
      run: () => {
        // Phase 4: open the editor's hidden file input via the existing
        // `te-slash-image` event that editor.js wires to the sidebar
        // uploader. If the page doesn't render a sidebar uploader (test
        // harness, embedded preview), fall back to a URL prompt so the
        // button still does something.
        const slashImage = new CustomEvent('te-slash-image', { bubbles: true });
        const fileInput = document.getElementById('ed-file-input');
        if (fileInput && typeof fileInput.click === 'function') {
          rootEl.dispatchEvent(slashImage);
          return;
        }
        const url = window.prompt('Image URL');
        if (!url) return;
        if (!isSafeLinkUrl(url)) {
          alert('That URL is not allowed.');
          return;
        }
        editor.chain().focus().setImage({ src: url }).run();
      },
    }),
  );
  gInsert.appendChild(
    tbBtn({
      label: 'Embed',
      shortcut: '',
      glyph: '⧉',
      active: () => false,
      run: () => {
        // Phase 7: dispatch the same event the slash menu uses so the
        // page-level wiring can route through its own picker if it
        // wants to; fall back to an inline URL prompt + /api/embed.
        const evt = new CustomEvent('te-slash-embed', { bubbles: true, cancelable: true });
        const handled = !editor.view.dom.dispatchEvent(evt);
        if (!handled) triggerEmbedPrompt(editor);
      },
    }),
  );
  richToolbar.appendChild(gInsert);
  richToolbar.appendChild(tbDivider());

  // Group: history
  const gHist = tbGroup('History');
  gHist.appendChild(
    tbBtn({
      label: 'Undo',
      shortcut: `${mod}+Z`,
      glyph: '↶',
      active: () => false,
      canRun: () => editor.can().undo(),
      run: () => editor.chain().focus().undo().run(),
    }),
  );
  gHist.appendChild(
    tbBtn({
      label: 'Redo',
      shortcut: `${mod}+${shift}+Z`,
      glyph: '↷',
      active: () => false,
      canRun: () => editor.can().redo(),
      run: () => editor.chain().focus().redo().run(),
    }),
  );
  richToolbar.appendChild(gHist);

  // ─── Phase 3c: advanced-block buttons ───────────────────────
  //
  // Math, Callout (dropdown), Footnote — always available. Tables get
  // their own contextual group below that only shows up when the
  // cursor is inside a `table`.
  richToolbar.appendChild(tbDivider());
  const gAdv = tbGroup('Advanced');
  gAdv.appendChild(
    tbBtn({
      label: 'Math (inline)',
      shortcut: '',
      glyph: '∑',
      active: () => editor.isActive('mathInline') || editor.isActive('mathBlock'),
      run: () => {
        editor
          .chain()
          .focus()
          .insertContent({ type: 'mathInline', attrs: { formula: '' } })
          .run();
      },
    }),
  );

  // Callout dropdown — clicking the button cycles through info → tip →
  // warn → danger → off, mirroring what the slash menu's four entries
  // provide more verbosely. The aria-label updates per state.
  const calloutTypes = ['info', 'tip', 'warn', 'danger'];
  let calloutCursor = 0;
  gAdv.appendChild(
    tbBtn({
      label: 'Callout (cycle type)',
      shortcut: '',
      glyph: '!',
      className: 'te-tb-callout',
      active: () => editor.isActive('callout'),
      run: () => {
        if (editor.isActive('callout')) {
          editor.chain().focus().unsetCallout().run();
          return;
        }
        const type = calloutTypes[calloutCursor % calloutTypes.length];
        calloutCursor += 1;
        editor.chain().focus().setCallout(type).run();
      },
    }),
  );
  gAdv.appendChild(
    tbBtn({
      label: 'Footnote',
      shortcut: '',
      glyph: '†',
      active: () => false,
      run: () => insertFootnote(editor, null),
    }),
  );
  richToolbar.appendChild(gAdv);

  // ─── Code-block language picker ─────────────────────────────
  //
  // Shows up as a small <select> wrapped in a button-group div, but is
  // hidden unless the cursor is inside a codeBlock. We keep the markup
  // present at all times so the toolbar layout doesn't shift when the
  // user enters/leaves a code block.
  const gCode = tbGroup('Code language');
  gCode.classList.add('te-tb-code-group');
  const langLabel = document.createElement('label');
  langLabel.className = 'te-tb-lang-label';
  langLabel.setAttribute('aria-label', 'Code block language');
  const langSel = document.createElement('select');
  langSel.className = 'te-tb-lang';
  langSel.setAttribute('aria-label', 'Code block language');
  CODE_LANGUAGES.forEach((opt) => {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    langSel.appendChild(o);
  });
  langSel.addEventListener('change', () => {
    if (!editor.isActive('codeBlock')) return;
    const v = langSel.value || null;
    editor.chain().focus().updateAttributes('codeBlock', { language: v }).run();
  });
  langLabel.appendChild(langSel);
  gCode.appendChild(langLabel);
  richToolbar.appendChild(gCode);

  // ─── Table contextual group ────────────────────────────────
  //
  // Buttons here are no-ops unless the cursor is in a table. The whole
  // group hides (display:none) when out-of-table to keep the toolbar
  // compact.
  richToolbar.appendChild(tbDivider());
  const gTable = tbGroup('Table');
  gTable.classList.add('te-tb-table-group');
  function tableBtn(label, glyph, runFn) {
    return tbBtn({
      label,
      shortcut: '',
      glyph,
      active: () => false,
      canRun: () => editor.isActive('table'),
      run: runFn,
    });
  }
  gTable.appendChild(
    tableBtn('Add row above', '⤴', () => editor.chain().focus().addRowBefore().run()),
  );
  gTable.appendChild(
    tableBtn('Add row below', '⤵', () => editor.chain().focus().addRowAfter().run()),
  );
  gTable.appendChild(
    tableBtn('Add column left', '⇤', () => editor.chain().focus().addColumnBefore().run()),
  );
  gTable.appendChild(
    tableBtn('Add column right', '⇥', () => editor.chain().focus().addColumnAfter().run()),
  );
  gTable.appendChild(tableBtn('Delete row', '−', () => editor.chain().focus().deleteRow().run()));
  gTable.appendChild(
    tableBtn('Delete column', '×', () => editor.chain().focus().deleteColumn().run()),
  );
  gTable.appendChild(
    tableBtn('Toggle header row', 'H', () => editor.chain().focus().toggleHeaderRow().run()),
  );
  gTable.appendChild(
    tableBtn('Delete table', '⌫', () => editor.chain().focus().deleteTable().run()),
  );
  richToolbar.appendChild(gTable);

  function refreshToolbarState() {
    toolbarButtons.forEach((b) => {
      try {
        b._update();
      } catch (_) {
        /* ignore */
      }
    });
    // Show the table contextual group only when the cursor is in a
    // table; show the language picker only when in a code block. We
    // toggle a class rather than `display: none` so screen-reader
    // discovery is preserved when in the right context.
    const inTable = editor.isActive('table');
    const inCode = editor.isActive('codeBlock');
    gTable.classList.toggle('is-visible', inTable);
    gTable.classList.toggle('is-hidden', !inTable);
    gCode.classList.toggle('is-visible', inCode);
    gCode.classList.toggle('is-hidden', !inCode);
    if (inCode) {
      const attrs = editor.getAttributes('codeBlock');
      const lang = attrs && attrs.language ? String(attrs.language) : '';
      if (langSel.value !== lang) langSel.value = lang;
    }
  }
  refreshToolbarState();

  // ── Link dialog ───────────────────────────────────────────
  let linkDialog = null;
  let linkPrevFocus = null;
  function ensureLinkDialog() {
    if (linkDialog) return linkDialog;
    const wrap = document.createElement('div');
    wrap.className = 'te-link-dialog';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'te-link-title');
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="te-link-card">' +
      '<h3 id="te-link-title">Link</h3>' +
      '<div class="te-link-field"><label for="te-link-text">Text</label>' +
      '<input id="te-link-text" type="text" autocomplete="off" /></div>' +
      '<div class="te-link-field"><label for="te-link-url">URL</label>' +
      '<input id="te-link-url" type="text" autocomplete="off" placeholder="https://" /></div>' +
      '<p class="te-link-error" id="te-link-error" hidden></p>' +
      '<div class="te-link-foot">' +
      '<button type="button" class="te-link-cancel">Cancel</button>' +
      '<button type="button" class="te-link-remove">Remove link</button>' +
      '<button type="button" class="te-link-ok">Apply</button>' +
      '</div></div>';
    document.body.appendChild(wrap);
    linkDialog = {
      el: wrap,
      txt: wrap.querySelector('#te-link-text'),
      url: wrap.querySelector('#te-link-url'),
      err: wrap.querySelector('#te-link-error'),
      ok: wrap.querySelector('.te-link-ok'),
      cancel: wrap.querySelector('.te-link-cancel'),
      remove: wrap.querySelector('.te-link-remove'),
    };
    linkDialog.cancel.addEventListener('click', closeLinkDialog);
    linkDialog.ok.addEventListener('click', applyLinkDialog);
    linkDialog.remove.addEventListener('click', () => {
      editor.chain().focus().unsetLink().run();
      closeLinkDialog();
    });
    linkDialog.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeLinkDialog();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        applyLinkDialog();
      } else if (e.key === 'Tab') {
        // Focus trap.
        const focusables = Array.from(
          linkDialog.el.querySelectorAll('input, button, [tabindex]:not([tabindex="-1"])'),
        ).filter((n) => !n.disabled && !n.hidden);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
    return linkDialog;
  }
  function openLinkDialog() {
    const d = ensureLinkDialog();
    const { from, to, empty } = editor.state.selection;
    const selectedText = empty ? '' : editor.state.doc.textBetween(from, to, ' ');
    const existing = editor.getAttributes('link') || {};
    d.txt.value = selectedText;
    d.url.value = existing.href || '';
    d.err.hidden = true;
    d.err.textContent = '';
    d.remove.hidden = !existing.href;
    d.el.hidden = false;
    d.el.classList.add('open');
    linkPrevFocus = document.activeElement;
    // If the selection is non-empty we hide the text field — Cmd+K with
    // a selection should only ask for a URL.
    const textRow = d.txt.closest('.te-link-field');
    if (!empty) {
      textRow.style.display = 'none';
      queueMicrotask(() => d.url.focus());
    } else {
      textRow.style.display = '';
      queueMicrotask(() => d.txt.focus());
    }
  }
  function closeLinkDialog() {
    if (!linkDialog) return;
    linkDialog.el.classList.remove('open');
    linkDialog.el.hidden = true;
    if (linkPrevFocus && typeof linkPrevFocus.focus === 'function') {
      try {
        linkPrevFocus.focus();
      } catch (_) {
        /* ignore */
      }
    }
    // Return focus to the editor surface afterwards.
    queueMicrotask(() => editor.commands.focus());
  }
  function applyLinkDialog() {
    if (!linkDialog) return;
    const url = (linkDialog.url.value || '').trim();
    const txt = (linkDialog.txt.value || '').trim();
    if (!url) {
      linkDialog.err.textContent = 'URL is required.';
      linkDialog.err.hidden = false;
      return;
    }
    if (!isSafeLinkUrl(url)) {
      linkDialog.err.textContent = 'That URL scheme is not allowed.';
      linkDialog.err.hidden = false;
      return;
    }
    const { empty } = editor.state.selection;
    if (empty) {
      const label = txt || url;
      editor
        .chain()
        .focus()
        .insertContent([
          {
            type: 'text',
            text: label,
            marks: [{ type: 'link', attrs: { href: url } }],
          },
        ])
        .run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
    closeLinkDialog();
  }

  // ── Public façade ─────────────────────────────────────────
  // An EventTarget so consumers can do `instance.addEventListener('input', …)`.
  const instance = new EventTarget();

  Object.defineProperty(instance, 'value', {
    get() {
      return hidden.value;
    },
    set(next) {
      const md = String(next === null || next === undefined ? '' : next);
      if (hidden.value === md && mode === 'wysiwyg') {
        // No-op fast path; but always sync TipTap if its serialised
        // form differs (e.g., on first hydration).
        if (getMarkdownFromEditor() === md) return;
      }
      suppressInput = true;
      hidden.value = md;
      if (mode === 'source') {
        if (cmView && cmView.state.doc.toString() !== md) {
          cmView.dispatch({ changes: { from: 0, to: cmView.state.doc.length, insert: md } });
        }
      }
      // Always update TipTap (even when not focused) so a later mode
      // switch starts from the right document.
      applyMarkdownToEditor(md, false);
      selectionStart = selectionEnd = md.length;
      suppressInput = false;
      emitInput();
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(instance, 'selectionStart', {
    get() {
      if (mode === 'source' && cmView) return cmView.state.selection.main.from;
      return selectionStart;
    },
    set(n) {
      const v = Math.max(0, Math.min(Number(n) || 0, hidden.value.length));
      selectionStart = v;
      if (mode === 'source' && cmView) {
        cmView.dispatch({ selection: { anchor: v, head: v } });
      }
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(instance, 'selectionEnd', {
    get() {
      if (mode === 'source' && cmView) return cmView.state.selection.main.to;
      return selectionEnd;
    },
    set(n) {
      const v = Math.max(0, Math.min(Number(n) || 0, hidden.value.length));
      selectionEnd = v;
      if (mode === 'source' && cmView) {
        cmView.dispatch({ selection: { anchor: selectionStart, head: v } });
      }
    },
    configurable: true,
    enumerable: true,
  });

  instance.setMode = setMode;
  instance.getMode = () => mode;
  instance.focus = () => {
    if (mode === 'source' && cmView) cmView.focus();
    else editor.commands.focus();
  };
  instance.destroy = () => {
    try {
      editor.destroy();
    } catch (_) {
      /* ignore */
    }
    if (cmView) cmView.destroy();
    cmView = null;
    try {
      slashMenu.destroy();
    } catch (_) {
      /* ignore */
    }
    if (linkDialog && linkDialog.el && linkDialog.el.parentNode) {
      try {
        linkDialog.el.parentNode.removeChild(linkDialog.el);
      } catch (_) {
        /* ignore */
      }
      linkDialog = null;
    }
    // Phase 7 paste-to-embed UI.
    try {
      embedPasteCleanup();
    } catch (_) {
      /* ignore */
    }
    rootEl.innerHTML = '';
    rootEl.classList.remove('te-editor');
  };
  // Test/external hooks for Phase 3b features.
  instance.openLinkDialog = openLinkDialog;
  instance.closeLinkDialog = closeLinkDialog;
  instance._slashMenu = slashMenu;
  instance._toolbarButtons = toolbarButtons;

  // Hook the placeholder onto the WYSIWYG when empty (Phase 3b will
  // make this a proper TipTap placeholder extension; for now we use
  // CSS :empty pseudo as a stop-gap).
  if (opts.placeholder) {
    rootEl.dataset.placeholder = opts.placeholder;
  }

  // Hydrate initial content. We do this last so all listeners are in
  // place — but with input suppressed since the caller already knows
  // what they passed in.
  suppressInput = true;
  applyMarkdownToEditor(md0, false);
  suppressInput = false;
  refreshToolbarState();

  // ── Phase 3d: find & replace modal ───────────────────────
  //
  // The modal lives inside the editor root so it scrolls with the pane.
  // Cmd+F (Mod+F) opens it — both when the editor has focus and when
  // any element inside the editor root has focus. We hijack the event
  // before the browser opens its native find.
  const findModal = createFindReplaceModal(
    rootEl,
    editor,
    () => cmView,
    () => mode,
  );

  // Cmd+F shortcut for both modes. TipTap-style keymap covers WYSIWYG;
  // CodeMirror keymap (defined further down) covers source mode; the
  // root-level keydown handles either while focus is on the toolbar.
  function isModF(e) {
    return (e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F');
  }
  rootEl.addEventListener('keydown', (e) => {
    if (!isModF(e)) return;
    e.preventDefault();
    e.stopPropagation();
    findModal.toggle();
  });
  // CodeMirror's keymap dispatches a custom editor-find event when
  // source-mode users hit Cmd+F — pick it up and open the same modal.
  rootEl.addEventListener('editor-find', (e) => {
    e.preventDefault?.();
    findModal.open();
  });

  // ── Phase 3d: TOC sidebar ─────────────────────────────────
  //
  // The page mounts the TOC container before calling mount(); we look
  // it up by id and wire updates here. If the host page doesn't render
  // a container, this is a silent no-op.
  const tocContainer = document.getElementById('ed-toc-body');
  const tocEmpty = document.getElementById('ed-toc-empty');
  const toc = tocContainer ? buildTocController(editor, tocContainer, tocEmpty) : null;
  if (toc) {
    editor.on('transaction', () => {
      // Schedule a throttled re-scan — heading nodes might have been
      // added/removed/edited, so the TOC structure could be stale.
      toc.schedule();
    });
    editor.on('selectionUpdate', () => {
      toc.setActiveFromSelection();
    });
  }

  // ── Phase 3d: drag-handle keyboard-only mode ──────────────
  //
  // Already wired via the teFindReplace extension's addKeyboardShortcuts
  // — `Alt+Shift+ArrowUp/Down` moves the current top-level block.

  // Expose the underlying editors for Phase 3b/c/d hooks. Treat these
  // as semi-private: prefer the façade API where possible.
  instance._tiptap = editor;
  instance._getCM = () => cmView;
  instance._hidden = hidden;
  instance._findModal = findModal;
  instance._toc = toc;
  instance.openFind = () => findModal.open();
  instance.closeFind = () => findModal.close();
  instance.getToc = () => (toc ? toc.getNodes() : []);

  return instance;
}

function isMacLike() {
  if (typeof navigator === 'undefined') return false;
  // navigator.platform is deprecated but still the most reliable
  // synchronous signal for keyboard symbol selection.
  const p = (navigator.platform || '') + ' ' + (navigator.userAgent || '');
  return /Mac|iPhone|iPad|iPod/i.test(p);
}

// Default export is the namespace expected on window.TEEditor.
export default { mount, isSafeLinkUrl, resolveEmbed, looksLikeSingleUrlPaste };
