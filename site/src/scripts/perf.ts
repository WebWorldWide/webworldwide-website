/**
 * Device/connection capability hints for the homepage's decorative motion.
 *
 * "Lite" = a slow CPU, little memory, a slow or metered connection, or the
 * user asked for reduced data/motion. Decorative work scales down on lite
 * devices (fewer 3D wall pieces on the app icons, no cursor parallax, no
 * backdrop blur). Decorative animation is never frozen: it is all
 * compositor-only and costs nothing on the main thread.
 */
type NavigatorHints = Navigator & {
  deviceMemory?: number;
  connection?: { saveData?: boolean; effectiveType?: string };
};

let cached: boolean | null = null;

export function isLiteDevice(): boolean {
  if (cached !== null) return cached;
  if (typeof navigator === 'undefined') return (cached = false);
  const n = navigator as NavigatorHints;
  const cores = n.hardwareConcurrency || 8;
  const memory = n.deviceMemory || 8;
  const conn = n.connection;
  const slowNet = Boolean(conn && (conn.saveData || /(^|-)2g|3g/.test(conn.effectiveType || '')));
  const reduced =
    typeof matchMedia !== 'undefined' &&
    (matchMedia('(prefers-reduced-motion: reduce)').matches ||
      matchMedia('(prefers-reduced-data: reduce)').matches);
  cached = cores <= 4 || memory <= 4 || slowNet || reduced;
  return cached;
}
