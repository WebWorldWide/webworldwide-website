// @ts-check
/**
 * editor.js — page-level wiring for the admin post editor.
 *
 * Phase 3a swaps Phase 2's plain `<textarea id="editor-fallback">` for a
 * TipTap + CodeMirror bundle (admin/public/js/editor.bundle.js). The
 * bundle attaches `window.TEEditor.mount(rootEl, markdown, options)`
 * which returns a textarea-compatible façade:
 *
 *   bodyEl.value (get/set Markdown)
 *   bodyEl.addEventListener('input', fn)
 *   bodyEl.selectionStart / .selectionEnd
 *   bodyEl.setMode('wysiwyg' | 'source')
 *   bodyEl.focus()
 *   bodyEl.destroy()
 *
 * We mount once on boot and hold onto the instance. If the bundle fails
 * to load (e.g., offline dev with no build, network blip), we fall back
 * to the pre-rendered `<textarea id="editor-fallback">` so the page
 * still works.
 *
 * Backend (unchanged):
 *   GET    /api/posts             → list
 *   GET    /api/posts/:filename   → { data, content }
 *   POST   /api/posts             → create
 *   PUT    /api/posts/:filename   → update
 *   DELETE /api/posts/:filename
 *   POST   /api/publish
 *   GET/POST/DELETE /api/media…   (via window.TE.media)
 */
