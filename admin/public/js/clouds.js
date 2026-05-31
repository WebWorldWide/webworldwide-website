/* Web World Wide — admin pixel-cloud engine.
 *
 * Mirrors site/src/scripts/clouds.ts but is shipped as a plain
 * script (admin is not a build pipeline). Auto-runs on
 * DOMContentLoaded against #skyPuffs.
 */
(function () {
  'use strict';

  var SHAPES = [
    ['0002220002220000022000','0022112202211220222110','0211111211111111111112','2111111111111111111112','2111111111111111111112','0222222222222222222220'],
    ['00022200002200','00211122022112','02111111111112','02111111111112','02222222222220'],
    ['00022000022000022000022000','02211220221122022112202112','21111111111111111111111111','02222222222222222222222220'],
    ['0002220000','0022112200','0211111120','2111111112','2111111112','0211111120','0022222200']
  ];

  function shapeToSVG(shape, scale, outlineHex) {
    var h = shape.length, w = shape[0].length;
    var body = '', outline = '';
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var ch = shape[y][x];
        if (ch === '1') body += "<rect x='" + x + "' y='" + y + "' width='1' height='1'/>";
        else if (ch === '2') outline += "<rect x='" + x + "' y='" + y + "' width='1' height='1'/>";
      }
    }
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='" + (w * scale) + "' height='" + (h * scale) + "' viewBox='0 0 " + w + " " + h + "' shape-rendering='crispEdges'><g fill='%23ffffff'>" + body + "</g><g fill='" + outlineHex + "'>" + outline + "</g></svg>";
    return "url(\"data:image/svg+xml;utf8," + svg + "\")";
  }

  // Admin is dimmer than the public site — fewer puffs.
  var LAYERS = [
    { count: 3, scaleMin: 3, scaleMax: 5, durMin: 280, durMax: 360, opMin: 0.3, opMax: 0.5, outline: '%23d4dff0', topMin: 0, topMax: 30 },
    { count: 4, scaleMin: 5, scaleMax: 9, durMin: 220, durMax: 300, opMin: 0.5, opMax: 0.7, outline: '%23c0d0ec', topMin: 2, topMax: 65 },
    { count: 4, scaleMin: 9, scaleMax: 13, durMin: 150, durMax: 220, opMin: 0.7, opMax: 0.85, outline: '%23a8c8f0', topMin: 6, topMax: 88 },
    { count: 2, scaleMin: 14, scaleMax: 20, durMin: 100, durMax: 160, opMin: 0.85, opMax: 0.95, outline: '%2388b4e8', topMin: 14, topMax: 96 }
  ];

  // a11y: skip rendering entirely under prefers-reduced-motion. The
  // global CSS rule in admin.css:193 also kills the animations, but
  // skipping DOM creation saves CPU + leaves a clean empty layer.
  var REDUCED_MOTION =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function start() {
    var wrap = document.getElementById('skyPuffs');
    if (!wrap) return;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    if (REDUCED_MOTION) return;

    LAYERS.forEach(function (L) {
      for (var i = 0; i < L.count; i++) {
        var shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];
        var scale = L.scaleMin + Math.floor(Math.random() * (L.scaleMax - L.scaleMin + 1));
        var widthPx = shape[0].length * scale;
        var heightPx = shape.length * scale;
        var drifter = document.createElement('div');
        drifter.className = 'puff';
        drifter.style.setProperty('--w', widthPx + 'px');
        drifter.style.width = widthPx + 'px';
        drifter.style.height = heightPx + 'px';
        drifter.style.top = (L.topMin + Math.random() * (L.topMax - L.topMin)) + 'vh';
        drifter.style.left = '0';
        drifter.style.opacity = (L.opMin + Math.random() * (L.opMax - L.opMin)).toFixed(2);
        var dur = L.durMin + Math.random() * (L.durMax - L.durMin);
        drifter.style.animationDuration = dur + 's';
        drifter.style.animationDelay = -Math.random() * dur + 's';
        var bobber = document.createElement('div');
        bobber.className = 'puff-bob';
        bobber.style.backgroundImage = shapeToSVG(shape, scale, L.outline);
        bobber.style.animationDuration = (4 + Math.random() * 4) + 's';
        bobber.style.animationDelay = -Math.random() * 4 + 's';
        drifter.appendChild(bobber);
        wrap.appendChild(drifter);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
