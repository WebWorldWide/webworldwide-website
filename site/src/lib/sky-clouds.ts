/**
 * Background sky clouds — chunky block clouds in the style of the channel
 * banner art: a white body built from a few overlapping rectangles, with
 * paler blocks peeking out behind it. No outline.
 *
 * Pure data + string building (no DOM), shared by the public site
 * (components/SkyBackdrop.astro, rendered at build time) and the CMS
 * homepage preview (bundled to admin/public/js/sky-clouds.js as WWWSky),
 * so both draw the identical sky.
 *
 * The clouds are kept quiet: the whole layer is translucent (see sky.css)
 * and each cloud's opacity tops out well below solid white, so they read as
 * pale blue shapes behind the content rather than bright white blocks.
 */

/** [x, y, width, height, layer]; layer 0 = body, 1 = pale back, 2 = paler back. */
type Block = [number, number, number, number, 0 | 1 | 2];

export type BlockCloud = { w: number; h: number; blocks: Block[] };

/** Cloud designs, in grid units (traced from the banner artwork). */
export const CLOUDS: BlockCloud[] = [
  {
    w: 30,
    h: 20,
    blocks: [
      [0, 4, 8, 12, 2],
      [20, 1, 10, 12, 1],
      [3, 2, 24, 12, 0],
      [8, 0, 11, 20, 0],
      [20, 4, 6, 12, 0],
    ],
  },
  {
    w: 25,
    h: 17,
    blocks: [
      [0, 5, 8, 11, 2],
      [15, 0, 10, 10, 2],
      [7, 2, 15, 15, 0],
    ],
  },
  {
    w: 38,
    h: 17,
    blocks: [
      [3, 3, 8, 4, 2],
      [0, 6, 11, 8, 0],
      [11, 0, 14, 15, 0],
      [25, 1, 13, 16, 0],
    ],
  },
  {
    w: 20,
    h: 18,
    blocks: [
      [0, 2, 6, 3, 2],
      [5, 14, 11, 4, 2],
      [0, 5, 11, 11, 0],
      [5, 0, 11, 14, 0],
      [16, 3, 4, 11, 0],
    ],
  },
  {
    w: 19,
    h: 12,
    blocks: [
      [2, 1, 4, 2, 1],
      [5, 10, 7, 2, 1],
      [0, 3, 18, 7, 0],
      [5, 0, 7, 3, 0],
      [12, 1, 6, 8, 0],
      [10, 8, 7, 3, 0],
    ],
  },
  {
    w: 30,
    h: 12,
    blocks: [
      [4, 2, 6, 3, 2],
      [21, 1, 9, 9, 1],
      [0, 5, 10, 6, 0],
      [10, 0, 11, 12, 0],
    ],
  },
  {
    w: 23,
    h: 21,
    blocks: [
      [0, 2, 6, 4, 2],
      [6, 16, 12, 5, 2],
      [0, 6, 23, 12, 0],
      [6, 0, 12, 6, 0],
      [18, 3, 5, 3, 0],
    ],
  },
];

/** Fill opacity of each block layer inside a cloud (body, pale, paler). */
const LAYER_ALPHA = [1, 0.62, 0.42];

/** A cloud as an SVG data URI (single-quoted inside, so it can sit in url("…")). */
export function cloudImage(c: BlockCloud): string {
  const rects = c.blocks
    .map(
      ([x, y, w, h, l]) =>
        `<rect x='${x}' y='${y}' width='${w}' height='${h}'${l ? ` fill-opacity='${LAYER_ALPHA[l]}'` : ''}/>`,
    )
    .join('');
  return (
    `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${c.w} ${c.h}' ` +
    `preserveAspectRatio='none' shape-rendering='crispEdges'><g fill='%23ffffff'>${rects}</g></svg>`
  );
}

type Layer = {
  count: number;
  /** Pixels per grid unit. */
  unitMin: number;
  unitMax: number;
  /** Seconds to cross the screen. */
  durMin: number;
  durMax: number;
  opMin: number;
  opMax: number;
  /** Vertical band, vh. */
  topMin: number;
  topMax: number;
};

/** Far → near: smaller, slower and fainter at the back. */
const LAYERS: Layer[] = [
  {
    count: 5,
    unitMin: 2,
    unitMax: 3,
    durMin: 280,
    durMax: 360,
    opMin: 0.24,
    opMax: 0.34,
    topMin: 0,
    topMax: 30,
  },
  {
    count: 5,
    unitMin: 3,
    unitMax: 5,
    durMin: 220,
    durMax: 300,
    opMin: 0.32,
    opMax: 0.44,
    topMin: 2,
    topMax: 65,
  },
  {
    count: 5,
    unitMin: 5,
    unitMax: 7,
    durMin: 150,
    durMax: 220,
    opMin: 0.4,
    opMax: 0.52,
    topMin: 6,
    topMax: 88,
  },
  {
    count: 4,
    unitMin: 7,
    unitMax: 9,
    durMin: 100,
    durMax: 160,
    opMin: 0.46,
    opMax: 0.58,
    topMin: 14,
    topMax: 96,
  },
];

export type Puff = {
  /** Index into CLOUDS. */
  cloud: number;
  width: number;
  height: number;
  /** vh */
  top: number;
  opacity: number;
  driftDur: number;
  driftDelay: number;
  /** 0..1: where in its crossing the puff is at t=0 (rest position). */
  progress: number;
  bobDur: number;
  bobDelay: number;
};

/** Deterministic PRNG (mulberry32): the same sky every build and in the CMS preview. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The sky layout: every puff, far layer first (so nearer ones paint on top). */
export function skyPuffs(): Puff[] {
  const rng = mulberry32(0x80808080);
  const rand = (lo: number, hi: number): number => lo + rng() * (hi - lo);
  const out: Puff[] = [];
  for (const L of LAYERS) {
    for (let i = 0; i < L.count; i++) {
      const cloud = Math.floor(rng() * CLOUDS.length);
      const unit = L.unitMin + Math.floor(rng() * (L.unitMax - L.unitMin + 1));
      const driftDur = rand(L.durMin, L.durMax);
      const top = rand(L.topMin, L.topMax);
      const opacity = rand(L.opMin, L.opMax);
      const progress = rng();
      out.push({
        cloud,
        width: CLOUDS[cloud].w * unit,
        height: CLOUDS[cloud].h * unit,
        top,
        opacity,
        driftDur,
        driftDelay: -progress * driftDur,
        progress,
        bobDur: 5 + rng() * 4,
        bobDelay: -rng() * 5,
      });
    }
  }
  return out;
}
