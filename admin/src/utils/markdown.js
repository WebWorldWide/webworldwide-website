// @ts-check
/**
 * markdown.js — server-side Markdown / ProseMirror JSON helpers.
 *
 * The Phase 3 admin frontend (admin/public/js/editor.entry.js) bundles
 * TipTap + a custom prosemirror-markdown parser/serializer. We mirror
 * that contract on the server so Node code (e.g., future preview
 * rendering, search-index build, save-time validation) can round-trip
 * Markdown through the same TipTap-shaped document tree without having
 * to spin up a browser-only TipTap editor.
 *
 * The schema declared here is intentionally a minimal copy of what
 * StarterKit + extension-link + extension-task-list produce — node
 * names match (camelCase: `bulletList`, `codeBlock`, `hardBreak`,
 * `horizontalRule`, plus `taskList`/`taskItem`), and the mark names
 * match TipTap's (`bold`, `italic`, `code`, `link`). DOM
 * serialization is intentionally simple; this module is for parsing,
 * not rendering.
 *
 * Round-trip rules (mirrored from the bundle):
 *   - ATX headings, never Setext
 *   - bullet lists use "-"
 *   - ordered lists default `start: 1`
 *   - fenced code blocks (```), never indented
 *   - inline links, never reference-style
 *   - hardBreak serialises as a bare "\n"
 *
 * Used by:
 *   - admin/test/editor.vitest.test.js (round-trip fixture test)
 *   - Phase 3c+ server-side preview rendering (not yet wired)
 */
import { Schema } from 'prosemirror-model';
import { MarkdownParser, MarkdownSerializer } from 'prosemirror-markdown';
import MarkdownIt from 'markdown-it';
import mdContainer from 'markdown-it-container';
import mdFootnote from 'markdown-it-footnote';

/**
 * Minimal TipTap-shaped ProseMirror schema. Only nodes/marks that
 * survive Markdown round-trip are declared.
 */
