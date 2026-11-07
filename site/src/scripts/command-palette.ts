/**
 * Search palette (vanilla; replaces the React island).
 *
 * WAI-ARIA dialog + combobox/listbox:
 *   - role="dialog" + aria-modal on the backdrop
 *   - role="combobox" on the input with aria-controls / aria-activedescendant
 *   - role="listbox" + role="option" on results
 *   - Esc closes; ArrowUp/Down + Home/End navigate; Enter opens
 *   - aria-live polite on the result count
 *   - focus stays on the input while open, and returns to the trigger on close
 * Opened only by clicking a [data-open-cmdk] trigger (no global shortcut).
 */
type Post = { title: string; url: string; slug: string; excerpt: string };

const LISTBOX_ID = 'cmdk-listbox';
let posts: Post[] | null = null;
let root: HTMLElement | null = null;
let input: HTMLInputElement;
let list: HTMLUListElement;
let count: HTMLElement;
let results: Post[] = [];
let active = 0;
let trigger: HTMLElement | null = null;

function loadPosts(): Post[] {
  if (posts) return posts;
  try {
    posts = JSON.parse(document.getElementById('cmdk-data')?.textContent || '[]') as Post[];
  } catch {
    posts = [];
  }
  return posts;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function build(): void {
  root = el('div', {
    class: 'cmdk-back',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Search posts',
  });
  const box = el('div', { class: 'cmdk' });
  const bar = el('div', { class: 'cmdk-input' });
  bar.append(el('span', { class: 'cmdk-prompt', 'aria-hidden': 'true' }, '›'));
  input = el('input', {
    type: 'text',
    placeholder: 'search posts…',
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': LISTBOX_ID,
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Search posts',
    'aria-describedby': 'cmdk-esc-hint',
  });
  bar.append(
    input,
    el('span', { class: 'kbd', 'aria-hidden': 'true' }, 'ESC'),
    el('span', { id: 'cmdk-esc-hint', class: 'sr-only' }, 'Press Escape to close'),
  );
  count = el('div', { class: 'cmdk-section', 'aria-live': 'polite', 'aria-atomic': 'true' });
  list = el('ul', {
    id: LISTBOX_ID,
    role: 'listbox',
    'aria-label': 'Search results',
    class: 'cmdk-list',
  });
  box.append(bar, count, list);
  root.append(box);

  root.addEventListener('click', (e) => {
    if (e.target === root) close();
  });
  box.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.cmdk-row');
    if (row) go(Number(row.dataset.i));
  });
  list.addEventListener('mousemove', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.cmdk-row');
    if (row && Number(row.dataset.i) !== active) setActive(Number(row.dataset.i));
  });
  input.addEventListener('input', render);
  input.addEventListener('keydown', onKey);
}

function render(): void {
  const q = input.value.toLowerCase().trim();
  const all = loadPosts();
  results = (
    q
      ? all.filter(
          (p) =>
            p.title.toLowerCase().includes(q) ||
            p.excerpt.toLowerCase().includes(q) ||
            p.slug.toLowerCase().includes(q),
        )
      : all
  ).slice(0, 10);
  active = Math.min(active, Math.max(0, results.length - 1));
  count.textContent = `// POSTS — ${results.length}`;
  list.textContent = '';
  if (!results.length) {
    list.append(
      el(
        'li',
        { class: 'cmdk-empty', role: 'option', 'aria-selected': 'false' },
        'no matches in the archive.',
      ),
    );
  } else {
    results.forEach((p, i) => {
      const li = el('li', {
        id: `cmdk-opt-${i}`,
        role: 'option',
        'aria-selected': String(i === active),
        class: `cmdk-row${i === active ? ' is-active' : ''}`,
        'data-i': String(i),
      });
      const l = el('div', { class: 'cmdk-row-l' });
      l.append(
        el('span', { class: 'cmdk-row-icon', 'aria-hidden': 'true' }, '▸'),
        el('span', { class: 'cmdk-row-title' }, p.title),
      );
      li.append(l);
      list.append(li);
    });
  }
  syncActive();
}

function syncActive(): void {
  if (results.length) input.setAttribute('aria-activedescendant', `cmdk-opt-${active}`);
  else input.removeAttribute('aria-activedescendant');
}

function setActive(i: number): void {
  const rows = list.querySelectorAll<HTMLElement>('.cmdk-row');
  rows[active]?.classList.remove('is-active');
  rows[active]?.setAttribute('aria-selected', 'false');
  active = i;
  rows[active]?.classList.add('is-active');
  rows[active]?.setAttribute('aria-selected', 'true');
  rows[active]?.scrollIntoView({ block: 'nearest' });
  syncActive();
}

function go(i: number): void {
  const pick = results[i];
  if (!pick) return;
  close();
  window.location.assign(pick.url);
}

function onKey(e: KeyboardEvent): void {
  const last = Math.max(0, results.length - 1);
  if (e.key === 'ArrowDown') setActive(Math.min(last, active + 1));
  else if (e.key === 'ArrowUp') setActive(Math.max(0, active - 1));
  else if (e.key === 'Home') setActive(0);
  else if (e.key === 'End') setActive(last);
  else if (e.key === 'Enter') go(active);
  else if (e.key === 'Escape') close();
  else if (e.key === 'Tab') {
    /* Focus trap: the input is the only focusable element in the dialog. */
  } else return;
  e.preventDefault();
}

function open(from: HTMLElement): void {
  if (!root) build();
  if (root!.isConnected) return;
  trigger = from;
  input.value = '';
  active = 0;
  render();
  document.body.append(root!);
  document.body.style.overflow = 'hidden';
  // Focus synchronously so keystrokes typed right after the click land in
  // the search box.
  input.focus();
}

function close(): void {
  if (!root?.isConnected) return;
  root.remove();
  document.body.style.overflow = '';
  trigger?.focus();
}

document.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-open-cmdk]');
  if (t) {
    e.preventDefault();
    open(t);
  }
});
