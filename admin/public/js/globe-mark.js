// @ts-check
/**
 * globe-mark.js — the sidebar brand globe.
 *
 * A real 3D wireframe (lat/long polylines rotated and orthographically
 * projected) on a 2D canvas — ~2KB instead of the THREE.js the design
 * prototype used. Two depth passes (faint back hemisphere, full-ink
 * front) give it volume, rotation is wall-clock-timed so the speed is
 * identical at any frame rate, and the backing store scales with
 * devicePixelRatio so the strokes stay crisp on dense screens.
 * Honors prefers-reduced-motion (renders a single static frame).
 */
(function () {
  function boot() {
    const canvas = /** @type {HTMLCanvasElement | null} */ (document.getElementById('brand-globe'));
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const CSS_SIZE = canvas.clientWidth || 34;
    const DPR = Math.min(window.devicePixelRatio || 1, 3);
    const SIZE = Math.round(CSS_SIZE * DPR);
    canvas.width = SIZE;
    canvas.height = SIZE;

    const R = SIZE * 0.42;
    const CX = SIZE / 2;
    const CY = SIZE / 2;
    const TILT = 0.42; // axial tilt, radians — reads as "globe", not "clock"
    const SPEED = 0.55; // radians per second
    const MERIDIANS = 7;
    const PARALLELS = [-0.66, -0.33, 0, 0.33, 0.66];
    const STEPS = 36; // segments per polyline

    /**
     * Build the lat/long wireframe once as unit-sphere polylines.
     * @type {Array<Array<[number, number, number]>>}
     */
    const LINES = [];
    for (const p of PARALLELS) {
      /** @type {Array<[number, number, number]>} */
      const line = [];
      const r = Math.sqrt(1 - p * p);
      for (let s = 0; s <= STEPS; s++) {
        const a = (s / STEPS) * Math.PI * 2;
        line.push([r * Math.cos(a), p, r * Math.sin(a)]);
      }
      LINES.push(line);
    }
    for (let m = 0; m < MERIDIANS; m++) {
      /** @type {Array<[number, number, number]>} */
      const line = [];
      const lon = (m / MERIDIANS) * Math.PI;
      for (let s = 0; s <= STEPS; s++) {
        const a = (s / STEPS) * Math.PI * 2;
        line.push([Math.cos(lon) * Math.cos(a), Math.sin(a), Math.sin(lon) * Math.cos(a)]);
      }
      LINES.push(line);
    }

    const cosT = Math.cos(TILT);
    const sinT = Math.sin(TILT);

    /** @param {number} rot rotation around the (tilted) vertical axis */
    function draw(rot) {
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.lineWidth = Math.max(1, SIZE / 34);
      ctx.lineCap = 'round';

      // Outline
      ctx.strokeStyle = 'rgba(14, 41, 96, 0.9)';
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, Math.PI * 2);
      ctx.stroke();

      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);

      // Two passes: z<0 (back) faint, z≥0 (front) full ink. Each
      // polyline is walked once per pass, splitting strokes at the
      // depth boundary so lines fade behind the sphere instead of
      // strobing through it.
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass === 0 ? 'rgba(14, 41, 96, 0.22)' : 'rgba(14, 41, 96, 0.9)';
        ctx.beginPath();
        for (const line of LINES) {
          let pen = false;
          for (const [x0, y0, z0] of line) {
            // Spin around Y, then tilt around X, then project (x, y).
            const x1 = x0 * cosR + z0 * sinR;
            const z1 = -x0 * sinR + z0 * cosR;
            const y2 = y0 * cosT - z1 * sinT;
            const z2 = y0 * sinT + z1 * cosT;
            const front = z2 >= 0;
            const px = CX + x1 * R;
            const py = CY - y2 * R;
            if ((pass === 1) === front) {
              if (pen) ctx.lineTo(px, py);
              else ctx.moveTo(px, py);
              pen = true;
            } else {
              pen = false;
            }
          }
        }
        ctx.stroke();
      }
    }

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0;
    /** @param {number} now */
    function tick(now) {
      draw((now / 1000) * SPEED);
      raf = window.requestAnimationFrame(tick);
    }
    function start() {
      window.cancelAnimationFrame(raf);
      if (reduceMotion.matches) draw(0.5);
      else raf = window.requestAnimationFrame(tick);
    }
    start();
    if (typeof reduceMotion.addEventListener === 'function') {
      reduceMotion.addEventListener('change', start);
    }
    // Don't burn battery while the tab is hidden.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) window.cancelAnimationFrame(raf);
      else start();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
