// @ts-check
/**
 * router.js — SPA hash router (admin v2).
 *
 * The shell hosts the v2 views — Content (Overview, Posts, Homepage,
 * Media), Audience (Comments, Analytics), System (Settings, System) —
 * plus the tucked-away utility views (Redirects, Activity).
 * Rather than re-architect the page, we hide-show
 * `#view-<name>` divs on hash change. Each page module wires its own
 * boot inside an `init()` exposed on window.TE.routes.
 *
 * Honors:
 *   (default) | #overview → overview
 *   #dashboard | #posts   → posts table (the old dashboard view div)
 *   #homepage             → homepage editor
 *   #media                → media library
 *   #comments             → comment moderation
 *   #analytics            → umami analytics
 *   #settings             → site + author settings
 *   #system | #terminal   → health / containers / backups / terminal
 *   #redirects #activity  → utility views ("More")
 */
(function () {
  // Boot on the shell page only — '/', '/index.html', or any path that
  // ENDS in /index.html (file:// in tests serves the absolute fs path).
  // editor.html / login.html have their own page modules.
  const path = window.location.pathname;
  if (path !== '/' && !path.endsWith('/index.html')) return;

  /** @type {Record<string, () => void>} */
  const initialized = {};

  const VIEW_MAP = {
    overview: 'view-overview',
    dashboard: 'view-dashboard', // legacy alias for posts
    posts: 'view-dashboard',
    homepage: 'view-homepage',
    media: 'view-media',
    comments: 'view-comments',
    analytics: 'view-analytics',
    settings: 'view-settings',
    system: 'view-system',
    terminal: 'view-system', // legacy deep link → System view's terminal tab
    redirects: 'view-redirects',
    activity: 'view-activity',
  };

  function currentRoute() {
    const hash = (window.location.hash || '').replace(/^#/, '').split('?')[0];
    if (hash && VIEW_MAP[hash]) return hash;
    return 'overview';
  }

  /**
   * Announce the new view to screen readers via a polite live region.
   * @param text
   */
  function announce(text) {
    let live = document.getElementById('route-announcer');
    if (!live) {
      live = document.createElement('div');
      live.id = 'route-announcer';
      live.className = 'sr-only';
      live.setAttribute('role', 'status');
      live.setAttribute('aria-live', 'polite');
      document.body.appendChild(live);
    }
    live.textContent = `${text} view`;
  }

  /**
   * @param {string} route
   * @param {{ focus?: boolean }} [opts] focus=true moves focus + announces
   *   (used for user-driven hash navigation, not the initial paint).
   */
  function show(route, opts) {
    opts = opts || {};
    const target = VIEW_MAP[route] || 'view-dashboard';
    for (const id of Object.values(VIEW_MAP)) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.hidden = id !== target;
    }
    // Update sidebar aria-current. Legacy aliases highlight their v2
    // home: #dashboard → Posts, #terminal → System.
    document.querySelectorAll('.side-item[data-route]').forEach((el) => {
      const r = el.getAttribute('data-route');
      if (
        r === route ||
        (route === 'dashboard' && r === 'posts') ||
        (route === 'posts' && r === 'dashboard') ||
        (route === 'terminal' && r === 'system')
      ) {
        el.setAttribute('aria-current', 'page');
      } else {
        el.removeAttribute('aria-current');
      }
    });
    // Crumb
    const crumb = document.getElementById('crumb-section');
    if (crumb) crumb.textContent = labelFor(route);

    // Lazy init for the active view (aliases init their v2 module).
    const initRoute = route === 'terminal' ? 'system' : route === 'dashboard' ? 'posts' : route;
    const initFn = (window.TE && window.TE.routes && window.TE.routes[initRoute]) || null;
    if (initFn && !initialized[initRoute]) {
      initialized[initRoute] = true;
      try {
        initFn();
      } catch (err) {
        console.warn(`[router] init ${route} failed:`, err);
      }
    } else if (initialized[initRoute]) {
      // Revisit: let the view re-pull its data if it registered a refresh
      // hook (init only runs once, so without this the view stays stale).
      const refresh = window.TE && window.TE.viewRefresh && window.TE.viewRefresh[initRoute];
      if (typeof refresh === 'function') {
        try {
          refresh();
        } catch (err) {
          console.warn(`[router] refresh ${route} failed:`, err);
        }
      }
    }

    // Every switch starts the new view at the top — the .stage scroll
    // position otherwise carries over from the previous view.
    const stage = document.getElementById('stage');
    if (stage) stage.scrollTop = 0;

    // On user-driven navigation, move focus to the main region and
    // announce the view so screen-reader + keyboard users aren't stranded
    // on a now-hidden control. Skipped on the initial paint.
    if (opts.focus) {
      announce(labelFor(route));
      const main = document.getElementById('main');
      if (main && typeof main.focus === 'function') {
        try {
          main.focus();
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  function labelFor(route) {
    switch (route) {
      case 'overview':
        return 'Overview';
      case 'dashboard':
      case 'posts':
        return 'Posts';
      case 'homepage':
        return 'Homepage';
      case 'media':
        return 'Media library';
      case 'comments':
        return 'Comments';
      case 'analytics':
        return 'Analytics';
      case 'settings':
        return 'Settings';
      case 'system':
      case 'terminal':
        return 'System';
      case 'redirects':
        return 'Redirects';
      case 'activity':
        return 'Activity';
      default:
        return 'Overview';
    }
  }

  // ── Mobile nav drawer (hamburger < 800px) ─────────────────────
  function wireMobileNav() {
    const toggle = document.getElementById('nav-toggle');
    const sidebar = document.getElementById('sidebar');
    if (!toggle || !sidebar) return;

    // The backdrop must live INSIDE .shell: the shell is a stacking
    // context (position:relative + z-index), so a body-level backdrop
    // would always paint above the sidebar regardless of z-index.
    const backdrop = document.createElement('div');
    backdrop.className = 'nav-backdrop';
    (document.querySelector('.shell') || document.body).appendChild(backdrop);

    function setOpen(open) {
      const wasOpen = document.body.classList.contains('nav-open');
      document.body.classList.toggle('nav-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
      // The drawer follows the modal keyboard pattern: Tab cycles
      // inside it while open (trapFocus also restores focus on release).
      if (open && !wasOpen) {
        if (window.TE && TE.trapFocus) TE.trapFocus(sidebar);
        sidebar.querySelector('a, button')?.focus();
      } else if (!open && wasOpen) {
        if (window.TE && TE.releaseFocus) TE.releaseFocus(sidebar);
      }
    }
    const close = () => setOpen(false);

    // Growing past the breakpoint (rotate, window resize) turns the
    // drawer back into the static rail — the focus trap and nav-open
    // state must release with it or Tab stays caged in the sidebar.
    const mq = window.matchMedia('(max-width: 800px)');
    const onBreakpoint = () => {
      if (!mq.matches && document.body.classList.contains('nav-open')) close();
    };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onBreakpoint);

    toggle.addEventListener('click', () => setOpen(!document.body.classList.contains('nav-open')));
    backdrop.addEventListener('click', close);
    // Following a nav link should dismiss the drawer.
    sidebar.addEventListener('click', (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (t.closest('a')) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('nav-open')) {
        close();
        toggle.focus();
      }
    });
  }

  // ── Template picker for + New Post ────────────────────────────
  function wireNewPost() {
    const btn = document.getElementById('btn-new-post');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (window.TE && typeof window.TE.openModal === 'function') {
        window.TE.openModal('template-modal');
      } else {
        window.location.href = '/editor.html';
      }
    });
  }

  // ── Boot ─────────────────────────────────────────────────────
  function boot() {
    window.TE = window.TE || {};
    window.TE.routes = window.TE.routes || {};
    // Views with unsaved state register a guard: TE.viewGuards.<route>
    // returns a warning string while dirty (or null when clean).
    // beforeunload only covers full page loads — hash navigation needs
    // this hook or edits silently vanish on a sidebar click.
    window.TE.viewGuards = window.TE.viewGuards || {};

    // Guards are registered under canonical route names — normalize
    // aliases (#dashboard→posts, #terminal→system) before lookup, the
    // same mapping show() uses for module init.
    const canonical = (r) => (r === 'terminal' ? 'system' : r === 'dashboard' ? 'posts' : r);

    let activeRoute = currentRoute();
    // currentRoute() strips ?params, so the restore-on-cancel keeps
    // the full hash separately (#comments?status=spam must survive).
    let activeHash = window.location.hash || '#overview';
    show(activeRoute);
    window.addEventListener('hashchange', () => {
      const next = currentRoute();
      if (canonical(next) !== canonical(activeRoute)) {
        const guard = window.TE.viewGuards[canonical(activeRoute)];
        const warning = typeof guard === 'function' ? guard() : null;
        if (warning && !window.confirm(`${warning} Leave this view anyway?`)) {
          // replaceState: assigning location.hash would PUSH a new
          // history entry (desyncing the back button — each cancel
          // would add a step), and replaceState fires no hashchange,
          // so no restore-flag dance is needed. The view never
          // changed; only the URL is put back.
          window.history.replaceState(null, '', activeHash);
          return;
        }
      }
      activeRoute = next;
      activeHash = window.location.hash || `#${next}`;
      show(next, { focus: true });
    });
    wireMobileNav();
    wireNewPost();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
