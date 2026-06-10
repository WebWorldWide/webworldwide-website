// @ts-check
/**
 * router.js — SPA hash router (admin v2).
 *
 * The shell hosts the v2 views — Content (Overview, Posts, Homepage,
 * Media), Audience (Comments, Analytics), System (Settings, System) —
 * plus the tucked-away utility views (Tags, Redirects, Shortcodes,
 * Activity). Rather than re-architect the page, we hide-show
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
 *   #tags #redirects #activity #shortcodes → utility views ("More")
 */
(function () {
  if (window.location.pathname !== '/' && window.location.pathname !== '/index.html') return;

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
    tags: 'view-tags',
    redirects: 'view-redirects',
    activity: 'view-activity',
    shortcodes: 'view-shortcodes',
  };

  function currentRoute() {
    const hash = (window.location.hash || '').replace(/^#/, '').split('?')[0];
    if (hash && VIEW_MAP[hash]) return hash;
    return 'overview';
  }

  function show(route) {
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
      case 'tags':
        return 'Tags';
      case 'redirects':
        return 'Redirects';
      case 'activity':
        return 'Activity';
      case 'shortcodes':
        return 'Shortcodes';
      default:
        return 'Overview';
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
