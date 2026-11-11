/**
 * Bake the pixel globe's world map (src/lib/world-map.ts) from Natural Earth.
 *
 * Natural Earth (public domain) 1:50m layers, from
 * https://github.com/nvkelso/natural-earth-vector/tree/master/geojson :
 *   ne_50m_land, ne_50m_lakes, ne_50m_glaciated_areas,
 *   ne_50m_antarctic_ice_shelves_polys, ne_50m_geography_regions_polys
 *
 * Usage (one-off; the output is committed, the build never downloads):
 *   npx tsx scripts/generate-world-map.ts <dir-with-the-geojson-files>
 *
 * Output: a 0.5° equirectangular grid (720 × 360, row 0 = 90°N, column 0 =
 * 180°W), each cell one of the globe's colour classes, run-length encoded;
 * plus ISLANDS, the centres of islands too small to survive at globe scale
 * (the globe always gives each a pixel, so Hawaii never disappears).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RES = 2; // cells per degree
const W = 360 * RES;
const H = 180 * RES;
// Class indices (0 = ocean, the grid's default).
const LAND = 1;
const DESERT = 2;
const TUNDRA = 3;
const ICE = 4;
const CODES = ['.', 'g', 'd', 't', 'i'];

type Ring = number[][];
type Geometry = { type: string; coordinates: unknown };
type Feature = { properties: Record<string, unknown>; geometry: Geometry | null };

const dir = process.argv[2];
if (!dir) {
  console.error('usage: generate-world-map.ts <geojson dir>');
  process.exit(1);
}
const load = (name: string): Feature[] =>
  (JSON.parse(readFileSync(resolve(dir, `${name}.geojson`), 'utf8')) as { features: Feature[] })
    .features;

/** Polygons (each a list of rings) of a feature. */
function polygons(g: Geometry | null): Ring[][] {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates as Ring[]];
  if (g.type === 'MultiPolygon') return g.coordinates as Ring[][];
  return [];
}

/**
 * Rasterise polygons into a mask: a cell is inside when its centre is
 * (even-odd over all of a polygon's rings, so holes stay holes). Sampled on
 * a 3×3 grid per cell; ≥ `share` of the samples inside marks the cell.
 */
function rasterise(polys: Ring[][], share = 0.45): Uint8Array {
  const S = 3;
  const hits = new Uint8Array(W * H);
  for (const rings of polys) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const r of rings) {
      for (const [, y] of r) {
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    for (let row = 0; row < H; row++) {
      for (let sy = 0; sy < S; sy++) {
        const lat = 90 - (row + (sy + 0.5) / S) / RES;
        if (lat < minY || lat > maxY) continue;
        const xs: number[] = [];
        for (const r of rings) {
          for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
            const [x1, y1] = r[i];
            const [x2, y2] = r[j];
            if (y1 > lat !== y2 > lat) xs.push(x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1));
          }
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          for (let col = 0; col < W; col++) {
            for (let sx = 0; sx < S; sx++) {
              const lon = -180 + (col + (sx + 0.5) / S) / RES;
              if (lon >= xs[k] && lon < xs[k + 1]) hits[row * W + col]++;
            }
          }
        }
      }
    }
  }
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = hits[i] >= Math.ceil(S * S * share) ? 1 : 0;
  return out;
}

const all = (name: string, keep: (f: Feature) => boolean = () => true): Ring[][] =>
  load(name)
    .filter(keep)
    .flatMap((f) => polygons(f.geometry));

const landPolys = all('ne_50m_land');
const land = rasterise(landPolys);
// Only the big lakes read at globe scale.
const lakes = rasterise(
  all('ne_50m_lakes', (f) => Number(f.properties.scalerank ?? 9) <= 1),
  0.6,
);
const ice = rasterise([
  ...all('ne_50m_glaciated_areas'),
  ...all('ne_50m_antarctic_ice_shelves_polys'),
]);
const cls = (f: Feature): string => String(f.properties.featurecla ?? f.properties.FEATURECLA);
// Punjab and the Caatinga are tagged as deserts but read as farmland/scrub.
const NOT_DESERT = new Set(['PUNJAB', 'CAATINGAS']);
const desertPolys = all(
  'ne_50m_geography_regions_polys',
  (f) => cls(f) === 'Desert' && !NOT_DESERT.has(String(f.properties.name ?? f.properties.NAME)),
);

