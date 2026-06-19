// @ts-check
/**
 * overview.js — the v2 landing view.
 *
 * An actionable morning briefing: greeting, three stat tiles (traffic
 * from the Umami proxy, comment count), "Pick up where you left off"
 * (drafts with real word-count progress), and a "Needs you" queue
 * (scheduled posts, unhealthy containers, stale backups). The inbox and
 * recent-activity widgets that moved here from the old dashboard keep
 * their own modules (comments.js / dashboard.js) — ids unchanged.
 *
 * Every card degrades to '—' / a quiet note when its source is down;
 * the view must paint even with analytics 503 and comments offline
 * (Promise.allSettled, no spinner deadlocks).
 */
(function () {
  function $(id) {
    return document.getElementById(id);
  }

  /** @param {number | null | undefined} n */
  function fmtNum(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  /**
   * @param {HTMLElement | null} el
   * @param {number | null} delta fractional change vs the previous window
   */
  function renderDelta(el, delta) {
    if (!el) return;
    if (delta === null || delta === undefined || !Number.isFinite(delta)) {
      el.textContent = '';
      el.className = 'stat-delta flat';
      return;
    }
    const pct = Math.round(Math.abs(delta) * 100);
    if (pct === 0) {
      el.textContent = '→ flat vs prev';
      el.className = 'stat-delta flat';
      return;
    }
    el.textContent = `${delta > 0 ? '↑' : '↓'} ${pct}% vs prev`;
    el.className = `stat-delta${delta > 0 ? '' : ' down'}`;
  }

  /** @param {string} iso */
  function timeAgo(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  async function loadStats() {
    try {
      const sum = await TE.fetchJSON('/api/analytics/summary?range=30d');
      if (!sum || sum.configured === false) {
        const pv = $('ov-stat-pageviews');
        if (pv) pv.textContent = '—';
        const pvd = $('ov-stat-pageviews-delta');
        if (pvd) {
          pvd.textContent = 'analytics not configured';
          pvd.className = 'stat-delta flat';
        }
        return;
      }
      const pv = $('ov-stat-pageviews');
      if (pv) pv.textContent = fmtNum(sum.pageviews);
      const vi = $('ov-stat-visitors');
      if (vi) vi.textContent = fmtNum(sum.visitors);
      renderDelta($('ov-stat-pageviews-delta'), sum.deltas && sum.deltas.pageviews);
      renderDelta($('ov-stat-visitors-delta'), sum.deltas && sum.deltas.visitors);

      // Sparkline: last 30 daily bars; the max day is highlighted.
      const spark = $('ov-stat-pageviews-spark');
      const series = Array.isArray(sum.series) ? sum.series : [];
      if (spark && series.length) {
        const max = Math.max(...series.map((d) => d.pageviews), 1);
        spark.innerHTML = series
          .map((d) => {
            const h = Math.max(2, Math.round((d.pageviews / max) * 22));
            const on = d.pageviews === max ? ' class="on"' : '';
            return `<i${on} style="height:${h}px"></i>`;
          })
          .join('');
      }
    } catch (_) {
      const pvd = $('ov-stat-pageviews-delta');
      if (pvd) {
        pvd.textContent = 'analytics offline';
        pvd.className = 'stat-delta flat';
      }
    }
  }

  async function loadComments() {
    try {
      // Live comments only (visible + pinned) — the old `total` counted
      // spam/deleted/webmentions too and disagreed with every other widget.
      const data = await TE.fetchJSON('/api/comments/counts');
      const c = (data && data.counts) || {};
      const live = (c.visible || 0) + (c.pinned || 0);
      const el = $('ov-stat-comments');
      if (el) el.textContent = fmtNum(live);
    } catch (_) {
      const el = $('ov-stat-comments');
      if (el) el.textContent = '—';
    }
  }

  async function loadPostsCards() {
    let posts;
    try {
      posts = await TE.fetchJSON('/api/posts');
      if (!Array.isArray(posts)) posts = [];
    } catch (_) {
      posts = [];
    }

    // ── Drafts: "pick up where you left off" ─────────────────
    const draftsBody = $('ov-drafts-body');
    if (draftsBody) {
      const drafts = posts
        .filter((p) => p.draft)
        .sort((a, b) => new Date(b.modified || b.date) - new Date(a.modified || a.date))
        .slice(0, 4);
      if (!drafts.length) {
        draftsBody.innerHTML = `<div class="empty"><div class="e-mark">✓</div><div class="e-text">No drafts.</div></div>`;
      } else {
        draftsBody.innerHTML = drafts
          .map((p) => {
            const words = p.word_count || 0;
            // ~800 words ≈ a "complete" post for the progress bar; honest
            // heuristic, clearly labeled with the real word count.
            const pct = Math.min(100, Math.round((words / 800) * 100));
            const read = Math.max(1, Math.round(words / TE.WPM));
            const edited = p.modified ? ` · edited ${timeAgo(p.modified)}` : '';
            return `
            <div class="draft-card" data-file="${TE.escape(p.filename)}">
              <div class="dc-body">
                <div class="dc-title">${TE.escape(p.title)}</div>
                <div class="dc-meta">DRAFT · ${words} words${edited} · ~${read} min read</div>
              </div>
              <div class="dc-bar" aria-hidden="true"><i style="width:${pct}%"></i></div>
              <a class="btn sm primary" href="/editor.html?file=${encodeURIComponent(p.filename)}">Resume</a>
            </div>`;
          })
          .join('');
      }
    }

    // ── Needs you: scheduled posts + system warnings ─────────
    const needsBody = $('ov-needs-body');
    if (!needsBody) return;
    /** @type {string[]} */
    const items = [];

    const now = Date.now();
    posts
      .filter((p) => !p.draft && new Date(p.date).getTime() > now + 60 * 1000)
      .slice(0, 3)
      .forEach((p) => {
        items.push(`
        <div class="todo-row">
          <span class="todo-ic sky" aria-hidden="true">◷</span>
          <span class="todo-txt"><b>${TE.escape(p.title)}</b>
            <span class="sub">scheduled · ${TE.escape(new Date(p.date).toISOString().slice(0, 16).replace('T', ' '))} UTC</span>
          </span>
          <span class="todo-actions"><a class="btn-mini" href="/editor.html?file=${encodeURIComponent(p.filename)}">Edit</a></span>
        </div>`);
      });

    try {
      const health = await TE.fetchJSON('/api/health');
      const docker = (health && health.docker) || [];
      docker
        .filter((c) => c && c.healthy === false)
        .forEach((c) => {
          items.push(`
          <div class="todo-row">
            <span class="todo-ic warn" aria-hidden="true">▲</span>
            <span class="todo-txt"><b>${TE.escape(c.name)}</b> container is unhealthy
              <span class="sub">${TE.escape(c.status || '')}</span>
            </span>
            <span class="todo-actions"><a class="btn-mini" href="/index.html#system">System →</a></span>
          </div>`);
        });
      const backup = health && health.backup;
      if (backup && (backup.status === 'stale' || backup.status === 'warn')) {
        items.push(`
        <div class="todo-row">
          <span class="todo-ic warn" aria-hidden="true">▲</span>
          <span class="todo-txt"><b>Backups are ${backup.status === 'stale' ? 'stale' : 'overdue'}</b>
            <span class="sub">${TE.escape(backup.log || 'last run unknown')}</span>
          </span>
          <span class="todo-actions"><a class="btn-mini" href="/index.html#system">System →</a></span>
        </div>`);
      }
    } catch (_) {
      /* health offline → no system rows; the System view shows detail */
    }

    needsBody.innerHTML = items.length
      ? items.join('')
      : `<div class="empty"><div class="e-mark">✓</div><div class="e-text">All clear.</div></div>`;
  }

  function init() {
    const date = $('ov-date');
    if (date) {
      date.textContent = new Date().toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    }
    refresh();
  }

  // Re-pull the data — router calls this each time Overview is revisited.
  function refresh() {
    void Promise.allSettled([loadStats(), loadComments(), loadPostsCards()]);
    if (typeof TE.loadActivityWidget === 'function') TE.loadActivityWidget();
  }

  window.TE = window.TE || {};
  window.TE.routes = window.TE.routes || {};
  window.TE.routes.overview = init;
  window.TE.viewRefresh = window.TE.viewRefresh || {};
  window.TE.viewRefresh.overview = refresh;
})();
