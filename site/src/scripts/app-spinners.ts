/**
 * Extruded 3D app icons — drag-to-spin with idle auto-spin.
 *
 * Each .spinner becomes a solid object (extrude.ts): front + back faces and
 * side walls that follow the icon's own silhouette and edge colours, shaded
 * as it turns. Pointer events drag, with click-vs-drag detection
 * (move > 6px = swallow click).
 *
 * Keyboard equivalents (a11y):
 *   - Focus + Space toggles idle auto-spin
 *   - Arrow keys nudge rotation
 *
 * Respects prefers-reduced-motion: drag still works but idle auto-spin
 * is disabled.
 */

import { isLiteDevice } from './perf.ts';
import { buildSolid, renderSolid, shadeSolid, type Rendered } from './extrude.ts';

// Fewer wall pieces on slow devices (each is a small 3D-transformed layer).
const MAX_WALLS = isLiteDevice() ? 36 : 84;
const DEPTH = 44;
const SIZE = 200; // .drift box (px); 172 on narrow screens — read at build
// Frame budget: 60fps normally, 30fps on lite devices (a slow idle spin
// looks identical at 30fps and halves the work).
const MIN_FRAME_MS = isLiteDevice() ? 1000 / 30 : 0;

const reducedMotion = (): boolean =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function attachSpinner(spinner: HTMLElement): void {
  const icon = spinner.getAttribute('data-icon');
  const fallback = spinner.getAttribute('data-fallback');
  const drift = spinner.closest('.drift') as HTMLElement | null;

  let parsedFallback: { label?: string; bg?: string; ink?: string } | null = null;
  try {
    parsedFallback = fallback ? JSON.parse(fallback) : null;
  } catch {
    /* malformed fallback config: plain placeholder */
  }
  let rendered: Rendered | null = null;
  const size = (): number => spinner.clientWidth || SIZE;
  const mount = (icn: string | null): Promise<void> =>
    buildSolid(icn, parsedFallback || { label: '?' }, MAX_WALLS).then((solid) => {
      rendered = renderSolid(spinner, solid, size(), DEPTH * (size() / SIZE));
      shadeSolid(rendered, rotX, rotY);
    });

  if (drift) {
    drift.style.animationDelay = `${-Math.random() * 5.4}s`;
    drift.style.animationDuration = `${4.8 + Math.random() * 2.4}s`;
  }

  // Spinning is a custom pointer gesture — suppress the browser's native drag
  // (the "dragging a PNG" ghost + no-drop cursor) on the icon and its layers.
  spinner.setAttribute('draggable', 'false');
  spinner.addEventListener('dragstart', (e) => e.preventDefault());

  let rotX = -8 + (Math.random() - 0.5) * 6;
  let rotY = Math.random() * 360;
  let velY = reducedMotion() ? 0 : 16 + Math.random() * 10;
  let velX = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let lastT = 0;
  let moveSum = 0;
  let touched = false;
  let touchedAt = 0;
  let hovering = false;
  let scale = 1;

  // Per-icon idle character, so the four don't tumble in lockstep.
  const spinBase = 18 + Math.random() * 14; // idle Y-spin speed (deg/s)
  const wobbleFreq = 0.5 + Math.random() * 0.5; // X-nod frequency
  const wobblePhase = Math.random() * Math.PI * 2; // X-nod desync
  const wobbleAmp = 10 + Math.random() * 8; // X-nod amplitude (deg)

  function apply(): void {
    if (rotX > 72) rotX = 72;
    if (rotX < -72) rotX = -72;
    spinner.style.transform = `rotateX(${rotX}deg) rotateY(${rotY}deg) scale(${scale.toFixed(3)})`;
    if (rendered) shadeSolid(rendered, rotX, rotY);
  }
  apply();
  // An unreachable icon degrades to the drawn placeholder tile.
  mount(icon).catch(() => mount(null).catch(() => undefined));

  let lastFrame = performance.now();
  let onScreen = true;
  let running = false;
  function loop(now: number): void {
    if (MIN_FRAME_MS && now - lastFrame < MIN_FRAME_MS - 1) {
      if (onScreen && !document.hidden) requestAnimationFrame(loop);
      else running = false;
      return;
    }
    const dt = Math.min(0.06, (now - lastFrame) / 1000);
    lastFrame = now;
    // Ease the hover "pop" every frame, even mid-drag.
    const targetScale = hovering && !reducedMotion() ? 1.07 : 1;
    scale += (targetScale - scale) * Math.min(1, dt * 8);
    if (!dragging) {
      const drag = Math.pow(0.99, dt * 60); // gentle — flings keep spinning longer
      velY *= drag;
      velX *= drag;
      rotY += velY * dt;
      rotX += velX * dt;
      const idle = !touched || performance.now() - touchedAt > 1500;
      if (idle && !reducedMotion()) {
        const t = now / 1000;
        const target = hovering ? spinBase * 2.6 : spinBase;
        velY += (target - velY) * Math.min(1, dt * 0.8);
        // Gentle multi-axis nod instead of resting at a fixed tilt.
        const amp = hovering ? wobbleAmp * 1.6 : wobbleAmp;
        const targetX = -6 + Math.sin(t * wobbleFreq + wobblePhase) * amp;
        rotX += (targetX - rotX) * Math.min(1, dt * 1.1);
        velX *= 0.9; // let the wobble own the X axis once settled
      }
    }
    apply();
    if (onScreen && !document.hidden) requestAnimationFrame(loop);
    else running = false;
  }
  function startLoop(): void {
    if (running || !onScreen || document.hidden) return;
    running = true;
    lastFrame = performance.now();
    requestAnimationFrame(loop);
  }
  startLoop();
  // Pause this icon's spin loop while it's scrolled off-screen or the tab is
  // hidden (the apps section sits mid-page; four 60fps loops are wasteful —
  // and a drain — when unseen).
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      onScreen = entries[0]?.isIntersecting ?? true;
      if (onScreen) startLoop();
    });
    io.observe(spinner);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) startLoop();
  });

  // Hover (mouse/pen): perk up — spin faster + pop in scale.
  spinner.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'touch') return;
    hovering = true;
    touched = true;
    touchedAt = 0; // engage the lively idle immediately
    if (!reducedMotion() && Math.abs(velY) < spinBase) velY += 36;
  });
  spinner.addEventListener('pointerleave', () => {
    hovering = false;
  });

  spinner.addEventListener('pointerdown', (e) => {
    dragging = true;
    touched = true;
    touchedAt = performance.now();
    spinner.setPointerCapture(e.pointerId);
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = performance.now();
    moveSum = 0;
    velY = 0;
    velX = 0;
  });
  spinner.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const now = performance.now();
    const dt = Math.max(8, now - lastT);
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    rotY += dx * 0.5;
    rotX -= dy * 0.35;
    velY = (dx * 0.5) / (dt / 1000);
    velX = -(dy * 0.35) / (dt / 1000);
    velY = Math.max(-2400, Math.min(2400, velY));
    velX = Math.max(-1400, Math.min(1400, velX));
    moveSum += Math.abs(dx) + Math.abs(dy);
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = now;
    apply();
  });
  const end = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    try {
      spinner.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };
  spinner.addEventListener('pointerup', end);
  spinner.addEventListener('pointercancel', end);
  spinner.addEventListener('lostpointercapture', () => {
    dragging = false;
  });

  // a11y: keyboard equivalents
  spinner.setAttribute('tabindex', '0');
  spinner.addEventListener('keydown', (e) => {
    let handled = true;
    switch (e.key) {
      case ' ':
        // toggle auto-spin
        velY = velY === 0 ? 24 : 0;
        touched = true;
        touchedAt = performance.now();
        break;
      case 'ArrowLeft':
        rotY -= 10;
        break;
      case 'ArrowRight':
        rotY += 10;
        break;
      case 'ArrowUp':
        rotX -= 6;
        break;
      case 'ArrowDown':
        rotX += 6;
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      apply();
    }
  });

  // Click handling on the parent <a>:
  //  - if the user dragged (moved > 6px), swallow the click (it was a spin);
  //  - otherwise navigate to data-href. The real destination lives in
  //    `data-href` (not `href`) so the raw URL never previews in the browser
  //    status bar while spinning/hovering; `href="#apps"` is a harmless no-JS
  //    fallback. Tiles with no destination ("coming soon") just no-op.
  const link = spinner.closest('a');
  if (link) {
    // Stop the anchor itself from starting a native link-drag while spinning.
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
  // Don't trace + build the solids during page load for a section below the fold:
  // wait until it's within a screen of the viewport, then build in idle time.
  const build = (): void => {
    const run = (): void => spinners.forEach(attachSpinner);
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 600 });
    else setTimeout(run, 0);
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
