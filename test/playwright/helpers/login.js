// @ts-check
/**
 * login.js — authenticate Playwright against the live dev admin.
 *
 * The admin gates its pages client-side: auth.js bounces any page to
 * /login.html when GET /auth/status says unauthenticated. The gated
 * (DEV_STACK_RUNNING=1) specs therefore need a real session or they
 * silently end up auditing the login page after the redirect.
 *
 * `npm run db:seed` creates the dev user admin/password (dev DB only —
 * see scripts/dev/seed.mjs). page.request shares the cookie jar with
 * the page, so one POST is all it takes.
 */

/** @type {import('@playwright/test').Cookie[] | null} */
let cachedCookies = null;

/**
 * Log in, reusing one session across the worker's tests — credential
 * POSTs are brute-force rate-limited (20/15 min) and each test gets a
 * fresh cookie jar, so logging in per-test would trip the limiter
 * mid-suite.
 * @param {import('@playwright/test').Page} page
 * @param {string} origin e.g. http://127.0.0.1:3000
 */
export async function loginDevAdmin(page, origin) {
  const context = page.context();
  if (cachedCookies) {
    await context.addCookies(cachedCookies);
    const status = await page.request.get(`${origin}/auth/status`);
    const body = await status.json().catch(() => ({}));
    if (body && body.authenticated) return;
    cachedCookies = null; // session expired — fall through to a fresh login
  }
  const res = await page.request.post(`${origin}/auth/login/password`, {
    data: { username: 'admin', password: 'password' },
  });
  if (!res.ok()) {
    throw new Error(
      `dev admin login failed (${res.status()}). Did \`npm run db:seed\` run? ` +
        `Is the dev admin up at ${origin}?`,
    );
  }
  cachedCookies = await context.cookies(origin);
}
