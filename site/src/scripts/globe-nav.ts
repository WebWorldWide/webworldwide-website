/**
 * Wireframe globe for the nav + hero wordmark.
 *
 * Pure 2D-canvas implementation: the same lat/long wireframe the old
 * Three.js version drew (14 meridian half-circles, 8 parallels, ink
 * lines, perspective camera at z≈3.4), projected by hand. Dropping
 * WebGL removes the ~500 KB three-vendor chunk from every page and the
 * two GPU contexts the homepage used to spin up — the main culprits in
 * the homepage's perf score.
 *
 * Honors prefers-reduced-motion: we still render a single frame so the
 * globe is visible, but skip the rAF loop.
 */
type GlobeOpts = {
  speed?: number;
  meridians?: number;
  parallels?: number;
  color?: number;
  opacity?: number;
  tilt?: number;
  chunkyPx?: number;
};

type Vec3 = [number, number, number];

export async function makeGlobe(canvas: HTMLCanvasElement, opts: GlobeOpts = {}): Promise<void> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const meridians = opts.meridians ?? 14;
  const parallels = opts.parallels ?? 9;
  const lineSegs = 48;
  const tilt = ((opts.tilt ?? 0) * Math.PI) / 180;
  // Match the old PerspectiveCamera(fov 34°, z = 3.4) framing.
  const CAM_Z = 3.4;
  const FOV = (34 * Math.PI) / 180;

  const color = opts.color ?? 0x000000;
  const rgb = `${(color >> 16) & 255}, ${(color >> 8) & 255}, ${color & 255}`;
  const stroke = `rgba(${rgb}, ${opts.opacity ?? 1})`;

  // Build the unit-sphere polylines once.
  const lines: Vec3[][] = [];
  for (let i = 0; i < meridians; i++) {
    const pts: Vec3[] = [];
    const a = (i / meridians) * Math.PI * 2;
    for (let j = 0; j <= lineSegs; j++) {
      const t = (j / lineSegs) * Math.PI;
      pts.push([Math.sin(t) * Math.cos(a), Math.cos(t), Math.sin(t) * Math.sin(a)]);
    }
    lines.push(pts);
  }
  for (let i = 1; i < parallels; i++) {
    const pts: Vec3[] = [];
    const phi = (i / parallels) * Math.PI;
    const y = Math.cos(phi);
    const r = Math.sin(phi);
    for (let j = 0; j <= lineSegs; j++) {
      const t = (j / lineSegs) * Math.PI * 2;
      pts.push([r * Math.cos(t), y, r * Math.sin(t)]);
    }
    lines.push(pts);
  }

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // The Three version advanced rotation per FRAME at ~60fps; keep the
  // same on-screen speed but make it wall-clock based so a dropped
  // frame doesn't read as a stutter.
  const speedPerSec = (opts.speed ?? 0.012) * 60;

  function resize(): void {
    const dpr = opts.chunkyPx ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const w = opts.chunkyPx ?? Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = opts.chunkyPx ?? Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  const cosTilt = Math.cos(tilt);
  const sinTilt = Math.sin(tilt);

  function draw(rotY: number): void {
    const w = canvas.width;
    const h = canvas.height;
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(1, Math.min(w, h) / 72);
    const f = h / 2 / Math.tan(FOV / 2); // perspective focal length
    const cx = w / 2;
    const cy = h / 2;
    const cosR = Math.cos(rotY);
    const sinR = Math.sin(rotY);

    ctx.beginPath();
    for (const line of lines) {
      let first = true;
      for (const [x0, y0, z0] of line) {
        // rotate around Y (spin), then around Z (tilt) — same order as
        // the old scene graph (group.rotation.z wrapped rotation.y).
        const x1 = x0 * cosR + z0 * sinR;
        const z1 = -x0 * sinR + z0 * cosR;
        const x2 = x1 * cosTilt - y0 * sinTilt;
        const y2 = x1 * sinTilt + y0 * cosTilt;
        // perspective projection (camera on +z looking at origin)
        const s = f / (CAM_Z - z1);
        const px = cx + x2 * s;
        const py = cy - y2 * s;
        if (first) {
          ctx.moveTo(px, py);
          first = false;
        } else {
          ctx.lineTo(px, py);
        }
      }
    }
    ctx.stroke();
  }

  resize();
  if (reducedMotion || speedPerSec === 0) {
    draw(0.6); // single static frame
    return;
  }

  // Baked spin, played by the compositor. The wireframe repeats every
  // meridian step (2π / meridians), so one step's worth of frames is drawn
  // ONCE into a vertical strip and a steps() transform animation flips
  // through them. Nothing runs on the main thread per frame — the old rAF
  // loop forced a full style/layout pass every vsync (and with it every CSS
  // animation on the page), capped at 30fps.
  const period = (Math.PI * 2) / meridians / speedPerSec; // seconds per step
  const FRAMES = Math.max(24, Math.min(120, Math.round(period * 120))); // 120fps
  const fw = canvas.width;
  const fh = canvas.height;
  draw(0); // the canvas shows the first frame while the sheet is drawn

  // Frames go in a compact square-ish SHEET (not a tall strip): a strip of
  // 75 frames was ~7,500px tall, which the compositor rasterises only near
  // the visible window — jumping to an unrastered part showed blank
  // (white) for a frame or two, about twice a second. A ~900px sheet is
  // rastered whole, once. Each cell has a transparent gutter so sub-pixel
  // positioning can never bleed a neighbouring frame into the edges.
  const G = 2; // gutter, device px
  const cols = Math.ceil(Math.sqrt(FRAMES));
  const rows = Math.ceil(FRAMES / cols);
  const cw = fw + 2 * G;
  const ch = fh + 2 * G;
  const sheet = document.createElement('canvas');
  sheet.width = cw * cols;
  sheet.height = ch * rows;
  // The animated layer is a plain image of the sheet, not a live canvas:
  // a canvas used as an animated layer can drop its backing store for a
  // frame (seen as the nav globe blanking), an image layer cannot.
  const reel = document.createElement('div');
  reel.className = 'globe-strip-reel';
  // Sized in % of the viewport so it tracks CSS size changes; offset by one
  // gutter so the viewport shows exactly one frame.
  reel.style.width = `${(cw * cols * 100) / fw}%`;
  reel.style.height = `${(ch * rows * 100) / fh}%`;
  reel.style.left = `${(-G * 100) / fw}%`;
  reel.style.top = `${(-G * 100) / fh}%`;
  const rctx = sheet.getContext('2d');
  if (!rctx) return;
  const step = (Math.PI * 2) / meridians;

  // Draw the frames in small batches during idle time so page load never
  // sees a long task (all at once cost ~190ms of main thread on a slow phone).
  const idle = (cb: () => void): void => {
    if ('requestIdleCallback' in window) requestIdleCallback(cb, { timeout: 200 });
    else setTimeout(cb, 16);
  };
  await new Promise<void>((done) => {
    let k = 0;
    const batch = (): void => {
      const end = Math.min(FRAMES, k + 6);
      for (; k < end; k++) {
        draw((k / FRAMES) * step);
        rctx.drawImage(canvas, (k % cols) * cw + G, Math.floor(k / cols) * ch + G);
      }
      if (k < FRAMES) idle(batch);
      else done();
    };
    idle(batch);
  });
  draw(0);

  // Encode off the main thread (toBlob), then hand it over as a data: URL
  // (the site CSP allows data: images, not blob:).
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
  // Decode before it goes on screen, so the first frame never shows empty.
  const img = new Image();
  img.src = url;
  await img.decode().catch(() => undefined);
  reel.style.backgroundImage = `url("${url}")`;

  const host = canvas.parentElement;
  if (!host) return;
  const viewport = document.createElement('div');
  viewport.className = 'globe-strip';
  viewport.setAttribute('aria-hidden', 'true');
  viewport.appendChild(reel);
  host.insertBefore(viewport, canvas.nextSibling);

  // One keyframe per frame, each held (step-end) until the next: a single
  // compositor animation walks the sheet cell by cell, wrap included.
  const keyframes: Keyframe[] = [];
  for (let k = 0; k <= FRAMES; k++) {
    const f = k % FRAMES;
    const x = ((f % cols) * 100) / cols;
    const y = (Math.floor(f / cols) * 100) / rows;
    keyframes.push({
      offset: k / FRAMES,
      easing: 'step-end',
      transform: `translate3d(-${x}%, -${y}%, 0)`,
    });
  }
  const anim = reel.animate(keyframes, { duration: period * 1000, iterations: Infinity });
  canvas.style.visibility = 'hidden';

  // Stop the (already cheap) compositor animation when it can't be seen.
  const sync = (visible: boolean): void => {
    if (visible && !document.hidden) anim.play();
    else anim.pause();
  };
  let onScreen = true;
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      onScreen = entries[0]?.isIntersecting ?? true;
      sync(onScreen);
    }).observe(viewport);
  }
  document.addEventListener('visibilitychange', () => sync(onScreen));
}

/** Initialize all globes matching a selector. */
export function initGlobes(selector = 'canvas[data-globe]'): void {
  const canvases = document.querySelectorAll<HTMLCanvasElement>(selector);
  for (const canvas of canvases) {
    makeGlobe(canvas, { speed: 0.012 }).catch((err) => {
      console.warn('[globe-nav] failed to init', err);
    });
  }
}
