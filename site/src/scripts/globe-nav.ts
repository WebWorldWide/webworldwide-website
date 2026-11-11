/**
 * Pixel-art Earth for the nav + hero (replaces the old wireframe).
 *
 * The globe is a real world map (lib/world-map.ts, Natural Earth) drawn as
 * N×N chunky pixels by lib/pixel-globe.ts, scaled up with
 * `image-rendering: pixelated` and clipped to a circle by CSS.
 *
 * Smoothness: a revolution is baked ONCE into a sheet of frames (tiny —
 * each frame is N×N px), and a step-end transform animation flips through
 * it on the compositor. Nothing runs on the main thread per frame. The
 * Earth turns west to east, as seen from space: features drift right.
 *
 * Honors prefers-reduced-motion: one still frame, no spin.
 */
import { globeSampler, paintClasses } from '../lib/pixel-globe.ts';

type GlobeOpts = {
  /** Globe resolution in pixels across (default: one pixel per 1.5 CSS px). */
  pixels?: number;
  /** Spin (default true). */
  spin?: boolean;
  /** Seconds per revolution. */
  period?: number;
};

/** Latitude the globe is seen from: a little north, so Europe/Asia read. */
const VIEW_LAT = 5;
/** Longitude facing the viewer at rest: the Atlantic (Americas + Africa). */
const START_LON = -30;
/** Transparent-free gutter around each sheet cell (edge pixels repeated). */
const G = 2;

export async function makeGlobe(canvas: HTMLCanvasElement, opts: GlobeOpts = {}): Promise<void> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const n = Math.max(12, Math.round(opts.pixels ?? (canvas.clientWidth || 50) / 1.5));
  canvas.width = n;
  canvas.height = n;
  const sample = globeSampler(n, VIEW_LAT);

  // First frame straight onto the canvas — visible immediately.
  const first = ctx.createImageData(n, n);
  paintClasses(first.data, n, 0, 0, n, sample(START_LON));
  ctx.putImageData(first, 0, 0);

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || opts.spin === false) return;

  // One frame per half-pixel of turn at the disc's centre.
  const FRAMES = Math.round(2 * Math.PI * n);
  const period = opts.period ?? 24;
  const cw = n + 2 * G;
  const cols = Math.ceil(Math.sqrt(FRAMES));
  const rows = Math.ceil(FRAMES / cols);
  const sheet = document.createElement('canvas');
  sheet.width = cw * cols;
  sheet.height = cw * rows;
  const sctx = sheet.getContext('2d');
  if (!sctx) return;
  const img = sctx.createImageData(sheet.width, sheet.height);
  const cell = new Uint8Array(n * n * 4);

  // Build the frames in small idle batches so page load never sees a long task.
  const idle = (cb: () => void): void => {
    if ('requestIdleCallback' in window) requestIdleCallback(cb, { timeout: 200 });
    else setTimeout(cb, 16);
  };
  await new Promise<void>((done) => {
    let k = 0;
    const batch = (): void => {
      const end = Math.min(FRAMES, k + 16);
      for (; k < end; k++) {
        paintClasses(cell, n, 0, 0, n, sample(START_LON - (k / FRAMES) * 360));
        // Copy into the sheet with the edge pixels repeated into the gutter,
        // so sub-pixel placement can never show a seam at the rim.
        const ox = (k % cols) * cw;
        const oy = Math.floor(k / cols) * cw;
        for (let j = -G; j < n + G; j++) {
          const sj = Math.min(n - 1, Math.max(0, j));
          for (let i = -G; i < n + G; i++) {
            const si = Math.min(n - 1, Math.max(0, i));
            const s = (sj * n + si) * 4;
            const d = ((oy + j + G) * sheet.width + ox + i + G) * 4;
            img.data[d] = cell[s];
            img.data[d + 1] = cell[s + 1];
            img.data[d + 2] = cell[s + 2];
            img.data[d + 3] = 255;
          }
        }
      }
      if (k < FRAMES) idle(batch);
      else done();
    };
    idle(batch);
  });
  sctx.putImageData(img, 0, 0);

  // Hand the sheet over as an image (the CSP allows data: images, not
  // blob:). An image layer, unlike an animated canvas, never drops its
  // backing store mid-animation.
  const url = await new Promise<string | null>((resolve) => {
    sheet.toBlob((blob) => {
      if (!blob) return resolve(null);
      const fr = new FileReader();
      fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    }, 'image/png');
  });
  if (!url) return;
  const pre = new Image();
  pre.src = url;
  await pre.decode().catch(() => undefined);

  const reel = document.createElement('div');
  reel.className = 'globe-strip-reel';
  reel.style.width = `${(cw * cols * 100) / n}%`;
  reel.style.height = `${(cw * rows * 100) / n}%`;
  reel.style.left = `${(-G * 100) / n}%`;
  reel.style.top = `${(-G * 100) / n}%`;
  reel.style.backgroundImage = `url("${url}")`;

  const host = canvas.parentElement;
  if (!host) return;
  const viewport = document.createElement('div');
  viewport.className = 'globe-strip';
  viewport.setAttribute('aria-hidden', 'true');
  viewport.appendChild(reel);
  host.insertBefore(viewport, canvas.nextSibling);

  // One keyframe per frame, each held (step-end) until the next.
  const keyframes: Keyframe[] = [];
  for (let k = 0; k <= FRAMES; k++) {
    const f = k % FRAMES;
    keyframes.push({
      offset: k / FRAMES,
      easing: 'step-end',
      transform: `translate3d(-${((f % cols) * 100) / cols}%, -${(Math.floor(f / cols) * 100) / rows}%, 0)`,
    });
  }
  const anim = reel.animate(keyframes, { duration: period * 1000, iterations: Infinity });
  canvas.style.visibility = 'hidden';

  // Pause the (already cheap) animation while it can't be seen.
  let onScreen = true;
  const sync = (): void => {
    if (onScreen && !document.hidden) anim.play();
    else anim.pause();
  };
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      onScreen = entries[0]?.isIntersecting ?? true;
      sync();
    }).observe(viewport);
  }
  document.addEventListener('visibilitychange', sync);
}

/** Initialize all globes matching a selector. */
export function initGlobes(selector = 'canvas[data-globe]'): void {
  for (const canvas of document.querySelectorAll<HTMLCanvasElement>(selector)) {
    makeGlobe(canvas).catch((err) => {
      console.warn('[globe-nav] failed to init', err);
    });
  }
}
