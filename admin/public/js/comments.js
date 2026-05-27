// @ts-check
/**
 * comments.js — Phase 8.5 admin comment moderation page.
 *
 * Surface: /admin/#/comments  (with optional ?status=visible|… filter)
 *
 * What this file owns:
 *   - the SPA view (rendered into #view-comments by router.js)
 *   - the EventSource connection to /api/comments/stream
 *   - the unread-count badge in the sidebar
 *   - the drawer for one comment (reply / pin / spam / delete)
 *   - the bulk-action bar (delete / mark spam / approve)
 *
 * State:
 *   activeTab    — status filter ('all' | 'visible' | 'pinned' | 'spam' | 'pending' | 'blocked')
 *   page / limit — pagination
 *   items[]      — current page of normalised rows
 *   selected     — Set<string>
 *
 * Live updates:
 *   EventSource → on `comment-new` / `webmention-new`, we bump the
 *   unread counter and refresh the list if the user is on a matching
 *   tab. The "last visit" timestamp lives in localStorage so the badge
 *   survives a refresh.
 */
(function () {
  if (window.location.pathname !== '/' && window.location.pathname !== '/index.html') return;

  const $ = (id) => document.getElementById(id);
  const escape = (s) =>
    window.TE && TE.escape ? TE.escape(s) : String(s === null || s === undefined ? '' : s);

  const STATUS_TABS = [
    { id: 'all', label: 'All' },
    { id: 'visible', label: 'Visible' },
    { id: 'pinned', label: 'Pinned' },
    { id: 'pending', label: 'Pending mentions' },
    { id: 'spam', label: 'Spam' },
    { id: 'deleted', label: 'Deleted' },
    { id: 'blocked', label: 'Blocked' },
  ];

  const LAST_VISIT_KEY = 'te.comments.lastVisit';

  /** @type {{ activeTab: string, page: number, limit: number, items: any[], total: number, hasMore: boolean, postFilter: string, authorFilter: string, selected: Set<string>, counts: Record<string, number>, blocked: any[], evt: EventSource|null, opened: boolean }} */
  const state = {
    activeTab: 'all',
    page: 1,
    limit: 30,
    items: [],
    total: 0,
    hasMore: false,
    postFilter: '',
    authorFilter: '',
    selected: new Set(),
    counts: {},
    blocked: [],
    evt: null,
    opened: false,
  };

  // ── Time formatting (shared with activity.js style) ──────────
  function fmtTs(ms) {
    if (!ms) return '—';
    const delta = Date.now() - ms;
    if (delta < 0) return new Date(ms).toISOString().slice(0, 10);
    if (delta < 60 * 1000) return 'just now';
    if (delta < 3600 * 1000) return `${Math.floor(delta / 60000)}m ago`;
    if (delta < 24 * 3600 * 1000) return `${Math.floor(delta / 3600000)}h ago`;
    return new Date(ms).toISOString().slice(0, 10);
  }

  function readLastVisit() {
    try {
      return Number(localStorage.getItem(LAST_VISIT_KEY)) || 0;
    } catch (_) {
      return 0;
    }
  }
  function writeLastVisit(ts) {
    try {
      localStorage.setItem(LAST_VISIT_KEY, String(ts));
    } catch (_) {
      /* ignore */
    }
  }

  // ── DOM scaffold (built inside #view-comments) ───────────────
  function ensureScaffold() {
    const root = $('view-comments');
    if (!root || root.dataset.ready === '1') return root;
    root.dataset.ready = '1';
    root.innerHTML = `
      <div class="sec-head">
        <div>
          <h1 class="sec-title">Comments</h1>
          <div class="sec-sub" id="cm-sub">Remark42 + webmentions, one moderation queue.</div>
        </div>
        <div class="sec-actions">
          <span id="cm-live" class="te-cm-live" data-state="connecting" title="Live updates">
            <span class="dot"></span><span>Connecting…</span>
          </span>
          <button type="button" class="btn" id="cm-refresh">Refresh</button>
        </div>
      </div>
      <div class="te-cm-shell">
        <nav class="te-cm-nav" aria-label="Filter comments by status">
          ${STATUS_TABS.map(
            (t) =>
              `<button type="button" class="te-cm-nav-item" data-tab="${t.id}" aria-selected="${t.id === 'all'}">
                <span>${escape(t.label)}</span>
                <span class="count" id="cm-tab-count-${t.id}">—</span>
              </button>`,
          ).join('')}
        </nav>
        <section class="te-cm-panel panel">
          <div class="panel-head">
            <span class="panel-title"><span class="ind">▾</span><span id="cm-section-title">All comments</span></span>
            <div class="panel-head-r">
              <span id="cm-total">—</span>
            </div>
          </div>
          <div class="te-cm-toolbar">
            <label class="sr-only" for="cm-search-post">Filter by post slug</label>
            <input id="cm-search-post" type="search" placeholder="Post slug…" autocomplete="off" />
            <label class="sr-only" for="cm-search-author">Filter by author</label>
            <input id="cm-search-author" type="search" placeholder="Author…" autocomplete="off" />
            <span class="te-cm-spacer"></span>
            <label style="font-family:var(--mono);font-size:11px;color:var(--fg-mute)">
              <input type="checkbox" id="cm-select-all" /> Select all
            </label>
          </div>
          <div id="cm-error-host"></div>
          <div class="te-cm-list" id="cm-list" role="list" aria-live="polite">
            <!--
              Header is purely visual labels for the data rows. We mark
              it aria-hidden so axe doesn't expect role="row" semantics
              (the parent is role="list", not role="grid"), and so a
              screen reader doesn't announce the column legend before
              every row.
            -->
            <div class="te-cm-row te-cm-row-head" aria-hidden="true">
              <span></span>
              <span>Author</span>
              <span>Post / excerpt</span>
              <span>Status</span>
              <span>When</span>
            </div>
            <div class="te-cm-empty" id="cm-loading">Loading comments…</div>
          </div>
          <div class="te-cm-foot">
            <span id="cm-foot-text">—</span>
            <span class="te-cm-pager">
              <button type="button" id="cm-prev" disabled>← Prev</button>
              <button type="button" id="cm-next" disabled>Next →</button>
            </span>
          </div>
        </section>
      </div>

      <!-- Drawer -->
      <aside class="te-cm-drawer" id="cm-drawer" role="dialog" aria-modal="false" aria-hidden="true" aria-labelledby="cm-drawer-title">
        <header class="te-cm-drawer-head">
          <span id="cm-drawer-title">[ Comment ]</span>
          <button type="button" class="btn ghost" id="cm-drawer-close" aria-label="Close">✕</button>
        </header>
        <div class="te-cm-drawer-body" id="cm-drawer-body"></div>
        <div class="te-cm-actions" id="cm-drawer-actions"></div>
      </aside>

      <!-- Bulk-action bar -->
      <div class="te-cm-bulk-bar" id="cm-bulk-bar" role="region" aria-label="Bulk actions" hidden>
        <span><b id="cm-bulk-count">0</b> selected</span>
        <button type="button" class="btn" data-bulk="approve">Approve</button>
        <button type="button" class="btn" data-bulk="spam">Mark spam</button>
        <button type="button" class="btn danger" data-bulk="delete">Delete</button>
        <button type="button" class="btn ghost" id="cm-bulk-clear">Clear</button>
      </div>
    `;
    wire();
    return root;
  }

  // ── API helpers ──────────────────────────────────────────────
  async function fetchList() {
    const qs = new URLSearchParams();
    qs.set('status', state.activeTab === 'blocked' ? 'all' : state.activeTab);
    qs.set('page', String(state.page));
    qs.set('limit', String(state.limit));
    if (state.postFilter) qs.set('post', state.postFilter);
    if (state.authorFilter) qs.set('author', state.authorFilter);
    return TE.fetchJSON(`/api/comments?${qs.toString()}`);
  }

  async function fetchBlocks() {
    return TE.fetchJSON(`/api/comments/blocks`);
  }

  async function fetchCounts() {
    // Counts come from the same list endpoint — we run a tiny "all"
    // query that returns totals, then break it down by status.
    const data = await TE.fetchJSON(`/api/comments?status=all&page=1&limit=200`);
    const counts = { all: 0, visible: 0, pinned: 0, spam: 0, deleted: 0, pending: 0, blocked: 0 };
    for (const c of data.items || []) {
      counts.all += 1;
      if (c.source === 'webmention') {
        if (c.status === 'pending') counts.pending += 1;
      } else if (Object.prototype.hasOwnProperty.call(counts, c.status)) {
        counts[c.status] += 1;
      }
    }
    return counts;
  }

  // ── Render ───────────────────────────────────────────────────
  function renderTabs() {
    document.querySelectorAll('.te-cm-nav-item').forEach((btn) => {
      const id = btn.getAttribute('data-tab');
      const on = id === state.activeTab;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    for (const tab of STATUS_TABS) {
      const el = $(`cm-tab-count-${tab.id}`);

      if (el) el.textContent = String(state.counts[tab.id] ?? '—');
    }
  }

  function renderList() {
    const list = $('cm-list');
    if (!list) return;
    // Preserve the header row.
    list.innerHTML = `
      <div class="te-cm-row te-cm-row-head" aria-hidden="true">
        <span></span>
        <span>Author</span>
        <span>Post / excerpt</span>
        <span>Status</span>
        <span>When</span>
      </div>
    `;
    if (state.activeTab === 'blocked') {
      renderBlocked(list);
      return;
    }
    if (!state.items.length) {
      list.insertAdjacentHTML(
        'beforeend',
        `<div class="te-cm-empty">No comments match this filter.</div>`,
      );
      return;
    }
    const lastVisit = readLastVisit();
    for (const c of state.items) {
      const unread = c.ts > lastVisit && (c.status === 'visible' || c.status === 'pending');
      const isSelected = state.selected.has(c.id);
      const row = document.createElement('div');
      row.className = 'te-cm-row' + (unread ? ' unread' : '') + (isSelected ? ' selected' : '');
      row.setAttribute('role', 'listitem');
      row.dataset.id = c.id;
      row.innerHTML = `
        <span class="te-cm-check">
          <input type="checkbox" data-row-check="${escape(c.id)}" ${isSelected ? 'checked' : ''} aria-label="Select" />
        </span>
        <span class="te-cm-author">
          <span class="badge ${c.source === 'remark42' ? 'remark42' : 'webmention'}">${c.source === 'remark42' ? 'R42' : 'WM'}</span>
          <span class="name">${escape(c.author?.name || 'anonymous')}</span>
        </span>
        <span class="te-cm-body">
          <span class="post">${escape(c.postTitle || c.postSlug || '—')}</span>
          <span class="excerpt">${escape(c.excerpt || '(no body)')}</span>
        </span>
        <span class="te-cm-status s-${escape(c.status)}">${escape(c.status)}</span>
        <span class="te-cm-ts" title="${escape(new Date(c.ts).toISOString())}">${escape(fmtTs(c.ts))}</span>
      `;
      // Row click → drawer (but checkbox clicks shouldn't propagate)
      row.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        if (target.tagName === 'INPUT') return;
        openDrawer(c);
      });
      const cb = /** @type {HTMLInputElement} */ (row.querySelector(`input[data-row-check]`));
      if (cb) {
        cb.addEventListener('change', () => {
          if (cb.checked) state.selected.add(c.id);
          else state.selected.delete(c.id);
          row.classList.toggle('selected', cb.checked);
          renderBulkBar();
        });
      }
      list.appendChild(row);
    }
    const total = state.total;
    const start = (state.page - 1) * state.limit + 1;
    const end = Math.min(total, state.page * state.limit);
    $('cm-foot-text').textContent = total ? `${start}–${end} of ${total}` : 'No comments.';
    $('cm-total').textContent = total ? `${total} total` : '—';
    $('cm-prev').disabled = state.page <= 1;
    $('cm-next').disabled = !state.hasMore;
    const sectionTitle = $('cm-section-title');
    const tab = STATUS_TABS.find((t) => t.id === state.activeTab);
    if (sectionTitle && tab) sectionTitle.textContent = tab.label;
  }

  function renderBlocked(list) {
    if (!state.blocked.length) {
      list.insertAdjacentHTML('beforeend', `<div class="te-cm-empty">No blocked users.</div>`);
      return;
    }
    for (const b of state.blocked) {
      const row = document.createElement('div');
      row.className = 'te-cm-row';
      row.dataset.id = b.id;
      row.innerHTML = `
        <span class="te-cm-check"></span>
        <span class="te-cm-author">
          <span class="badge webmention">BLOCK</span>
          <span class="name">${escape(b.user_name || b.user_id)}</span>
        </span>
        <span class="te-cm-body">
          <span class="post">${escape(b.user_id)}</span>
          <span class="excerpt">${escape(b.reason || 'no reason recorded')}</span>
        </span>
        <span class="te-cm-status s-spam">blocked</span>
        <span class="te-cm-ts">${escape(fmtTs(b.created_at))}</span>
      `;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-mini bad';
      btn.textContent = 'Unblock';
      btn.style.position = 'absolute';
      btn.style.right = '16px';
      btn.style.marginTop = '6px';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Unblock ${b.user_name || b.user_id}?`)) return;
        try {
          await TE.fetchJSON(`/api/comments/blocks/${encodeURIComponent(b.id)}`, {
            method: 'DELETE',
            body: undefined,
          });
          TE.toast('Unblocked.');
          await reloadActive();
        } catch (err) {
          TE.toast(err.message || 'Unblock failed.', 'error');
        }
      });
      row.appendChild(btn);
      row.style.position = 'relative';
      list.appendChild(row);
    }
    $('cm-foot-text').textContent = `${state.blocked.length} blocked`;
    $('cm-total').textContent = `${state.blocked.length} total`;
    $('cm-prev').disabled = true;
    $('cm-next').disabled = true;
  }

  function renderBulkBar() {
    const bar = $('cm-bulk-bar');
    const count = state.selected.size;
    if (!bar) return;
    if (!count) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    $('cm-bulk-count').textContent = String(count);
  }

  function renderLive(stateName, text) {
    const el = $('cm-live');
    if (!el) return;
    el.setAttribute('data-state', stateName);
    el.querySelector('span:not(.dot)').textContent = text;
  }

  // ── Drawer ───────────────────────────────────────────────────
  let drawerActive = null;

  function openDrawer(c) {
    drawerActive = c;
    const body = $('cm-drawer-body');
    const title = $('cm-drawer-title');
    const actions = $('cm-drawer-actions');
    if (!body || !title || !actions) return;
    title.textContent = c.source === 'webmention' ? '[ Webmention ]' : '[ Comment ]';
    const avatar = c.author?.avatar
      ? `<img class="te-cm-avatar" src="${escape(c.author.avatar)}" alt="" />`
      : `<div class="te-cm-avatar"></div>`;
    body.innerHTML = `
      <div class="te-cm-detail-header">
        ${avatar}
        <div class="te-cm-detail-name">
          <b>${escape(c.author?.name || 'anonymous')}</b>
          ${c.author?.url ? `<a href="${escape(c.author.url)}" target="_blank" rel="noopener noreferrer">${escape(c.author.url)}</a>` : ''}
        </div>
      </div>
      <div class="te-cm-detail-content">${
        c.source === 'remark42' ? c.content : escape(c.content)
      }</div>
      <div class="te-cm-detail-meta">
        <span>${escape(c.status)} · ${escape(c.source)}</span>
        <span>Post: <a href="${escape(c.postUrl || '#')}" target="_blank" rel="noopener noreferrer">${escape(c.postTitle || c.postSlug || c.postUrl)}</a></span>
        <span>${escape(new Date(c.ts).toISOString())}</span>
        ${c.originalUrl ? `<span>Source: <a href="${escape(c.originalUrl)}" target="_blank" rel="noopener noreferrer">${escape(c.originalUrl)}</a></span>` : ''}
      </div>
      ${
        c.source === 'remark42'
          ? `
        <div class="te-cm-reply">
          <label class="sr-only" for="cm-reply-text">Reply</label>
          <textarea id="cm-reply-text" placeholder="Reply as admin… (Cmd+Enter to send)"></textarea>
          <div class="row">
            <button type="button" class="btn primary" id="cm-reply-send">Send reply</button>
            <span class="hint">Markdown supported · ⌘↵ to send</span>
          </div>
        </div>`
          : `<div class="te-cm-reply"><span class="hint">Replies to webmentions go on the source site. Phase 9 will cross-post via Bluesky automatically.</span></div>`
      }
    `;
    actions.innerHTML = renderDrawerActions(c);
    wireDrawerActions(c);
    const drawer = $('cm-drawer');
    if (drawer) {
      drawer.classList.add('open');
      drawer.removeAttribute('aria-hidden');
    }
    const replyTextarea = /** @type {HTMLTextAreaElement | null} */ ($('cm-reply-text'));
    if (replyTextarea) {
      replyTextarea.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          $('cm-reply-send')?.click();
        }
      });
    }
  }

  function renderDrawerActions(c) {
    const buttons = [];
    if (c.source === 'remark42') {
      buttons.push(
        c.status === 'pinned'
          ? `<button type="button" class="btn" data-act="unpin">Unpin</button>`
          : `<button type="button" class="btn" data-act="pin">Pin</button>`,
      );
      buttons.push(`<button type="button" class="btn" data-act="spam">Mark spam</button>`);
      buttons.push(`<button type="button" class="btn danger" data-act="delete">Delete</button>`);
    } else if (c.source === 'webmention') {
      if (c.status === 'pending') {
        buttons.push(
          `<button type="button" class="btn primary" data-act="approve">Approve</button>`,
        );
      }
      buttons.push(`<button type="button" class="btn" data-act="reject">Reject</button>`);
      buttons.push(`<button type="button" class="btn danger" data-act="delete">Delete</button>`);
    }
    return buttons.join('');
  }

  function wireDrawerActions(c) {
    const actions = $('cm-drawer-actions');
    if (!actions) return;
    actions.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const act = btn.getAttribute('data-act');
        try {
          await runAction(c, act);
        } catch (err) {
          TE.toast(err.message || 'Action failed.', 'error');
        }
      });
    });
    $('cm-reply-send')?.addEventListener('click', async () => {
      const text = /** @type {HTMLTextAreaElement | null} */ ($('cm-reply-text'))?.value?.trim();
      if (!text) {
        TE.toast('Reply is empty.', 'warn');
        return;
      }
      const btn = /** @type {HTMLButtonElement | null} */ ($('cm-reply-send'));
      if (btn) btn.disabled = true;
      try {
        await TE.fetchJSON(`/api/comments/${encodeURIComponent(c.id)}/reply`, {
          method: 'POST',
          body: JSON.stringify({ text, postUrl: c.postUrl }),
        });
        TE.toast('Reply sent.');
        closeDrawer();
        await reloadActive();
      } catch (err) {
        TE.toast(err.message || 'Reply failed.', 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  async function runAction(c, act) {
    const id = encodeURIComponent(c.id);
    if (act === 'pin' || act === 'unpin') {
      await TE.fetchJSON(`/api/comments/${id}/${act}`, {
        method: 'POST',
        body: JSON.stringify({ postUrl: c.postUrl }),
      });
      TE.toast(act === 'pin' ? 'Pinned.' : 'Unpinned.');
    } else if (act === 'spam') {
      if (!confirm('Mark as spam and block the author?')) return;
      await TE.fetchJSON(`/api/comments/${id}/spam`, {
        method: 'POST',
        body: JSON.stringify({
          postUrl: c.postUrl,
          userId: c.author?.id,
          userName: c.author?.name,
        }),
      });
      TE.toast('Marked spam.');
    } else if (act === 'delete') {
      if (!confirm('Delete this comment?')) return;
      await TE.fetchJSON(`/api/comments/${id}?url=${encodeURIComponent(c.postUrl)}`, {
        method: 'DELETE',
        body: undefined,
      });
      TE.toast('Deleted.');
    } else if (act === 'approve') {
      await TE.fetchJSON(`/api/webmentions/${id}/approve`, {
        method: 'POST',
        body: '{}',
      });
      TE.toast('Approved.');
    } else if (act === 'reject') {
      await TE.fetchJSON(`/api/webmentions/${id}/reject`, {
        method: 'POST',
        body: '{}',
      });
      TE.toast('Rejected.');
    }
    closeDrawer();
    await reloadActive();
  }

  function closeDrawer() {
    drawerActive = null;
    const drawer = $('cm-drawer');
    if (!drawer) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
  }

  // ── Bulk actions ─────────────────────────────────────────────
  async function runBulk(act) {
    const ids = Array.from(state.selected);
    if (!ids.length) return;
    if (act === 'delete' && !confirm(`Delete ${ids.length} comment(s)?`)) return;
    if (act === 'spam' && !confirm(`Mark ${ids.length} as spam (also blocks authors)?`)) return;
    if (act === 'approve' && !confirm(`Approve ${ids.length} webmention(s)?`)) return;

    const errors = [];
    for (const id of ids) {
      const c = state.items.find((x) => x.id === id);
      if (!c) continue;
      try {
        if (act === 'delete') {
          await TE.fetchJSON(
            `/api/comments/${encodeURIComponent(id)}?url=${encodeURIComponent(c.postUrl)}`,
            { method: 'DELETE', body: undefined },
          );
        } else if (act === 'spam') {
          await TE.fetchJSON(`/api/comments/${encodeURIComponent(id)}/spam`, {
            method: 'POST',
            body: JSON.stringify({
              postUrl: c.postUrl,
              userId: c.author?.id,
              userName: c.author?.name,
            }),
          });
        } else if (act === 'approve' && c.source === 'webmention') {
          await TE.fetchJSON(`/api/webmentions/${encodeURIComponent(id)}/approve`, {
            method: 'POST',
            body: '{}',
          });
        }
      } catch (err) {
        errors.push(`${id}: ${err.message}`);
      }
    }
    state.selected.clear();
    renderBulkBar();
    if (errors.length) {
      TE.toast(`${errors.length} action(s) failed.`, 'error');
      console.warn('[comments] bulk errors:', errors);
    } else {
      TE.toast(`${ids.length} updated.`);
    }
    await reloadActive();
  }

  // ── Live updates via EventSource ─────────────────────────────
  function openStream() {
    if (state.evt) return;
    try {
      const es = new EventSource('/api/comments/stream', { withCredentials: true });
      state.evt = es;
      es.addEventListener('open', () => renderLive('live', 'Live'));
      es.addEventListener('error', () => renderLive('down', 'Offline'));
      es.addEventListener('hello', () => renderLive('live', 'Live'));
      const bump = (ev) => {
        try {
          const data = JSON.parse(ev.data || 'null');
          if (!data) return;
          incrementUnread();
          TE.toast(`New ${ev.type.replace('-new', '').replace('webmention', 'webmention')}.`);
          // Reload the current view if it could now include this row.
          if (state.activeTab === 'all' || state.activeTab === 'pending') {
            reloadActive();
          }
        } catch (_) {
          /* swallow */
        }
      };
      es.addEventListener('comment-new', bump);
      es.addEventListener('webmention-new', bump);
      es.addEventListener('webmention-validated', () => {
        if (state.activeTab === 'pending' || state.activeTab === 'all') reloadActive();
      });
    } catch (err) {
      console.warn('[comments] EventSource failed:', err);
      renderLive('down', 'No live updates');
    }
  }

  function closeStream() {
    if (state.evt) {
      try {
        state.evt.close();
      } catch (_) {
        /* ignore */
      }
      state.evt = null;
    }
  }

  // ── Sidebar unread badge ─────────────────────────────────────
  function setSidebarBadge(n) {
    const link = document.querySelector('[data-route="comments"] .badge');
    if (!link) return;
    link.textContent = n > 0 ? String(n) : '0';
    link.classList.toggle('zero', n <= 0);
  }

  let unread = 0;
  function incrementUnread() {
    unread += 1;
    setSidebarBadge(unread);
  }
  function clearUnread() {
    unread = 0;
    setSidebarBadge(0);
  }

  async function refreshSidebarBadge() {
    // On other pages we still want the badge populated. Read last visit
    // + the most recent N comments and webmentions.
    try {
      const lastVisit = readLastVisit();
      const data = await TE.fetchJSON(`/api/comments?status=all&page=1&limit=100`);
      const items = Array.isArray(data?.items) ? data.items : [];
      const n = items.filter((c) => c.ts > lastVisit).length;
      unread = n;
      setSidebarBadge(n);
    } catch (_) {
      /* swallow */
    }
  }

  // ── Wiring ───────────────────────────────────────────────────
  function wire() {
    document.querySelectorAll('.te-cm-nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab') || 'all';
        state.activeTab = tab;
        state.page = 1;
        state.selected.clear();
        renderBulkBar();
        // Reflect in URL so refresh keeps the tab.
        const newHash = `#comments?status=${encodeURIComponent(tab)}`;
        history.replaceState(null, '', newHash);
        reloadActive();
      });
    });
    $('cm-refresh')?.addEventListener('click', () => reloadActive());
    $('cm-prev')?.addEventListener('click', () => {
      if (state.page > 1) {
        state.page -= 1;
        reloadActive();
      }
    });
    $('cm-next')?.addEventListener('click', () => {
      if (state.hasMore) {
        state.page += 1;
        reloadActive();
      }
    });
    let postT = 0;
    $('cm-search-post')?.addEventListener('input', (e) => {
      clearTimeout(postT);
      postT = setTimeout(() => {
        state.postFilter = /** @type {HTMLInputElement} */ (e.target).value.trim();
        state.page = 1;
        reloadActive();
      }, 180);
    });
    let authT = 0;
    $('cm-search-author')?.addEventListener('input', (e) => {
      clearTimeout(authT);
      authT = setTimeout(() => {
        state.authorFilter = /** @type {HTMLInputElement} */ (e.target).value.trim();
        state.page = 1;
        reloadActive();
      }, 180);
    });
    $('cm-select-all')?.addEventListener('change', (e) => {
      const on = /** @type {HTMLInputElement} */ (e.target).checked;
      state.selected.clear();
      if (on) for (const c of state.items) state.selected.add(c.id);
      renderList();
      renderBulkBar();
    });
    $('cm-drawer-close')?.addEventListener('click', () => closeDrawer());
    document.querySelectorAll('#cm-bulk-bar button[data-bulk]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.getAttribute('data-bulk');
        if (act) runBulk(act);
      });
    });
    $('cm-bulk-clear')?.addEventListener('click', () => {
      state.selected.clear();
      renderList();
      renderBulkBar();
    });
    // Esc closes drawer
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drawerActive) {
        e.stopPropagation();
        closeDrawer();
      }
    });
  }

  async function reloadActive() {
    const list = $('cm-list');
    if (list) {
      const existing = list.querySelector('.te-cm-empty');
      if (existing) existing.textContent = 'Loading…';
    }
    try {
      if (state.activeTab === 'blocked') {
        const blocks = await fetchBlocks();
        state.blocked = Array.isArray(blocks?.items) ? blocks.items : [];
        state.items = [];
        state.total = state.blocked.length;
        state.hasMore = false;
      } else {
        const data = await fetchList();
        state.items = Array.isArray(data?.items) ? data.items : [];
        state.total = Number(data?.total || 0);
        state.hasMore = Boolean(data?.hasMore);
        const errorHost = $('cm-error-host');
        if (errorHost) {
          errorHost.innerHTML = data?.warning
            ? `<div class="te-cm-error">${escape(data.warning)}</div>`
            : '';
        }
      }
      try {
        const counts = await fetchCounts();
        state.counts = { ...state.counts, ...counts };
      } catch (_) {
        /* counts are best-effort */
      }
    } catch (err) {
      const errorHost = $('cm-error-host');
      if (errorHost) {
        errorHost.innerHTML = `<div class="te-cm-error">Failed to load comments: ${escape(err.message)}</div>`;
      }
    }
    renderTabs();
    renderList();
    renderBulkBar();
  }

  function applyInitialFilterFromHash() {
    const hash = (window.location.hash || '').slice(1);
    const qIdx = hash.indexOf('?');
    if (qIdx === -1) return;
    const params = new URLSearchParams(hash.slice(qIdx + 1));
    const status = params.get('status');
    if (status && STATUS_TABS.some((t) => t.id === status)) state.activeTab = status;
  }

  async function init() {
    ensureScaffold();
    applyInitialFilterFromHash();
    // Mark this visit so the badge resets.
    writeLastVisit(Date.now());
    clearUnread();
    await reloadActive();
    openStream();
  }

  // Re-init on hashchange in case the user navigates while on the page.
  window.addEventListener('hashchange', () => {
    const hash = (window.location.hash || '').replace(/^#/, '').split('?')[0];
    if (hash === 'comments') {
      applyInitialFilterFromHash();
      reloadActive();
    } else if (state.opened) {
      // leaving the comments view — close the SSE so we don't burn a
      // connection on every other tab.
      closeStream();
    }
  });

  window.TE = window.TE || {};
  window.TE.routes = window.TE.routes || {};
  window.TE.routes.comments = function () {
    state.opened = true;
    init();
  };

  // Boot the sidebar badge regardless of which page we're on.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refreshSidebarBadge);
  } else {
    refreshSidebarBadge();
  }
})();
