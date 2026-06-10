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

  // Pause the loop while the canvas is off-screen OR the tab is hidden —
  // a long-running loop on a backgrounded page is wasted battery.
  let onScreen = true;
  let running = false;
  let rot = 0;
  let last = 0;

  const shouldRun = (): boolean => !reducedMotion && onScreen && !document.hidden;

  function tick(now: number): void {
    resize();
    if (last) rot += speedPerSec * Math.min(0.1, (now - last) / 1000);
    last = now;
    draw(rot);
    if (shouldRun()) {
      requestAnimationFrame(tick);
    } else {
      running = false;
      last = 0;
    }
  }
  function start(): void {
    if (running || !shouldRun()) return;
    running = true;
    last = 0;
    requestAnimationFrame(tick);
  }

  resize();
  if (reducedMotion) {
    draw(0.6); // single static frame
  } else {
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        onScreen = entries[0]?.isIntersecting ?? true;
        if (onScreen) start();
      });
      io.observe(canvas);
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) start();
    });
    start();
  }
  window.addEventListener('resize', resize);
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
