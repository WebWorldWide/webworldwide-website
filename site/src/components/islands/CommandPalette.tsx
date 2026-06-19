/**
 * CommandPalette — ⌘K search palette React island.
 *
 * Receives a slim PostSummary[] at build time (not full bodies — keeps
 * hydration payload small). Filters in-memory as the user types.
 *
 * A11y:
 *   - role="dialog" + aria-modal on the backdrop
 *   - role="combobox" on the input with aria-controls/expanded
 *   - role="listbox" + role="option" on results with aria-activedescendant
 *   - Esc closes; Arrow Up/Down + Home/End navigate; Enter selects
 *   - aria-live polite on the count for SR announcement
 *   - Focus trap: focus returns to the trigger on close
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import type { PostSummary } from '@/lib/post-utils';

/* This island implements the WAI-ARIA combobox/listbox + dialog pattern by
   hand (see the A11y notes above): the listbox/option roles on ul/li are
   correct, the backdrop closes on click as a convenience while Escape +
   arrow keys provide full keyboard control. jsx-a11y/strict can't see the
   keyboard handling wired at the dialog level, so its element/role checks
   are false positives here. */
/* eslint-disable jsx-a11y/no-noninteractive-element-to-interactive-role, jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions, jsx-a11y/no-noninteractive-element-interactions */

const LISTBOX_ID = 'cmdk-listbox';

export default function CommandPalette({ posts }: { posts: PostSummary[] }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Open via click on a [data-open-cmdk] trigger; close via Escape. We
  // deliberately do NOT bind a global open shortcut (e.g. ⌘K) — a website
  // can't own a keystroke across every OS/browser, so search is click-driven.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    // Listen for clicks on any [data-open-cmdk] trigger.
    function onTriggerClick(e: Event) {
      const tgt = e.target as HTMLElement | null;
      if (tgt && tgt.closest('[data-open-cmdk]')) {
        e.preventDefault();
        triggerRef.current = tgt.closest('[data-open-cmdk]') as HTMLElement | null;
        setOpen(true);
      }
    }
    document.addEventListener('click', onTriggerClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onTriggerClick);
    };
  }, [open]);

  // Focus input on open; restore focus on close.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      document.body.style.overflow = 'hidden';
      return () => {
        clearTimeout(t);
        document.body.style.overflow = '';
      };
    } else {
      setQ('');
      setActiveIdx(0);
      triggerRef.current?.focus();
    }
  }, [open]);

  const results = useMemo(() => {
    const ql = q.toLowerCase().trim();
    const filtered = ql
      ? posts.filter(
          (p) =>
            p.title.toLowerCase().includes(ql) ||
            p.excerpt.toLowerCase().includes(ql) ||
            p.slug.toLowerCase().includes(ql),
        )
      : posts;
    return filtered.slice(0, 10);
  }, [q, posts]);

  // Keep activeIdx in range when results shrink.
  useEffect(() => {
    if (activeIdx >= results.length) setActiveIdx(Math.max(0, results.length - 1));
  }, [results, activeIdx]);

  function onListKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIdx(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIdx(Math.max(0, results.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = results[activeIdx];
      if (pick) {
        setOpen(false);
        window.location.assign(pick.url);
      }
    } else if (e.key === 'Tab') {
      // Focus trap: the input is the ONLY focusable element inside the
      // dialog (the listbox uses aria-activedescendant, so options are
      // not in the tab order). Trap Tab + Shift+Tab on the input itself
      // so focus can never leak to background page elements while open.
      e.preventDefault();
    }
  }

  if (!open) return null;

  return (
    <div
      className="cmdk-back"
      role="dialog"
      aria-modal="true"
      aria-label="Search posts"
      onClick={() => setOpen(false)}
    >
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input">
          <span className="cmdk-prompt" aria-hidden="true">
            ›
          </span>
          <input
            ref={inputRef}
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onListKey}
            placeholder="search posts…"
            role="combobox"
            aria-expanded="true"
            aria-controls={LISTBOX_ID}
            aria-activedescendant={results.length ? `cmdk-opt-${activeIdx}` : undefined}
            autoComplete="off"
            spellCheck="false"
            aria-label="Search posts"
            aria-describedby="cmdk-esc-hint"
          />
          {/* Visual hint is decorative; the real instruction is announced to
              screen readers via aria-describedby on the input. */}
          <span className="kbd" aria-hidden="true">
            ESC
          </span>
          <span id="cmdk-esc-hint" className="sr-only">
            Press Escape to close
          </span>
        </div>
        <div className="cmdk-section" aria-live="polite" aria-atomic="true">
          {`// POSTS — ${results.length}`}
        </div>
        <ul id={LISTBOX_ID} role="listbox" aria-label="Search results" className="cmdk-list">
          {results.length === 0 ? (
            <li className="cmdk-empty" role="option" aria-selected="false">
              no matches in the archive.
            </li>
          ) : (
            results.map((p, i) => (
              <li
                key={p.slug}
                id={`cmdk-opt-${i}`}
                role="option"
                aria-selected={i === activeIdx}
                className={`cmdk-row${i === activeIdx ? ' is-active' : ''}`}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => {
                  setOpen(false);
                  window.location.assign(p.url);
                }}
              >
                <div className="cmdk-row-l">
                  <span className="cmdk-row-icon" aria-hidden="true">
                    ▸
                  </span>
                  <span className="cmdk-row-title">{p.title}</span>
                </div>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
