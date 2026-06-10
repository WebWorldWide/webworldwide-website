// @ts-check
/**
 * system.js — the System view's tab strip (Health / Containers /
 * Backups / Terminal).
 *
 * The data inside the panes is filled by dashboard.js's health poller
 * (metric bars, docker list, backup status — all wired by element id,
 * so they update regardless of which view is visible) and terminal.js
 * (the terminal form). This module only owns switching the panes and
 * the roving-tabindex keyboard pattern, mirroring the posts tablist.
 *
 * Deep link: #terminal routes here (router maps it to view-system) and
 * pre-selects the Terminal tab.
 */
(function () {
  const PANES = ['health', 'containers', 'backups', 'terminal'];

  function $(id) {
    return document.getElementById(id);
  }

  /** @param {string} name */
  function select(name) {
    if (!PANES.includes(name)) return;
    for (const pane of PANES) {
      const el = $(`systab-${pane}`);
      if (el) el.hidden = pane !== name;
    }
    document.querySelectorAll('#system-tabs .tab').forEach((tab) => {
      const active = tab.getAttribute('data-systab') === name;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.setAttribute('tabindex', active ? '0' : '-1');
    });
    if (name === 'terminal') {
      const input = $('terminal-input');
      if (input) {
        try {
          input.focus();
        } catch (_) {
          /* focus can fail in sandboxed iframes */
        }
      }
    }
  }

  function init() {
    const tablist = $('system-tabs');
    if (!tablist) return;

    tablist.addEventListener('click', (e) => {
      const tab = /** @type {HTMLElement} */ (e.target).closest('[data-systab]');
      if (tab) select(tab.getAttribute('data-systab') || 'health');
    });

    // Roving tabindex — ArrowLeft/Right move selection, Home/End jump.
    tablist.addEventListener('keydown', (e) => {
      const ev = /** @type {KeyboardEvent} */ (e);
      const tabs = Array.from(tablist.querySelectorAll('[data-systab]'));
      const current = tabs.findIndex((t) => t.classList.contains('active'));
      let next = -1;
      if (ev.key === 'ArrowRight') next = (current + 1) % tabs.length;
      else if (ev.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
      else if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = tabs.length - 1;
      if (next < 0) return;
      ev.preventDefault();
      const name = tabs[next].getAttribute('data-systab') || 'health';
      select(name);
      /** @type {HTMLElement} */ (tabs[next]).focus();
    });

    // #terminal deep link opens the terminal pane directly.
    const route = (window.location.hash || '').replace(/^#/, '').split('?')[0];
    select(route === 'terminal' ? 'terminal' : 'health');
    window.addEventListener('hashchange', () => {
      const r = (window.location.hash || '').replace(/^#/, '').split('?')[0];
      if (r === 'terminal') select('terminal');
    });
  }

  window.TE = window.TE || {};
  window.TE.routes = window.TE.routes || {};
  window.TE.routes.system = init;
})();
