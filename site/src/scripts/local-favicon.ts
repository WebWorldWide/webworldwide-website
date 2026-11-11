/**
 * Local favicon: turn the favicon's pixel globe to the visitor's side of
 * the world (Africa for someone in Lagos, Asia in Tokyo, the Americas in
 * Chicago).
 *
 * Where the visitor is comes from the device's time zone, not geolocation:
 * no permission prompt, no network request, nothing leaves the browser. The
 * zone's standard UTC offset gives the longitude (15° per hour), and its
 * region (Europe/…, Africa/…, America/Sao_Paulo…) a rough latitude to tip
 * the globe toward. Without a usable zone (UTC, privacy-hardened browsers)
 * the static favicon — the Americas, like the logo — stays.
 */
import { globeIcon, type IconOpts } from '../lib/pixel-globe.ts';

type View = { lon: number; lat: number };

const SOUTH_AMERICA =
  /^America\/(Argentina|Sao_Paulo|Santiago|Lima|La_Paz|Asuncion|Montevideo|Bogota|Caracas|Guayaquil|Cuiaba|Manaus|Recife|Fortaleza|Belem|Bahia|Campo_Grande|Porto_Velho|Rio_Branco|Boa_Vista|Maceio|Araguaina|Santarem|Noronha|Punta_Arenas|Cayenne|Paramaribo|Guyana)/;
const SOUTHEAST_ASIA =
  /^Asia\/(Jakarta|Singapore|Kuala_Lumpur|Manila|Makassar|Jayapura|Pontianak|Dili|Brunei|Kuching|Ho_Chi_Minh|Saigon|Bangkok|Phnom_Penh|Vientiane|Yangon|Rangoon|Colombo)/;
const NORTH_ASIA =
  /^Asia\/(Yekaterinburg|Omsk|Novosibirsk|Barnaul|Tomsk|Novokuznetsk|Krasnoyarsk|Irkutsk|Chita|Yakutsk|Khandyga|Vladivostok|Ust-Nera|Magadan|Sakhalin|Srednekolymsk|Kamchatka|Anadyr|Almaty|Ulaanbaatar)/;

/** Latitude to centre on, from the zone's region (degrees, ±40 at most). */
function latFor(tz: string): number {
  if (SOUTH_AMERICA.test(tz)) return -15;
  if (SOUTHEAST_ASIA.test(tz)) return 5;
  if (NORTH_ASIA.test(tz)) return 40;
  if (/^Pacific\/(Auckland|Chatham)/.test(tz)) return -38;
  if (/^Pacific\/Honolulu/.test(tz)) return 20;
  const area = tz.split('/')[0];
  const byArea: Record<string, number> = {
    America: 25,
    Europe: 40,
    Africa: 5,
    Asia: 28,
    Australia: -25,
    Antarctica: -40,
    Pacific: -5,
    Indian: -10,
    Atlantic: 30,
    Arctic: 40,
  };
  return byArea[area] ?? 12;
}

/** The visitor's view from their time zone, or null if there isn't one to go on. */
export function localView(): View | null {
  let tz = '';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return null;
  }
  // UTC / Etc zones say nothing about where someone is (and are what
  // fingerprint-resistant browsers report).
  if (!tz.includes('/') || tz.startsWith('Etc/')) return null;
  // Standard (winter) offset, so daylight saving doesn't shift the view.
  const year = new Date().getFullYear();
  const west = Math.max(
    new Date(year, 0, 1).getTimezoneOffset(),
    new Date(year, 6, 1).getTimezoneOffset(),
  );
  return { lon: -west / 4, lat: latFor(tz) };
}

function iconURL(opts: IconOpts, view: View): string | null {
  const c = document.createElement('canvas');
  c.width = opts.size;
  c.height = opts.size;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(opts.size, opts.size);
  img.data.set(globeIcon(opts, view.lon, view.lat));
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/** Swap the page's favicon (and, on Apple touch devices, the home-screen icon). */
export function setLocalFavicon(): void {
  const view = localView();
  if (!view) return;
  // Same art as the static favicon-32.png: 16 globe pixels, 2px each.
  const url = iconURL({ size: 32, pixels: 16 }, view);
  if (!url) return;
  for (const old of document.querySelectorAll('link[rel="icon"]')) old.remove();
  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/png';
  link.sizes.value = '32x32';
  link.href = url;
  document.head.appendChild(link);

  const apple = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
  const appleTouch = navigator.maxTouchPoints > 0 && /iPhone|iPad|Mac/.test(navigator.userAgent);
  if (apple && appleTouch) {
    const big = iconURL({ size: 180, pixels: 32, scale: 0.84, background: [255, 255, 255] }, view);
    if (big) apple.href = big;
  }
}
