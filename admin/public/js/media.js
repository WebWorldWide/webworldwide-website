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

  // Maps a media bucket to an icons.js registry name; rendered to inline
  // SVG via window.TE.icon() at each call site through the typeIcon() helper.
  const TYPE_ICONS = {
    image: 'file_image',
    video: 'file_video',
    audio: 'file_audio',
    document: 'file_doc',
    archive: 'file_archive',
    other: 'file_other',
  };
  const typeIcon = (type) =>
    (window.TE.icon && window.TE.icon(TYPE_ICONS[type] || TYPE_ICONS.other)) || '';
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
   * Edit asset metadata: `alt_text` (string to set; null/'' clears) and/or
   * `original_name` (the friendly display label — the URL is unaffected).
   * Returns the updated, API-shaped record.
   *
   * @param {string} id
   * @param {{ alt_text?: string | null, original_name?: string }} fields
   * @returns {Promise<any>}
   */
  media.patch = function patchMedia(id, fields) {
    return TE.fetchJSON(`/api/media/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(fields),
    });
  };

  /**
   * Apply per-item edits to many assets in one call.
   *
   * @param {Array<{ id: string, alt_text?: string | null, original_name?: string }>} edits
   * @returns {Promise<{ updated: number, errors: any[] }>}
   */
  media.bulkEdit = function bulkEdit(edits) {
    return TE.fetchJSON('/api/media/bulk', {
      method: 'POST',
      body: JSON.stringify({ edits }),
    });
  };

  /**
   * True when an image's alt text is missing or is really a filename
   * (`image-19.webp`) — the states the library badges as needing alt.
   *
   * @param {{ alt_text?: string | null, filename?: string, original_name?: string }} m
   * @returns {boolean}
   */
  media.needsAlt = function needsAlt(m) {
    const a = String(m.alt_text || '').trim();
    if (!a) return true;
    if (/^[\w. ()-]+\.(webp|png|jpe?g|gif|svg|avif|bmp|ico)$/i.test(a)) return true;
    if (m.filename && a === m.filename) return true;
    if (m.original_name && a === m.original_name) return true;
    return false;
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
          <button type="button" class="te-upload-x" aria-label="Cancel upload">${window.TE.icon('close')}</button>
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
            cancelBtn.innerHTML = window.TE.icon('close');
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
    total: 0, // server's total match count (items is capped at 200)
    type: 'all',
    q: '',
    sort: 'date',
    used: 'all', // 'all' | 'in' | 'unused' — client-side usage filter
    selected: new Set(),
    view: 'grid',
  };

  /**
   * The items shown after the client-side type + usage filters. Shared by
   * the grid and select-all so they never disagree.
   * @returns {any[]}
   */
  function visibleItems() {
    return lib.items.filter((m) => {
      const type = m.type || classifyOnClient(m.mime_type);
      if (lib.type && lib.type !== 'all' && type !== lib.type) return false;
      if (lib.used === 'in') return isUsed(m);
      if (lib.used === 'unused') return !isUsed(m);
      return true;
    });
  }

  /**
   * True when a media record is referenced by at least one post.
   * @param {{ used_in?: any[] }} m
   * @returns {boolean}
   */
  function isUsed(m) {
    return Array.isArray(m.used_in) && m.used_in.length > 0;
  }

  function $(id) {
    return document.getElementById(id);
  }

  async function reload() {
    const grid = $('media-grid');
    if (grid) grid.setAttribute('aria-busy', 'true');
    try {
      // Fetch across ALL types (type filtering is applied client-side) so
      // the type-chip counts are accurate and switching type is instant.
      // The server still applies the text search; the 200 cap is surfaced
      // via lib.total below.
      const data = await media.list({ q: lib.q, sort: lib.sort, limit: 200 });
      lib.items = (data && data.items) || [];
      lib.total = data && typeof data.total === 'number' ? data.total : lib.items.length;
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
    // Type + usage filters are applied client-side (see visibleItems) so
    // the type-chip counts, which read the full lib.items, stay accurate.
    const visible = visibleItems();
    if (!visible.length) {
      grid.innerHTML = '';
      if (empty) {
        empty.hidden = false;
        empty.textContent =
          lib.q || lib.used !== 'all'
            ? 'No files match that filter.'
            : 'No uploads yet. Drop files anywhere to add them.';
      }
      return;
    }
    if (empty) empty.hidden = true;

    grid.classList.toggle('view-list', lib.view === 'list');
    grid.classList.toggle('view-grid', lib.view === 'grid');

    grid.innerHTML = visible
      .map((m) => {
        const type = m.type || classifyOnClient(m.mime_type);
        const sel = lib.selected.has(m.id);
        // Prefer the generated -thumb.webp over the full-res original so the
        // grid isn't downloading megapixel images to paint 120px tiles.
        const thumbSrc = (type === 'image' && m.conversions && m.conversions.thumb) || m.url;
        const thumb =
          type === 'image'
            ? `<img class="te-media-img" loading="lazy" decoding="async" src="${TE.escape(thumbSrc)}" alt="${TE.escape(m.original_name || m.filename)}" />`
            : `<span class="te-media-glyph" aria-hidden="true">${typeIcon(type)}</span>`;
        const subtitle = `${TE.escape(type.toUpperCase())} · ${TE.escape(TE.fmtBytes(m.size))}`;
        // "Used in" chip: one post → its (truncated) title; many → "N posts".
        const usedIn = Array.isArray(m.used_in) ? m.used_in : [];
        let postChip = '';
        if (usedIn.length === 1) {
          postChip = `<span class="te-media-post" title="${TE.escape(usedIn[0].title)}">${TE.escape(usedIn[0].title)}</span>`;
        } else if (usedIn.length > 1) {
          const titles = usedIn.map((p) => p.title).join('\n');
          postChip = `<span class="te-media-post" title="${TE.escape(titles)}">${usedIn.length} posts</span>`;
        }
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
        // Accessibility nudge: images with no usable alt text wear a
        // warning chip; the drawer is where alt gets written.
        if (type === 'image' && media.needsAlt(m)) {
          statusBadge += `<span class="te-media-status no-alt" title="No alt text — open details to add one" aria-label="No alt text">⚠ No alt</span>`;
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
            ${postChip}
          </div>
        </div>`;
      })
      .join('');

    // A broken/missing thumbnail degrades to the type glyph, not the
    // browser's broken-image icon (CSP-safe; no inline onerror).
    if (window.TE && TE.wireImgFallbacks) {
      TE.wireImgFallbacks(grid, '.te-media-img', () => {
        const span = document.createElement('span');
        span.className = 'te-media-glyph';
        span.setAttribute('aria-hidden', 'true');
        span.innerHTML = typeIcon('image');
        return span;
      });
    }

    // Surface the 200-item cap so a large library doesn't silently truncate.
    if (lib.total > lib.items.length) {
      grid.insertAdjacentHTML(
        'beforeend',
        `<div class="te-media-more" role="note">Showing the first ${lib.items.length} of ${lib.total} — refine the search to narrow the list.</div>`,
      );
    }

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

  // ── Usage filter (All / In posts / Unused) ─────────────────
  // Builds a small segmented control and drops it next to the search
  // input. Idempotent — won't double-mount if bootLibrary runs twice.
  function mountUsedFilter() {
    const toolbar = document.querySelector('.te-media-toolbar');
    if (!toolbar || document.getElementById('media-used-filter')) return;
    const opts = [
      { key: 'all', label: 'All' },
      { key: 'in', label: 'In posts' },
      { key: 'unused', label: 'Unused' },
    ];
    const group = document.createElement('div');
    group.id = 'media-used-filter';
    group.className = 'te-media-used-filter';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Filter by post usage');
    group.innerHTML = opts
      .map(
        (o) =>
          `<button type="button" data-used-filter="${o.key}" aria-pressed="${
            lib.used === o.key ? 'true' : 'false'
          }">${TE.escape(o.label)}</button>`,
      )
      .join('');
    group.querySelectorAll('[data-used-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        lib.used = btn.getAttribute('data-used-filter') || 'all';
        group.querySelectorAll('[data-used-filter]').forEach((b) => {
          b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
        });
        renderItems();
      });
    });
    // Sit right after the search input when present, else append.
    const search = document.getElementById('media-search');
    if (search && search.parentNode === toolbar && search.nextSibling) {
      toolbar.insertBefore(group, search.nextSibling);
    } else {
      toolbar.appendChild(group);
    }
  }

  // ── Detail drawer ──────────────────────────────────────────
  // Monotonic token so that if the user clicks several items quickly, only
  // the most recent fetch is allowed to render — earlier (slower) responses
  // are discarded instead of clobbering the drawer with stale data.
  let drawerSeq = 0;
  async function openDrawer(id) {
    const drawer = $('media-drawer');
    if (!drawer) return;
    const seq = ++drawerSeq;
    // Shared overlay open: focus into the drawer, trap Tab, inert the
    // background, restore focus to the opener on close.
    if (window.TE && TE.openDrawer) TE.openDrawer(drawer);
    else {
      drawer.classList.add('open');
      drawer.removeAttribute('aria-hidden');
      drawer.inert = false;
    }
    const body = $('media-drawer-body');
    if (body) body.innerHTML = '<p class="te-media-loading">Loading…</p>';
    try {
      const m = await media.get(id);
      if (seq !== drawerSeq) return; // a newer open superseded this one
      renderDrawer(m);
    } catch (err) {
      if (seq !== drawerSeq) return;
      if (body) body.innerHTML = `<p class="te-media-error">${TE.escape(err.message)}</p>`;
    }
  }

  function closeDrawer() {
    const drawer = $('media-drawer');
    if (!drawer) return;
    if (window.TE && TE.closeDrawer) {
      TE.closeDrawer(drawer);
      return;
    }
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.inert = true;
  }

  function renderDrawer(m) {
    const body = $('media-drawer-body');
    if (!body) return;
    const type = m.type || classifyOnClient(m.mime_type);
    const preview =
      type === 'image'
        ? `<img class="te-drawer-preview" src="${TE.escape(m.url)}" alt="${TE.escape(m.alt_text || m.original_name)}" />`
        : type === 'video'
          ? `<video class="te-drawer-preview" controls src="${TE.escape(m.url)}"></video>`
          : type === 'audio'
            ? `<audio class="te-drawer-preview" controls src="${TE.escape(m.url)}"></audio>`
            : `<div class="te-drawer-preview placeholder"><span class="te-media-glyph" aria-hidden="true">${typeIcon(type)}</span></div>`;
    // Prefer the richer `used_in` (filename + post title); fall back to the
    // legacy `usage` (filenames only) for older API responses.
    const usedIn = Array.isArray(m.used_in)
      ? m.used_in
      : Array.isArray(m.usage)
        ? m.usage.map((f) => ({ filename: f, title: f }))
        : [];
    const usageHtml = usedIn.length
      ? `<ul class="te-drawer-usage">${usedIn
          .map(
            (p) =>
              `<li><a href="/editor.html?file=${encodeURIComponent(p.filename)}">${TE.escape(p.title || p.filename)}</a></li>`,
          )
          .join('')}</ul>`
      : '<p class="te-drawer-usage empty">Not referenced by any post.</p>';
    const dims = m.width && m.height ? `${m.width} × ${m.height} px` : '—';
    const isImage = type === 'image';
    // Editable details: the friendly name (original_name — a label; the URL
    // is unaffected) for every asset, plus alt text for images.
    const editSection = `
      <div class="te-drawer-alt">
        <label class="te-drawer-alt-label" for="drawer-name-input">Name</label>
        <input id="drawer-name-input" class="te-drawer-name-input" type="text" maxlength="200"
          value="${TE.escape(m.original_name || m.filename)}" />
        ${
          isImage
            ? `<label class="te-drawer-alt-label" for="drawer-alt-input">Alt text</label>
        <textarea id="drawer-alt-input" class="te-drawer-alt-input" rows="3" maxlength="1000"
          placeholder="Describe this image for screen readers…">${TE.escape(m.alt_text || '')}</textarea>
        <div class="te-drawer-alt-row">
          <span class="te-drawer-alt-hint">${media.needsAlt(m) ? '⚠ Images without alt text are invisible to screen readers.' : ''}</span>
        </div>`
            : ''
        }
        <div class="te-drawer-alt-row">
          <span></span>
          <button type="button" class="btn" data-drawer-save="${TE.escape(m.id)}">Save details</button>
        </div>
      </div>`;
    body.innerHTML = `
      ${preview}
      <h3 class="te-drawer-title">${TE.escape(m.original_name || m.filename)}</h3>
      ${editSection}
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
        ${usedIn.length ? '' : '<span class="te-drawer-unused" role="note">Not used in any post</span>'}
      </div>
    `;
    const saveBtn = body.querySelector('[data-drawer-save]');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const nameInput = /** @type {HTMLInputElement} */ (
          body.querySelector('#drawer-name-input')
        );
        const altInput = /** @type {HTMLTextAreaElement | null} */ (
          body.querySelector('#drawer-alt-input')
        );
        const fields = {};
        const newName = (nameInput?.value || '').trim();
        if (newName && newName !== (m.original_name || '')) fields.original_name = newName;
        if (altInput) fields.alt_text = altInput.value;
        if (!Object.keys(fields).length) {
          TE.toast('Nothing changed.');
          return;
        }
        saveBtn.setAttribute('disabled', 'true');
        try {
          const updated = await media.patch(m.id, fields);
          TE.toast('Details saved.');
          // Keep the local list copy in sync so the grid refreshes.
          const item = lib.items.find((i) => i.id === m.id);
          if (item) {
            item.alt_text = updated.alt_text;
            item.original_name = updated.original_name;
          }
          renderItems();
          const titleEl = body.querySelector('.te-drawer-title');
          if (titleEl) titleEl.textContent = updated.original_name || updated.filename;
        } catch (err) {
          TE.toast(err.message || 'Could not save details.', 'error');
        } finally {
          saveBtn.removeAttribute('disabled');
        }
      });
    }
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

  // ── Bulk edit (name + alt for many at once) ────────────────
  function buildBulkModal() {
    let m = document.getElementById('media-bulk-modal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'media-bulk-modal';
    m.className = 'modal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-labelledby', 'media-bulk-modal-title');
    m.setAttribute('aria-hidden', 'true');
    m.innerHTML =
      '<div class="modal-card te-media-bulk-card">' +
      '<div class="modal-head"><h3 id="media-bulk-modal-title">Edit details</h3>' +
      '<button type="button" class="btn ghost" data-modal-close="media-bulk-modal" aria-label="Close">' +
      '<span class="ico" aria-hidden="true" data-icon="close"></span></button></div>' +
      '<div class="modal-body"><div id="media-bulk-rows" class="te-media-bulk-rows"></div></div>' +
      '<div class="modal-foot"><button type="button" class="btn ghost" data-modal-close="media-bulk-modal">Cancel</button>' +
      '<button type="button" class="btn solid" id="media-bulk-save">Save all</button></div>' +
      '</div>';
    document.body.appendChild(m);
    m.querySelector('#media-bulk-save').addEventListener('click', saveBulkEdit);
    return m;
  }

  function openBulkEdit() {
    if (!lib.selected.size) return;
    const items = lib.items.filter((i) => lib.selected.has(i.id));
    const modal = buildBulkModal();
    const rowsHost = modal.querySelector('#media-bulk-rows');
    rowsHost.innerHTML = items
      .map((m) => {
        const type = m.type || classifyOnClient(m.mime_type);
        const thumbSrc = (type === 'image' && m.conversions && m.conversions.thumb) || m.url;
        const thumb =
          type === 'image'
            ? `<img class="te-media-bulk-thumb" src="${TE.escape(thumbSrc)}" alt="" loading="lazy" />`
            : `<span class="te-media-bulk-thumb placeholder" aria-hidden="true">${typeIcon(type)}</span>`;
        const altField =
          type === 'image'
            ? `<input class="te-media-bulk-alt" data-bulk-alt="${TE.escape(m.id)}" type="text" maxlength="1000"
                 placeholder="Alt text…" value="${TE.escape(m.alt_text || '')}" />`
            : '';
        return `<div class="te-media-bulk-row">
          ${thumb}
          <div class="te-media-bulk-fields">
            <input class="te-media-bulk-name" data-bulk-name="${TE.escape(m.id)}" type="text" maxlength="200"
              placeholder="Name…" value="${TE.escape(m.original_name || m.filename)}" />
            ${altField}
          </div>
        </div>`;
      })
      .join('');
    if (typeof TE.wireImgFallbacks === 'function') {
      try {
        TE.wireImgFallbacks(rowsHost);
      } catch (_) {
        /* cosmetic */
      }
    }
    TE.openModal('media-bulk-modal');
  }

  async function saveBulkEdit() {
    const modal = document.getElementById('media-bulk-modal');
    if (!modal) return;
    const edits = [];
    modal.querySelectorAll('[data-bulk-name]').forEach((el) => {
      const id = el.getAttribute('data-bulk-name');
      const item = lib.items.find((i) => i.id === id);
      if (!item) return;
      const fields = { id };
      const newName = String(el.value || '').trim();
      if (newName && newName !== (item.original_name || '')) fields.original_name = newName;
      const altEl = modal.querySelector(`[data-bulk-alt="${CSS.escape(id)}"]`);
      if (altEl && altEl.value !== (item.alt_text || '')) fields.alt_text = altEl.value;
      if (Object.keys(fields).length > 1) edits.push(fields);
    });
    if (!edits.length) {
      TE.toast('Nothing changed.');
      TE.closeModal('media-bulk-modal');
      return;
    }
    const saveBtn = document.getElementById('media-bulk-save');
    if (saveBtn) saveBtn.setAttribute('disabled', 'true');
    try {
      const res = await media.bulkEdit(edits);
      TE.toast(
        `Updated ${res.updated} file${res.updated === 1 ? '' : 's'}` +
          (res.errors && res.errors.length ? ` (${res.errors.length} failed)` : '') +
          '.',
      );
      TE.closeModal('media-bulk-modal');
      lib.selected.clear();
      reload();
    } catch (err) {
      TE.toast(err.message || 'Bulk edit failed.', 'error');
    } finally {
      if (saveBtn) saveBtn.removeAttribute('disabled');
    }
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
        // Type filtering is client-side now — re-render, don't refetch.
        render();
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

    // Usage filter pills (All / In posts / Unused). Injected here rather
    // than in the static markup so the whole feature lives in this file.
    // Filtering is client-side (over the loaded page) so it re-renders
    // without a round-trip.
    mountUsedFilter();

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
          // Only the items actually visible under the current type/usage
          // filters — never silently select rows the user can't see.
          for (const m of visibleItems()) lib.selected.add(m.id);
        } else {
          lib.selected.clear();
        }
        render();
      });
    }

    // Bulk delete
    const bulkDel = $('media-bulk-delete');
    if (bulkDel) bulkDel.addEventListener('click', bulkDelete);
    const bulkEdit = $('media-bulk-edit');
    if (bulkEdit) bulkEdit.addEventListener('click', openBulkEdit);

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
            (m, i) => `
            <button type="button" class="thumb" data-idx="${i}" data-url="${TE.escape(m.url)}" data-filename="${TE.escape(m.filename)}"
                    style="background-image:url('${TE.escape(m.url)}'); border:1px solid var(--glass-border); padding:0;">
              <span class="badge" aria-hidden="true">${TE.escape((m.filename || '').split('.').pop().toUpperCase())}</span>
              <span class="sr-only">${TE.escape(m.alt_text || m.original_name || m.filename)}</span>
            </button>`,
          )
          .join('');
        recentEl.querySelectorAll('.thumb').forEach((el) => {
          el.addEventListener('click', () => {
            // Hand the FULL library record to the insert callback —
            // editor.js needs id/alt_text/type, not just the URL.
            const m = items[Number(el.getAttribute('data-idx'))];
            onInsert(
              m || {
                url: el.getAttribute('data-url'),
                filename: el.getAttribute('data-filename'),
              },
            );
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