export const tipTapSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    blockquote: {
      content: 'block+',
      group: 'block',
      defining: true,
      parseDOM: [{ tag: 'blockquote' }],
      toDOM: () => ['blockquote', 0],
    },
    horizontalRule: {
      group: 'block',
      parseDOM: [{ tag: 'hr' }],
      toDOM: () => ['hr'],
    },
    heading: {
      attrs: { level: { default: 1 } },
      content: 'inline*',
      group: 'block',
      defining: true,
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
      toDOM: (node) => [`h${node.attrs.level}`, 0],
    },
    codeBlock: {
      content: 'text*',
      group: 'block',
      code: true,
      defining: true,
      marks: '',
      attrs: { language: { default: null } },
      parseDOM: [
        {
          tag: 'pre',
          preserveWhitespace: 'full',
          getAttrs: (node) => ({
            language: node.getAttribute('data-language') || null,
          }),
        },
      ],
      toDOM: (node) => [
        'pre',
        node.attrs.language ? { 'data-language': node.attrs.language } : {},
        ['code', 0],
      ],
    },
    bulletList: {
      content: 'listItem+',
      group: 'block',
      attrs: { tight: { default: false } },
      parseDOM: [{ tag: 'ul' }],
      toDOM: () => ['ul', 0],
    },
    orderedList: {
      content: 'listItem+',
      group: 'block',
      attrs: { start: { default: 1 }, tight: { default: false } },
      parseDOM: [
        {
          tag: 'ol',
          getAttrs: (dom) => ({
            start: dom.hasAttribute('start') ? Number(dom.getAttribute('start')) || 1 : 1,
          }),
        },
      ],
      toDOM: (node) => ['ol', node.attrs.start === 1 ? {} : { start: node.attrs.start }, 0],
    },
    listItem: {
      content: 'block+',
      defining: true,
      parseDOM: [{ tag: 'li' }],
      toDOM: () => ['li', 0],
    },
    taskList: {
      content: 'taskItem+',
      group: 'block',
      parseDOM: [{ tag: 'ul[data-type="taskList"]' }],
      toDOM: () => ['ul', { 'data-type': 'taskList' }, 0],
    },
    taskItem: {
      content: 'paragraph block*',
      defining: true,
      attrs: { checked: { default: false } },
      parseDOM: [
        {
          tag: 'li[data-type="taskItem"]',
          getAttrs: (dom) => ({ checked: dom.getAttribute('data-checked') === 'true' }),
        },
      ],
      toDOM: (node) => [
        'li',
        { 'data-type': 'taskItem', 'data-checked': node.attrs.checked ? 'true' : 'false' },
        0,
      ],
    },
    text: { group: 'inline' },
    image: {
      inline: true,
      group: 'inline',
      attrs: { src: {}, alt: { default: null }, title: { default: null } },
      draggable: true,
      parseDOM: [
        {
          tag: 'img[src]',
          getAttrs: (dom) => ({
            src: dom.getAttribute('src'),
            title: dom.getAttribute('title'),
            alt: dom.getAttribute('alt'),
          }),
        },
      ],
      toDOM: (node) => ['img', node.attrs],
    },
    hardBreak: {
      inline: true,
      group: 'inline',
      selectable: false,
      parseDOM: [{ tag: 'br' }],
      toDOM: () => ['br'],
    },
    // Phase 3c: tables, math, callouts, footnotes.
    table: {
      content: 'tableRow+',
      group: 'block',
      isolating: true,
      parseDOM: [{ tag: 'table' }],
      toDOM: () => ['table', ['tbody', 0]],
    },
    tableRow: {
      content: '(tableCell | tableHeader)*',
      parseDOM: [{ tag: 'tr' }],
      toDOM: () => ['tr', 0],
    },
    tableCell: {
      content: 'block+',
      attrs: { colspan: { default: 1 }, rowspan: { default: 1 } },
      isolating: true,
      parseDOM: [{ tag: 'td' }],
      toDOM: () => ['td', 0],
    },
    tableHeader: {
      content: 'block+',
      attrs: { colspan: { default: 1 }, rowspan: { default: 1 } },
      isolating: true,
      parseDOM: [{ tag: 'th' }],
      toDOM: () => ['th', { scope: 'col' }, 0],
    },
    mathInline: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { formula: { default: '' } },
      parseDOM: [
        {
          tag: 'span[data-math-inline]',
          getAttrs: (el) => ({
            formula: el.getAttribute('data-formula') || el.textContent || '',
          }),
        },
      ],
      toDOM: (node) => [
        'span',
        { 'data-math-inline': 'true', 'data-formula': node.attrs.formula || '' },
        `$${node.attrs.formula || ''}$`,
      ],
    },
    mathBlock: {
      group: 'block',
      atom: true,
      attrs: { formula: { default: '' } },
      parseDOM: [
        {
          tag: 'div[data-math-block]',
          getAttrs: (el) => ({
            formula: el.getAttribute('data-formula') || el.textContent || '',
          }),
        },
      ],
      toDOM: (node) => [
        'div',
        { 'data-math-block': 'true', 'data-formula': node.attrs.formula || '' },
        `$$\n${node.attrs.formula || ''}\n$$`,
      ],
    },
    callout: {
      content: 'block+',
      group: 'block',
      defining: true,
      attrs: { type: { default: 'info' } },
      parseDOM: [
        {
          tag: 'aside.callout',
          getAttrs: (el) => {
            const m = (el.className || '').match(/callout-(info|tip|warn|danger)/);
            return { type: m ? m[1] : 'info' };
          },
        },
      ],
      toDOM: (node) => ['aside', { class: `callout callout-${node.attrs.type || 'info'}` }, 0],
    },
    footnoteRef: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { label: { default: '1' } },
      parseDOM: [
        {
          tag: 'sup.footnote-ref',
          getAttrs: (el) => ({ label: el.getAttribute('data-label') || '' }),
        },
      ],
      toDOM: (node) => [
        'sup',
        { class: 'footnote-ref', 'data-label': node.attrs.label || '' },
        ['a', { href: `#fn-${node.attrs.label}` }, `[${node.attrs.label}]`],
      ],
    },
    footnoteItem: {
      content: 'paragraph',
      defining: true,
      attrs: { label: { default: '1' } },
      parseDOM: [
        {
          tag: 'li[data-footnote-item]',
          getAttrs: (el) => ({ label: el.getAttribute('data-label') || '' }),
        },
      ],
      toDOM: (node) => [
        'li',
        {
          'data-footnote-item': 'true',
          'data-label': node.attrs.label || '',
          id: `fn-${node.attrs.label}`,
        },
        0,
      ],
    },
    footnoteBlock: {
      content: 'footnoteItem+',
      group: 'block',
      defining: true,
      isolating: true,
      parseDOM: [{ tag: 'ol.footnote-list' }],
      toDOM: () => ['ol', { class: 'footnote-list' }, 0],
    },
  },
  marks: {
    bold: {
      parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
      toDOM: () => ['strong'],
    },
    italic: {
      parseDOM: [{ tag: 'em' }, { tag: 'i' }],
      toDOM: () => ['em'],
    },
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      parseDOM: [
        {
          tag: 'a[href]',
          getAttrs: (dom) => ({
            href: dom.getAttribute('href'),
            title: dom.getAttribute('title'),
          }),
        },
      ],
      toDOM: (node) => ['a', node.attrs],
    },
    code: {
      parseDOM: [{ tag: 'code' }],
      toDOM: () => ['code'],
    },
  },
});

