// @ts-check
/**
 * globe-mark.js — the sidebar brand globe.
 *
 * A tiny 2D-canvas wireframe globe (meridians + parallels) spinning in
 * place, drawn in ink on the sky-blue brand dot. ~1KB instead of the
 * THREE.js the design prototype used — same look at 34px.
 * Honors prefers-reduced-motion (renders a single static frame).
 */
(function () {
  function boot() {
    const canvas = /** @type {HTMLCanvasElement | null} */ (document.getElementById('brand-globe'));
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const SIZE = canvas.width; // square, drawn at 2x for crispness
    const R = SIZE * 0.42;
    const CX = SIZE / 2;
    const CY = SIZE / 2;
    const MERIDIANS = 6;
    const PARALLELS = [-0.66, -0.33, 0, 0.33, 0.66];
    const INK = 'rgba(14, 41, 96, 0.9)';

    /** @param {number} rot rotation in radians */
    function draw(rot) {
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.strokeStyle = INK;
      ctx.lineWidth = SIZE / 34;

      // Outline
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, Math.PI * 2);
      ctx.stroke();

      // Parallels — ellipses squashed toward the poles.
      for (const p of PARALLELS) {
        const y = CY + R * p;
        const rx = Math.sqrt(Math.max(0, R * R - (R * p) ** 2));
        ctx.beginPath();
        ctx.ellipse(CX, y, rx, rx * 0.22, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Meridians — rotate around the vertical axis; each projects to an
      // ellipse whose x-radius is |cos(angle)|·R.
      for (let i = 0; i < MERIDIANS; i++) {
        const a = rot + (i * Math.PI) / MERIDIANS;
        const rx = Math.abs(Math.cos(a)) * R;
        ctx.beginPath();
        if (rx < 0.5) {
          ctx.moveTo(CX, CY - R);
          ctx.lineTo(CX, CY + R);
        } else {
          ctx.ellipse(CX, CY, rx, R, 0, 0, Math.PI * 2);
        }
        ctx.stroke();
      }
    }

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let rot = 0;
    let raf = 0;
    function tick() {
      rot += 0.008;
      draw(rot);
      raf = window.requestAnimationFrame(tick);
    }
    function start() {
      if (reduceMotion.matches) {
        window.cancelAnimationFrame(raf);
        draw(0.5);
      } else {
        window.cancelAnimationFrame(raf);
        raf = window.requestAnimationFrame(tick);
      }
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
