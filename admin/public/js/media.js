// @ts-check
/**
 * media.js — Phase 4 universal media library + upload client.
 *
 * Replaces the Phase 2 image-only sidebar widget. Three concerns:
 *
 *   1. `window.TE.media.upload(files, opts)` — XHR-based multi-file
 *      upload with per-file progress + cancellation. Used by the editor
 *      drop zone, the library page, and the sidebar dropzone.
 *   2. `window.TE.media.uploadTray` — bottom-right progress tray that
 *      shows a row per active upload with cancel + retry. Mounted lazily
 *      the first time we kick off an upload.
 *   3. The library page UI (`#view-media`): grid/list views, type
 *      filters, search, sort, bulk select, bulk delete, detail drawer.
 *
 * The page wiring auto-detects whether `#view-media` is in the DOM and
 * shows/hides itself based on `location.hash`. Phase 2 only had a
 * dashboard view; the Phase 4 admin shell adds `#media` as a sibling
 * `#view-media` panel inside the same `<div class="stage">`.
 */

(function () {
  if (!window.TE) window.TE = {};
  if (window.TE.media && window.TE.media.__phase4) return; // idempotent

  const media = (window.TE.media = window.TE.media || {});
  media.__phase4 = true;

  const TYPE_ICONS = {
    image: '▦',
    video: '▶',
    audio: '♪',
    document: '⊟',
    archive: '◫',
    other: '◇',
  };
  // TYPE_LABELS intentionally omitted — chip labels live in
  // index.html. Reintroduce here if the filter UI ever needs to
  // render the bucket display name from a JS-only context.

  // ── Upload primitive ───────────────────────────────────────
  /**
   * Upload a single File via XHR so we get progress + cancellation.
   *
   * @param {File} file
   * @param {{ onProgress?: (pct: number, loaded: number, total: number) => void, signal?: AbortSignal }} [opts]
   * @returns {Promise<any>} resolves with the server's `file` record
   */
  media.uploadOne = function uploadOne(file, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const fd = new FormData();
      fd.append('files', file);
      xhr.open('POST', '/api/media/upload');
      xhr.withCredentials = true;
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && opts.onProgress) {
          opts.onProgress(Math.round((e.loaded / e.total) * 100), e.loaded, e.total);
        }
      });
      xhr.addEventListener('load', () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText || '{}');
        } catch {
          /* leave as null */
        }
        if (xhr.status === 401) {
          window.location.href = '/login.html';
          reject(new Error('Not authenticated'));
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          // The route returns `{ file, files }` for new shape; legacy
          // single-file path returns `{ success, url, filename, file }`.
          const result = (data && (data.file || (data.files && data.files[0]))) || data;
          resolve(result);
        } else {
          const err = new Error(
            (data && (data.message || data.error)) || `Upload failed (${xhr.status})`,
          );
          /** @type {any} */ (err).status = xhr.status;
          /** @type {any} */ (err).data = data;
          reject(err);
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Network error')));
      xhr.addEventListener('abort', () => reject(new DOMException('Upload aborted', 'AbortError')));
      if (opts.signal) {
        if (opts.signal.aborted) {
          xhr.abort();
        } else {
          opts.signal.addEventListener('abort', () => xhr.abort());
        }
      }
      xhr.send(fd);
    });
  };

  /**
   * Upload many files; resolves after every one settles. The tray UI
   * is rendered for each upload so the user gets visible per-file
   * progress and a per-file error/retry button.
   *
   * @param {File[] | FileList} files
   * @param {{ onFileDone?: (result: any) => void }} [opts]
   * @returns {Promise<{ ok: any[], failed: { name: string, error: string }[] }>}
   */
  media.upload = async function upload(files, opts) {
    opts = opts || {};
    const list = Array.from(files || []);
    const tray = ensureUploadTray();
    /** @type {any[]} */
    const ok = [];
    /** @type {{ name: string, error: string }[]} */
    const failed = [];

    for (const file of list) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const row = tray.addRow(file.name, () => controller && controller.abort());
      try {
        const result = await media.uploadOne(file, {
          signal: controller ? controller.signal : undefined,
          onProgress: (pct) => row.setProgress(pct),
        });
        row.markDone();
        ok.push(result);
        if (typeof opts.onFileDone === 'function') {
          try {
            opts.onFileDone(result);
          } catch (_) {
            /* swallow — UI listener errors don't abort the batch */
          }
        }
      } catch (err) {
        row.markFailed(err.message || 'Upload failed');
        failed.push({ name: file.name, error: err.message || 'Upload failed' });
      }
    }

    return { ok, failed };
  };

  /**
   * Fetch /api/media. Always returns the new envelope shape.
   *
   * @param {{ type?: string, q?: string, sort?: string, page?: number, limit?: number }} [filters]
   * @returns {Promise<{ items: any[], total: number, page: number, limit: number }>}
   */
  media.list = async function listMedia(filters) {
    const qs = new URLSearchParams();
    if (filters) {
      if (filters.type && filters.type !== 'all') qs.set('type', filters.type);
      if (filters.q) qs.set('q', filters.q);
      if (filters.sort) qs.set('sort', filters.sort);
      if (filters.page) qs.set('page', String(filters.page));
      if (filters.limit) qs.set('limit', String(filters.limit));
    }
    return TE.fetchJSON(`/api/media${qs.toString() ? `?${qs}` : ''}`);
  };

  /**
   * @param {string} id
   * @returns {Promise<any>}
   */
  media.get = function getMedia(id) {
    return TE.fetchJSON(`/api/media/${encodeURIComponent(id)}`);
  };

  /**
   * Trigger a re-run of the most recent conversion job for an asset.
   * Used by the failed-state retry button in the library grid.
   *
   * @param {string} id
   * @returns {Promise<any>}
   */
  media.retry = async function retryMedia(id) {
    const res = await fetch(`/api/media/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (res.status === 401) {
      window.location.href = '/login.html';
      throw new Error('Not authenticated');
    }
    if (!res.ok) {
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* ignore */
      }
      throw new Error((data && (data.message || data.error)) || `Retry failed (${res.status})`);
    }
    return res.json();
  };

  /**
   * @param {string} id
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<void>}
   */
  media.delete = async function deleteMedia(id, opts) {
    const force = opts && opts.force ? '?force=true' : '';
    const res = await fetch(`/api/media/${encodeURIComponent(id)}${force}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (res.status === 204) return;
    if (res.status === 401) {
      window.location.href = '/login.html';
      throw new Error('Not authenticated');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* ignore */
    }
    const err = new Error(
      (data && (data.message || data.error)) || `Delete failed (${res.status})`,
    );
    /** @type {any} */ (err).status = res.status;
    /** @type {any} */ (err).data = data;
    throw err;
  };

  // ── Upload tray (toasts) ───────────────────────────────────
  /** @type {HTMLElement | null} */
  let trayRoot = null;

  function ensureUploadTray() {
    if (trayRoot) return getTrayApi();
    trayRoot = document.createElement('div');
    trayRoot.className = 'te-upload-tray';
    trayRoot.id = 'te-upload-tray';
    trayRoot.setAttribute('role', 'region');
    trayRoot.setAttribute('aria-label', 'File uploads');
    trayRoot.setAttribute('aria-live', 'polite');
    document.body.appendChild(trayRoot);
    return getTrayApi();
  }

  function getTrayApi() {
    return {
      /**
       * @param {string} name
       * @param {() => void} onCancel
       */
      addRow(name, onCancel) {
        const row = document.createElement('div');
        row.className = 'te-upload-row';
        row.innerHTML = `
          <div class="te-upload-meta">
            <span class="te-upload-name"></span>
            <span class="te-upload-status">Uploading…</span>
          </div>
          <div class="te-upload-bar"><i style="width:0%"></i></div>
          <button type="button" class="te-upload-x" aria-label="Cancel upload">✕</button>
        `;
        row.querySelector('.te-upload-name').textContent = name;
        const bar = /** @type {HTMLElement} */ (row.querySelector('.te-upload-bar i'));
        const statusEl = /** @type {HTMLElement} */ (row.querySelector('.te-upload-status'));
        const cancelBtn = /** @type {HTMLButtonElement} */ (row.querySelector('.te-upload-x'));
        cancelBtn.addEventListener('click', () => {
          if (typeof onCancel === 'function') onCancel();
          statusEl.textContent = 'Cancelled';
          row.classList.add('failed');
          setTimeout(() => row.remove(), 2400);
        });
        trayRoot.appendChild(row);
        return {
          setProgress(pct) {
            bar.style.width = `${pct}%`;
            statusEl.textContent = `${pct}%`;
          },
          markDone() {
            bar.style.width = '100%';
            statusEl.textContent = 'Done';
            row.classList.add('done');
            cancelBtn.remove();
            setTimeout(() => row.remove(), 1600);
          },
          markFailed(reason) {
            row.classList.add('failed');
            statusEl.textContent = reason || 'Failed';
            cancelBtn.textContent = '✕';
            cancelBtn.setAttribute('aria-label', 'Dismiss');
            cancelBtn.onclick = () => row.remove();
          },
        };
      },
    };
  }

  // ── Library page ──────────────────────────────────────────
  /** @type {{ items: any[], type: string, q: string, sort: string, selected: Set<string>, view: 'grid' | 'list' }} */
  const lib = {
    items: [],
    type: 'all',
    q: '',
    sort: 'date',
    selected: new Set(),
    view: 'grid',
  };

  function $(id) {
    return document.getElementById(id);
  }

  async function reload() {
    const grid = $('media-grid');
    if (grid) grid.setAttribute('aria-busy', 'true');
    try {
      const data = await media.list({ type: lib.type, q: lib.q, sort: lib.sort, limit: 200 });
      lib.items = (data && data.items) || [];
      // Drop any stale selections that no longer exist.
      const known = new Set(lib.items.map((m) => m.id));
      for (const id of Array.from(lib.selected)) if (!known.has(id)) lib.selected.delete(id);
      render();
    } catch (err) {
      if (err.status === 401) return; // common.js will redirect
      const empty = $('media-empty');
      if (empty) {
        empty.hidden = false;
        empty.textContent = `Failed to load media: ${TE.escape(err.message)}`;
      }
    } finally {
      if (grid) grid.setAttribute('aria-busy', 'false');
    }
  }

  function classifyOnClient(mime) {
    if (!mime) return 'other';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (
      mime === 'application/pdf' ||
      mime === 'application/msword' ||
      mime === 'text/plain' ||
      mime === 'text/markdown' ||
      mime === 'application/json' ||
      mime.indexOf('officedocument') >= 0
    )
      return 'document';
    if (
      mime === 'application/zip' ||
      mime === 'application/x-tar' ||
      mime === 'application/x-7z-compressed' ||
      mime === 'application/x-rar-compressed'
    )
      return 'archive';
    return 'other';
  }

  function render() {
    renderChipCounts();
    renderItems();
    renderBulkBar();
  }

  function renderChipCounts() {
    const buckets = {
      all: lib.items.length,
      image: 0,
      video: 0,
      audio: 0,
      document: 0,
      archive: 0,
      other: 0,
    };
    // Counts reflect the *full* listing (server-side filtered by type
    // already, but when filter==='all' the buckets are useful).
    for (const m of lib.items) buckets[m.type || classifyOnClient(m.mime_type)]++;
    document.querySelectorAll('[data-media-chip]').forEach((el) => {
      const k = el.getAttribute('data-media-chip');
      const c = el.querySelector('.count');
      if (c && Object.prototype.hasOwnProperty.call(buckets, k)) c.textContent = String(buckets[k]);
      el.setAttribute('aria-selected', lib.type === k ? 'true' : 'false');
      el.classList.toggle('active', lib.type === k);
    });
  }

  function renderItems() {
    const grid = $('media-grid');
    const empty = $('media-empty');
    if (!grid) return;
    if (!lib.items.length) {
      grid.innerHTML = '';
      if (empty) {
        empty.hidden = false;
        empty.textContent = lib.q
          ? 'No files match that filter.'
          : 'No uploads yet. Drop files anywhere to add them.';
      }
      return;
    }
    if (empty) empty.hidden = true;

    grid.classList.toggle('view-list', lib.view === 'list');
    grid.classList.toggle('view-grid', lib.view === 'grid');

    grid.innerHTML = lib.items
      .map((m) => {
        const type = m.type || classifyOnClient(m.mime_type);
        const sel = lib.selected.has(m.id);
        const thumb =
          type === 'image'
            ? `<img loading="lazy" src="${TE.escape(m.url)}" alt="${TE.escape(m.original_name || m.filename)}" />`
            : `<span class="te-media-glyph" aria-hidden="true">${TYPE_ICONS[type] || TYPE_ICONS.other}</span>`;
        const subtitle = `${TE.escape(type.toUpperCase())} · ${TE.escape(TE.fmtBytes(m.size))}`;
        // Phase 5: status overlay. 'processing' shows a shimmering badge,
        // 'failed' surfaces a retry button. 'ready' (the common case)
        // emits nothing so the card layout is unchanged.
        const status = m.status || 'ready';
        let statusBadge = '';
        if (status === 'processing') {
          statusBadge = `<span class="te-media-status processing" title="Converting…" aria-label="Converting">⟳ Converting</span>`;
        } else if (status === 'failed') {
          statusBadge = `<span class="te-media-status failed" title="Conversion failed" aria-label="Conversion failed">● Failed</span>
            <button type="button" class="te-media-retry" data-retry-id="${TE.escape(m.id)}" aria-label="Retry conversion">Retry</button>`;
        }
        return `
        <div class="te-media-card ${sel ? 'is-selected' : ''} status-${TE.escape(status)}" data-id="${TE.escape(m.id)}" role="listitem">
          <label class="te-media-check">
            <input type="checkbox" data-bulk-id="${TE.escape(m.id)}" ${sel ? 'checked' : ''}
                   aria-label="Select ${TE.escape(m.original_name || m.filename)}" />
          </label>
          <button type="button" class="te-media-thumb" data-open-id="${TE.escape(m.id)}"
                  aria-label="Open details for ${TE.escape(m.original_name || m.filename)}">
            ${thumb}
            ${statusBadge}
          </button>
          <div class="te-media-info">
            <span class="te-media-name" title="${TE.escape(m.original_name || m.filename)}">${TE.escape(m.original_name || m.filename)}</span>
            <span class="te-media-sub">${subtitle}</span>
          </div>
        </div>`;
      })
      .join('');

    // Phase 5: retry button (failed state only). Click rebounds the asset
    // back to 'processing' and the next poll picks up the change.
    grid.querySelectorAll('[data-retry-id]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-retry-id');
        btn.setAttribute('disabled', 'true');
        try {
          await media.retry(id);
          TE.toast('Retrying conversion…');
          schedulePoll();
          // Flip the local card to 'processing' immediately so the UI
          // doesn't lag the next poll tick.
          const card = btn.closest('.te-media-card');
          if (card) {
            card.classList.remove('status-failed');
            card.classList.add('status-processing');
          }
        } catch (err) {
          TE.toast(err.message || 'Retry failed.', 'error');
          btn.removeAttribute('disabled');
        }
      });
    });

    // Phase 5: if any item is processing, kick off the poll loop so the
    // badges update without a manual reload.
    if (lib.items.some((m) => (m.status || 'ready') === 'processing')) {
      schedulePoll();
    }

    grid.querySelectorAll('input[data-bulk-id]').forEach((cb) => {
      cb.addEventListener('change', (e) => {
        const t = /** @type {HTMLInputElement} */ (e.currentTarget);
        const id = t.getAttribute('data-bulk-id');
        if (t.checked) lib.selected.add(id);
        else lib.selected.delete(id);
        renderBulkBar();
        const card = t.closest('.te-media-card');
        if (card) card.classList.toggle('is-selected', t.checked);
      });
    });
    grid.querySelectorAll('[data-open-id]').forEach((btn) => {
      btn.addEventListener('click', () => openDrawer(btn.getAttribute('data-open-id')));
    });

    // Arrow-key navigation inside the grid (left/right/up/down).
    grid.querySelectorAll('.te-media-thumb').forEach((thumb, idx, all) => {
      thumb.setAttribute('tabindex', idx === 0 ? '0' : '-1');
      thumb.addEventListener('keydown', (e) => {
        const ev = /** @type {KeyboardEvent} */ (e);
        if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(ev.key) < 0)
          return;
        ev.preventDefault();
        let next = idx;
        const cols = Math.max(1, Math.floor(grid.clientWidth / 180));
        if (ev.key === 'ArrowRight') next = idx + 1;
        else if (ev.key === 'ArrowLeft') next = idx - 1;
        else if (ev.key === 'ArrowDown') next = idx + cols;
        else if (ev.key === 'ArrowUp') next = idx - cols;
        else if (ev.key === 'Home') next = 0;
        else if (ev.key === 'End') next = all.length - 1;
        if (next < 0 || next >= all.length) return;
        /** @type {HTMLElement} */ (all[next]).focus();
      });
    });
  }

  // ── Status polling ─────────────────────────────────────────
  // Light-touch poller: every POLL_INTERVAL while any visible item is
  // 'processing', re-fetch the list and re-render. Stops automatically
  // once every item is ready/failed. Tab-visibility-aware so a
  // backgrounded tab doesn't keep hammering the server.
  const POLL_INTERVAL_MS = 5000;
  let pollTimer = 0;

  function schedulePoll() {
    if (pollTimer) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    pollTimer = window.setTimeout(async () => {
      pollTimer = 0;
      try {
        await reload();
      } catch (_) {
        /* reload surfaces its own errors */
      }
    }, POLL_INTERVAL_MS);
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = 0;
        }
      } else {
        // Coming back to the tab — re-evaluate.
        if (lib.items.some((m) => (m.status || 'ready') === 'processing')) {
          schedulePoll();
        }
      }
    });
  }

  function renderBulkBar() {
    const bar = $('media-bulk-bar');
    const count = $('media-bulk-count');
    if (!bar) return;
    const n = lib.selected.size;
    bar.hidden = n === 0;
    if (count) count.textContent = String(n);
  }

  // ── Detail drawer ──────────────────────────────────────────
  async function openDrawer(id) {
    const drawer = $('media-drawer');
    if (!drawer) return;
    drawer.classList.add('open');
    drawer.removeAttribute('aria-hidden');
    const body = $('media-drawer-body');
    if (body) body.innerHTML = '<p class="te-media-loading">Loading…</p>';
    try {
      const m = await media.get(id);
      renderDrawer(m);
    } catch (err) {
      if (body) body.innerHTML = `<p class="te-media-error">${TE.escape(err.message)}</p>`;
    }
  }

  function closeDrawer() {
    const drawer = $('media-drawer');
    if (!drawer) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
  }

  function renderDrawer(m) {
    const body = $('media-drawer-body');
    if (!body) return;
    const type = m.type || classifyOnClient(m.mime_type);
    const preview =
      type === 'image'
        ? `<img class="te-drawer-preview" src="${TE.escape(m.url)}" alt="${TE.escape(m.original_name)}" />`
        : type === 'video'
          ? `<video class="te-drawer-preview" controls src="${TE.escape(m.url)}"></video>`
          : type === 'audio'
            ? `<audio class="te-drawer-preview" controls src="${TE.escape(m.url)}"></audio>`
            : `<div class="te-drawer-preview placeholder"><span class="te-media-glyph" aria-hidden="true">${TYPE_ICONS[type] || TYPE_ICONS.other}</span></div>`;
    const usage = Array.isArray(m.usage) ? m.usage : [];
    const usageHtml = usage.length
      ? `<ul class="te-drawer-usage">${usage.map((p) => `<li><a href="/editor.html?file=${encodeURIComponent(p)}">${TE.escape(p)}</a></li>`).join('')}</ul>`
      : '<p class="te-drawer-usage empty">Not referenced by any post.</p>';
    const dims = m.width && m.height ? `${m.width} × ${m.height} px` : '—';
    body.innerHTML = `
      ${preview}
      <h3 class="te-drawer-title">${TE.escape(m.original_name || m.filename)}</h3>
      <dl class="te-drawer-meta">
        <dt>Type</dt><dd>${TE.escape(type)} (${TE.escape(m.mime_type)})</dd>
        <dt>Size</dt><dd>${TE.escape(TE.fmtBytes(m.size))}</dd>
        <dt>Dimensions</dt><dd>${TE.escape(dims)}</dd>
        <dt>Hash</dt><dd><code>${TE.escape(m.hash_prefix)}…</code></dd>
        <dt>Uploaded</dt><dd>${TE.escape(new Date(m.uploaded_at).toISOString().slice(0, 19).replace('T', ' '))}</dd>
        <dt>Used in</dt><dd>${usageHtml}</dd>
      </dl>
      <div class="te-drawer-actions">
        <a class="btn" href="${TE.escape(m.url)}" download="${TE.escape(m.original_name || m.filename)}">Download original</a>
        <button type="button" class="btn danger" data-drawer-delete="${TE.escape(m.id)}">Delete</button>
      </div>
    `;
    const delBtn = body.querySelector('[data-drawer-delete]');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        try {
          await media.delete(m.id);
          TE.toast('File deleted.');
          closeDrawer();
          reload();
        } catch (err) {
          if (err.status === 409 && err.data && Array.isArray(err.data.posts)) {
            const ok = window.confirm(
              `${err.message}\n\nReferenced by:\n${err.data.posts.join('\n')}\n\nDelete anyway?`,
            );
            if (!ok) return;
            try {
              await media.delete(m.id, { force: true });
              TE.toast('File deleted (forced).');
              closeDrawer();
              reload();
            } catch (err2) {
              TE.toast(err2.message || 'Delete failed.', 'error');
            }
          } else {
            TE.toast(err.message || 'Delete failed.', 'error');
          }
        }
      });
    }
  }

  // ── Bulk delete ────────────────────────────────────────────
  async function bulkDelete() {
    if (!lib.selected.size) return;
    const ids = Array.from(lib.selected);
    const ok = window.confirm(`Delete ${ids.length} file${ids.length === 1 ? '' : 's'}?`);
    if (!ok) return;
    let okCount = 0;
    let forcedCount = 0;
    for (const id of ids) {
      try {
        await media.delete(id);
        okCount++;
      } catch (err) {
        if (err.status === 409) {
          const force = window.confirm(`${err.message}\n\nForce delete?`);
          if (force) {
            try {
              await media.delete(id, { force: true });
              forcedCount++;
            } catch (err2) {
              TE.toast(`Failed: ${err2.message}`, 'error');
            }
          }
        } else {
          TE.toast(`Failed: ${err.message}`, 'error');
        }
      }
    }
    TE.toast(`Deleted ${okCount + forcedCount} file${okCount + forcedCount === 1 ? '' : 's'}.`);
    lib.selected.clear();
    reload();
  }

  // ── View routing (hash-based) ──────────────────────────────
  function showMediaView() {
    const dash = $('view-dashboard');
    const mediaView = $('view-media');
    if (!mediaView) return;
    if (dash) dash.hidden = true;
    mediaView.hidden = false;
    const crumb = document.getElementById('crumb-section');
    if (crumb) crumb.textContent = 'Media';
    reload();
  }
  function showDashView() {
    const dash = $('view-dashboard');
    const mediaView = $('view-media');
    if (mediaView) mediaView.hidden = true;
    if (dash) dash.hidden = false;
    const crumb = document.getElementById('crumb-section');
    if (crumb) crumb.textContent = 'Dashboard';
  }

  function routeFromHash() {
    if (!$('view-media')) return; // legacy pages w/o the media view markup
    const hash = window.location.hash || '';
    if (hash.startsWith('#media')) showMediaView();
    else showDashView();
  }

  // ── Boot ───────────────────────────────────────────────────
  function bootLibrary() {
    if (!$('view-media')) return; // page doesn't include the library

    // Type filter chips
    document.querySelectorAll('[data-media-chip]').forEach((chip) => {
      chip.addEventListener('click', () => {
        lib.type = chip.getAttribute('data-media-chip') || 'all';
        reload();
      });
      chip.setAttribute('role', 'tab');
    });

    // Search
    const search = $('media-search');
    if (search) {
      let t = 0;
      search.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          lib.q = /** @type {HTMLInputElement} */ (search).value.trim();
          reload();
        }, 120);
      });
    }

    // Sort
    const sort = $('media-sort');
    if (sort) {
      sort.addEventListener('change', () => {
        lib.sort = /** @type {HTMLSelectElement} */ (sort).value;
        reload();
      });
    }

    // View toggle
    document.querySelectorAll('[data-media-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        lib.view = /** @type {'grid' | 'list'} */ (btn.getAttribute('data-media-view') || 'grid');
        document.querySelectorAll('[data-media-view]').forEach((b) => {
          b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
        });
        render();
      });
    });

    // Bulk select-all
    const selectAll = $('media-select-all');
    if (selectAll) {
      selectAll.addEventListener('change', (e) => {
        const checked = /** @type {HTMLInputElement} */ (e.currentTarget).checked;
        if (checked) {
          for (const m of lib.items) lib.selected.add(m.id);
        } else {
          lib.selected.clear();
        }
        render();
      });
    }

    // Bulk delete
    const bulkDel = $('media-bulk-delete');
    if (bulkDel) bulkDel.addEventListener('click', bulkDelete);

    // Drawer dismissal
    const closeBtn = $('media-drawer-close');
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const d = $('media-drawer');
        if (d && d.classList.contains('open')) closeDrawer();
      }
    });

    // Inline library upload (drop zone above the grid)
    const dz = $('media-library-dropzone');
    if (dz && window.TE.dropzone) {
      window.TE.dropzone(dz, {
        label: 'Drop files to upload, or click to choose',
        ariaLabel: 'Upload to library',
        multiple: true,
        onUpload: async (files) => {
          await media.upload(files);
          await reload();
          // After upload, images come back as status='processing'.
          // Trigger the poll so badges update without user intervention.
          schedulePoll();
        },
      });
    }

    // Sidebar dropzone (always-on, drag anywhere on page lights it up).
    // We mount on `document.body` so the user can drop anywhere — the
    // tray gives feedback. We don't want this on the editor page because
    // the editor's inline drop zone already covers that surface.
    if (window.TE.dropzone && !window.__teBodyDropzoneInstalled) {
      window.__teBodyDropzoneInstalled = true;
      window.TE.dropzone(document.body, {
        label: '',
        ariaLabel: 'Drop files to upload',
        multiple: true,
        pasteOnBody: true,
        onUpload: async (files) => {
          await media.upload(files);
          // If we're on the library page, refresh the grid.
          if ($('view-media') && !$('view-media').hidden) reload();
        },
      });
      document.body.classList.add('te-has-body-dropzone');
    }

    window.addEventListener('hashchange', routeFromHash);
    routeFromHash();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootLibrary);
  } else {
    bootLibrary();
  }

  // Phase 2 compat: editor.js still calls `TE.media.bindUploader(...)`.
  // Keep the legacy surface working by shimming it onto the new
  // upload pipeline. We don't show the legacy "recents" grid anymore —
  // editor.html's media sidebar will render via the new library list
  // call instead — but we don't want to break the contract during
  // Phase 4 → Phase 5 transition.
  media.bindUploader = function bindUploader(opts) {
    opts = opts || {};
    const dropzone =
      typeof opts.dropzone === 'string' ? document.getElementById(opts.dropzone) : opts.dropzone;
    const inputEl =
      typeof opts.input === 'string' ? document.getElementById(opts.input) : opts.input;
    const recentEl =
      typeof opts.recent === 'string' ? document.getElementById(opts.recent) : opts.recent;
    const onInsert = typeof opts.onInsert === 'function' ? opts.onInsert : () => {};

    async function refresh() {
      if (!recentEl) return;
      try {
        const data = await media.list({ type: 'image', limit: 9, sort: 'date' });
        const items = (data && data.items) || [];
        if (!items.length) {
          recentEl.innerHTML = `<div style="grid-column:1/-1;color:var(--fg-mute);font-size:11px;">No uploads yet.</div>`;
          return;
        }
        recentEl.innerHTML = items
          .map(
            (m) => `
            <button type="button" class="thumb" data-url="${TE.escape(m.url)}" data-filename="${TE.escape(m.filename)}"
                    style="background-image:url('${TE.escape(m.url)}'); border:1px solid var(--glass-border); padding:0;">
              <span class="badge" aria-hidden="true">${TE.escape((m.filename || '').split('.').pop().toUpperCase())}</span>
              <span class="sr-only">${TE.escape(m.original_name || m.filename)}</span>
            </button>`,
          )
          .join('');
        recentEl.querySelectorAll('.thumb').forEach((el) => {
          el.addEventListener('click', () => {
            onInsert({
              url: el.getAttribute('data-url'),
              filename: el.getAttribute('data-filename'),
            });
          });
        });
      } catch (err) {
        recentEl.innerHTML = `<div style="grid-column:1/-1;color:var(--fg-mute);font-size:11px;">${TE.escape(err.message || 'Failed to load media.')}</div>`;
      }
    }

    async function handleFiles(files) {
      const arr = Array.from(files || []);
      if (!arr.length) return;
      const { ok, failed } = await media.upload(arr);
      if (ok[0]) onInsert(ok[0]);
      if (failed.length) {
        TE.toast(failed.map((f) => f.error).join(' / '), 'error');
      }
      refresh();
    }

    if (dropzone && window.TE.dropzone) {
      window.TE.dropzone(dropzone, {
        label: 'Drop or click',
        multiple: true,
        onUpload: handleFiles,
      });
    }
    if (inputEl) {
      // Legacy callers also wire a separate file input. Keep that path
      // active so editor.js doesn't need to change in Phase 4.
      inputEl.addEventListener('change', () => {
        handleFiles(inputEl.files);
        inputEl.value = '';
      });
    }

    refresh();
    return { refresh };
  };
})();