// Phase 3c: enable GFM tables + callout containers + footnotes. Note
// that we keep `html: false` here — the server-side parser is used by
// search/index/save pipelines where we never want raw HTML to slip in.
const rawTokenizer = MarkdownIt('commonmark', { html: false })
  .enable('table')
  .use(mdContainer, 'info')
  .use(mdContainer, 'tip')
  .use(mdContainer, 'warn')
  .use(mdContainer, 'danger')
  .use(mdFootnote);

/**
 * Wrap the markdown-it tokenizer so we can post-process the token
 * stream before prosemirror-markdown sees it:
 *   1. strip `thead`/`tbody` wrappers (the schema doesn't model them);
 *   2. inject paragraph wrappers around inline content inside th/td;
 *   3. split inline text runs on `$x$` for math nodes;
 *   4. detect block-level `$$ ... $$` paragraphs and rewrite them as
 *      a single `math_block` token.
 */
const MATH_INLINE = /\$([^\s$][^$\n]*?[^\s$]|\S)\$/;
function postProcessTokens(tokens) {
  // Step 1+2: table preprocessing.
  let stage = [];
  for (let i = 0; i < tokens.length; i++) {
    // eslint-disable-next-line security/detect-object-injection -- bounded
    const tok = tokens[i];
    if (tok.type === 'thead_open' || tok.type === 'thead_close') continue;
    if (tok.type === 'tbody_open' || tok.type === 'tbody_close') continue;
    // The footnote_anchor token has no Markdown form — it's a render-
    // time decoration. Drop it before prosemirror-markdown sees it so
    // we don't have to register it in tokenSpec.
    if (tok.type === 'footnote_anchor') continue;
    if (tok.type === 'th_open' || tok.type === 'td_open') {
      stage.push(tok);
      const pOpen = new tok.constructor('paragraph_open', 'p', 1);
      pOpen.block = true;
      stage.push(pOpen);
      continue;
    }
    if (tok.type === 'th_close' || tok.type === 'td_close') {
      const pClose = new tok.constructor('paragraph_close', 'p', -1);
      pClose.block = true;
      stage.push(pClose);
      stage.push(tok);
      continue;
    }
    stage.push(tok);
  }
  // Step 3: inline `$...$` math split.
  for (let i = 0; i < stage.length; i++) {
    // eslint-disable-next-line security/detect-object-injection -- bounded
    const tk = stage[i];
    if (!tk.children || tk.type !== 'inline') continue;
    const out = [];
    for (let j = 0; j < tk.children.length; j++) {
      // eslint-disable-next-line security/detect-object-injection -- bounded
      const c = tk.children[j];
      if (c.type !== 'text' || !c.content || c.content.indexOf('$') < 0) {
        out.push(c);
        continue;
      }
      let rest = c.content;
      while (rest.length) {
        const m = MATH_INLINE.exec(rest);
        if (!m) {
          if (rest) {
            const t = new c.constructor('text', '', 0);
            t.content = rest;
            t.level = c.level;
            out.push(t);
          }
          break;
        }
        if (m.index > 0) {
          const t = new c.constructor('text', '', 0);
          t.content = rest.slice(0, m.index);
          t.level = c.level;
          out.push(t);
        }
        const mt = new c.constructor('math_inline', '', 0);
        mt.content = m[1];
        mt.level = c.level;
        out.push(mt);
        rest = rest.slice(m.index + m[0].length);
      }
    }
    tk.children = out;
  }
  // Step 4: paragraph-level math block.
  const final = [];
  for (let i = 0; i < stage.length; i++) {
    /* eslint-disable security/detect-object-injection -- bounded i */
    const tok = stage[i];
    const next = stage[i + 1];
    const after = stage[i + 2];
    /* eslint-enable security/detect-object-injection */
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
      const mathTok = new tok.constructor('math_block', '', 0);
      mathTok.content = inner;
      mathTok.block = true;
      final.push(mathTok);
      i += 2;
      continue;
    }
    final.push(tok);
  }
  stage = final;
  return stage;
}

