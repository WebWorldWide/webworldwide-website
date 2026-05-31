/**
 * Wireframe globe for the nav. Loaded lazily — Three.js is heavy so we
 * dynamic-import it after first paint via client:idle.
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

export async function makeGlobe(canvas: HTMLCanvasElement, opts: GlobeOpts = {}): Promise<void> {
  // Dynamic-import the tree-shaken re-export module (NOT `three` directly)
  // so the lazy chunk only includes what we actually use. See
  // three-globe-deps.ts for the rationale.
  const T = await import('./three-globe-deps');
  const renderer = new T.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(opts.chunkyPx ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.z = 3.4;
  const group = new T.Group();
  group.rotation.z = T.MathUtils.degToRad(opts.tilt ?? 0);
  scene.add(group);

  const meridians = opts.meridians ?? 14;
  const parallels = opts.parallels ?? 9;
  const lineSegs = 96;
  const mat = new T.LineBasicMaterial({
    color: opts.color ?? 0x000000,
    transparent: true,
    opacity: opts.opacity ?? 1.0,
  });

  for (let i = 0; i < meridians; i++) {
    const points: InstanceType<typeof T.Vector3>[] = [];
    const a = (i / meridians) * Math.PI * 2;
    for (let j = 0; j <= lineSegs; j++) {
      const t = (j / lineSegs) * Math.PI;
      points.push(new T.Vector3(Math.sin(t) * Math.cos(a), Math.cos(t), Math.sin(t) * Math.sin(a)));
    }
    group.add(new T.Line(new T.BufferGeometry().setFromPoints(points), mat));
  }
  for (let i = 1; i < parallels; i++) {
    const points: InstanceType<typeof T.Vector3>[] = [];
    const phi = (i / parallels) * Math.PI;
    const y = Math.cos(phi);
    const r = Math.sin(phi);
    for (let j = 0; j <= lineSegs; j++) {
      const t = (j / lineSegs) * Math.PI * 2;
      points.push(new T.Vector3(r * Math.cos(t), y, r * Math.sin(t)));
    }
    group.add(new T.Line(new T.BufferGeometry().setFromPoints(points), mat));
  }

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const speed = opts.speed ?? 0.012;

  function resize() {
    const w = opts.chunkyPx ?? Math.max(1, canvas.clientWidth);
    const h = opts.chunkyPx ?? Math.max(1, canvas.clientHeight);
    if (renderer.domElement.width !== w || renderer.domElement.height !== h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  // Pause the render loop while the canvas is off-screen OR the tab is hidden,
  // and stop cleanly if the GPU drops the WebGL context. A long-running render
  // loop on a lost/backgrounded context is a known cause of tab memory growth
  // and "the page crashed" over time.
  let onScreen = true;
  let lost = false;
  let running = false;

  const shouldRun = (): boolean => !reducedMotion && onScreen && !lost && !document.hidden;

  function tick() {
    resize();
    if (!reducedMotion) group.rotation.y += speed;
    if (!lost) renderer.render(scene, camera);
    if (shouldRun()) {
      requestAnimationFrame(tick);
    } else {
      running = false;
    }
  }
  function start() {
    if (running || !shouldRun()) return;
    running = true;
    requestAnimationFrame(tick);
  }

  // WebGL context loss/restore — stop on loss (no render-on-dead-context spam),
  // resume once the browser hands the context back.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    lost = true;
    running = false;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    lost = false;
    start();
  });

  resize();
  if (reducedMotion) {
    tick(); // single frame, no loop
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
