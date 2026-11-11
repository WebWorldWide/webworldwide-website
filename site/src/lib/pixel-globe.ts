/**
 * Pixel-art Earth: a real world map (lib/world-map.ts, from Natural Earth)
 * projected onto an orthographic globe of N×N chunky pixels. Islands too
 * small for a pixel of their own (Hawaii and ~230 others) always get one.
 *
 * Pure (no DOM), so the same code draws the nav and hero globes in the
 * browser (scripts/globe-nav.ts) and the favicons at build time
 * (scripts/generate-globe-icons.ts).
 */
import { ISLANDS, MAP_H, MAP_RLE, MAP_W } from './world-map.ts';

/** Ocean, land, desert, tundra, ice — the palette of the globe artwork. */
export const PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [0x1e, 0x68, 0xf0],
  [0x39, 0xbe, 0x00],
  [0xc6, 0xd7, 0x6f],
  [0xd7, 0xd7, 0xd7],
  [0xff, 0xff, 0xff],
];

const CODE: Record<string, number> = { '.': 0, g: 1, d: 2, t: 3, i: 4 };

let decoded: Uint8Array | null = null;

/** The world map as MAP_W × MAP_H class indices (decoded once). */
export function worldMap(): Uint8Array {
  if (decoded) return decoded;
  const out = new Uint8Array(MAP_W * MAP_H);
  let i = 0;
  for (const m of MAP_RLE.matchAll(/([.gdti])(\d*)/g)) {
    const n = m[2] ? Number(m[2]) : 1;
    out.fill(CODE[m[1]], i, i + n);
    i += n;
  }
  decoded = out;
  return out;
}

/** Sub-samples per pixel side: each pixel takes its most common class. */
const SS = 3;

/**
 * A globe of N×N pixels seen from latitude `lat` (degrees; positive tips
 * the north pole toward the viewer). Returns a function that gives the
 * colour class of every pixel (row-major) with longitude `lon` (degrees
 * east) at the centre of the disc.
 *
 * The projection is worked out once: turning the globe only shifts
 * longitude, so each frame is just map lookups. Every pixel is
 * sub-sampled SS×SS and takes the majority class, which keeps coastlines
 * blocky but free of single-pixel speckle. Pixels whose centre falls just
 * outside the disc take the colour at the rim, so a circular clip shows
 * land running to the edge rather than a ragged ring of background.
 */
export function globeSampler(n: number, lat = 0): (lon: number) => Uint8Array {
  const map = worldMap();
  const lat0 = (lat * Math.PI) / 180;
  const perDeg = MAP_W / 360;
  const cosL = Math.cos(lat0);
  const sinL = Math.sin(lat0);
  const deg = 180 / Math.PI;
  const K = SS * SS;
  const rowOf = new Uint16Array(n * n * K);
  const lonOf = new Float32Array(n * n * K);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      for (let s = 0; s < K; s++) {
        let x = ((i + ((s % SS) + 0.5) / SS) / n) * 2 - 1;
        let y = 1 - ((j + (Math.floor(s / SS) + 0.5) / SS) / n) * 2;
        const r2 = x * x + y * y;
        if (r2 > 0.998) {
          const r = Math.sqrt(r2 / 0.998);
          x /= r;
          y /= r;
        }
        const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
        // Inverse orthographic projection.
        const la = Math.asin(y * cosL + z * sinL) * deg;
        const k = (j * n + i) * K + s;
        rowOf[k] = Math.min(MAP_H - 1, Math.max(0, Math.floor((90 - la) * perDeg)));
        lonOf[k] = Math.atan2(x, z * cosL - y * sinL) * deg + 180;
      }
    }
  }
  const counts = new Uint8Array(PALETTE.length);
  // Map cell under each island centre, for its colour (tundra, ice…).
  const islandCell = new Uint32Array(ISLANDS.length / 2);
  for (let q = 0; q < ISLANDS.length; q += 2) {
    const r = Math.min(MAP_H - 1, Math.floor((90 - ISLANDS[q]) * perDeg));
    const c = Math.min(MAP_W - 1, Math.floor((ISLANDS[q + 1] + 180) * perDeg));
    islandCell[q / 2] = r * MAP_W + c;
  }
  return (lon: number): Uint8Array => {
    const out = new Uint8Array(n * n);
    for (let p = 0; p < n * n; p++) {
      counts.fill(0);
      let best = 0;
      for (let s = 0; s < K; s++) {
        const k = p * K + s;
        const col = ((Math.floor((lonOf[k] + lon) * perDeg) % MAP_W) + MAP_W) % MAP_W;
        const c = map[rowOf[k] * MAP_W + col];
        if (++counts[c] > counts[best]) best = c;
      }
      out[p] = best;
    }
    // Small islands (Hawaii, the Azores, Fiji…) would lose every majority
    // vote; give each one at least the pixel its centre falls in, when it
    // is on the near side.
    for (let q = 0; q < ISLANDS.length; q += 2) {
      const la = ISLANDS[q] / deg;
      const dl = (ISLANDS[q + 1] - lon) / deg;
      const cosLa = Math.cos(la);
      const sinLa = Math.sin(la);
      if (sinL * sinLa + cosL * cosLa * Math.cos(dl) <= 0.05) continue;
      const x = cosLa * Math.sin(dl);
      const y = cosL * sinLa - sinL * cosLa * Math.cos(dl);
      const i = Math.min(n - 1, Math.floor(((x + 1) / 2) * n));
      const j = Math.min(n - 1, Math.floor(((1 - y) / 2) * n));
      const p = j * n + i;
      if (out[p] === 0) {
        const c = map[islandCell[q / 2]];
        out[p] = c === 0 ? 1 : c;
      }
    }
    return out;
  };
}