const tokenizer = {
  parse(text, env) {
    return postProcessTokens(rawTokenizer.parse(text || '', env || {}));
  },
};

function listIsTight(tokens, i) {
  while (++i < tokens.length) {
    // eslint-disable-next-line security/detect-object-injection -- `i` is bounded by tokens.length above.
    const tok = tokens[i];
    if (tok.type !== 'list_item_open') return tok.hidden;
  }
  return false;
}

/** markdown-it token → TipTap-shaped node/mark spec. */
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
  link: {
    mark: 'link',
    getAttrs: (tok) => ({
      href: tok.attrGet('href'),
      title: tok.attrGet('title') || null,
    }),
  },
  code_inline: { mark: 'code', noCloseToken: true },
  // Phase 3c: tables.
  table: { block: 'table' },
  tr: { block: 'tableRow' },
  th: { block: 'tableHeader' },
  td: { block: 'tableCell' },
  // Phase 3c: callouts.
  container_info: { block: 'callout', getAttrs: () => ({ type: 'info' }) },
  container_tip: { block: 'callout', getAttrs: () => ({ type: 'tip' }) },
  container_warn: { block: 'callout', getAttrs: () => ({ type: 'warn' }) },
  container_danger: { block: 'callout', getAttrs: () => ({ type: 'danger' }) },
  // Phase 3c: footnotes.
  footnote_ref: {
    node: 'footnoteRef',
    getAttrs: (tok) => ({ label: (tok.meta && tok.meta.label) || '' }),
  },
  footnote_block: { block: 'footnoteBlock' },
  footnote: {
    block: 'footnoteItem',
    getAttrs: (tok) => ({ label: (tok.meta && tok.meta.label) || '' }),
  },
  // footnote_anchor is stripped by postProcessTokens — never seen here.
  // Phase 3c: math.
  math_inline: {
    node: 'mathInline',
    getAttrs: (tok) => ({ formula: tok.content || '' }),
  },
  math_block: {
    node: 'mathBlock',
    getAttrs: (tok) => ({ formula: tok.content || '' }),
  },
};

export const markdownParser = new MarkdownParser(
  tipTapSchema,
  /** @type {any} */ (tokenizer),
  tokenSpec,
);

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

