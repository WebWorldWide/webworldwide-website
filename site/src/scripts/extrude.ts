/**
 * extrude.ts — turn a flat app icon into a solid 3D object with CSS 3D.
 *
 * The old spinner stacked N copies of the icon along Z, which read as a
 * deck of cards whenever the icon turned edge-on. Instead:
 *
 *   1. Trace the icon's silhouette from its alpha channel (Moore-neighbour
 *      contour on a small offscreen canvas).
 *   2. Simplify it into straight edges, then split each edge wherever the
 *      artwork's edge colour changes — so FileID's hazard stripes carry on
 *      around the sides instead of becoming one flat colour.
 *   3. Render a front face, a back face, and one thin wall per edge piece,
 *      standing perpendicular to the face along the outline.
 *   4. Shade each wall from its normal (shadeSolid), so it reads as lit
 *      volume rather than painted card. Colour and normal are blended with
 *      the neighbouring pieces at each end (a gradient along the wall), so
 *      rounded corners and the artwork's own rim gradients come out smooth
 *      instead of banded — while real colour breaks (FileID's stripes) stay
 *      hard.
 *
 * Shared by the public homepage (app-spinners.ts) and the CMS homepage
 * preview (bundled into admin/public/js/extrude.js). No dependencies.
 */

export interface Wall {
  /** Midpoint, edge length and angle — in 0..1 units of the icon box. */
  x: number;
  y: number;
  len: number;
  angle: number;
  /** Outward normal in the icon plane (screen coords, y down). */
  nx: number;
  ny: number;
  /** Edge colour of the artwork at this piece. */
  r: number;
  g: number;
  b: number;
  /** Colour and normal at the piece's start / end, blended with neighbours. */
  c0: [number, number, number];
  c1: [number, number, number];
  n0: [number, number];
  n1: [number, number];
}

export interface Solid {
  /** Face artwork: an image URL, or a canvas for drawn placeholders. */
  face: string | HTMLCanvasElement;
  walls: Wall[];
}

export interface Fallback {
  label?: string;
  bg?: string;
  ink?: string;
}

const GRID = 320; // trace resolution (px); walls are resolution-independent

// 8-neighbourhood, clockwise on screen (y down), starting East.
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];
const dirIndex = (dx: number, dy: number): number =>
  DIRS.findIndex(([x, y]) => x === dx && y === dy);

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`icon failed to load: ${src}`));
    img.src = src;
  });
}

/** Draw `src` into a GRID×GRID canvas, object-fit: contain, centred. */
function rasterize(src: CanvasImageSource, w: number, h: number): ImageData {
  const c = document.createElement('canvas');
  c.width = GRID;
  c.height = GRID;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d canvas unavailable');
  const s = Math.min(GRID / w, GRID / h);
  const dw = w * s;
  const dh = h * s;
  ctx.drawImage(src, (GRID - dw) / 2, (GRID - dh) / 2, dw, dh);
  return ctx.getImageData(0, 0, GRID, GRID);
}

/** Ordered outer boundary of the largest opaque region (Moore tracing). */
function traceContour(data: ImageData): Array<[number, number]> {
  const { width: W, height: H } = data;
  const px = data.data;
  const fg = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < W && y < H && px[(y * W + x) * 4 + 3] > 127;

  let sx = -1;
  let sy = -1;
  outer: for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (fg(x, y)) {
        sx = x;
        sy = y;
        break outer;
      }
    }
  }
  if (sx < 0) return [];

  const pts: Array<[number, number]> = [[sx, sy]];
  let cx = sx;
  let cy = sy;
  let back = 4; // we "entered" from the West, which is background
  const limit = W * H * 2;
  for (let step = 0; step < limit; step++) {
    let found = false;
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8;
      const nx = cx + DIRS[d][0];
      const ny = cy + DIRS[d][1];
      if (fg(nx, ny)) {
        // New backtrack: from the new pixel toward the last background
        // neighbour we examined.
        const pd = (back + k - 1) % 8;
        const bx = cx + DIRS[pd][0];
        const by = cy + DIRS[pd][1];
        back = dirIndex(bx - nx, by - ny);
        if (back < 0) back = (d + 4) % 8;
        cx = nx;
        cy = ny;
        found = true;
        break;
      }
    }
    if (!found) break; // isolated pixel
    if (cx === sx && cy === sy) break;
    pts.push([cx, cy]);
  }
  return pts;
}