(function () {
  if (!/\/editor(\.html)?$/.test(window.location.pathname)) return;

  // ── DOM refs ──────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const titleEl = $('post-title');
  const slugEl = $('post-slug');
  const dateEl = $('post-date');
  const draftEl = $('post-draft');
  const descEl = $('post-desc');
  const editorRoot = $('editor-root');
  // Phase 3a: `bodyEl` is the façade returned by the bundle's mount().
  // It quacks like the old <textarea> so the rest of this file (and
  // media.bindUploader) keeps working unchanged.
  let bodyEl = $('editor-fallback');
  const btnSave = $('btn-save');
  const btnSave2 = $('btn-save-2');
  const btnPub = $('btn-publish');
  const btnPub2 = $('btn-publish-2');
  const btnDel = $('btn-delete');
  const savedTxt = $('ed-saved-text');
  const statusPill = $('ed-status-pill');
  const wordsTop = $('editor-words');
  const wordsFoot = $('foot-words');
  const wordsSide = $('editor-side-words');
  const charsFoot = $('foot-chars');
  const readTop = $('editor-read');
  const readFoot = $('foot-read');
  const readSide = $('editor-side-read');
  const sideStatus = $('editor-side-status');
  const crumbEditor = $('crumb-editor');
  const spTitle = $('sp-title');
  const spDesc = $('sp-desc');
  const fileFoot = $('foot-file');
  // Phase 3d: autosave status pip in the editor status bar + the
  // existing "Saved/Unsaved/Saving…/Error saving" text used in the
  // top bar and editor head.
  const autoEl = $('autosave-indicator');
  const autoTxt = $('autosave-text');
  // Phase 3d: SEO preview panel (right-side aux column). All four
  // elements are present in editor.html; refs may be null in test envs
  // that mount editor.js outside the production HTML shell.
  const serpDomain = $('serp-domain');
  const serpSlug = $('serp-slug');
  const serpTitle = $('serp-title');
  const serpDesc = $('serp-desc');
  const seoTitleLen = $('seo-title-len');
  const seoDescLen = $('seo-desc-len');
  const seoTitleBar = $('seo-title-bar');
  const seoDescBar = $('seo-desc-bar');
  // Phase 3d: panel toggles (TOC + SEO).
  const btnTocToggle = $('btn-toc-toggle');
  const btnSeoToggle = $('btn-seo-toggle');
  const tocPanel = $('ed-toc-panel');
  const seoPanel = $('ed-seo-panel');
  const tocCloseBtn = $('ed-toc-close');
  const seoCloseBtn = $('ed-seo-close');
  const edLayout = document.querySelector('.editor-layout');

  const urlParams = new URLSearchParams(window.location.search);
  // Accept either `?file=` (legacy) or `?slug=` (Phase 2 plan)
  let currentFile =
    urlParams.get('file') || (urlParams.get('slug') ? `${urlParams.get('slug')}.md` : null);

  // Optimistic-concurrency token: the file mtime we loaded/last saved. Sent
  // back on save so the server can 409 rather than clobber a newer copy.
  let loadedMtime = null;

  let isDirty = false;
  let autosaveTimer = null;
  // Set when the initial load failed: the editor stays bound to currentFile
  // but with blank fields, so saving must be blocked until a reload.
  let loadFailed = false;
  // In-flight save lock so autosave can't overlap a manual save (false 409
  // / double-create) — savePost early-returns while one is running.
  let saving = false;

  // Warn the user before navigating away with unsaved edits.
  window.addEventListener('beforeunload', (e) => {
    if (!isDirty) return;
    e.preventDefault();
    // Modern browsers ignore the message, but Chrome still needs this set.
    e.returnValue = '';
  });

  // ── Helpers ──────────────────────────────────────────────
  function setSaved(text) {
    if (savedTxt) savedTxt.textContent = text || '';
  }
  function updateStatusPill() {
    if (!statusPill) return;
    const isDraft = draftEl?.value === 'true';
    statusPill.textContent = isDraft ? 'DRAFT' : 'PUBLISHED';
    statusPill.classList.toggle('pub', !isDraft);
    if (sideStatus) sideStatus.textContent = isDraft ? 'Draft' : 'Published';
  }

  // Phase 3d: reading-time formula bumped from 200 → 250 wpm (industry
  // standard for prose-style content). Status bar also surfaces a
  // character count alongside the existing word count.
  function computeMetrics() {
    // Prefer the live TipTap textContent if available — strips
    // Markdown punctuation we don't want to count as words.
    const tipText =
      bodyEl && bodyEl._tiptap && bodyEl._tiptap.state
        ? bodyEl._tiptap.state.doc.textContent
        : null;
    const text = (tipText !== null ? tipText : bodyEl?.value || '').trim();
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
    const chars = text ? text.length : 0;
    const charsNoSpace = text ? text.replace(/\s+/g, '').length : 0;
    const mins = words ? Math.max(1, Math.round(words / 250)) : 0;
    return { words, chars, charsNoSpace, mins };
  }

  // Phase 3d: throttle metric updates via rAF — large pastes can fire
  // dozens of input events per frame.
  let metricsFrame = null;
  function updateMetrics() {
    if (metricsFrame) return;
    const requestFrame =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb) => setTimeout(cb, 16);
    metricsFrame = requestFrame(() => {
      metricsFrame = null;
      const { words, chars, mins } = computeMetrics();
      const wText = `${words.toLocaleString()} word${words === 1 ? '' : 's'}`;
      const rText = `${mins} min`;
      if (wordsTop) wordsTop.textContent = wText;
      if (wordsFoot) wordsFoot.textContent = words.toLocaleString();
      if (wordsSide) wordsSide.textContent = words.toLocaleString();
      if (charsFoot) charsFoot.textContent = chars.toLocaleString();
      if (readTop) readTop.textContent = rText;
      if (readFoot) readFoot.textContent = mins.toString() + ' min';
      if (readSide) readSide.textContent = rText;
      updateSeoPreview();
    });
  }

  function updateSocialPreview() {
    if (spTitle) spTitle.textContent = (titleEl?.value || '').trim() || 'Post title';
    if (spDesc) spDesc.textContent = (descEl?.value || '').trim() || 'Description appears here…';
  }

  // Phase 3d: SEO preview (Google SERP snippet shape). Falls back to
  // the first 160 chars of body text when the meta description is empty.
  function siteDomain() {
    // Hard-coded for now — Phase 9 will surface a per-site config.
    return 'webworldwide.online';
  }
  function updateSeoPreview() {
    const title = (titleEl?.value || '').trim();
    const slug = (slugEl?.value || '').trim() || 'post-slug';
    let desc = (descEl?.value || '').trim();
    if (!desc) {
      const tipText =
        bodyEl && bodyEl._tiptap && bodyEl._tiptap.state
          ? bodyEl._tiptap.state.doc.textContent
          : bodyEl?.value || '';
      desc = String(tipText || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
    }
    const displayTitle = title || 'Untitled post';
    const displayDesc = desc || 'Description appears here.';
    if (serpDomain) serpDomain.textContent = siteDomain();
    // Posts publish under /blog/<slug>/ — mirror the real URL path.
    if (serpSlug) serpSlug.textContent = `blog › ${slug}`;
    if (serpTitle) serpTitle.textContent = displayTitle;
    if (serpDesc) {
      // Truncate at 160 chars per Google's common limit.
      serpDesc.textContent =
        displayDesc.length > 160 ? displayDesc.slice(0, 157) + '…' : displayDesc;
    }
    if (seoTitleLen) seoTitleLen.textContent = String(displayTitle.length);
    if (seoDescLen) seoDescLen.textContent = String(displayDesc.length);
    if (seoTitleBar) {
      const pct = Math.min(100, Math.round((displayTitle.length / 60) * 100));
      seoTitleBar.style.width = pct + '%';
      seoTitleBar.parentElement?.classList?.toggle('is-over', displayTitle.length > 60);
    }
    if (seoDescBar) {
      const pct = Math.min(100, Math.round((displayDesc.length / 160) * 100));
      seoDescBar.style.width = pct + '%';
      seoDescBar.parentElement?.classList?.toggle('is-over', displayDesc.length > 160);
    }
  }

  // ── Phase 3d: autosave status pip ─────────────────────────
  //
  // Four states map to the four colours/visuals in editor.css:
  //
  //   idle  → "Ready"          (subtle, default)
  //   dirty → "Unsaved changes" (warning tint)
  //   saving → "Saving…"        (spinner)
  //   saved → "Saved"           (accent; fades back to idle after 2s)
  //   error → "Error saving"    (danger; clickable to retry)
  //
  // We also keep the top-bar `setSaved()` text in sync for the existing
  // aria-live region so screen readers always announce the same state
  // regardless of which surface they're tracking.
  let savedFadeTimer = null;
  function setAutoState(stateName, msg) {
    if (!autoEl) return;
    if (savedFadeTimer) {
      clearTimeout(savedFadeTimer);
      savedFadeTimer = null;
    }
    autoEl.dataset.state = stateName;
    if (autoTxt) autoTxt.textContent = msg || stateName;
    // Announce terminal states via the dedicated aria-live region (the pip
    // text changes too often — Saving…/dirty — to announce every flip).
    const live = $('save-status');
    if (live && (stateName === 'saved' || stateName === 'error')) {
      live.textContent = msg || stateName;
    }
    if (stateName === 'error') {
      autoEl.setAttribute('role', 'button');
      autoEl.setAttribute('tabindex', '0');
      autoEl.title = 'Click to retry saving';
    } else {
      autoEl.removeAttribute('role');
      autoEl.removeAttribute('tabindex');
      autoEl.removeAttribute('title');
    }
    if (stateName === 'saved') {
      savedFadeTimer = setTimeout(() => {
        if (!isDirty && autoEl.dataset.state === 'saved') {
          autoEl.dataset.state = 'idle';
          if (autoTxt) autoTxt.textContent = 'Saved';
        }
      }, 2000);
    }
  }
  function slugify(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)+/g, '');
  }

  // ── Live slug validation ──────────────────────────────────
  // Catch a taken/invalid slug AS the writer types, not at save time — the
  // server still guards (409 slug_taken), but a quiet inline hint is far
  // friendlier than a failed save.
  let slugCheckTimer = null;
  function setSlugMsg(text, kind) {
    const el = $('slug-msg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'ed-slug-msg' + (text ? ` ${kind || 'warn'}` : '');
  }
  async function checkSlug() {
    const raw = (slugEl?.value || '').trim();
    if (!raw) {
      // Empty is fine — save derives the slug from the title.
      setSlugMsg('');
      return;
    }
    if (raw !== slugify(raw)) {
      setSlugMsg('Use lowercase letters, numbers and hyphens only.', 'warn');
      return;
    }
    try {
      const posts = await TE.fetchJSON('/api/posts');
      // A clash is any OTHER post (not the one we're editing) using this slug.
      const clash = posts.find((p) => p.slug === raw && p.filename !== currentFile);
      if (clash) {
        setSlugMsg(`Already used by “${clash.title || clash.slug}”. Pick another.`, 'err');
      } else {
        setSlugMsg('Available', 'ok');
      }
    } catch {
      setSlugMsg('');
    }
  }
  function scheduleSlugCheck() {
    clearTimeout(slugCheckTimer);
    slugCheckTimer = setTimeout(checkSlug, 350);
  }

  // Count images in the markdown body that ship without alt text — empty
  // `![](url)` and `<img>` tags whose alt is missing/blank. Used to warn
  // before publishing (bad for screen readers AND SEO).
  function imagesMissingAlt(md) {
    const text = String(md || '');
    let n = 0;
    // Markdown images: ![alt](url) — alt is the bit between ! [ and ].
    const mdImg = /!\[([^\]]*)\]\([^)]*\)/g;
    let m;
    while ((m = mdImg.exec(text)) !== null) {
      if (!m[1].trim()) n += 1;
    }
    // Raw <img …> tags: flag when there's no non-empty alt. Handle double-,
    // single-, and unquoted alt values so we don't over-count an image that
    // actually has alt text written in another quoting style.
    const htmlImg = /<img\b[^>]*>/gi;
    while ((m = htmlImg.exec(text)) !== null) {
      const alt = /\balt\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/i.exec(m[0]);
      const val = alt ? (alt[2] ?? alt[3] ?? alt[4] ?? '') : '';
      if (!val.trim()) n += 1;
    }
    return n;
  }
  function markDirty() {
    isDirty = true;
    setSaved('Unsaved changes');
    setAutoState('dirty', 'Unsaved changes');
    if (editorRoot) {
      editorRoot.dispatchEvent(new CustomEvent('autosave-dirty', { bubbles: true }));
    }
    scheduleAutosave();
  }
  function setCurrentFile(filename) {
    currentFile = filename;
    if (filename) {
      const u = new URL(window.location);
      u.searchParams.set('file', filename);
      window.history.replaceState({}, '', u);
      if (btnDel) btnDel.style.display = '';
      if (fileFoot) fileFoot.textContent = filename;
    } else {
      if (btnDel) btnDel.style.display = 'none';
      if (fileFoot) fileFoot.textContent = '';
    }
    if (crumbEditor) crumbEditor.textContent = filename || 'New post';
  }

  // ── Load series names into <datalist> for autocomplete ────
  async function loadSeriesSuggestions() {
    try {
      const posts = await TE.fetchJSON('/api/posts');
      const seriesSet = new Set();
      (posts || []).forEach((p) => {
        if (p.series) seriesSet.add(p.series);
      });
      const seriesDataList = $('series-suggestions');
      if (seriesDataList) {
        seriesDataList.innerHTML = Array.from(seriesSet)
          .sort()
          .map((s) => `<option value="${TE.escape(s)}">`)
          .join('');
      }
    } catch (_) {
      /* non-fatal */
    }
  }

  // Phase 5e: preview-link button
  async function generatePreviewLink() {
    if (!currentFile) {
      TE.toast('Save the post first.', 'warn');
      return;
    }
    const btn = $('btn-preview-link');
    const out = $('preview-link-out');
    if (btn) btn.disabled = true;
    try {
      const res = await TE.fetchJSON(`/api/posts/${encodeURIComponent(currentFile)}/preview`, {
        method: 'POST',
        body: '{}',
      });
      if (out) {
        out.value = res.url || '';
        out.select?.();
      }
      try {
        await navigator.clipboard.writeText(res.url || '');
        TE.toast('Preview link copied.');
      } catch (_) {
        TE.toast('Preview link generated.');
      }
    } catch (err) {
      TE.toast(err.message || 'Preview failed.', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // Phase 5e: pick a cover image from the media library (simple prompt
  // fallback when the modal picker isn't wired). Future iterations can
  // replace this with the full media library modal.
  // ── Visual image picker (cover image) ─────────────────────
  // A real thumbnail grid with search, replacing the old "type a number"
  // prompt. `onChoose(mediaItem)` fires when a tile is clicked.
  let imgPickOnChoose = null;
  let imgPickTimer = null;
  // Sequence guard: a slow earlier search must not overwrite a newer one.
  let imgPickSeq = 0;

  async function loadImgPickerGrid(q) {
    const grid = $('imgpick-grid');
    if (!grid) return;
    const seq = ++imgPickSeq;
    try {
      const qs = new URLSearchParams({ type: 'image', limit: '60' });
      if (q) qs.set('q', q);
      const list = await TE.fetchJSON('/api/media?' + qs.toString());
      if (seq !== imgPickSeq) return; // superseded by a newer query
      const items = list.items || [];
      if (!items.length) {
        grid.innerHTML = `<p class="te-history-hint">${q ? 'No images match.' : 'No images in the library yet.'}</p>`;
        return;
      }
      grid.innerHTML = '';
      items.forEach((m) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'te-imgpick-item';
        btn.setAttribute('role', 'option');
        btn.title = m.original_name || m.filename || '';
        btn.innerHTML =
          `<img src="${TE.escape(m.url || '')}" alt="" loading="lazy" decoding="async" />` +
          `<span class="te-imgpick-name">${TE.escape(m.original_name || m.filename || '')}</span>`;
        btn.addEventListener('click', () => {
          if (imgPickOnChoose) imgPickOnChoose(m);
          TE.closeModal('image-picker-modal');
        });
        grid.appendChild(btn);
      });
    } catch (_err) {
      if (seq === imgPickSeq)
        grid.innerHTML = '<p class="te-history-hint">Couldn’t load images.</p>';
    }
  }

  function openImagePicker(onChoose) {
    imgPickOnChoose = onChoose;
    const search = $('imgpick-search');
    const grid = $('imgpick-grid');
    if (search) {
      search.value = '';
      search.oninput = () => {
        clearTimeout(imgPickTimer);
        imgPickTimer = setTimeout(() => loadImgPickerGrid(search.value.trim()), 250);
      };
    }
    if (grid)
      grid.innerHTML = '<p class="te-history-hint"><span class="te-spinner"></span> Loading…</p>';
    TE.openModal('image-picker-modal');
    loadImgPickerGrid('');
  }

  function pickCover() {
    openImagePicker((m) => {
      const coverEl = $('post-cover');
      const altEl = $('post-cover-alt');
      if (coverEl) coverEl.value = m.url || '';
      // Prefill only from real library alt text — never the filename (an
      // empty field + placeholder beats a filename-alt shipping).
      if (altEl && !altEl.value) altEl.value = m.alt_text || '';
      updateCoverPreview();
      markDirty();
    });
  }

  // Phase 5e: load a template into a fresh editor when ?template=name.
  async function maybeLoadTemplate() {
    const t = urlParams.get('template');
    if (!t || currentFile) return;
    try {
      const res = await fetch(`/api/templates/${encodeURIComponent(t)}.md`, {
        credentials: 'same-origin',
      });
      if (!res.ok) return;
      const raw = await res.text();
      const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      if (m) {
        // Skip front-matter (template's placeholder), keep body
        bodyEl.value = m[2] || '';
      } else {
        bodyEl.value = raw;
      }
      updateMetrics();
      markDirty();
    } catch (_) {
      /* template missing — leave body blank */
    }
  }

  // Populate every editor field + the body from a {data, content} pair.
  // Shared by loadPost (fresh GET) and the revision-history restore so
  // both render identically.
  function populateFields(data, content, filename) {
    titleEl.value = data.title || '';
    slugEl.value = data.slug || (filename ? filename.replace(/\.md$/, '') : '');
    draftEl.value = data.draft ? 'true' : 'false';
    // The blog reads frontmatter `excerpt` for the hook line + SEO description.
    descEl.value = data.excerpt || '';
    if (data.date) {
      const d = new Date(data.date);
      // Adjust for local TZ so the datetime-local input shows the same
      // wall-clock time the user expects.
      d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
      dateEl.value = d.toISOString().slice(0, 16);
    }
    // Phase 5e additions
    setExtraFields(data);
    bodyEl.value = content || '';
    updateMetrics();
    updateSocialPreview();
    updateSeoPreview();
    updateStatusPill();
  }

  // ── Load existing post ────────────────────────────────────
  async function loadPost(filename) {
    try {
      const { data, content, mtime } = await TE.fetchJSON(
        `/api/posts/${encodeURIComponent(filename)}`,
      );
      loadedMtime = typeof mtime === 'number' ? mtime : null;
      populateFields(data, content, filename);
      setCurrentFile(filename);
      isDirty = false;
      loadFailed = false;
      setSaved('Saved');
      setAutoState('saved', 'Saved');
    } catch (err) {
      // The load failed but the editor is still bound to `filename` with
      // blank fields. Saving now would PUT empty content over the real post
      // — and without a baseMtime token would bypass the conflict guard.
      // Lock saving + autosave until a successful reload; the error pip
      // re-loads (not saves).
      loadFailed = true;
      clearTimeout(autosaveTimer);
      setAutoState('error', 'Couldn’t load — click to retry');
      TE.toast(err.message || 'Failed to load post.', 'error');
    }
  }

  // ── Revision history ──────────────────────────────────────
  // Git-published versions + recent local pre-save snapshots. Selecting a
  // row previews it; Restore loads it into the editor as unsaved changes
  // (the writer reviews and saves — never a silent server-side overwrite).
  let selectedVersion = null;

  function histWhen(v) {
    if (typeof v === 'number') {
      const secs = Math.max(1, Math.round((Date.now() - v) / 1000));
      if (secs < 60) return `${secs}s ago`;
      const mins = Math.round(secs / 60);
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.round(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      return new Date(v).toLocaleDateString();
    }
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
  }

  async function openHistory() {
    if (!currentFile) {
      TE.toast('Save the post first — history appears once it has versions.', 'warn');
      return;
    }
    const listEl = $('history-list');
    const previewEl = $('history-preview');
    const restoreBtn = $('history-restore');
    selectedVersion = null;
    if (restoreBtn) restoreBtn.disabled = true;
    if (previewEl)
      previewEl.innerHTML = '<p class="te-history-hint">Select a version to preview it here.</p>';
    if (listEl)
      listEl.innerHTML =
        '<li class="te-history-empty"><span class="te-spinner"></span> Loading…</li>';
    TE.openModal('history-modal');
    let hist;
    try {
      hist = await TE.fetchJSON(`/api/posts/${encodeURIComponent(currentFile)}/history`);
    } catch (_err) {
      if (listEl) listEl.innerHTML = '<li class="te-history-empty">Couldn’t load history.</li>';
      return;
    }
    const rows = [];
    for (const s of hist.snapshots || []) {
      rows.push({
        source: 'snapshot',
        ref: s.id,
        kind: 'Autosave',
        label: s.title || currentFile,
        when: s.ts,
      });
    }
    for (const c of hist.git || []) {
      rows.push({
        source: 'git',
        ref: c.hash,
        kind: 'Published',
        label: c.message || c.hash.slice(0, 7),
        when: c.date,
      });
    }
    if (!rows.length) {
      if (listEl)
        listEl.innerHTML =
          '<li class="te-history-empty">No earlier versions yet — they appear here after you save or publish.</li>';
      return;
    }
    if (!listEl) return;
    listEl.innerHTML = '';
    rows.forEach((r) => {
      const li = document.createElement('li');
      li.className = 'te-history-row';
      li.setAttribute('role', 'button');
      li.tabIndex = 0;
      li.innerHTML =
        `<span class="te-history-kind k-${r.source}">${TE.escape(r.kind)}</span>` +
        `<span class="te-history-label">${TE.escape(r.label)}</span>` +
        `<span class="te-history-when">${TE.escape(histWhen(r.when))}</span>`;
      const choose = () => selectVersion(r, li);
      li.addEventListener('click', choose);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          choose();
        }
      });
      listEl.appendChild(li);
    });
  }

  let versionReqSeq = 0;
  async function selectVersion(r, li) {
    const previewEl = $('history-preview');
    const restoreBtn = $('history-restore');
    const listEl = $('history-list');
    if (listEl)
      listEl.querySelectorAll('.te-history-row').forEach((n) => n.classList.remove('active'));
    li.classList.add('active');
    if (previewEl) previewEl.innerHTML = '<p class="te-history-hint">Loading…</p>';
    if (restoreBtn) restoreBtn.disabled = true;
    // Guard against out-of-order responses: rapidly clicking rows could let
    // a slow earlier fetch overwrite a newer selection's preview/restore.
    const seq = ++versionReqSeq;
    try {
      const ver = await TE.fetchJSON(
        `/api/posts/${encodeURIComponent(currentFile)}/version/${r.source}/${encodeURIComponent(r.ref)}`,
      );
      if (seq !== versionReqSeq) return; // a newer selection superseded this one
      selectedVersion = { ...r, data: ver.data || {}, content: ver.content || '' };
      const title = (ver.data && ver.data.title) || '(untitled)';
      if (previewEl) {
        previewEl.innerHTML =
          `<h4 class="te-history-ptitle">${TE.escape(title)}</h4>` +
          `<pre class="te-history-pbody">${TE.escape(ver.content || '(empty)')}</pre>`;
      }
      if (restoreBtn) restoreBtn.disabled = false;
    } catch (_err) {
      if (seq === versionReqSeq && previewEl)
        previewEl.innerHTML = '<p class="te-history-hint">Couldn’t load this version.</p>';
    }
  }

  function restoreSelected() {
    if (!selectedVersion) return;
    populateFields(selectedVersion.data || {}, selectedVersion.content || '', currentFile);
    isDirty = true;
    // Honor "review then Save" — cancel any pending autosave so the restored
    // version isn't silently applied 10s later.
    clearTimeout(autosaveTimer);
    setSaved('Unsaved');
    setAutoState('idle', 'Restored — Save to apply');
    TE.closeModal('history-modal');
    TE.toast('Version loaded into the editor. Review, then Save to apply.', 'info');
  }

  // Phase 5e: hydrate the new sidebar fields (series, publish_at,
  // cover, custom_css, custom_js) from the front-matter object. Guards
  // for missing DOM refs so tests that mount editor.js against a
  // minimal HTML shell don't break.
  function setExtraFields(data) {
    const seriesEl = $('post-series');
    const pubAtEl = $('post-publish-at');
    const coverEl = $('post-cover');
    const coverAltEl = $('post-cover-alt');
    const cssEl = $('post-custom-css');
    const jsEl = $('post-custom-js');
    if (seriesEl) seriesEl.value = data.series || '';
    if (pubAtEl) {
      if (data.publish_at) {
        try {
          const d = new Date(data.publish_at);
          d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
          pubAtEl.value = d.toISOString().slice(0, 16);
        } catch (_) {
          pubAtEl.value = '';
        }
      } else pubAtEl.value = '';
    }
    if (coverEl) coverEl.value = data.cover || '';
    if (coverAltEl) coverAltEl.value = data.cover_alt || '';
    if (cssEl) cssEl.value = data.custom_css || '';
    if (jsEl) jsEl.value = data.custom_js || '';
    updateCoverPreview();
    updatePublishAtBadge();
  }

  function updateCoverPreview() {
    const coverEl = $('post-cover');
    const wrap = $('cover-preview');
    const img = $('cover-preview-img');
    if (!coverEl || !wrap || !img) return;
    const url = coverEl.value.trim();
    if (url) {
      img.src = url;
      img.alt = ($('post-cover-alt')?.value || '').trim();
      wrap.hidden = false;
    } else {
      wrap.hidden = true;
    }
  }

  function updatePublishAtBadge() {
    const badge = $('publish-at-badge');
    const pubAt = $('post-publish-at');
    if (!badge || !pubAt) return;
    const isDraft = draftEl?.value === 'true';
    const ts = pubAt.value ? new Date(pubAt.value).getTime() : 0;
    if (ts && isDraft && ts > Date.now()) {
      const when = new Date(ts).toUTCString().replace(/:\d{2} GMT$/, ' UTC');
      badge.textContent = `Scheduled · ${when}`;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  // ── Save ──────────────────────────────────────────────────
  async function savePost() {
    if (loadFailed) {
      TE.toast('This post failed to load — reload it before saving.', 'error');
      return false;
    }
    if (saving) return false; // in-flight lock: no overlapping autosave + manual save
    if (!titleEl.value.trim()) {
      TE.toast('Title is required.', 'error');
      return false;
    }
    const data = {
      title: titleEl.value.trim(),
      slug: slugEl.value.trim() || slugify(titleEl.value),
      draft: draftEl.value === 'true',
      date: dateEl.value ? new Date(dateEl.value).toISOString() : new Date().toISOString(),
      excerpt: descEl.value.trim(),
    };
    // Phase 5e: scoop optional fields. Empty strings are dropped so
    // the front-matter object stays clean.
    const series = ($('post-series')?.value || '').trim();
    if (series) data.series = series;
    const pubAt = $('post-publish-at')?.value || '';
    if (pubAt) {
      try {
        data.publish_at = new Date(pubAt).toISOString();
      } catch (_) {
        /* invalid date — let server reject */
      }
    }
    const cover = ($('post-cover')?.value || '').trim();
    if (cover) data.cover = cover;
    const coverAlt = ($('post-cover-alt')?.value || '').trim();
    if (coverAlt) data.cover_alt = coverAlt;
    const customCss = ($('post-custom-css')?.value || '').trim();
    if (customCss) data.custom_css = customCss;
    const customJs = ($('post-custom-js')?.value || '').trim();
    if (customJs) data.custom_js = customJs;
    const content = bodyEl.value || '';
    const url = currentFile ? `/api/posts/${encodeURIComponent(currentFile)}` : '/api/posts';
    const method = currentFile ? 'PUT' : 'POST';
    // Optimistic concurrency: tell the server which version we loaded so
    // it can refuse to clobber a newer on-disk copy.
    const payload = { data, content };
    if (method === 'PUT') {
      if (typeof loadedMtime !== 'number') {
        // No base version for an existing post (a failed/again load) — refuse
        // rather than send a token-less PUT the server would accept blindly.
        TE.toast('Reload this post before saving (no base version).', 'error');
        return false;
      }
      payload.baseMtime = loadedMtime;
    }

    saving = true;
    setSaved('Saving…');
    setAutoState('saving', 'Saving…');
    if (editorRoot) {
      editorRoot.dispatchEvent(new CustomEvent('autosave-start', { bubbles: true }));
    }
    try {
      const result = await TE.fetchJSON(url, {
        method,
        body: JSON.stringify(payload),
      });
      if (typeof result.mtime === 'number') loadedMtime = result.mtime;
      isDirty = false;
      clearTimeout(autosaveTimer);
      setSaved('Saved');
      setAutoState('saved', 'Saved');
      if (editorRoot) {
        editorRoot.dispatchEvent(
          new CustomEvent('autosave-success', {
            bubbles: true,
            detail: { filename: result.filename || currentFile },
          }),
        );
      }
      if (result.filename && result.filename !== currentFile) {
        setCurrentFile(result.filename);
      } else if (!currentFile && result.filename) {
        setCurrentFile(result.filename);
      }
      updateStatusPill();
      return true;
    } catch (err) {
      // 409 = a guard fired (stale copy / slug already taken). These are
      // recoverable user states, not crashes — surface the server's
      // human-readable message and don't pretend a generic save failure.
      const isConflict = err && err.status === 409;
      setSaved(isConflict ? 'Not saved' : 'Save failed');
      setAutoState('error', isConflict ? 'Conflict' : 'Error saving');
      if (editorRoot) {
        editorRoot.dispatchEvent(
          new CustomEvent('autosave-error', {
            bubbles: true,
            detail: { message: err && err.message },
          }),
        );
      }
      const msg = (err && err.data && err.data.message) || (err && err.message) || 'Save failed.';
      TE.toast(msg, isConflict ? 'warn' : 'error');
      return false;
    } finally {
      saving = false;
    }
  }

  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    if (loadFailed) return; // never autosave over a post that failed to load
    autosaveTimer = setTimeout(() => {
      // Only autosave existing posts that actually have unsaved edits and
      // aren't mid-save — never create a post from a half-typed draft, and
      // never fire a phantom save when nothing changed.
      if (currentFile && isDirty && !saving && titleEl.value.trim()) savePost();
    }, 10000);
  }

  async function publishSite() {
    // Accessibility/SEO guard: warn (don't block) when images lack alt text.
    const missing = imagesMissingAlt(bodyEl?.value || '');
    if (missing > 0) {
      const ok = window.confirm(
        `${missing} image${missing === 1 ? '' : 's'} ${missing === 1 ? 'has' : 'have'} no alt text — ` +
          'bad for screen readers and SEO. Publish anyway?',
      );
      if (!ok) return;
    }
    if (!(await savePost())) return;
    btnPub.disabled = btnPub2.disabled = true;
    try {
      await TE.fetchJSON('/api/publish', { method: 'POST', body: '{}' });
      TE.toast('Publish triggered.');
    } catch (err) {
      TE.toast(err.message || 'Publish failed.', 'error');
    } finally {
      btnPub.disabled = btnPub2.disabled = false;
    }
  }

  // ── Delete ────────────────────────────────────────────────
  async function deletePost() {
    if (!currentFile) return;
    if (!confirm(`Delete "${titleEl.value || currentFile}" permanently?`)) return;
    try {
      await TE.fetchJSON(`/api/posts/${encodeURIComponent(currentFile)}`, {
        method: 'DELETE',
        body: undefined,
      });
      TE.toast('Post deleted.');
      isDirty = false; // the post is gone — don't fire the unsaved-changes prompt
      window.location.href = '/index.html';
    } catch (err) {
      TE.toast(err.message || 'Delete failed.', 'error');
    }
  }

  // ── Mount the TipTap + CodeMirror editor (Phase 3a) ───────
  //
  // The bundle (admin/public/js/editor.bundle.js) attaches its public
  // surface to window.TEEditor. We lift it onto window.TE.editor for
  // consistency with the rest of TE.* helpers, then mount over
  // #editor-root. If the bundle isn't available (build missing,
  // network failure), we leave the pre-rendered <textarea> in place
  // and the page degrades to plain Markdown editing.
  function mountEditor() {
    const TEEditor = /** @type {any} */ (window).TEEditor;
    if (TEEditor && typeof TEEditor.mount === 'function' && editorRoot) {
      if (window.TE && !window.TE.editor) window.TE.editor = TEEditor;
      try {
        // Hand over the textarea's current value (empty on first boot,
        // hydrated later by loadPost) so the WYSIWYG renders from the
        // same source the textarea would have shown.
        const initial = (bodyEl && bodyEl.value) || '';
        const labelEditorSurface = () => {
          const surface = editorRoot.querySelector('.ProseMirror');
          if (surface && !surface.getAttribute('aria-label')) {
            surface.setAttribute('aria-label', 'Post body');
          }
        };
        const instance = TEEditor.mount(editorRoot, initial, {
          placeholder: 'Write your post in Markdown…',
        });
        labelEditorSurface();
        // The façade is the new bodyEl. It exposes .value, .selectionStart,
        // .selectionEnd, addEventListener('input'), .focus(), .setMode().
        bodyEl = instance;
        return true;
      } catch (err) {
        // Don't bring the page down; fall back to the prerendered textarea.
        console.error('[editor] mount failed, using fallback textarea', err);
      }
    }
    return false;
  }

  // ── Phase 4: editor inline drop zone ──────────────────────
  //
  // Catches files dropped anywhere on the editor surface (#editor-root)
  // and uploads them. For images we call TipTap's `setImage()` so the
  // image lands at the cursor; for non-images we insert a paragraph
  // placeholder ("[File: name.ext]") that Phase 6's attachment node
  // will eventually replace. We don't show a visible dropzone here —
  // the global body dropzone already handles "no editor focus" cases.
  function wireEditorDrop() {
    if (!editorRoot) return;
    let depth = 0;
    function isFileDrag(e) {
      return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    }
    editorRoot.addEventListener('dragenter', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth += 1;
      editorRoot.classList.add('is-dragover');
    });
    editorRoot.addEventListener('dragover', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    editorRoot.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) editorRoot.classList.remove('is-dragover');
    });
    editorRoot.addEventListener('drop', async (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth = 0;
      editorRoot.classList.remove('is-dragover');
      const files = Array.from(e.dataTransfer.files || []);
      if (!files.length || !window.TE || !TE.media) return;
      const { ok, failed } = await TE.media.upload(files);
      for (const item of ok) insertMediaIntoEditor(item);
      if (failed.length) TE.toast(failed.map((f) => f.error).join(' / '), 'error');
    });
  }

  function insertMediaIntoEditor(item) {
    if (!item || !item.url) return;
    // Determine the media kind. Library/upload items carry `type`/`mime_type`;
    // the "recent media" thumbnails pass only { url, filename }, so fall back
    // to the URL extension.
    let kind = item.type || (item.mime_type || '').split('/')[0];
    if (!kind || kind === 'application') {
      const u = (item.url || '').toLowerCase();
      if (/\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)(\?|$)/.test(u)) kind = 'image';
      else if (/\.(mp4|webm|mov|m4v|ogv)(\?|$)/.test(u)) kind = 'video';
    }
    const tt = bodyEl && bodyEl._tiptap;
    const splice = (md) => {
      const start = bodyEl.selectionStart || 0;
      const end = bodyEl.selectionEnd || 0;
      bodyEl.value = bodyEl.value.slice(0, start) + md + bodyEl.value.slice(end);
      bodyEl.selectionStart = bodyEl.selectionEnd = start + md.length;
      bodyEl.focus && bodyEl.focus();
    };

    if (kind === 'video') {
      // Reference the compressed renditions the conversion worker produced —
      // NOT the heavy original — so what ships to GitHub Pages stays small.
      const conv = item.conversions || {};
      const mp4 = conv['h264-mp4'] || '';
      const webm = conv['vp9-webm'] || '';
      const poster = conv['poster'] || '';
      if (!mp4 && !webm && item.status && item.status !== 'ready') {
        // Still being optimized (or ffmpeg unavailable). Don't bake in the raw
        // original; tell the user to insert from the library once it's ready.
        if (window.TE && TE.toast) {
          TE.toast(
            'Video is still being optimized — insert it from the media library once ready.',
            'info',
          );
        }
        return;
      }
      if (tt && tt.chain) {
        tt.chain()
          .focus()
          .insertContent({
            type: 'video',
            attrs: { mp4, webm, poster, src: mp4 || webm ? '' : item.url },
          })
          .run();
      } else {
        const posterAttr = poster ? ` poster="${poster}"` : '';
        // Multi-line so CommonMark treats it as one html_block (see the video
        // serializer in editor.entry.js for why single-line fails to parse).
        const lines = [];
        if (mp4 || webm) {
          lines.push(`<video controls${posterAttr}>`);
          if (mp4) lines.push(`<source src="${mp4}" type="video/mp4">`);
          if (webm) lines.push(`<source src="${webm}" type="video/webm">`);
        } else {
          lines.push(`<video controls${posterAttr} src="${item.url}">`);
        }
        lines.push('</video>');
        splice(`\n\n${lines.join('\n')}\n\n`);
      }
      markDirty();
      updateMetrics();
      return;
    }

    if (kind === 'image') {
      // Images + GIFs → standard Markdown image (Astro-native; GIFs animate as
      // <img>). Renders inline in the WYSIWYG editor and round-trips cleanly.
      //
      // Alt text comes from the media library (`alt_text`), NEVER the
      // filename — a filename-alt is what screen readers end up reading
      // aloud. When the library has none, ask; the answer is saved back
      // so the next insertion of the same image starts with it.
      let alt = String(item.alt_text || '').trim();
      const altIsUsable = alt && !(TE.media && TE.media.needsAlt && TE.media.needsAlt(item));
      if (!altIsUsable) {
        const answer = window.prompt(
          'Describe this image for screen readers (alt text):',
          alt || '',
        );
        alt = (answer || '').trim();
        if (alt && item.id && TE.media && TE.media.patch) {
          // Fire-and-forget: teach the library this alt for next time.
          TE.media.patch(item.id, { alt_text: alt }).catch(() => {});
        }
        if (!alt && window.TE && TE.toast) {
          TE.toast('Inserted without alt text — add one in the media library.', 'warn');
        }
      }
      if (tt && tt.chain) {
        tt.chain().focus().setImage({ src: item.url, alt }).run();
      } else {
        splice(`\n![${alt}](${item.url})\n`);
      }
      markDirty();
      updateMetrics();
      return;
    }

    // audio / pdf / archive / other → a plain Markdown link.
    const label = `[${item.original_name || item.filename || 'file'}](${item.url})`;
    if (tt && tt.chain) {
      tt.chain().focus().insertContent(`\n\n${label}\n\n`).run();
    } else {
      splice(`\n${label}\n`);
    }
    markDirty();
    updateMetrics();
  }

  // ── Wire DOM ──────────────────────────────────────────────
  function boot() {
    mountEditor();
    wireEditorDrop();

    // Title → slug auto-fill (only when slug is empty or matches the
    // previous auto-derived slug).
    let lastAutoSlug = '';
    titleEl.addEventListener('input', () => {
      const auto = slugify(titleEl.value);
      if (!slugEl.value || slugEl.value === lastAutoSlug) {
        slugEl.value = auto;
        lastAutoSlug = auto;
      }
      updateSocialPreview();
      updateSeoPreview();
      scheduleSlugCheck();
      markDirty();
    });

    // Dirty-tracking + UI updates
    [slugEl, dateEl, draftEl].forEach((el) =>
      el.addEventListener('input', () => {
        updateSeoPreview();
        if (el === slugEl) scheduleSlugCheck();
        markDirty();
      }),
    );
    descEl.addEventListener('input', () => {
      updateSocialPreview();
      updateSeoPreview();
      markDirty();
    });
    bodyEl.addEventListener('input', () => {
      updateMetrics();
      markDirty();
    });
    draftEl.addEventListener('change', updateStatusPill);

    // Phase 3d: autosave pip click → retry. The pip exposes role=button
    // + tabindex=0 only while in the error state.
    if (autoEl) {
      const retry = () => {
        if (autoEl.dataset.state !== 'error') return;
        // A load failure must RE-LOAD, not save (saving would clobber the
        // post with the blank editor). A save error retries the save.
        if (loadFailed && currentFile) loadPost(currentFile);
        else savePost();
      };
      autoEl.addEventListener('click', retry);
      autoEl.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && autoEl.dataset.state === 'error') {
          e.preventDefault();
          retry();
        }
      });
    }

    // Phase 3d: TOC + SEO panel toggle buttons.
    function setPanelOpen(panelKey, open) {
      if (!edLayout) return;
      edLayout.dataset[panelKey === 'toc' ? 'tocOpen' : 'seoOpen'] = open ? 'true' : 'false';
      try {
        localStorage.setItem('te-editor-panel-' + panelKey, open ? '1' : '0');
      } catch (_) {
        /* ignore — privacy mode or quota */
      }
      const panel = panelKey === 'toc' ? tocPanel : seoPanel;
      const btn = panelKey === 'toc' ? btnTocToggle : btnSeoToggle;
      if (panel) panel.hidden = !open;
      if (btn) btn.setAttribute('aria-pressed', open ? 'true' : 'false');
      // Hide the entire aux column when both panels are closed.
      const aux = document.getElementById('ed-aux');
      if (aux) {
        const tocOpen = edLayout.dataset.tocOpen === 'true';
        const seoOpen = edLayout.dataset.seoOpen === 'true';
        aux.hidden = !tocOpen && !seoOpen;
      }
    }
    // Restore persisted state.
    try {
      const tocStored = localStorage.getItem('te-editor-panel-toc');
      const seoStored = localStorage.getItem('te-editor-panel-seo');
      // Default both panels CLOSED so the writing column is wide and
      // uncluttered; the topbar toggles bring them in on demand. Users who
      // previously opened a panel keep their saved preference.
      setPanelOpen('toc', tocStored === '1');
      setPanelOpen('seo', seoStored === '1');
    } catch (_) {
      setPanelOpen('toc', false);
      setPanelOpen('seo', false);
    }
    if (btnTocToggle) {
      btnTocToggle.addEventListener('click', () => {
        const open = edLayout?.dataset.tocOpen !== 'true';
        setPanelOpen('toc', open);
      });
    }
    if (btnSeoToggle) {
      btnSeoToggle.addEventListener('click', () => {
        const open = edLayout?.dataset.seoOpen !== 'true';
        setPanelOpen('seo', open);
      });
    }
    if (tocCloseBtn) tocCloseBtn.addEventListener('click', () => setPanelOpen('toc', false));
    if (seoCloseBtn) seoCloseBtn.addEventListener('click', () => setPanelOpen('seo', false));

    // Action buttons (both top + sidebar copies)
    [btnSave, btnSave2].forEach((b) => b && b.addEventListener('click', savePost));
    [btnPub, btnPub2].forEach((b) => b && b.addEventListener('click', publishSite));
    if (btnDel) btnDel.addEventListener('click', deletePost);
    const btnHistory = $('btn-history');
    if (btnHistory) btnHistory.addEventListener('click', openHistory);
    const btnRestore = $('history-restore');
    if (btnRestore) btnRestore.addEventListener('click', restoreSelected);

    // Focus mode: hide the panels for a calm full-width writing surface.
    const btnZen = $('btn-zen');
    function setZen(on) {
      document.body.classList.toggle('distraction-free', on);
      if (btnZen) btnZen.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (btnZen) {
      btnZen.addEventListener('click', () =>
        setZen(!document.body.classList.contains('distraction-free')),
      );
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !document.body.classList.contains('distraction-free')) return;
        // Don't steal Escape from an open overlay (history modal, image
        // picker, command palette, find/replace) — let it close that first;
        // only exit focus mode when Escape would otherwise do nothing.
        if (e.defaultPrevented) return;
        if (
          document.querySelector('.modal:not([aria-hidden="true"]), .te-find-modal, .cmdk.open')
        ) {
          return;
        }
        setZen(false);
      });
    }

    // Keyboard: Cmd/Ctrl + S (fired from anywhere outside the editor).
    // Inside the editor, TipTap's keymap intercepts these first and
    // dispatches the matching `editor-save` / `editor-publish` custom
    // events on #editor-root — see below.
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        savePost();
      }
    });

    // Phase 3b: the editor bundle's keymap dispatches custom events for
    // Cmd+S and Cmd+Enter so the page can route them through its
    // existing save / publish flow without coupling the bundle to the
    // page. The events bubble from #editor-root; we listen at the root
    // element to capture them regardless of focus location inside.
    if (editorRoot) {
      editorRoot.addEventListener('editor-save', (e) => {
        e.preventDefault?.();
        savePost();
      });
      editorRoot.addEventListener('editor-publish', (e) => {
        e.preventDefault?.();
        publishSite();
      });
      // The slash menu's "Image" placeholder dispatches this so we can
      // open the existing sidebar uploader's file picker (Phase 4 will
      // replace with a proper media browser).
      editorRoot.addEventListener('te-slash-image', () => {
        const input = document.getElementById('ed-file-input');
        if (input && typeof input.click === 'function') input.click();
      });
      // Phase 6: the slash menu's "File attachment" entry routes here.
      // We reuse the same file picker the image flow uses — the upload
      // handler is content-agnostic — and the success callback inserts
      // the right markup per kind (image/video/plain link) via
      // insertMediaIntoEditor. If the page hosts a proper media-library
      // modal in future, swap this for `openLibrary()`.
      editorRoot.addEventListener('te-slash-attachment', () => {
        const input = document.getElementById('ed-file-input');
        if (input && typeof input.click === 'function') input.click();
      });
    }

    // Media uploader inside the editor sidebar (Phase 4 will overhaul)
    if (window.TE && TE.media) {
      TE.media.bindUploader({
        dropzone: 'ed-dropzone',
        input: 'ed-file-input',
        recent: 'ed-recent-media',
        // Route both the recent-media thumbnails and sidebar uploads through
        // the same inserter so images/GIFs/videos get the right markup +
        // inline preview in WYSIWYG and the textarea fallback alike.
        onInsert: (item) => insertMediaIntoEditor(item),
      });
    }

    // Initial state
    if (currentFile) {
      loadPost(currentFile);
    } else {
      const now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      dateEl.value = now.toISOString().slice(0, 16);
      setCurrentFile(null);
      updateMetrics();
      updateSocialPreview();
      updateSeoPreview();
      updateStatusPill();
      setSaved('');
      setAutoState('idle', 'Ready');
    }
    loadSeriesSuggestions();

    // Phase 5e wiring — only fires when the corresponding sidebar
    // panels are present in the DOM (editor.html includes them).
    const btnPreview = $('btn-preview-link');
    if (btnPreview) btnPreview.addEventListener('click', generatePreviewLink);
    const btnCover = $('btn-pick-cover');
    if (btnCover) btnCover.addEventListener('click', pickCover);
    const coverEl = $('post-cover');
    if (coverEl)
      coverEl.addEventListener('input', () => {
        updateCoverPreview();
        markDirty();
      });
    const coverAltEl = $('post-cover-alt');
    if (coverAltEl)
      coverAltEl.addEventListener('input', () => {
        updateCoverPreview();
        markDirty();
      });
    const pubAtEl = $('post-publish-at');
    if (pubAtEl)
      pubAtEl.addEventListener('change', () => {
        updatePublishAtBadge();
        markDirty();
      });
    if (draftEl) draftEl.addEventListener('change', updatePublishAtBadge);
    ['post-series', 'post-custom-css', 'post-custom-js'].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('input', markDirty);
    });
    // Load a template if ?template=<name> was passed for a new post
    maybeLoadTemplate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
