// @ts-check
/**
 * router.js — Phase 5e SPA hash router.
 *
 * The admin shell now hosts six top-level views (dashboard, media,
 * tags, redirects, activity, shortcodes, settings) instead of two.
 * Rather than re-architect the page, we hide-show `#view-<name>` divs
 * on hash change. Each page module wires its own boot inside an
 * `init()` exposed on window.TE.routes.
 *
 * Honors:
 *   #dashboard | #posts → show dashboard
 *   #media              → show media library
 *   #tags               → tag manager
 *   #redirects          → redirects table
 *   #activity           → activity log table
 *   #shortcodes         → shortcode docs
 *   #settings           → site + author settings
 */
(function () {
  if (window.location.pathname !== '/' && window.location.pathname !== '/index.html') return;

  /** @type {Record<string, () => void>} */
  const initialized = {};

  const VIEW_MAP = {
    dashboard: 'view-dashboard',
    posts: 'view-dashboard',
    media: 'view-media',
    tags: 'view-tags',
    redirects: 'view-redirects',
    activity: 'view-activity',
    shortcodes: 'view-shortcodes',
    settings: 'view-settings',
    comments: 'view-comments',
  };

  function currentRoute() {
    const hash = (window.location.hash || '').replace(/^#/, '').split('?')[0];
    if (hash && VIEW_MAP[hash]) return hash;
    return 'dashboard';
  }

  function show(route) {
    const target = VIEW_MAP[route] || 'view-dashboard';
    for (const id of Object.values(VIEW_MAP)) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.hidden = id !== target;
    }
    // Update sidebar aria-current
    document.querySelectorAll('.side-item[data-route]').forEach((el) => {
      const r = el.getAttribute('data-route');
      if (r === route || (route === 'posts' && r === 'dashboard')) {
        el.setAttribute('aria-current', 'page');
      } else {
        el.removeAttribute('aria-current');
      }
    });
    // Crumb
    const crumb = document.getElementById('crumb-section');
    if (crumb) crumb.textContent = labelFor(route);

    // Lazy init for the active view
    const initFn = (window.TE && window.TE.routes && window.TE.routes[route]) || null;
    if (initFn && !initialized[route]) {
      initialized[route] = true;
      try {
        initFn();
      } catch (err) {
        console.warn(`[router] init ${route} failed:`, err);
      }
    }
  }

  function labelFor(route) {
    switch (route) {
      case 'dashboard':
        return 'Dashboard';
      case 'media':
        return 'Media library';
      case 'tags':
        return 'Tags';
      case 'redirects':
        return 'Redirects';
      case 'activity':
        return 'Activity';
      case 'shortcodes':
        return 'Shortcodes';
      case 'settings':
        return 'Settings';
      case 'comments':
        return 'Comments';
      default:
        return 'Dashboard';
    }
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
    show(currentRoute());
    window.addEventListener('hashchange', () => show(currentRoute()));
    wireNewPost();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