/** Ramer–Douglas–Peucker on a closed polyline. */
function simplify(pts: Array<[number, number]>, eps: number): Array<[number, number]> {
  if (pts.length < 8) return pts;
  const rdp = (a: number, b: number, out: number[]): void => {
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const L = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let wd = 0;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L;
      if (d > wd) {
        wd = d;
        worst = i;
      }
    }
    if (wd > eps && worst > 0) {
      rdp(a, worst, out);
      out.push(worst);
      rdp(worst, b, out);
    }
  };
  // Split the loop at its farthest point from the start, simplify both halves.
  let far = 0;
  let fd = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const idx: number[] = [0];
  rdp(0, far, idx);
  idx.push(far);
  const tail: Array<[number, number]> = [...pts.slice(far), pts[0]];
  const keep: number[] = [];
  const rdpTail = (a: number, b: number): void => {
    const [ax, ay] = tail[a];
    const [bx, by] = tail[b];
    const dx = bx - ax;
    const dy = by - ay;
    const L = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let wd = 0;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((tail[i][0] - ax) * dy - (tail[i][1] - ay) * dx) / L;
      if (d > wd) {
        wd = d;
        worst = i;
      }
    }
    if (wd > eps && worst > 0) {
      rdpTail(a, worst);
      keep.push(worst + far);
      rdpTail(worst, b);
    }
  };
  rdpTail(0, tail.length - 1);
  return [...idx, ...keep].map((i) => pts[i]);
}

/**
 * Trace `data` into wall pieces. Edges are split where the artwork's edge
 * colour changes by more than `tol`; `tol` grows until there are at most
 * `maxWalls` pieces.
 */
function wallsFrom(data: ImageData, maxWalls: number): Wall[] {
  const contour = traceContour(data);
  if (contour.length < 8) return [];
  // The traced boundary steps pixel by pixel; average it along the loop
  // first so curves come out as smooth arcs, not staircases.
  const n = contour.length;
  const R = 3;
  const smooth: Array<[number, number]> = contour.map((_, i) => {
    let sx = 0;
    let sy = 0;
    for (let k = -R; k <= R; k++) {
      const q = contour[(i + k + n) % n];
      sx += q[0];
      sy += q[1];
    }
    return [sx / (2 * R + 1), sy / (2 * R + 1)];
  });
  // Finest outline that fits the wall budget (rounded corners stay round).
  let eps = 0.12;
  let poly = simplify(smooth, eps);
  while (poly.length > maxWalls * 0.85 && eps < 8) {
    eps *= 1.35;
    poly = simplify(smooth, eps);
  }
  const W = data.width;
  const px = data.data;
  const alphaAt = (x: number, y: number): number => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= W || iy >= data.height) return 0;
    return px[(iy * W + ix) * 4 + 3];
  };
  // Edge colour: average a few opaque pixels just inside the outline.
  const colourAt = (x: number, y: number, inx: number, iny: number): [number, number, number] => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (const t of [1.5, 2.5, 3.5]) {
      const ix = Math.round(x + inx * t);
      const iy = Math.round(y + iny * t);
      if (ix < 0 || iy < 0 || ix >= W || iy >= data.height) continue;
      const o = (iy * W + ix) * 4;
      if (px[o + 3] < 128) continue;
      r += px[o];
      g += px[o + 1];
      b += px[o + 2];
      n++;
    }
    return n ? [r / n, g / n, b / n] : [128, 128, 128];
  };

  // Per edge: direction, outward normal, and colour samples every ~1px.
  type Edge = {
    ax: number;
    ay: number;
    ux: number;
    uy: number;
    L: number;
    nx: number;
    ny: number;
    cols: Array<[number, number, number]>;
  };
  const edges: Edge[] = [];
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 0.5) continue;
    const ux = (bx - ax) / L;
    const uy = (by - ay) / L;
    let nx = uy;
    let ny = -ux;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    // Outward = the side where the mask is empty.
    if (alphaAt(mx + nx * 2, my + ny * 2) > alphaAt(mx - nx * 2, my - ny * 2)) {
      nx = -nx;
      ny = -ny;
    }
    const cols: Array<[number, number, number]> = [];
    const n = Math.max(1, Math.round(L));
    for (let s = 0; s < n; s++) {
      const t = (s + 0.5) / n;
      cols.push(colourAt(ax + (bx - ax) * t, ay + (by - ay) * t, -nx, -ny));
    }
    edges.push({ ax, ay, ux, uy, L, nx, ny, cols });
  }

  const build = (tol: number): Wall[] => {
    const out: Wall[] = [];
    for (const e of edges) {
      const n = e.cols.length;
      let start = 0;
      let acc: [number, number, number] = [...e.cols[0]];
      let cnt = 1;
      const flush = (end: number): void => {
        const t0 = start / n;
        const t1 = end / n;
        const len = (t1 - t0) * e.L;
        const tm = (t0 + t1) / 2;
        const c: [number, number, number] = [acc[0] / cnt, acc[1] / cnt, acc[2] / cnt];
        out.push({
          // The contour runs through the centres of the outermost opaque
          // pixels, half a pixel inside the image's real (50% alpha) edge.
          x: (e.ax + e.ux * e.L * tm + e.nx * 0.5) / GRID,
          y: (e.ay + e.uy * e.L * tm + e.ny * 0.5) / GRID,
          len: len / GRID,
          angle: Math.atan2(e.uy, e.ux),
          nx: e.nx,
          ny: e.ny,
          r: c[0],
          g: c[1],
          b: c[2],
          c0: c,
          c1: c,
          n0: [e.nx, e.ny],
          n1: [e.nx, e.ny],
        });
      };
      for (let s = 1; s < n; s++) {
        const [r, g, b] = e.cols[s];
        const d =
          Math.abs(r - acc[0] / cnt) + Math.abs(g - acc[1] / cnt) + Math.abs(b - acc[2] / cnt);
        if (d > tol) {
          flush(s);
          start = s;
          acc = [r, g, b];
          cnt = 1;
        } else {
          acc[0] += r;
          acc[1] += g;
          acc[2] += b;
          cnt++;
        }
      }
      flush(n);
    }
    return out;
  };

  let tol = 48;
  let walls = build(tol);
  while (walls.length > maxWalls && tol < 800) {
    tol *= 1.5;
    walls = build(tol);
  }
  blendJoints(walls);
  return walls;
}

