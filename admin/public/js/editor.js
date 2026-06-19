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
  let loadFailCount = 0;
  // In-flight save lock so autosave can't overlap a manual save (false 409
  // / double-create) — savePost early-returns while one is running.
  let saving = false;
  // Set when the last save failed with a 409 (the on-disk copy changed, or a
  // rename target is taken). Retrying the SAME save just 409s again forever,
  // so the retry path reloads instead.
  let saveConflict = false;
  // Whether the slug is still tracking the title (true) or the writer has
  // manually overridden it (false). When auto, retitling an EXISTING post
  // renames its file/URL too — the headline feature. Recomputed on load.
  let slugIsAuto = true;

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
    // In Source (Markdown) mode the bundle deliberately doesn't round-trip
    // CodeMirror edits into the TipTap doc until a mode switch, so the doc is
    // stale while typing there — read the live façade value instead.
    const inWysiwyg = !bodyEl?.getMode || bodyEl.getMode() === 'wysiwyg';
    const tipText =
      inWysiwyg && bodyEl && bodyEl._tiptap && bodyEl._tiptap.state
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
      const inWysiwyg = !bodyEl?.getMode || bodyEl.getMode() === 'wysiwyg';
      const tipText =
        inWysiwyg && bodyEl && bodyEl._tiptap && bodyEl._tiptap.state
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

  // Escape text destined for a Markdown link/image label so a stray `[`, `]`,
  // or newline can't break the syntax (used by the textarea-fallback insert).
  function mdText(s) {
    return String(s || '')
      .replace(/[[\]]/g, '\\$&')
      .replace(/[\r\n]+/g, ' ');
  }
  // CommonMark requires parentheses in link/image URLs to be escaped
  // (or percent-encoded). Filenames rarely contain them, but handle it
  // so the markdown doesn't silently truncate at the first unescaped ')'.
  function mdUrl(u) {
    return String(u || '').replace(/[()]/g, '\\$&');
  }

  // ── Live slug validation ──────────────────────────────────
  // Catch a taken/invalid slug AS the writer types, not at save time — the
  // server still guards (409 slug_taken), but a quiet inline hint is far
  // friendlier than a failed save.
  let slugCheckTimer = null;
  let slugCheckSeq = 0;
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
    const mySeq = (slugCheckSeq += 1);
    try {
      const posts = await TE.fetchJSON('/api/posts');
      if (mySeq !== slugCheckSeq) return; // a newer check superseded this one
      // A clash is any OTHER post (not the one we're editing) using this slug.
      const clash = posts.find((p) => p.slug === raw && p.filename !== currentFile);
      if (clash) {
        setSlugMsg(`Already used by "${clash.title || clash.slug}". Pick another.`, 'err');
      } else if (currentFile && raw !== currentFile.replace(/\.md$/, '')) {
        // Live rename feedback: the writer SEES the new filename + that the
        // old URL is handled, before they save.
        setSlugMsg(`New address: /blog/${raw}/ · old link will redirect (no 404).`, 'warn');
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

  // Show a "Match title" button whenever the slug has drifted from the title
  // (e.g. an old post whose title was changed but slug left behind, so the
  // editor treats the slug as custom and won't auto-rename). One click
  // re-syncs the URL to the title — the discoverable fix for "I changed the
  // title but the address didn't change".
  function updateSlugSync() {
    const btn = $('slug-sync');
    if (!btn) return;
    const fromTitle = slugify(titleEl.value || '');
    const cur = (slugEl.value || '').trim();
    btn.hidden = !(fromTitle && fromTitle !== cur);
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
    backupNewDraft();
  }

  // ── New-post crash safety ─────────────────────────────────
  // A brand-new post (no file yet) isn't autosaved to the server — we never
  // want to create a post from a half-typed draft. To avoid losing work to a
  // crash or accidental close, mirror it to localStorage while editing and
  // offer to restore it the next time the editor opens blank.
  const NEWDRAFT_KEY = 'te_newpost_backup_v1';
  function backupNewDraft() {
    if (currentFile) return; // only for brand-new posts
    try {
      const body = bodyEl ? bodyEl.value || '' : '';
      const title = titleEl.value || '';
      if (!title.trim() && !body.trim()) {
        localStorage.removeItem(NEWDRAFT_KEY);
        return;
      }
      localStorage.setItem(
        NEWDRAFT_KEY,
        JSON.stringify({
          title,
          slug: slugEl.value || '',
          body,
          draft: draftEl.value === 'true',
          excerpt: descEl.value || '',
          series: $('post-series')?.value || '',
          ts: Date.now(),
        }),
      );
    } catch (_) {
      /* storage blocked/full — best effort */
    }
  }
  function clearNewDraftBackup() {
    try {
      localStorage.removeItem(NEWDRAFT_KEY);
    } catch (_) {
      /* ignore */
    }
  }
  // On a blank editor, surface any backed-up draft with a Restore/Discard bar.
  function offerNewDraftRestore() {
    if (currentFile) return;
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(NEWDRAFT_KEY) || 'null');
    } catch (_) {
      saved = null;
    }
    if (!saved || (!String(saved.title || '').trim() && !String(saved.body || '').trim())) return;
    const stage = $('stage') || document.body;
    const bar = document.createElement('div');
    bar.className = 'ed-restore-banner';
    const when = (() => {
      try {
        return new Date(saved.ts).toLocaleString();
      } catch (_) {
        return 'earlier';
      }
    })();
    bar.innerHTML =
      `<span>You have unsaved work from ${TE.escape(when)}. Restore it?</span>` +
      `<span class="ed-restore-actions"><button type="button" class="btn solid" data-restore>Restore</button>` +
      `<button type="button" class="btn ghost" data-discard>Discard</button></span>`;
    stage.prepend(bar);
    bar.querySelector('[data-restore]').addEventListener('click', () => {
      populateFields(
        {
          title: saved.title,
          slug: saved.slug,
          draft: saved.draft,
          excerpt: saved.excerpt,
          series: saved.series,
        },
        saved.body || '',
        null,
      );
      markDirty();
      bar.remove();
    });
    bar.querySelector('[data-discard]').addEventListener('click', () => {
      clearNewDraftBackup();
      bar.remove();
    });
  }
  // Strip ".md" from user-facing labels: the public URL never includes it
  // (/blog/slug/ not /blog/slug.md/) so showing the extension confuses novices.
  function prettyName(filename) {
    return filename ? filename.replace(/\.md$/, '') : '';
  }
  function setCurrentFile(filename) {
    currentFile = filename;
    if (filename) {
      const u = new URL(window.location);
      u.searchParams.set('file', filename);
      window.history.replaceState({}, '', u);
      if (btnDel) btnDel.style.display = '';
      if (fileFoot) fileFoot.textContent = prettyName(filename);
    } else {
      if (btnDel) btnDel.style.display = 'none';
      if (fileFoot) fileFoot.textContent = '';
    }
    if (crumbEditor) crumbEditor.textContent = prettyName(filename) || 'New post';
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
        grid.innerHTML = '<p class="te-history-hint">Couldn\'t load images.</p>';
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
    // The slug "tracks" the title only if it still matches what the title
    // would generate — i.e. it wasn't hand-customized. When it tracks,
    // retitling renames the file/URL; a custom slug is left untouched.
    slugIsAuto = slugEl.value === slugify(data.title || '');
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
    updateSlugSync();
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
      loadFailCount = 0;
      setSaved('Saved (not yet live)');
      setAutoState('saved', 'Saved — click Save & publish to go live');
    } catch (err) {
      // The load failed but the editor is still bound to `filename` with
      // blank fields. Saving now would PUT empty content over the real post
      // — and without a baseMtime token would bypass the conflict guard.
      // Lock saving + autosave until a successful reload; the error pip
      // re-loads (not saves).
      loadFailCount += 1;
      loadFailed = true;
      clearTimeout(autosaveTimer);
      if (loadFailCount >= 3) {
        setAutoState(
          'error',
          "Couldn't load after 3 tries. Check your connection and refresh the page.",
        );
      } else {
        setAutoState('error', "Couldn't load — click to retry");
      }
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
      if (listEl) listEl.innerHTML = '<li class="te-history-empty">Couldn\'t load history.</li>';
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
        previewEl.innerHTML = '<p class="te-history-hint">Couldn\'t load this version.</p>';
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
    // Titles with only emoji/punctuation slugify to nothing, which the server
    // rejects. Catch it here with a plain message.
    if (!slugify(slugEl.value.trim()) && !slugify(titleEl.value)) {
      TE.toast(
        'The title needs at least one letter or number — it forms the web address.',
        'error',
      );
      titleEl.focus();
      return false;
    }
    const data = {
      title: titleEl.value.trim(),
      // Always normalize — a fast manual edit ("Hello World!") could otherwise
      // be sent before the debounced slug-check runs. (Server slugifies too.)
      slug: slugify(slugEl.value.trim()) || slugify(titleEl.value),
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
      saveConflict = false;
      // Only declare the editor clean if its body hasn't changed since we
      // snapshotted the payload above. If the writer typed during the in-flight
      // request, keep tracking those edits and re-arm autosave — otherwise the
      // keystrokes are silently dropped (no pending autosave, no beforeunload
      // warning, UI says "Saved").
      if ((bodyEl.value || '') === content) {
        isDirty = false;
        clearTimeout(autosaveTimer);
        clearNewDraftBackup();
        setSaved('Saved (not yet live)');
        setAutoState('saved', 'Saved — click Save & publish to go live');
      } else {
        scheduleAutosave();
        setSaved('Unsaved changes');
        setAutoState('dirty', 'Unsaved changes');
      }
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
      // Renamed on disk → tell the writer the old URL is safe + links fixed.
      if (result.rename) {
        const r = result.rename;
        const parts = [];
        if (Array.isArray(r.redirected) && r.redirected.length) parts.push('old URL redirected');
        if (r.linksUpdated)
          parts.push(`${r.linksUpdated} link${r.linksUpdated === 1 ? '' : 's'} updated`);
        TE.toast(
          `New address: /blog/${prettyName(result.filename)}/${parts.length ? ' — ' + parts.join(', ') : ''}.`,
        );
        setSlugMsg('Available', 'ok');
        // A best-effort side effect failed on the server. The post saved fine,
        // but the old link may now 404 (or cross-links weren't rewritten), so
        // surface it instead of silently implying everything is wired up.
        if (Array.isArray(r.warnings) && r.warnings.length) {
          TE.toast(
            r.warnings.includes('redirect')
              ? "Renamed, but couldn't add a redirect — the old link may 404. Add one in the Redirects tab."
              : "Renamed, but couldn't update some internal links to the new address.",
            'error',
          );
        }
      }
      updateStatusPill();
      return true;
    } catch (err) {
      // 409 = a guard fired (stale copy / slug already taken). These are
      // recoverable user states, not crashes — surface the server's
      // human-readable message and don't pretend a generic save failure.
      const isConflict = err && err.status === 409;
      saveConflict = isConflict;
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
      // Autosave existing posts that have unsaved edits and aren't mid-save —
      // never create a post from a half-typed draft, never fire a phantom
      // save when nothing changed. This INCLUDES a title/slug change: the save
      // renames the file + auto-redirects the old URL. The 10s debounce fires
      // only after typing stops, so it won't rename to a half-typed slug.
      // Require a valid base-version token too: a PUT without it is refused
      // by savePost anyway, so don't let autosave spam that error path.
      if (
        currentFile &&
        isDirty &&
        !saving &&
        !saveConflict &&
        titleEl.value.trim() &&
        typeof loadedMtime === 'number'
      )
        savePost();
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
    // A draft won't appear on the live site even once pushed (Astro filters
    // drafts at build). This is a common "I published but nothing changed"
    // trap — warn before spending a deploy on an invisible change.
    if (draftEl?.value === 'true') {
      const ok = window.confirm(
        'Heads up: this post is a DRAFT. Drafts stay completely hidden on the live ' +
          "site — publishing now will rebuild the site but readers still won't see " +
          'this post.\n\nTo make it public: set Status to "Published" (in Post settings), ' +
          'then Save & publish again.\n\nRebuild the site anyway?',
      );
      if (!ok) return;
    }
    if (!(await savePost())) return;
    btnPub.disabled = btnPub2.disabled = true;
    try {
      const result = await TE.fetchJSON('/api/publish', { method: 'POST', body: '{}' });
      if (result && result.changed === false) {
        TE.toast('Nothing new to publish — your site is already up to date and live.');
      } else {
        TE.toast('Published — the site is building.');
        if (result && result.commitHash) watchDeploy(result.commitHash);
      }
    } catch (err) {
      // The server now returns a safe, actionable message per failure mode.
      const msg = (err.data && err.data.message) || err.message || 'Publish failed.';
      TE.toast(msg, 'error');
    } finally {
      btnPub.disabled = btnPub2.disabled = false;
    }
  }

  // Poll the deploy-status proxy after a publish and reflect the GitHub
  // Action's progress in the #deploy-status pill (Building… → Live ✓ / failed).
  // Best-effort: any error just leaves the pill on "Building…".
  let deployTimer = null;
  function watchDeploy(sha) {
    const el = document.getElementById('deploy-status');
    if (!el) return;
    clearTimeout(deployTimer);
    el.hidden = false;
    el.className = 'ed-deploy building';
    el.textContent = 'Building…';
    el.removeAttribute('href');
    let tries = 0;
    const tick = async () => {
      tries += 1;
      let d;
      try {
        d = await TE.fetchJSON(`/api/publish/deploy/${encodeURIComponent(sha)}`);
      } catch (_) {
        d = { status: 'unknown' };
      }
      if (d && d.url) el.href = d.url;
      if (d && d.status === 'not_pushed') {
        el.className = 'ed-deploy fail';
        el.textContent = 'Publish failed';
        TE.toast(
          "The publish didn't reach GitHub — check your internet connection and try again.",
          'error',
        );
        return;
      }
      if (d && d.status === 'completed') {
        const ok = d.conclusion === 'success';
        const slug = (slugEl?.value || '').trim();
        const isPublished = draftEl?.value === 'false';
        el.className = ok ? 'ed-deploy ok' : 'ed-deploy fail';
        if (ok) {
          // For a published post, point the badge at the live page.
          // A draft built fine but stays hidden — say "Site updated", not "Live".
          if (isPublished && slug) {
            el.href = `https://webworldwide.online/blog/${encodeURIComponent(slug)}/`;
            el.textContent = 'View it live ↗';
            TE.toast(`Your post is live at webworldwide.online/blog/${slug}`);
          } else {
            el.textContent = 'Site updated ✓';
            TE.toast("Site updated. (This post is a draft, so it won't appear publicly yet.)");
          }
        } else {
          el.textContent = 'Build failed';
        }
        return; // terminal — stop polling
      }
      el.textContent = d && d.status === 'in_progress' ? 'Building…' : 'Queued…';
      // Builds on a small server can queue for several minutes; poll up to ~10
      // min, then tell the writer where to check rather than freeze the badge.
      if (tries < 120) {
        deployTimer = setTimeout(tick, 5000);
      } else {
        el.className = 'ed-deploy';
        el.textContent = 'Still building — check back soon';
        TE.toast(
          'The site is taking longer than usual. It will finish on its own — ' +
            'refresh the live site in a few minutes.',
          'info',
        );
      }
    };
    deployTimer = setTimeout(tick, 4000);
  }

  // ── Delete ────────────────────────────────────────────────
  async function deletePost() {
    if (!currentFile) return;
    if (!confirm(`Delete "${titleEl.value || currentFile}" permanently?`)) return;
    // Cancel any pending autosave — otherwise its 10s timer could fire during
    // the delete request and re-create the post we just removed.
    clearTimeout(autosaveTimer);
    isDirty = false;
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
          placeholder: 'Start writing… (type "/" for headings, images, links and more)',
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
    editorRoot.addEventListener('drop', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth = 0;
      editorRoot.classList.remove('is-dragover');
      uploadAndInsertFiles(e.dataTransfer.files);
    });
    // Paste of image/video FILES with no accompanying text (e.g. a screenshot
    // on the clipboard). ProseMirror (editor.entry.js handlePaste) blocks its
    // own data: URI insertion for these, so the file reaches the media library
    // here instead. Pastes that carry text, or plain URL pastes, are untouched.
    editorRoot.addEventListener('paste', (e) => {
      const clip = e.clipboardData;
      if (!clip) return;
      const files = Array.from(clip.files || []).filter((f) =>
        /^(image|video)\//.test(f.type || ''),
      );
      const text = (clip.getData && clip.getData('text/plain')) || '';
      if (!files.length || text.trim() !== '') return;
      e.preventDefault();
      uploadAndInsertFiles(files);
    });
  }

  // Shared upload→insert path for dropped/pasted media. Reuses the media
  // library upload (with its progress tray) and the per-kind insert markup,
  // so paste, drop, the sidebar uploader, and the slash menu all behave alike.
  async function uploadAndInsertFiles(files) {
    const arr = Array.from(files || []);
    if (!arr.length || !window.TE || !TE.media) return;
    const { ok, failed } = await TE.media.upload(arr);
    for (const item of ok) insertMediaIntoEditor(item);
    if (failed.length) TE.toast(failed.map((f) => f.error).join(' / '), 'error');
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
          'Describe this image for screen readers (alt text):\n\n' +
            'This helps people who use screen readers or when the image fails to load. ' +
            'Hit Cancel to skip inserting this image.',
          alt || '',
        );
        // `null` = user hit Cancel → don't insert at all (avoids publishing
        // a permanently inaccessible image with no alt text).
        if (answer === null) return;
        alt = answer.trim();
        if (alt && item.id && TE.media && TE.media.patch) {
          // Fire-and-forget: teach the library this alt for next time.
          TE.media.patch(item.id, { alt_text: alt }).catch(() => {});
        }
        if (!alt && window.TE && TE.toast) {
          TE.toast(
            'Inserted without alt text. Edit the media library entry to add a description.',
            'warn',
          );
        }
      }
      if (tt && tt.chain) {
        tt.chain().focus().setImage({ src: item.url, alt }).run();
      } else {
        // Escape so a `]`/newline in the alt text can't break the markdown.
        splice(`\n![${mdText(alt)}](${mdUrl(item.url)})\n`);
      }
      markDirty();
      updateMetrics();
      return;
    }

    // audio / pdf / archive / other → a plain Markdown link.
    const label = `[${mdText(item.original_name || item.filename || 'file')}](${mdUrl(item.url)})`;
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
    // Off-canvas site nav on phones (shared with the SPA shell) — without
    // this the editor page's sidebar was unreachable on mobile.
    if (window.TE && typeof window.TE.wireMobileNav === 'function') window.TE.wireMobileNav();

    // Title → slug. While the slug is auto (tracking the title), retitling
    // updates the slug live — and for an existing post that means the file
    // and public URL rename on the next save (with an auto-redirect). A
    // manual slug edit breaks the link (slugIsAuto=false) so a custom URL
    // is never clobbered.
    titleEl.addEventListener('input', () => {
      if (slugIsAuto) {
        slugEl.value = slugify(titleEl.value);
        scheduleSlugCheck();
      }
      updateSocialPreview();
      updateSeoPreview();
      updateSlugSync();
      markDirty();
    });

    // Dirty-tracking + UI updates
    [slugEl, dateEl, draftEl].forEach((el) =>
      el.addEventListener('input', () => {
        // A hand-edited slug stops tracking the title (and an emptied slug
        // resumes tracking — save will re-derive it from the title).
        if (el === slugEl) {
          slugIsAuto = slugEl.value.trim() === '';
          scheduleSlugCheck();
          updateSlugSync();
        }
        updateSeoPreview();
        markDirty();
      }),
    );

    // "Match title" → re-sync the URL to the current title and resume
    // auto-tracking. The save then renames the file + redirects the old URL.
    const slugSyncBtn = $('slug-sync');
    if (slugSyncBtn) {
      slugSyncBtn.addEventListener('click', () => {
        slugEl.value = slugify(titleEl.value);
        slugIsAuto = true;
        scheduleSlugCheck();
        updateSlugSync();
        markDirty();
        slugEl.focus();
      });
    }
    descEl.addEventListener('input', () => {
      updateSocialPreview();
      updateSeoPreview();
      markDirty();
    });
    bodyEl.addEventListener('input', () => {
      updateMetrics();
      markDirty();
    });
    draftEl.addEventListener('change', () => {
      updateStatusPill();
      const nowDraft = draftEl.value === 'true';
      if (nowDraft) {
        TE.toast("Status set to Draft — post won't appear publicly until you set it to Published.");
      } else {
        TE.toast('Status set to Published — click Save & publish to make it live.');
      }
    });

    // Phase 3d: autosave pip click → retry. The pip exposes role=button
    // + tabindex=0 only while in the error state.
    if (autoEl) {
      const retry = () => {
        if (autoEl.dataset.state !== 'error') return;
        // A load failure must RE-LOAD, not save (saving would clobber the
        // post with the blank editor).
        if (loadFailed && currentFile) {
          if (loadFailCount >= 3) return;
          loadPost(currentFile);
          return;
        }
        // A 409 conflict can't be fixed by re-saving the same base version —
        // it just 409s again. Offer to reload the current on-disk copy
        // (which discards local edits), so the user isn't stuck in a loop.
        if (saveConflict && currentFile) {
          const reload = window.confirm(
            'This post changed somewhere else since you opened it. Reload the latest version?\n\n' +
              'Click OK to reload (your changes here will be lost).\n' +
              'Click Cancel to keep your text — you can copy it first.',
          );
          if (reload) {
            loadPost(currentFile);
          } else {
            // User chose to keep their text. Offer a quick copy-to-clipboard
            // so they can paste into a note or the reloaded editor.
            const body = bodyEl ? bodyEl.value : '';
            if (body && navigator.clipboard) {
              navigator.clipboard
                .writeText(body)
                .then(() =>
                  TE.toast(
                    'Your text was copied to clipboard — reload the page when ready, then paste it back.',
                    'info',
                  ),
                )
                .catch(() =>
                  TE.toast(
                    'Copy failed. Select all your text manually (Ctrl+A) and copy before reloading.',
                    'warn',
                  ),
                );
            } else {
              TE.toast(
                'Reload the page to get the latest version. Copy your text first so you do not lose it.',
                'warn',
              );
            }
          }
          return;
        }
        // A transient/save error retries the save.
        savePost();
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
      offerNewDraftRestore();
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