/** Write N×N classes as opaque RGBA into `rgba` at (ox, oy); `stride` is the row width in px. */
export function paintClasses(
  rgba: Uint8ClampedArray | Uint8Array,
  stride: number,
  ox: number,
  oy: number,
  n: number,
  cls: Uint8Array,
): void {
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [r, g, b] = PALETTE[cls[j * n + i]];
      const o = ((oy + j) * stride + ox + i) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = 255;
    }
  }
}

export type IconOpts = {
  /** Output size in px (square). */
  size: number;
  /** Globe pixels across: fewer = chunkier, which reads better small. */
  pixels: number;
  /** Globe diameter as a share of the canvas. */
  scale?: number;
  /** Solid background (iOS fills transparency with black); else transparent. */
  background?: readonly [number, number, number];
};

/**
 * An icon as RGBA: each output pixel takes the colour of the globe pixel it
 * falls in (hard pixel-art edges inside), and the disc's rim is anti-aliased
 * from 4×4 coverage samples so the circle itself is smooth. Shared by the
 * build-time icon generator and the in-page local favicon.
 */
export function globeIcon(opts: IconOpts, lon: number, lat: number): Uint8ClampedArray {
  const { size: S, pixels: n } = opts;
  const D = S * (opts.scale ?? 1);
  const off = (S - D) / 2;
  const cls = globeSampler(n, lat)(lon);
  const out = new Uint8ClampedArray(S * S * 4);
  const R = D / 2;
  const c = off + R;
  const A = 4;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let cover = 0;
      for (let sy = 0; sy < A; sy++) {
        for (let sx = 0; sx < A; sx++) {
          const dx = x + (sx + 0.5) / A - c;
          const dy = y + (sy + 0.5) / A - c;
          if (dx * dx + dy * dy <= R * R) cover++;
        }
      }
      const a = cover / (A * A);
      const gi = Math.min(n - 1, Math.max(0, Math.floor(((x + 0.5 - off) / D) * n)));
      const gj = Math.min(n - 1, Math.max(0, Math.floor(((y + 0.5 - off) / D) * n)));
      const [r, g, b] = PALETTE[cls[gj * n + gi]];
      const o = (y * S + x) * 4;
      if (opts.background) {
        const [br, bg, bb] = opts.background;
        out[o] = r * a + br * (1 - a);
        out[o + 1] = g * a + bg * (1 - a);
        out[o + 2] = b * a + bb * (1 - a);
        out[o + 3] = 255;
      } else {
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = a * 255;
      }
    }
  }
  return out;
}