/** Sum of channel differences between two colours. */
const colourGap = (a: [number, number, number], b: [number, number, number]): number =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

/**
 * Walls come out in order around the outline. Where two neighbours meet,
 * share one colour and one normal at the joint (smooth shading), unless the
 * artwork's colour really changes there (a stripe edge) or the outline turns
 * a sharp corner — those joints stay crisp.
 */
function blendJoints(walls: Wall[]): void {
  const n = walls.length;
  if (n < 3) return;
  for (let i = 0; i < n; i++) {
    const a = walls[i];
    const b = walls[(i + 1) % n];
    const ca: [number, number, number] = [a.r, a.g, a.b];
    const cb: [number, number, number] = [b.r, b.g, b.b];
    if (colourGap(ca, cb) < 90) {
      const mid: [number, number, number] = [
        (ca[0] + cb[0]) / 2,
        (ca[1] + cb[1]) / 2,
        (ca[2] + cb[2]) / 2,
      ];
      a.c1 = mid;
      b.c0 = mid;
    }
    // cos 40° — softer bends than that belong to one smooth curve.
    if (a.nx * b.nx + a.ny * b.ny > 0.76) {
      const mx = a.nx + b.nx;
      const my = a.ny + b.ny;
      const m = Math.hypot(mx, my) || 1;
      a.n1 = [mx / m, my / m];
      b.n0 = [mx / m, my / m];
    }
  }
}

/** Parse "linear-gradient(135deg,#aaa,#bbb)" into two stops (fallback tiles). */
function gradientStops(bg: string | undefined): [string, string] {
  const hex = (bg || '').match(/#[0-9a-f]{3,8}/gi) || [];
  return [hex[0] || '#ffd58b', hex[1] || hex[0] || '#ff8a3d'];
}

/**
 * Draw an icon-less placeholder tile (rounded gradient square + serif glyph)
 * the same way the site styles `.app-placeholder`.
 */
async function drawPlaceholder(cfg: Fallback, size = 400): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const r = size * (38 / 200);
  const [a, b] = gradientStops(cfg.bg);
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, a);
  grad.addColorStop(1, b);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, r);
  ctx.fill();
  const font = `italic 300 ${Math.round(size * 0.48)}px "Cormorant Garamond", Garamond, serif`;
  try {
    await Promise.race([document.fonts.load(font), new Promise((res) => setTimeout(res, 800))]);
  } catch {
    /* font API unavailable: system serif */
  }
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgb(255 255 255 / 0.5)';
  ctx.fillText(cfg.label || '', size / 2, size / 2 + size * 0.01 + 2);
  ctx.fillStyle = cfg.ink || 'rgb(58 24 16 / 0.85)';
  ctx.fillText(cfg.label || '', size / 2, size / 2);
  return c;
}

const cache = new Map<string, Promise<Solid>>();

/**
 * Build (and cache) the solid for an icon URL, or for a placeholder config
 * when there is no icon. Rejects if the icon can't be loaded.
 */
