// @ts-check
/**
 * dashboard.js — wires /index.html.
 *
 * - Posts table: GET /api/posts → render rows w/ status tabs + client
 *   search. Row actions: edit (link), delete (modal). Tabs have full
 *   ArrowLeft/ArrowRight roving keyboard nav.
 * - Live system health via GET /api/health (poll every 5s, pauses
 *   when the tab is hidden).
 * - Publish: POST /api/publish.
 * - Sidebar quick stats (CPU, uptime, system OK/WARN/BAD pip).
 *
 * No backend changes. Endpoint shapes match admin/src/routes/{posts,health,publish}.js.
 */
(function () {
  if (window.location.pathname !== '/' && window.location.pathname !== '/index.html') return;

  // ── State ─────────────────────────────────────────────────
  let allPosts = [];
  let activeTab = 'all';
  let pendingDelete = null;
  let healthTimer = null;

  // ── Helpers ───────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  function postStatus(post) {
    const now = Date.now();
    const date = post.date ? new Date(post.date).getTime() : 0;
    if (post.draft) return 'draft';
    if (date > now + 60 * 1000) return 'scheduled'; // 1 min cushion
    return 'published';
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toISOString().slice(0, 10);
    } catch (_) {
      return '—';
    }
  }

  // ── Posts ─────────────────────────────────────────────────
  async function loadPosts() {
    try {
      const posts = await TE.fetchJSON('/api/posts');
      allPosts = Array.isArray(posts) ? posts : [];
      renderCounts();
      renderPosts();
      // Register posts as Cmd+K palette entries (in addition to the
      // static commands installed by common.js).
      if (window.TE && Array.isArray(TE.paletteCommands)) {
        const staticCount = TE.paletteCommands.findIndex((c) => c.label === 'POST');
        if (staticCount === -1) {
          allPosts.slice(0, 30).forEach((p) => {
            TE.paletteCommands.push({
              label: p.title || p.filename,
              hint: `Edit · ${p.filename}`,
              href: `/editor.html?file=${encodeURIComponent(p.filename)}`,
              tag: 'POST',
            });
          });
        }
      }
    } catch (err) {
      if (err.status === 401) return; // auth.js will redirect
      console.error('Failed to load posts', err);
      const rows = $('posts-rows');
      if (rows)
        rows.innerHTML = `<div class="posts-empty">Failed to load posts: ${TE.escape(err.message)}</div>`;
    }
  }

  function renderCounts() {
    const counts = { all: allPosts.length, draft: 0, scheduled: 0, published: 0 };
    for (const p of allPosts) counts[postStatus(p)]++;
    $('posts-total').textContent = `${counts.all} total`;
    $('tab-count-all').textContent = counts.all;
    $('tab-count-draft').textContent = counts.draft;
    $('tab-count-scheduled').textContent = counts.scheduled;
    $('tab-count-published').textContent = counts.published;

    const sub = $('dash-sub');
    if (sub) {
      sub.textContent = `${counts.published} published · ${counts.draft} draft · ${counts.scheduled} scheduled`;
    }
    const sideBadge = $('side-badge-posts');
    if (sideBadge) sideBadge.textContent = counts.all;
  }

  function renderPosts() {
    const rows = $('posts-rows');
    const search = ($('posts-search')?.value || '').trim().toLowerCase();

    let visible = allPosts.filter((p) => activeTab === 'all' || postStatus(p) === activeTab);
    if (search) {
      visible = visible.filter((p) => {
        const tags = Array.isArray(p.tags) ? p.tags.join(' ').toLowerCase() : '';
        return (
          (p.title || '').toLowerCase().includes(search) ||
          (p.slug || '').toLowerCase().includes(search) ||
          tags.includes(search)
        );
      });
    }

    $('posts-visible').textContent = `${visible.length} visible`;
    $('posts-foot-text').textContent = `Showing ${visible.length} of ${allPosts.length}`;

    if (!visible.length) {
      rows.innerHTML = `<div class="posts-empty">${
        search ? 'No posts match that filter.' : 'No posts yet. Create one!'
      }</div>`;
      return;
    }

    rows.innerHTML = visible
      .map((p, i) => {
        const status = postStatus(p);
        const pillCls = status === 'draft' ? 'draft' : status === 'scheduled' ? 'sched' : 'pub';
        const pillLabel = status.toUpperCase();
        const num = String(i + 1).padStart(3, '0');
        const fn = TE.escape(p.filename);
        const title = TE.escape(p.title || '(untitled)');
        const href = `/editor.html?file=${encodeURIComponent(p.filename)}`;
        // Row uses an outer div w/ a full-bleed link for the click target
        // and a sibling button for delete — putting <button> inside <a> is
        // invalid HTML and several browsers flatten it.
        return `
        <div class="row-grid" data-filename="${fn}">
          <a class="r-link" href="${href}" aria-label="Edit ${title}">
            <span class="r-num">${num}</span>
            <span class="r-title-wrap">
              <span class="r-pill ${pillCls}">${pillLabel}</span>
              <span class="r-title">${title}</span>
            </span>
            <span class="r-status" style="text-align:right;">${TE.escape((p.tags || []).join(', ') || '—')}</span>
            <span class="r-date">${fmtDate(p.date)}</span>
          </a>
          <span class="r-actions">
            <button type="button" class="btn-mini bad js-delete" data-filename="${fn}" data-title="${TE.escape(p.title || p.filename)}" aria-label="Delete ${title}">✕</button>
          </span>
        </div>
      `;
      })
      .join('');

    rows.querySelectorAll('.js-delete').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        pendingDelete = {
          filename: btn.getAttribute('data-filename'),
          title: btn.getAttribute('data-title'),
        };
        $('delete-target-title').textContent = pendingDelete.title;
        TE.openModal('delete-modal');
      });
    });
  }

  function wirePostsUi() {
    const tabs = Array.from(document.querySelectorAll('.tab'));
    tabs.forEach((tab, idx) => {
      tab.setAttribute('tabindex', tab.getAttribute('aria-selected') === 'true' ? '0' : '-1');
      tab.addEventListener('click', () => activateTab(tab));
      tab.addEventListener('keydown', (e) => {
        const ev = /** @type {KeyboardEvent} */ (e);
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
          ev.preventDefault();
          const dir = ev.key === 'ArrowRight' ? 1 : -1;
          const next = /** @type {HTMLElement} */ (tabs[(idx + dir + tabs.length) % tabs.length]);
          next.focus();
          activateTab(next);
        } else if (ev.key === 'Home') {
          ev.preventDefault();
          /** @type {HTMLElement} */ (tabs[0]).focus();
          activateTab(tabs[0]);
        } else if (ev.key === 'End') {
          ev.preventDefault();
          const last = /** @type {HTMLElement} */ (tabs[tabs.length - 1]);
          last.focus();
          activateTab(last);
        }
      });
    });

    function activateTab(tab) {
      activeTab = tab.getAttribute('data-tab') || 'all';
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.setAttribute('tabindex', on ? '0' : '-1');
      });
      renderPosts();
    }

    const search = $('posts-search');
    if (search) {
      let t = 0;
      search.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(renderPosts, 80);
      });
    }
    // Topbar search filters the posts table too
    const topSearch = $('topbar-search-input');
    if (topSearch && search) {
      topSearch.addEventListener('input', (e) => {
        search.value = e.target.value;
        renderPosts();
      });
    }

    const btnDelete = $('btn-confirm-delete');
    if (btnDelete) {
      btnDelete.addEventListener('click', async () => {
        if (!pendingDelete) return;
        const { filename } = pendingDelete;
        btnDelete.disabled = true;
        try {
          await TE.fetchJSON(`/api/posts/${encodeURIComponent(filename)}`, {
            method: 'DELETE',
            body: undefined,
          });
          TE.toast('Post deleted.');
          TE.closeModal('delete-modal');
          pendingDelete = null;
          await loadPosts();
        } catch (err) {
          TE.toast(err.message || 'Delete failed.', 'error');
        } finally {
          btnDelete.disabled = false;
        }
      });
    }
  }

  // ── Health ────────────────────────────────────────────────
  function setMetric(metricId, valueText, percent, severity) {
    const el = $(metricId);
    if (!el) return;
    el.classList.remove('warn', 'bad');
    if (severity === 'warn') el.classList.add('warn');
    if (severity === 'bad') el.classList.add('bad');
    const valEl = $(`${metricId}-val`);
    const barEl = $(`${metricId}-bar`);
    if (valEl) valEl.textContent = valueText;
    if (barEl) barEl.style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
  }

  function severityForPct(pct, thresholds) {
    const [warnAt, badAt] = thresholds || [70, 90];
    if (pct >= badAt) return 'bad';
    if (pct >= warnAt) return 'warn';
    return 'ok';
  }

  async function loadHealth() {
    try {
      const data = await TE.fetchJSON('/api/health');

      const cpu = Number(data?.system?.cpu?.usagePercent || 0);
      const ram = Number(data?.system?.memory?.usagePercent || 0);
      const disk = Number(data?.disk?.usagePercent || 0);
      const temp = Number(data?.temperature?.temp || 0);
      const tempStatus = data?.temperature?.status; // 'ok' | 'warning' | 'critical'
      const tempSev = tempStatus === 'critical' ? 'bad' : tempStatus === 'warning' ? 'warn' : 'ok';

      setMetric('metric-cpu', `${cpu.toFixed(0)}%`, cpu, severityForPct(cpu, [70, 90]));
      setMetric('metric-ram', `${ram.toFixed(0)}%`, ram, severityForPct(ram, [75, 90]));
      setMetric('metric-disk', `${disk.toFixed(0)}%`, disk, severityForPct(disk, [80, 95]));
      const tempPct = Math.min(100, Math.max(0, (temp / 85) * 100)); // 85°C as visual max
      setMetric(
        'metric-temp',
        `${temp.toFixed(1)}°C  ${tempSev === 'bad' ? 'CRIT' : tempSev === 'warn' ? 'WARN' : 'OK'}`,
        tempPct,
        tempSev,
      );

      const uptime = data?.system?.uptime;
      $('health-uptime').textContent = TE.fmtUptime(uptime);
      $('side-uptime').textContent = TE.fmtUptime(uptime);
      $('side-cpu').textContent = `${cpu.toFixed(0)}%`;

      // Docker
      const containers = Array.isArray(data?.docker) ? data.docker : [];
      const list = $('docker-list');
      if (list) {
        if (!containers.length) {
          list.innerHTML = `<div class="docker"><span class="ddot warn" aria-hidden="true"></span><span class="name">no containers</span><span class="status">—</span></div>`;
        } else {
          list.innerHTML = containers
            .map((c) => {
              const healthy = c.healthy !== false;
              const cls = healthy ? '' : 'bad';
              const label = healthy ? 'healthy' : 'unhealthy';
              return `
              <div class="docker">
                <span class="ddot ${cls}" aria-hidden="true"></span>
                <span class="name">${TE.escape(c.name || 'container')}</span>
                <span class="status"><span class="${healthy ? 'ok' : 'bad'}">${TE.escape(label)}</span> · ${TE.escape(c.status || '—')}</span>
              </div>`;
            })
            .join('');
        }
      }

      // Sidebar overall status
      const anyBad = tempSev === 'bad' || containers.some((c) => c.healthy === false);
      const anyWarn = tempSev === 'warn' || cpu >= 70 || ram >= 75 || disk >= 80;
      const pip = $('side-pip');
      const sys = $('side-system');
      if (pip) {
        pip.classList.remove('warn', 'bad');
        if (anyBad) pip.classList.add('bad');
        else if (anyWarn) pip.classList.add('warn');
      }
      if (sys) sys.textContent = anyBad ? 'DEGRADED' : anyWarn ? 'WARN' : 'OK';

      // Backup line — Phase 5e: color-code based on age. stale (>36h)
      // shows in --danger, warn (>24h) in --warn, ok in --fg-dim.
      const backup = $('backup-status');
      if (backup) {
        const status = data?.backup?.status;
        let color = 'var(--fg-dim)';
        if (status === 'stale') color = 'var(--danger)';
        else if (status === 'warn') color = 'var(--warn)';
        backup.style.color = color;
        if (data?.backup?.log) {
          const last = String(data.backup.log).trim().split(/\r?\n/).pop() || '—';
          backup.textContent = last;
        } else {
          backup.textContent = '—';
        }
      }
    } catch (err) {
      if (err.status === 401) return;
      console.warn('health poll failed', err);
    }
  }

  // ── Publish ───────────────────────────────────────────────
  function wirePublishButtons() {
    document.querySelectorAll('#btn-publish, #btn-publish-2').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Publishing…';
        try {
          const data = await TE.fetchJSON('/api/publish', { method: 'POST', body: '{}' });
          if (data && data.success === false) throw new Error(data.error || 'Publish failed');
          TE.toast('Site publish triggered.');
        } catch (err) {
          TE.toast(err.message || 'Publish failed.', 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = orig;
        }
      });
    });
  }

  // ── Inbox widget (Phase 8.5) ──────────────────────────────
  async function loadInbox() {
    const host = $('inbox-grid');
    if (!host) return;
    try {
      const [comments, blocks] = await Promise.all([
        TE.fetchJSON('/api/comments?status=all&page=1&limit=200').catch((err) => {
          if (err.status === 401) throw err;
          return { items: [], total: 0, warning: err.message };
        }),
        TE.fetchJSON('/api/comments/blocks').catch(() => ({ items: [] })),
      ]);
      const items = Array.isArray(comments?.items) ? comments.items : [];
      const since = Date.now() - 24 * 3600 * 1000;
      const last24 = items.filter((c) => c.source === 'remark42' && c.ts > since).length;
      const pendingWm = items.filter(
        (c) => c.source === 'webmention' && c.status === 'pending',
      ).length;
      const totalWm = items.filter((c) => c.source === 'webmention').length;
      const spam = items.filter((c) => c.status === 'spam').length;

      const set = (id, val, hasNew) => {
        const el = $(id);
        if (!el) return;
        el.textContent = String(val);
        el.classList.toggle('has-new', Boolean(hasNew));
      };
      set('inbox-comments-24h', last24, last24 > 0);
      set('inbox-comments-total', `${items.filter((c) => c.source === 'remark42').length} total`);
      set('inbox-webmentions-pending', pendingWm, pendingWm > 0);
      set('inbox-webmentions-total', `${totalWm} total`);
      set('inbox-spam', spam);
      set('inbox-blocked', Array.isArray(blocks?.items) ? blocks.items.length : 0);
    } catch (err) {
      if (err.status === 401) return;
      console.warn('inbox widget failed', err);
      const set = (id, val) => {
        const el = $(id);
        if (el) el.textContent = val;
      };
      set('inbox-comments-24h', '—');
      set('inbox-webmentions-pending', '—');
      set('inbox-spam', '—');
      set('inbox-blocked', '—');
    }
  }

  // ── Boot ──────────────────────────────────────────────────
  function boot() {
    wirePostsUi();
    wirePublishButtons();
    $('btn-refresh-health')?.addEventListener('click', loadHealth);

    loadPosts();
    loadHealth();
    loadInbox();
    healthTimer = setInterval(loadHealth, 5000);

    // Pause polling when the tab is hidden (saves a request loop)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (healthTimer) {
          clearInterval(healthTimer);
          healthTimer = null;
        }
      } else if (!healthTimer) {
        loadHealth();
        healthTimer = setInterval(loadHealth, 5000);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
