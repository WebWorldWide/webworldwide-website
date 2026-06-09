/**
 * Pixel-art cloud puffs — generates inline SVG, animates via CSS keyframes.
 * Ported from blog-clouds.js. No dependencies; runs once on DOMContentLoaded.
 *
 * Respects prefers-reduced-motion: when reduced, clouds still render but
 * the puffDrift + puffBob animations are zero-duration via base.css.
 */
type CloudLayer = {
  count: number;
  scaleMin: number;
  scaleMax: number;
  durMin: number;
  durMax: number;
  opMin: number;
  opMax: number;
  outline: string; // url-encoded hex (e.g., '%23a8c8f0')
  topMin: number;
  topMax: number;
};

const SHAPES: string[][] = [
  [
    '0002220002220000022000',
    '0022112202211220222110',
    '0211111211111111111112',
    '2111111111111111111112',
    '2111111111111111111112',
    '0222222222222222222220',
  ],
  ['00022200002200', '00211122022112', '02111111111112', '02111111111112', '02222222222220'],
  [
    '00022000022000022000022000',
    '02211220221122022112202112',
    '21111111111111111111111111',
    '02222222222222222222222220',
  ],
  [
    '0002220000',
    '0022112200',
    '0211111120',
    '2111111112',
    '2111111112',
    '0211111120',
    '0022222200',
  ],
];

function shapeToSVG(shape: string[], scale: number, outlineHex: string): string {
  const h = shape.length;
  const w = shape[0].length;
  let body = '';
  let outline = '';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = shape[y][x];
      if (ch === '1') body += `<rect x='${x}' y='${y}' width='1' height='1'/>`;
      else if (ch === '2') outline += `<rect x='${x}' y='${y}' width='1' height='1'/>`;
    }
  }
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w * scale}' height='${h * scale}' ` +
    `viewBox='0 0 ${w} ${h}' shape-rendering='crispEdges'>` +
    `<g fill='%23ffffff'>${body}</g>` +
    `<g fill='${outlineHex}'>${outline}</g></svg>`;
  return `url("data:image/svg+xml;utf8,${svg}")`;
}

const DEFAULT_LAYERS: CloudLayer[] = [
  {
    count: 4,
    scaleMin: 3,
    scaleMax: 5,
    durMin: 280,
    durMax: 360,
    opMin: 0.3,
    opMax: 0.5,
    outline: '%23d4dff0',
    topMin: 0,
    topMax: 30,
  },
  {
    count: 6,
    scaleMin: 5,
    scaleMax: 9,
    durMin: 220,
    durMax: 300,
    opMin: 0.5,
    opMax: 0.7,
    outline: '%23c0d0ec',
    topMin: 2,
    topMax: 65,
  },
  {
    count: 6,
    scaleMin: 9,
    scaleMax: 13,
    durMin: 150,
    durMax: 220,
    opMin: 0.7,
    opMax: 0.85,
    outline: '%23a8c8f0',
    topMin: 6,
    topMax: 88,
  },
  {
    count: 3,
    scaleMin: 14,
    scaleMax: 20,
    durMin: 100,
    durMax: 160,
    opMin: 0.85,
    opMax: 0.95,
    outline: '%2388b4e8',
    topMin: 14,
    topMax: 96,
  },
];

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function startClouds(wrapId = 'skyPuffs', layers: CloudLayer[] = DEFAULT_LAYERS): void {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  // Idempotent — clear any existing puffs (HMR-friendly).
  wrap.replaceChildren();

  for (const L of layers) {
    for (let i = 0; i < L.count; i++) {
      const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];
      const scale = L.scaleMin + Math.floor(Math.random() * (L.scaleMax - L.scaleMin + 1));
      const widthPx = shape[0].length * scale;
      const heightPx = shape.length * scale;

      const drifter = document.createElement('div');
      drifter.className = 'puff';
      drifter.style.setProperty('--w', `${widthPx}px`);
      drifter.style.width = `${widthPx}px`;
      drifter.style.height = `${heightPx}px`;
      drifter.style.top = `${rand(L.topMin, L.topMax)}vh`;
      drifter.style.left = '0';
      drifter.style.opacity = rand(L.opMin, L.opMax).toFixed(2);

      const dur = rand(L.durMin, L.durMax);
      drifter.style.animationDuration = `${dur}s`;
      drifter.style.animationDelay = `${-Math.random() * dur}s`;

      const bobber = document.createElement('div');
      bobber.className = 'puff-bob';
      bobber.style.backgroundImage = shapeToSVG(shape, scale, L.outline);
      bobber.style.animationDuration = `${4 + Math.random() * 4}s`;
      bobber.style.animationDelay = `${-Math.random() * 4}s`;

      drifter.appendChild(bobber);
      wrap.appendChild(drifter);
    }
  }
}

// Auto-start when imported as a script tag.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => startClouds());
  } else {
    startClouds();
  }
}
