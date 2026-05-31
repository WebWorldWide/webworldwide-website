/**
 * Wordmark warp — 3-act sequence:
 *   1. Cascade entrance: each letter slides up + rotates upright along a line
 *   2. Warp: non-space letters re-position around a circle
 *   3. Central globe fades in inside the ring
 *
 * Triggered on DOMContentLoaded. Re-positions on resize.
 * Honors prefers-reduced-motion: skips animation, jumps to final ring state.
 */
import { makeGlobe } from './globe-nav.ts';

const ENTRANCE_BASE = 400;
const ENTRANCE_STAGGER = 70;
const ENTRANCE_DUR = 900;
const WARP_STAGGER = 70;
const DWELL = 1100;

export function initWordmarkWarp(): void {
  const wm = document.querySelector<HTMLElement>('.wordmark');
  const area = document.getElementById('wordmarkArea');
  const globe = document.getElementById('wordmarkGlobe');
  if (!wm || !area) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const text = wm.textContent ?? '';
  const chars = [...text];
  wm.textContent = '';

  const spans = chars.map((c) => {
    const s = document.createElement('span');
    s.className = 'ch' + (c === ' ' ? ' sp' : '');
    s.textContent = c === ' ' ? ' ' : c;
    s.style.position = 'static';
    s.style.opacity = '0';
    wm.appendChild(s);
    return s;
  });

  const widths = spans.map((s) => s.getBoundingClientRect().width);
  const totalWidth = widths.reduce((a, b) => a + b, 0);
  let cum = -totalWidth / 2;
  const linearXs = widths.map((w) => {
    const cx = cum + w / 2;
    cum += w;
    return cx;
  });
  spans.forEach((s) => {
    s.style.position = '';
  });
  spans.forEach((s, i) => {
    s.style.transform = `translate(-50%, -50%) translate(${linearXs[i]}px, 80px) rotate(-8deg)`;
  });
  void wm.offsetHeight;

  // Seam separator: an extra "•" that only appears once the letters form the
  // ring. Without it the loop reads "…WideWeb…" (the last word runs into the
  // first); with it the three words stay separated all the way around. It is
  // hidden during the linear cascade so the heading reads "Web • World • Wide".
  const seam = document.createElement('span');
  seam.className = 'ch seam';
  seam.textContent = '•';
  seam.setAttribute('aria-hidden', 'true');
  seam.style.opacity = '0';
  seam.style.transform = 'translate(-50%, -50%)';
  wm.appendChild(seam);

  // Glyphs that sit on the ring: every non-space character, then the seam
  // bullet at the end of the loop.
  const ringSpans: HTMLElement[] = [];
  chars.forEach((c, i) => {
    if (c !== ' ') ringSpans.push(spans[i]);
  });
  ringSpans.push(seam);
  const M = ringSpans.length;

  function computeRadius(): number {
    const r = area!.getBoundingClientRect();
    return Math.min(r.width, r.height) * 0.41;
  }

  function placeOnRing(): void {
    const R = computeRadius();
    ringSpans.forEach((s, j) => {
      const theta = (j / M) * Math.PI * 2 - Math.PI / 2;
      const tx = R * Math.cos(theta);
      const ty = R * Math.sin(theta);
      const rotDeg = ((theta + Math.PI / 2) * 180) / Math.PI;
      s.style.transform = `translate(-50%, -50%) translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) rotate(${rotDeg.toFixed(2)}deg)`;
    });
  }

  // Reduced motion: skip animation, jump to final state.
  if (reduced) {
    spans.forEach((s) => {
      s.style.opacity = '1';
    });
    seam.style.opacity = '1';
    placeOnRing();
    chars.forEach((c, i) => {
      if (c === ' ') spans[i].style.opacity = '0';
    });
    if (globe) globe.classList.add('on');
    const canvas = document.getElementById('wordmark-globe-canvas') as HTMLCanvasElement | null;
    if (canvas) makeGlobe(canvas, { speed: 0, chunkyPx: 80 }).catch(() => {});
    return;
  }

  // PHASE 1: cascade entrance
  spans.forEach((s, i) => {
    setTimeout(
      () => {
        s.style.transition = 'transform .9s cubic-bezier(.2, 1.2, .3, 1), opacity .6s ease-out';
        s.style.opacity = '1';
        s.style.transform = `translate(-50%, -50%) translate(${linearXs[i]}px, 0px) rotate(0deg)`;
      },
      ENTRANCE_BASE + i * ENTRANCE_STAGGER,
    );
  });

  // PHASE 2: warp to circle
  const WARP_DELAY = ENTRANCE_BASE + (chars.length - 1) * ENTRANCE_STAGGER + ENTRANCE_DUR + DWELL;
  setTimeout(() => {
    const R = computeRadius();
    ringSpans.forEach((s, j) => {
      const theta = (j / M) * Math.PI * 2 - Math.PI / 2;
      const tx = R * Math.cos(theta);
      const ty = R * Math.sin(theta);
      const rotDeg = ((theta + Math.PI / 2) * 180) / Math.PI;
      setTimeout(() => {
        s.style.transition = 'transform 1.4s cubic-bezier(.55, .0, .2, 1.04), opacity .6s ease-out';
        s.style.opacity = '1';
        s.style.transform = `translate(-50%, -50%) translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) rotate(${rotDeg.toFixed(2)}deg)`;
      }, j * WARP_STAGGER);
    });
    chars.forEach((c, i) => {
      if (c === ' ') {
        spans[i].style.transition = 'opacity .4s ease-out';
        spans[i].style.opacity = '0';
      }
    });

    // PHASE 3: central globe slides in
    setTimeout(() => {
      if (globe) globe.classList.add('on');
      const canvas = document.getElementById('wordmark-globe-canvas') as HTMLCanvasElement | null;
      if (canvas) makeGlobe(canvas, { speed: 0.012, chunkyPx: 80 }).catch(() => {});
    }, 600);
  }, WARP_DELAY);

  // Re-place on resize once the warp is done.
  let resizeTimer: ReturnType<typeof setTimeout>;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!globe || !globe.classList.contains('on')) return;
      placeOnRing();
    }, 150);
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWordmarkWarp);
  } else {
    initWordmarkWarp();
  }
}
