/**
 * Extruded 3D app icons — drag-to-spin with idle auto-spin.
 *
 * Each .spinner becomes a solid object (extrude.ts): front + back faces and
 * side walls that follow the icon's own silhouette and edge colours.
 *
 * Smoothness: the idle spin (rotation + gentle nod) is a Web Animation on
 * `transform`, so the compositor plays it at the display's refresh rate
 * (120Hz included) with no main-thread work per frame. JavaScript only runs
 * while the icon is being dragged or flung. Wall lighting is baked once into
 * the object (light from the upper left of the icon), so it turns with it.
 *
 * Pointer events drag, with click-vs-drag detection (move > 6px = swallow
 * click). Keyboard: Space toggles the spin, arrow keys nudge it.
 * prefers-reduced-motion: no idle spin; drag still works.
 */

import { isLiteDevice } from './perf.ts';
import { buildSolid, renderSolid, shadeSolid } from './extrude.ts';

// Silhouette detail. Each wall is a small composited quad; rasterised once,
// then only moved by the GPU, so high counts are cheap after the first paint.
const MAX_WALLS = isLiteDevice() ? 96 : 260;
const DEPTH = 44;
const SIZE = 200; // .drift box (px); 172 on narrow screens — read at build
const NOD_CYCLES = 2; // nods per revolution — keeps the loop seamless

const reducedMotion = (): boolean =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

type Fallback = { label?: string; bg?: string; ink?: string };

