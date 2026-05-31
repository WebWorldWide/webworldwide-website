/**
 * Universal typewriter — progressive enhancement.
 *
 * Any element carrying [data-typewriter] has its (server-rendered) text typed
 * out character-by-character behind a blinking `_` caret. The full text ships
 * in the HTML for SEO / no-JS / screen readers — the element also gets an
 * aria-label — so JS only *replaces* the visible text with an animated copy
 * (marked aria-hidden). prefers-reduced-motion leaves the text untouched.
 *
 * Typing starts when the element scrolls into view (IntersectionObserver), so
 * a long listing types its cards as you reach them instead of all at once.
 * The full text stays visible until that moment (no blank gap), then the
 * element clears and types. Mirrors the self-booting pattern of clouds.ts.
 *
 * Per-element tuning via data attributes:
 *   data-tw-delay="300"   delay (ms) after the element is in view (default 0)
 *   data-tw-speed="28"    ms per character (default 28; jittered +0–70%)
 *   data-tw-persist       keep the caret blinking after typing completes
 */

const REDUCE =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function animate(el: HTMLElement): void {
  // Idempotent — never run twice on the same element (HMR / re-observe).
  if (el.dataset.twReady === '1') return;
  const full = (el.textContent ?? '').trim();
  if (!full) return;

  el.dataset.twReady = '1';
  if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', full);

  const delay = Number(el.dataset.twDelay ?? 0) || 0;
  const speed = Number(el.dataset.twSpeed ?? 28) || 28;
  const persist = el.dataset.twPersist !== undefined;

  const begin = (): void => {
    // Reserve the current rendered height so clearing can't collapse the
    // line box (avoids layout shift). Fonts are already loaded by now.
    const h = el.getBoundingClientRect().height;
    if (h > 0) el.style.minHeight = `${h}px`;

    el.textContent = '';
    const text = document.createElement('span');
    text.setAttribute('aria-hidden', 'true');
    const caret = document.createElement('span');
    caret.className = 'type-caret';
    caret.setAttribute('aria-hidden', 'true');
    el.append(text, caret);

    let i = 0;
    const tick = (): void => {
      i = Math.min(i + 1, full.length);
      text.textContent = full.slice(0, i);
      if (i < full.length) {
        setTimeout(tick, speed + Math.random() * speed * 0.7);
      } else if (!persist) {
        caret.remove();
      }
    };
    tick();
  };

  if (delay > 0) setTimeout(begin, delay);
  else begin();
}

export function startTypewriter(root: ParentNode = document): void {
  const els = Array.from(root.querySelectorAll<HTMLElement>('[data-typewriter]'));
  if (!els.length) return;
  // Reduced motion: leave the server-rendered text exactly as shipped.
  if (REDUCE) return;

  const observe = (): void => {
    if (!('IntersectionObserver' in window)) {
      els.forEach(animate);
      return;
    }
    const io = new IntersectionObserver(
      (entries, obs) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            animate(e.target as HTMLElement);
            obs.unobserve(e.target);
          }
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    els.forEach((el) => io.observe(el));
  };

  // Wait for fonts so reserved heights match the final glyphs (no CLS).
  if (document.fonts?.ready) {
    document.fonts.ready.then(observe);
  } else {
    observe();
  }
}

// Auto-start when imported as a page script.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => startTypewriter());
  } else {
    startTypewriter();
  }
}
