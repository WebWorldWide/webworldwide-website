// @ts-check
/**
 * analytics.js — the Analytics view (client side).
 *
 * Renders into #analytics-root from the server-side Umami proxy
 * (/api/analytics/* — see admin/src/routes/analytics.js). The browser
 * never talks to Umami directly. Three server responses shape the UI:
 *   { configured: false }        → setup hint
 *   503 umami_unreachable        → offline empty-state
 *   normal payloads              → stats, daily bar chart, top lists
 */
(function () {
  /** @type {'7d' | '30d' | '90d'} */
  let range = '30d';
  // Guards against out-of-order range switches: a slow earlier range must
  // not render over a newer selection.
  let loadSeq = 0;

  function root() {
    return document.getElementById('analytics-root');
  }

  /** @param {number | null | undefined} n */
  function fmtNum(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
    return Number(n).toLocaleString();
  }

  /** @param {number | null | undefined} secs */
  function fmtTime(secs) {
    if (secs === null || secs === undefined || !Number.isFinite(secs)) return '—';
    const m = Math.floor(secs / 60);
    const s = Math.round(secs % 60);
    return m ? `${m}m ${s}s` : `${s}s`;
  }

  /**
   * @param {number | null} delta
   * @param invert
   */
  function deltaHtml(delta, invert = false) {
    if (delta === null || delta === undefined || !Number.isFinite(delta)) return '';
    const pct = Math.round(Math.abs(delta) * 100);
    if (pct === 0) return `<div class="stat-delta flat">→ flat vs prev</div>`;
    const good = invert ? delta < 0 : delta > 0;
    return `<div class="stat-delta${good ? '' : ' down'}">${delta > 0 ? '↑' : '↓'} ${pct}% vs prev</div>`;
  }

  function shell(inner) {
    return `
      <div class="sec-head">
        <div>
          <h1 class="sec-title">Analytics</h1>
          <div class="sec-sub">UMAMI · SELF-HOSTED · COOKIE-FREE</div>
        </div>
        <div class="sec-actions" role="group" aria-label="Date range">
          ${['7d', '30d', '90d']
            .map(
              (r) =>
                `<button type="button" class="btn sm${r === range ? ' primary' : ''}" data-range="${r}" aria-pressed="${r === range}">${r}</button>`,
            )
            .join('')}
        </div>
      </div>
      ${inner}`;
  }

  function renderMessage(mark, text, hint, retry) {
    const el = root();
    if (!el) return;
    el.innerHTML = shell(`
      <div class="panel"><div class="empty">
        <div class="e-mark">${mark}</div>
        <div class="e-text">${text}</div>
        ${hint ? `<div class="sec-sub" style="margin-top:8px">${hint}</div>` : ''}
        ${retry ? `<button type="button" class="btn sm" id="an-retry" style="margin-top:12px">Retry</button>` : ''}
      </div></div>`);
    wireRange();
    if (retry) {
      const btn = document.getElementById('an-retry');
      if (btn) btn.addEventListener('click', () => load());
    }
  }

  /** Loading state that already reflects the (possibly just-clicked) range. */
  function renderLoading() {
    const el = root();
    if (!el) return;
    el.innerHTML = shell(
      `<div class="panel"><div class="te-state te-state-loading" role="status"><span class="te-spinner" aria-hidden="true"></span> Loading analytics…</div></div>`,
    );
    wireRange();
  }

  function wireRange() {
    const el = root();
    if (!el) return;
    el.querySelectorAll('[data-range]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = btn.getAttribute('data-range');
        if (r === range) return;
        range = /** @type {any} */ (r);
        // Reflect the new range + show progress immediately, before the
        // fetch resolves (so the active button isn't stuck on the old range).
        renderLoading();
        load();
      });
    });
  }

  async function load() {
    const el = root();
    if (!el) return;
    const seq = ++loadSeq;
    let summary;
    try {
      summary = await TE.fetchJSON(`/api/analytics/summary?range=${range}`);
    } catch (_err) {
      if (seq !== loadSeq) return;
      renderMessage(
        '∅',
        'Analytics offline — the Umami container is unreachable.',
        'Check the <a href="/index.html#system">System view</a> for container status.',
        true,
      );
      return;
    }
    if (seq !== loadSeq) return; // a newer range superseded this fetch
    if (!summary || summary.configured === false) {
      renderMessage(
        '⚙',
        'Analytics is not configured yet.',
        'Set UMAMI_ADMIN_USER / UMAMI_ADMIN_PASSWORD / UMAMI_SITE_ID in docker/.env, then restart the cms container.',
      );
      return;
    }

    // Top lists load after the summary so the page paints fast; each
    // list degrades independently.
    const series = Array.isArray(summary.series) ? summary.series : [];
    const max = Math.max(...series.map((d) => d.pageviews), 1);
    const peak = series.find((d) => d.pageviews === max);

    el.innerHTML = shell(`
      <div class="stat-row" aria-label="Traffic stats">
        <div class="stat">
          <div class="stat-label">Visitors</div>
          <div class="stat-val">${fmtNum(summary.visitors)}</div>
          ${deltaHtml(summary.deltas && summary.deltas.visitors)}
        </div>
        <div class="stat">
          <div class="stat-label">Pageviews</div>
          <div class="stat-val">${fmtNum(summary.pageviews)}</div>
          ${deltaHtml(summary.deltas && summary.deltas.pageviews)}
        </div>
        <div class="stat">
          <div class="stat-label">Avg. time</div>
          <div class="stat-val">${fmtTime(summary.avgTime)}</div>
          ${deltaHtml(summary.deltas && summary.deltas.avgTime)}
        </div>
        <div class="stat">
          <div class="stat-label">Bounce rate</div>
          <div class="stat-val">${summary.bounce === null || summary.bounce === undefined ? '—' : Math.round(summary.bounce * 100) + '%'}</div>
          ${deltaHtml(summary.deltas && summary.deltas.bounce, true)}
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <span class="panel-title">Daily pageviews · ${range}</span>
          <div class="panel-head-r">${peak ? `peak ${fmtNum(peak.pageviews)}pv · ${peak.date}` : ''}</div>
        </div>
        <div class="chart-area">
          ${
            series.length
              ? `<div class="chart-bars" role="img" aria-label="Daily pageviews bar chart${peak ? `, peaking at ${peak.pageviews} on ${peak.date}` : ''}">
            ${series
              .map((d) => {
                const h = Math.max(3, Math.round((d.pageviews / max) * 220));
                return `<i style="height:${h}px" title="${d.date}: ${d.pageviews}"></i>`;
              })
              .join('')}
          </div>`
              : `<div class="te-state te-state-empty"><div class="e-text">No pageview data in this range.</div></div>`
          }
        </div>
      </div>

      <div class="grid-2">
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Top sources</span></div>
          <div class="panel-body tight" id="an-sources"><div class="empty"><div class="e-text">Loading…</div></div></div>
        </div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Top countries</span></div>
          <div class="panel-body tight" id="an-countries"><div class="empty"><div class="e-text">Loading…</div></div></div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><span class="panel-title">Top pages</span></div>
        <div class="panel-body tight" id="an-pages"><div class="empty"><div class="e-text">Loading…</div></div></div>
      </div>`);
    wireRange();

    loadTop('referrer', 'an-sources');
    loadTop('country', 'an-countries');
    loadPages();
  }

  /**
   * @param {'referrer' | 'country'} type
   * @param {string} targetId
   */
  async function loadTop(type, targetId) {
    const target = document.getElementById(targetId);
    if (!target) return;
    try {
      const data = await TE.fetchJSON(`/api/analytics/top?type=${type}&range=${range}`);
      const items = (data && data.items) || [];
      if (!items.length) {
        target.innerHTML = `<div class="empty"><div class="e-text">No data in this range.</div></div>`;
        return;
      }
      const max = Math.max(...items.map((i) => i.visitors), 1);
      target.innerHTML = items
        .map(
          (i) => `
        <div class="geo-row">
          <span class="geo-name">${TE.escape(i.label)}</span>
          <span class="geo-views">${fmtNum(i.visitors)}</span>
          <span class="geo-bar" aria-hidden="true"><i style="width:${Math.round((i.visitors / max) * 100)}%"></i></span>
        </div>`,
        )
        .join('');
    } catch (_) {
      target.innerHTML = `<div class="empty"><div class="e-text">Unavailable.</div></div>`;
    }
  }

  async function loadPages() {
    const target = document.getElementById('an-pages');
    if (!target) return;
    try {
      const data = await TE.fetchJSON(`/api/analytics/pages?range=${range}`);
      const items = ((data && data.items) || []).slice(0, 10);
      if (!items.length) {
        target.innerHTML = `<div class="empty"><div class="e-text">No data in this range.</div></div>`;
        return;
      }
      const max = Math.max(...items.map((i) => i.pageviews), 1);
      target.innerHTML = items
        .map(
          (i) => `
        <div class="geo-row">
          <span class="geo-name">${TE.escape(i.path)}</span>
          <span class="geo-views">${fmtNum(i.pageviews)}</span>
          <span class="geo-bar" aria-hidden="true"><i style="width:${Math.round((i.pageviews / max) * 100)}%"></i></span>
        </div>`,
        )
        .join('');
    } catch (_) {
      target.innerHTML = `<div class="empty"><div class="e-text">Unavailable.</div></div>`;
    }
  }

  window.TE = window.TE || {};
  window.TE.routes = window.TE.routes || {};
  window.TE.routes.analytics = load;
})();