export const markdownSerializer = new MarkdownSerializer(
  {
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
      state.write(state.repeat('#', node.attrs.level) + ' ');
      state.renderInline(node, false);
      state.closeBlock(node);
    },
    horizontalRule(state, node) {
      state.write('---');
      state.closeBlock(node);
    },
    bulletList(state, node) {
      state.renderList(node, '  ', () => '- ');
    },
    orderedList(state, node) {
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
      state.renderList(node, '  ', () => '');
    },
    taskItem(state, node) {
      state.write(`- ${node.attrs.checked ? '[x]' : '[ ]'} `);
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
          state.write('\n');
          return;
        }
      }
    },
    text(state, node) {
      // `inAutolink` is an internal serializer flag — the public types
      // omit it but the field is documented as @internal. Cast through
      // any to silence TS's strict type check.
      state.text(node.text, !(/** @type {any} */ (state).inAutolink));
    },
    // Phase 3c: tables (GFM).
    table(state, node) {
      const rows = [];
      node.forEach((row) => {
        const cells = [];
        row.forEach((cell) => {
          cells.push(_serializeCellInline(state, cell));
        });
        rows.push(cells);
      });
      if (!rows.length) {
        state.closeBlock(node);
        return;
      }
      const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
      rows.forEach((r) => {
        while (r.length < colCount) r.push('');
      });
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
    tableRow(state, node) {
      state.renderContent(node);
    },
    tableCell(state, node) {
      state.renderContent(node);
    },
    tableHeader(state, node) {
      state.renderContent(node);
    },
    // Phase 3c: math.
    mathInline(state, node) {
      state.write('$' + (node.attrs.formula || '') + '$');
    },
    mathBlock(state, node) {
      state.write('$$\n' + (node.attrs.formula || '') + '\n$$');
      state.closeBlock(node);
    },
    // Phase 3c: callouts.
    callout(state, node) {
      state.write(':::' + (node.attrs.type || 'info') + '\n');
      state.renderContent(node);
      // `flushClose` is documented @internal but is the only way to
      // pop the pending blank line before writing the closing fence.
      /** @type {any} */ (state).flushClose(1);
      state.write(':::');
      state.closeBlock(node);
    },
    // Phase 3c: footnotes.
    footnoteRef(state, node) {
      state.write('[^' + (node.attrs.label || '') + ']');
    },
    footnoteBlock(state, node) {
      state.renderContent(node);
    },
    footnoteItem(state, node) {
      state.write('[^' + (node.attrs.label || '') + ']: ');
      state.renderInline(node.firstChild || node, false);
      state.closeBlock(node);
    },
  },
  {
    italic: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
    bold: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
    link: {
      open() {
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
  },
  { hardBreakNodeName: 'hardBreak' },
);

/**
 * Render a tableCell / tableHeader to its single-line pipe-cell form.
 * Internal helper used by the table serializer.
 *
 * @param {any} state — markdown serializer state (any-typed for internal flags)
 * @param {import('prosemirror-model').Node} cell
 * @returns {string}
 */
function _serializeCellInline(state, cell) {
  const para = cell.firstChild;
  if (!para) return '';
  const oldOut = state.out;
  const oldAtBlank = state.atBlank;
  state.out = '';
  state.atBlank = true;
  state.renderInline(para, false);
  const inline = state.out.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
  state.out = oldOut;
  state.atBlank = oldAtBlank;
  return inline;
}

/**
 * Parse a Markdown string into a ProseMirror document (TipTap-shaped).
 * @param {string} markdown
 * @returns {import('prosemirror-model').Node}
 */
export function parseMarkdown(markdown) {
  return markdownParser.parse(markdown || '');
}

/**
 * Serialize a ProseMirror document back to Markdown.
 * @param {import('prosemirror-model').Node} doc
 * @returns {string}
 */
export function serializeMarkdown(doc) {
  return markdownSerializer.serialize(doc);
}

/**
 * Convenience: round-trip a Markdown string through parse → serialize.
 * Useful for tests asserting fixed-point stability.
 * @param {string} markdown
 * @returns {string}
 */
export function normalizeMarkdown(markdown) {
  return serializeMarkdown(parseMarkdown(markdown));
}
