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

// Each design also appears mirrored, so the sky never shows the same
// silhouette twice in a row.
const mirror = (c: BlockCloud): BlockCloud => ({
  w: c.w,
  h: c.h,
  blocks: c.blocks.map(([x, y, w, h, l]) => [c.w - x - w, y, w, h, l]),
});
CLOUDS.push(...CLOUDS.map(mirror));

/** The page sky behind the clouds (tokens.css --sky). */
const SKY: [number, number, number] = [0x1e, 0x68, 0xf0];

/** Sky mixed toward white by `t` (0 = sky, 1 = white), as an SVG fill. */
function tint(t: number): string {
  const c = SKY.map((v) => Math.round(v + (255 - v) * Math.min(1, Math.max(0, t))));
  return '%23' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Underside shade height, in grid units. */
const SHADE_UNITS = 2;

/**
 * A cloud as an SVG data URI (single-quoted inside, so it can sit in url("…")).
 *
 * Every colour is solid and pre-mixed with the sky (`tone` = how far toward
 * white the body goes), never translucent white: overlapping clouds then
 * layer cleanly, nearer over farther, like the banner art, instead of
 * showing through each other as muddy stacked rectangles.
 *
 * Within a cloud: the pale back blocks peek out behind the body, and the
 * body gets one touch of volume — it is drawn in a slightly deeper tint,
 * then again in its own tint with each block stopping SHADE_UNITS short of
 * its bottom, so a stepped shadow line shows only along the real underside.
 */
export function cloudImage(c: BlockCloud, tone: number): string {
  const rect = (x: number, y: number, w: number, h: number): string =>
    h > 0 ? `<rect x='${x}' y='${y}' width='${w}' height='${h}'/>` : '';
  const group = (fill: string, blocks: Block[], cut = 0): string =>
    `<g fill='${fill}'>${blocks.map(([x, y, w, h]) => rect(x, y, w, h - cut)).join('')}</g>`;
  const body = c.blocks.filter((b) => b[4] === 0);
  return (
    `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${c.w} ${c.h}' ` +
    `preserveAspectRatio='none' shape-rendering='crispEdges'>` +
    group(
      tint(tone * 0.55),
      c.blocks.filter((b) => b[4] === 2),
    ) +
    group(
      tint(tone * 0.72),
      c.blocks.filter((b) => b[4] === 1),
    ) +
    group(tint(tone * 0.86), body) +
    group(tint(tone), body, SHADE_UNITS) +
    `</svg>`
  );
}

/** CSS class for a puff's image (one class per cloud design + tone). */
export const imageClass = (p: Puff): string => `pf${p.cloud}t${Math.round(p.tone * 100)}`;

/** `.puff-bob.<class>{background-image:…}` rules for every distinct image in `puffs`. */
export function imageCss(puffs: Puff[]): string {
  const seen = new Map<string, string>();
  for (const p of puffs) {
    const cls = imageClass(p);
    if (!seen.has(cls))
      seen.set(
        cls,
        `.puff-bob.${cls}{background-image:url("${cloudImage(CLOUDS[p.cloud], p.tone)}")}`,
      );
  }
  return [...seen.values()].join('');
}

type Layer = {
  count: number;
  /** Pixels per grid unit. */
  unitMin: number;
  unitMax: number;
  /** Seconds to cross the screen. */
  durMin: number;
  durMax: number;
  /** Body colour: how far from the sky toward white (solid, not translucent). */
  tone: number;
  /** Vertical band, vh. */
  topMin: number;
  topMax: number;
};

/**
 * Far → near: smaller, slower and closer to the sky colour at the back
 * (aerial perspective). Even the nearest body stays a pale blue, well short
 * of white, so the sky never competes with the content.
 */
const LAYERS: Layer[] = [
  { count: 7, unitMin: 2, unitMax: 3, durMin: 280, durMax: 360, tone: 0.24, topMin: 0, topMax: 92 },
  { count: 7, unitMin: 3, unitMax: 5, durMin: 220, durMax: 300, tone: 0.33, topMin: 2, topMax: 92 },
  { count: 6, unitMin: 5, unitMax: 7, durMin: 150, durMax: 220, tone: 0.42, topMin: 4, topMax: 94 },
  { count: 4, unitMin: 7, unitMax: 9, durMin: 100, durMax: 160, tone: 0.5, topMin: 8, topMax: 96 },
];

export type Puff = {
  /** Index into CLOUDS. */
  cloud: number;
  width: number;
  height: number;
  /** vh for the sky, % of the frame height for film clouds */
  top: number;
  /** Body tone (see Layer.tone); the image is chosen by imageClass(). */
  tone: number;
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

/** Fisher–Yates with the seeded PRNG. */
function shuffled(n: number, rng: () => number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Lay out `layers` of clouds. Within a layer, heights and starting points are
 * stratified (one cloud per band, jittered, bands shuffled), so the clouds
 * spread evenly over the sky instead of clumping the way plain random
 * placement does.
 */
function layout(layers: Layer[], seed: number): Puff[] {
  const rng = mulberry32(seed);
  const rand = (lo: number, hi: number): number => lo + rng() * (hi - lo);
  const out: Puff[] = [];
  for (const L of layers) {
    const rows = shuffled(L.count, rng);
    for (let i = 0; i < L.count; i++) {
      const cloud = Math.floor(rng() * CLOUDS.length);
      const unit = L.unitMin + Math.floor(rng() * (L.unitMax - L.unitMin + 1));
      const driftDur = rand(L.durMin, L.durMax);
      const top = L.topMin + ((rows[i] + rand(0.15, 0.85)) / L.count) * (L.topMax - L.topMin);
      const progress = (i + rand(0.1, 0.9)) / L.count;
      out.push({
        cloud,
        width: CLOUDS[cloud].w * unit,
        height: CLOUDS[cloud].h * unit,
        top,
        tone: L.tone,
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

/** The background sky: every puff, far layer first (so nearer ones paint on top). */
export function skyPuffs(): Puff[] {
  return layout(LAYERS, 0x80808080);
}

/**
 * Clouds inside the YouTube film frame. Sizes are in px for a ~1000px-wide
 * frame; `top` is a percentage of the frame's height. Brighter than the
 * page sky: in the frame they are the subject, not the background.
 */
export function filmPuffs(): Puff[] {
  return layout(
    [
      {
        count: 4,
        unitMin: 3,
        unitMax: 4,
        durMin: 70,
        durMax: 95,
        tone: 0.62,
        topMin: 6,
        topMax: 70,
      },
      {
        count: 3,
        unitMin: 5,
        unitMax: 6,
        durMin: 45,
        durMax: 65,
        tone: 0.86,
        topMin: 10,
        topMax: 72,
      },
    ],
    0x5eedc10d,
  );
}