export function buildSolid(
  icon: string | null,
  fallback: Fallback | null,
  maxWalls = 72,
): Promise<Solid> {
  const key = `${icon || JSON.stringify(fallback)}|${maxWalls}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = (async (): Promise<Solid> => {
    if (icon) {
      const img = await loadImage(icon);
      await img.decode().catch(() => undefined);
      const data = rasterize(img, img.naturalWidth || GRID, img.naturalHeight || GRID);
      return { face: icon, walls: wallsFrom(data, maxWalls) };
    }
    const canvas = await drawPlaceholder(fallback || {});
    const data = rasterize(canvas, canvas.width, canvas.height);
    return { face: canvas, walls: wallsFrom(data, maxWalls) };
  })();
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}

export interface Rendered {
  walls: Array<{ el: HTMLElement; w: Wall; last: number }>;
}

/**
 * Render `solid` into `host` (an element with transform-style: preserve-3d
 * whose box is `size`×`size` px). `depth` is the extrusion thickness in px.
 */
export function renderSolid(
  host: HTMLElement,
  solid: Solid,
  size: number,
  depth: number,
): Rendered {
  host.textContent = '';
  const frag = document.createDocumentFragment();
  const face = (back: boolean): HTMLElement => {
    let el: HTMLElement;
    if (typeof solid.face === 'string') {
      el = document.createElement('div');
      el.style.backgroundImage = `url("${solid.face}")`;
    } else {
      const c = document.createElement('canvas');
      c.width = solid.face.width;
      c.height = solid.face.height;
      c.getContext('2d')?.drawImage(solid.face, 0, 0);
      el = c;
    }
    el.className = `x-face${back ? ' x-back' : ''}`;
    el.setAttribute('aria-hidden', 'true');
    el.style.transform = back
      ? `translateZ(${-depth / 2}px) rotateY(180deg)`
      : `translateZ(${depth / 2}px)`;
    return el;
  };
  const walls: Rendered['walls'] = [];
  for (const w of solid.walls) {
    const el = document.createElement('span');
    el.className = 'x-wall';
    // Overlap neighbours so no hairline seam shows between pieces (they
    // share colour at the joint, so the overlap is invisible).
    const len = w.len * size + 1.5;
    // 1px past each face too: where a face's anti-aliased rim meets the
    // wall's own anti-aliased edge, both half-cover the same pixels and the
    // background shows through as a hairline. Reaching past the face hides
    // the joint (seen face-on the extra is edge-on, so invisible).
    const tall = depth + 2;
    el.style.width = `${len.toFixed(2)}px`;
    el.style.height = `${tall}px`;
    el.style.left = `${(w.x * size - len / 2).toFixed(2)}px`;
    el.style.top = `${(w.y * size - tall / 2).toFixed(2)}px`;
    el.style.transform = `rotateZ(${w.angle.toFixed(4)}rad) rotateX(90deg)`;
    walls.push({ el, w, last: -1 });
    frag.appendChild(el);
  }
  frag.appendChild(face(true));
  frag.appendChild(face(false));
  host.appendChild(frag);
  return { walls };
}

// Key light from the upper left, toward the viewer (CSS axes: y down, z out).
const LIGHT = (() => {
  const v = [-0.45, -0.55, 0.7];
  const m = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / m, v[1] / m, v[2] / m];
})();

/**
 * Shade every wall for the object's current rotation (degrees, as applied by
 * `rotateX(rx) rotateY(ry)`). Only touches walls whose tone changed.
 */
export function shadeSolid(r: Rendered, rxDeg: number, ryDeg: number): void {
  const rx = (rxDeg * Math.PI) / 180;
  const ry = (ryDeg * Math.PI) / 180;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  // Wrapped (half-Lambert) light with a high floor: the walls should read as
  // the artwork's own rim colour turned to the side, not a dark band.
  const toneFor = ([nx, ny]: [number, number]): number => {
    // n' = Rx · Ry · (nx, ny, 0)
    const x1 = cy * nx;
    const z1 = -sy * nx;
    const y2 = cx * ny - sx * z1;
    const z2 = sx * ny + cx * z1;
    const wrap = (x1 * LIGHT[0] + y2 * LIGHT[1] + z2 * LIGHT[2]) * 0.5 + 0.5;
    return Math.round((0.6 + 0.42 * wrap) * 128) / 128;
  };
  const rgb = (c: [number, number, number], t: number): string =>
    `rgb(${Math.min(255, Math.round(c[0] * t))} ${Math.min(255, Math.round(c[1] * t))} ${Math.min(255, Math.round(c[2] * t))})`;
  for (const item of r.walls) {
    const w = item.w;
    const t0 = toneFor(w.n0);
    const t1 = toneFor(w.n1);
    const key = t0 * 1000 + t1;
    if (key === item.last) continue;
    item.last = key;
    const a = rgb(w.c0, t0);
    const b = rgb(w.c1, t1);
    item.el.style.background = a === b ? a : `linear-gradient(90deg, ${a}, ${b})`;
  }
}
