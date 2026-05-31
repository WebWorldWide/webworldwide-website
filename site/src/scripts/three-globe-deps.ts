/**
 * Re-export only the Three.js symbols the nav globe actually uses.
 *
 * Why a re-export module? `await import('three')` returns the full
 * namespace object — Rollup can't see which exports the consumer
 * destructures, so it bundles every Three module. By using *named*
 * static imports here and dynamic-importing THIS file from
 * globe-nav.ts, Rollup tree-shakes the unused Three modules out of
 * the lazy chunk. Cuts ~690 KB → ~150 KB (a ~75% reduction) for the
 * /nav globe chunk that loads on every page.
 *
 * To add another symbol, add it here AND import it from this module
 * (never directly from 'three' inside any client island/script that
 * gets dynamically imported).
 */
export {
  BufferGeometry,
  Group,
  Line,
  LineBasicMaterial,
  MathUtils,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