function attachSpinner(spinner: HTMLElement): void {
  const icon = spinner.getAttribute('data-icon');
  const fallbackAttr = spinner.getAttribute('data-fallback');
  const drift = spinner.closest('.drift') as HTMLElement | null;

  let fallback: Fallback | null = null;
  try {
    fallback = fallbackAttr ? JSON.parse(fallbackAttr) : null;
  } catch {
    /* malformed fallback config: plain placeholder */
  }

  // Per-icon idle character, so the four don't tumble in lockstep.
  const spinBase = 18 + Math.random() * 14; // deg/s
  const nodAmp = 10 + Math.random() * 8; // deg
  const nodBase = -6;
  const nodPhase = Math.random() * Math.PI * 2;
  const revMs = (360 / spinBase) * 1000;

  let rotX = nodBase + Math.sin(nodPhase) * nodAmp;
  let rotY = Math.random() * 360;
  let anim: Animation | null = null;
  let animRy0 = rotY;
  let spinning = !reducedMotion();
  let onScreen = false;

  const size = (): number => spinner.clientWidth || SIZE;
  const transformFor = (rx: number, ry: number): string =>
    `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
  const nodAt = (t: number): number =>
    nodBase + Math.sin(nodPhase + t * Math.PI * 2 * NOD_CYCLES) * nodAmp;

  /** Current angles: from the running animation if there is one. */
  function currentAngles(): [number, number] {
    if (anim && anim.currentTime !== null) {
      const ms = Number(anim.currentTime);
      const t = (ms % revMs) / revMs;
      return [nodAt(t), animRy0 + t * 360];
    }
    return [rotX, rotY];
  }

  /** (Re)start the compositor spin from the current pose. */
  function startSpin(): void {
    stopSpin();
    if (!spinning || reducedMotion()) {
      spinner.style.transform = transformFor(rotX, rotY);
      return;
    }
    // Start the loop where the pose is now (no jump after a drag): pick the
    // point in the nod cycle matching the current tilt, then offset the
    // yaw so the keyframes pass through the current heading at that time.
    const phase = Math.asin(Math.max(-1, Math.min(1, (rotX - nodBase) / nodAmp))) - nodPhase;
    const t0 = (((phase / (Math.PI * 2 * NOD_CYCLES)) % 1) + 1) % 1;
    animRy0 = rotY - t0 * 360;
    const K = 48;
    const frames: Keyframe[] = [];
    for (let k = 0; k <= K; k++) {
      const t = k / K;
      frames.push({ transform: transformFor(nodAt(t), animRy0 + t * 360) });
    }
    spinner.style.transform = '';
    anim = spinner.animate(frames, { duration: revMs, iterations: Infinity, easing: 'linear' });
    anim.currentTime = t0 * revMs;
    if (!onScreen || document.hidden) anim.pause();
  }

  function stopSpin(): void {
    if (anim) {
      [rotX, rotY] = currentAngles();
      anim.cancel();
      anim = null;
    }
    spinner.style.transform = transformFor(rotX, rotY);
  }

  function syncTimers(): void {
    if (!anim) return;
    if (onScreen && !document.hidden) anim.play();
    else anim.pause();
  }

  const mount = async (src: string | null): Promise<void> => {
    const solid = await buildSolid(src, fallback || { label: '?' }, MAX_WALLS);
    const rendered = renderSolid(spinner, solid, size(), DEPTH * (size() / SIZE));
    // Baked lighting: shade once for the icon's front-on pose.
    shadeSolid(rendered, -8, -24);
  };
  void (async () => {
    try {
      await mount(icon);
    } catch {
      // An icon that fails to load degrades to the drawn placeholder tile.
      await mount(null).catch(() => undefined);
    }
  })();

  if (drift) {
    drift.style.animationDelay = `${-Math.random() * 5.4}s`;
    drift.style.animationDuration = `${4.8 + Math.random() * 2.4}s`;
  }

  // Spinning is a custom pointer gesture — suppress the browser's native drag.
  spinner.setAttribute('draggable', 'false');
  spinner.addEventListener('dragstart', (e) => e.preventDefault());

  startSpin();

  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      onScreen = entries[0]?.isIntersecting ?? true;
      syncTimers();
    }).observe(spinner);
  } else {
    onScreen = true;
  }
  syncTimers();
  document.addEventListener('visibilitychange', syncTimers);

  // Hover (mouse/pen): spin faster and pop (scale is its own transform
  // property, so it composes with the animation; CSS transitions it).
  spinner.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'touch') return;
    spinner.classList.add('is-hover');
    if (anim) anim.updatePlaybackRate(2.4);
  });
  spinner.addEventListener('pointerleave', () => {
    spinner.classList.remove('is-hover');
    if (anim) anim.updatePlaybackRate(1);
  });

  // Drag: the pose follows the pointer; a fling coasts, then the idle spin
  // resumes from wherever it came to rest.
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let lastT = 0;
  let velX = 0;
  let velY = 0;
  let moveSum = 0;
  let coastRaf = 0;

  const clampX = (): void => {
    rotX = Math.max(-72, Math.min(72, rotX));
  };
  function pose(): void {
    clampX();
    spinner.style.transform = transformFor(rotX, rotY);
  }

  function coast(): void {
    cancelAnimationFrame(coastRaf);
    let last = performance.now();
    const step = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const drag = Math.pow(0.94, dt * 60);
      velY *= drag;
      velX *= drag;
      rotY += velY * dt;
      rotX += velX * dt;
      pose();
      if (Math.abs(velY) > spinBase * 1.2 || Math.abs(velX) > 20) {
        coastRaf = requestAnimationFrame(step);
      } else {
        coastRaf = 0;
        startSpin();
        syncTimers();
      }
    };
    coastRaf = requestAnimationFrame(step);
  }

  spinner.addEventListener('pointerdown', (e) => {
    dragging = true;
    cancelAnimationFrame(coastRaf);
    stopSpin();
    syncTimers();
    spinner.setPointerCapture(e.pointerId);
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = performance.now();
    moveSum = 0;
    velX = 0;
    velY = 0;
  });
  spinner.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const now = performance.now();
    const dt = Math.max(8, now - lastT);
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    rotY += dx * 0.5;
    rotX -= dy * 0.35;
    velY = Math.max(-2400, Math.min(2400, (dx * 0.5) / (dt / 1000)));
    velX = Math.max(-1400, Math.min(1400, -(dy * 0.35) / (dt / 1000)));
    moveSum += Math.abs(dx) + Math.abs(dy);
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = now;
    pose();
  });
  const end = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    try {
      spinner.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    // A stale velocity (pointer held still before release) shouldn't fling.
    if (performance.now() - lastT > 80) {
      velX = 0;
      velY = 0;
    }
    coast();
  };
  spinner.addEventListener('pointerup', end);
  spinner.addEventListener('pointercancel', end);
  spinner.addEventListener('lostpointercapture', () => {
    if (dragging) {
      dragging = false;
      coast();
    }
  });

  // a11y: keyboard equivalents
  spinner.setAttribute('tabindex', '0');
  spinner.addEventListener('keydown', (e) => {
    let handled = true;
    const nudge = (fn: () => void): void => {
      stopSpin();
      fn();
      pose();
      if (spinning) startSpin();
      syncTimers();
    };
    switch (e.key) {
      case ' ':
        spinning = !spinning;
        if (spinning) startSpin();
        else stopSpin();
        syncTimers();
        break;
      case 'ArrowLeft':
        nudge(() => (rotY -= 10));
        break;
      case 'ArrowRight':
        nudge(() => (rotY += 10));
        break;
      case 'ArrowUp':
        nudge(() => (rotX -= 6));
        break;
      case 'ArrowDown':
        nudge(() => (rotX += 6));
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  });

  // Click handling on the parent <a>:
  //  - if the user dragged (moved > 6px), swallow the click (it was a spin);
  //  - otherwise navigate to data-href. The real destination lives in
  //    `data-href` (not `href`) so the raw URL never previews in the browser
  //    status bar while spinning/hovering; `href="#apps"` is a harmless no-JS
  //    fallback. Tiles with no destination ("coming soon") just no-op.
  const link = spinner.closest('a');
  if (link) {
    link.setAttribute('draggable', 'false');
    link.addEventListener('dragstart', (e) => e.preventDefault());
    link.addEventListener(
      'click',
      (e) => {
        if (moveSum > 6) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        const dest = link.getAttribute('data-href');
        if (!dest) return;
        e.preventDefault();
        if (/^https?:/i.test(dest)) {
          window.open(dest, '_blank', 'noopener');
        } else {
          window.location.assign(dest);
        }
      },
      true,
    );
  }
}

export function initAppSpinners(selector = '[data-spin]'): void {
  const spinners = [...document.querySelectorAll<HTMLElement>(selector)];
  if (!spinners.length) return;
  // Don't trace + build the solids during page load for a section below the
  // fold: wait until it's within a screen of the viewport, then build in
  // idle time.
  const build = (): void => {
    // One icon per idle slot, so tracing + building never lands as a single
    // long task while the visitor is scrolling toward the section.
    const queue = [...spinners];
    const next = (): void => {
      const el = queue.shift();
      if (!el) return;
      attachSpinner(el);
      if ('requestIdleCallback' in window) requestIdleCallback(next, { timeout: 400 });
      else setTimeout(next, 16);
    };
    if ('requestIdleCallback' in window) requestIdleCallback(next, { timeout: 400 });
    else setTimeout(next, 0);
  };
  if (!('IntersectionObserver' in window)) return build();
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        build();
      }
    },
    { rootMargin: '100% 0px' },
  );
  io.observe(spinners[0].closest('section') || spinners[0]);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initAppSpinners());
  } else {
    initAppSpinners();
  }
}