// Natural Earth names deserts as label regions, which leaves gaps inside
// the big arid zones (Arabia, inland Australia, the Great Basin, Iran).
// Close them with coarse outlines of the arid cores (lon, lat).
const box = (w: number, s: number, e: number, n: number): Ring[] => [
  [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ],
];
desertPolys.push(
  // Arabian Peninsula interior
  [
    [
      [36.5, 29.5],
      [47.5, 29.5],
      [55, 22.5],
      [55, 18.5],
      [47, 16.5],
      [43.5, 18],
      [39.5, 24],
      [36.5, 29.5],
    ],
  ],
  // Inland Australia
  [
    [
      [118, -20],
      [125, -18.5],
      [137, -20],
      [143.5, -24],
      [142, -30],
      [134, -31.5],
      [125, -31.5],
      [118, -27],
      [118, -20],
    ],
  ],
  box(-120, 36, -111.5, 42.5), // Great Basin
  box(53, 28, 61, 34), // Iranian plateau (Dasht-e Kavir / Lut)
  box(-1, 16, 32, 30), // Sahara core
);
const desert = rasterise(desertPolys, 0.5);

/** Tundra line: where trees give out, by longitude (°N). */
function tundraLat(lon: number): number {
  if (lon < -140) return 64.5; // Alaska
  if (lon < -100) return 66; // NW Canada
  if (lon < -60) return 58.5; // Hudson Bay, Labrador
  if (lon < -10) return 63; // Iceland
  if (lon < 40) return 69; // Scandinavia, Kola
  if (lon < 100) return 66.5; // W Siberia
  return 64; // E Siberia
}

const grid = new Uint8Array(W * H);
for (let row = 0; row < H; row++) {
  const lat = 90 - (row + 0.5) / RES;
  for (let col = 0; col < W; col++) {
    const i = row * W + col;
    const lon = -180 + (col + 0.5) / RES;
    if (!land[i] || lakes[i]) continue;
    if (ice[i] || lat < -60) grid[i] = ICE;
    else if (lat >= tundraLat(lon)) grid[i] = TUNDRA;
    else if (desert[i]) grid[i] = DESERT;
    else grid[i] = LAND;
  }
}

// Islands that a globe pixel's majority vote would drop: every island of
// at least 1,000 km² (smaller than ~30,000 km², which show on their own),
// and the main Hawaiian Islands (Kauai, Oahu, Molokai, Maui, Hawaii).
const KM_PER_DEG = 111.32;
function areaKm2(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j];
    const [x2, y2] = ring[i];
    const k = Math.cos((((y1 + y2) / 2) * Math.PI) / 180);
    a += (x1 * k * y2 - x2 * k * y1) / 2;
  }
  return Math.abs(a) * KM_PER_DEG * KM_PER_DEG;
}
const hawaii = (lon: number, lat: number): boolean =>
  lon > -161 && lon < -154 && lat > 18 && lat < 23;
const islands: number[] = [];
for (const rings of landPolys) {
  const outer = rings[0];
  const area = areaKm2(outer);
  let cx = 0;
  let cy = 0;
  for (const [x, y] of outer) {
    cx += x;
    cy += y;
  }
  cx /= outer.length;
  cy /= outer.length;
  const keep = hawaii(cx, cy) ? area >= 300 : area >= 1000 && area < 30000;
  if (keep) islands.push(Math.round(cy * 10) / 10, Math.round(cx * 10) / 10);
}

// Run-length encode the flat grid: class letter, then the run length when > 1.
let rle = '';
for (let i = 0; i < grid.length;) {
  let j = i + 1;
  while (j < grid.length && grid[j] === grid[i]) j++;
  rle += CODES[grid[i]] + (j - i > 1 ? String(j - i) : '');
  i = j;
}

const out = `/**
 * World map for the pixel globe — GENERATED by scripts/generate-world-map.ts
 * from Natural Earth 1:50m (public domain). Do not edit by hand.
 *
 * ${1 / RES}° equirectangular grid, ${W} × ${H}: row 0 starts at 90°N, column 0
 * at 180°W. Run-length encoded: a class letter (. ocean, g land, d desert,
 * t tundra, i ice), followed by the run length when it is > 1.
 */
export const MAP_W = ${W};
export const MAP_H = ${H};
export const MAP_RLE =
  '${rle}';

/** Small islands the globe always shows (lat, lon pairs, degrees). */
export const ISLANDS = [${islands.join(', ')}];
`;
const target = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'world-map.ts');
writeFileSync(target, out);
const counts = [0, 0, 0, 0, 0];
for (const c of grid) counts[c]++;
console.log(
  `[world-map] ${rle.length} chars, ${islands.length / 2} islands; cells (ocean/land/desert/tundra/ice): ${counts.join('/')}`,
);
