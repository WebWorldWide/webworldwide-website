// @ts-check
/**
 * homepage.js — the Homepage editor view (client side).
 *
 * Renders into #homepage-root: a 392px rail of editable section cards
 * (Hero, Apps, Videos, Socials, Blog CTA) next to a live WYSIWYG
 * preview of the public homepage. The model comes from
 * GET /api/settings/homepage (see admin/src/routes/settings.js);
 * Save PATCHes the full edited model back; Publish PATCHes (if dirty)
 * and then POSTs /api/publish to commit + push site/.
 *
 * State model: `saved` is the last server-acknowledged snapshot,
 * `draft` is the working copy. Text edits re-render ONLY the preview
 * (so inputs keep focus); structural changes (add/remove/reorder/
 * toggle) rebuild the rail too.
 */
(function () {
  /** The five homepage sections — labels + rail subtitles. */
  const SECTION_LABELS = {
    hero: 'Hero',
    apps: 'Apps',
    videos: 'Videos',
    socials: 'Socials',
    blog_cta: 'Blog CTA',
  };

  const STATUS_LABEL = { live: '★ live', soon: 'coming soon', lab: 'in the lab' };

  /** Display names + brand fills for the 9 known social keys. */
  const SOCIAL_META = {
    youtube: { name: 'YouTube', brand: '#f00' },
    github: { name: 'GitHub', brand: '#1a1a1a' },
    twitter: { name: 'Twitter', brand: '#000' },
    bluesky: { name: 'Bluesky', brand: '#1185fe' },
    mastodon: { name: 'Mastodon', brand: '#6364ff' },
    reddit: { name: 'Reddit', brand: '#ff4500' },
    instagram: { name: 'Instagram', brand: '#d62976' },
    threads: { name: 'Threads', brand: '#000' },
    email: { name: 'Email', brand: '#0e2960' },
  };

  const MAX_WORDS = 5;
  const MAX_APPS = 8;
  const SITE_URL = 'https://webworldwide.online';

  // ── Inline icons (stroke = currentColor, same Lucide style as icons.js) ──
  /** @param {string} inner */
  const svg = (inner) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    inner +
    '</svg>';
  const IC = {
    drag: svg(
      '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
    ),
    chevUp: svg('<path d="m18 15-6-6-6 6"/>'),
    chevDown: svg('<path d="m6 9 6 6 6-6"/>'),
    eye: svg(
      '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    ),
    eyeOff: svg(
      '<path d="m3 3 18 18"/><path d="M10.6 5.1C11 5 11.5 5 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.9 3.6"/><path d="M6.6 6.6A16.8 16.8 0 0 0 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.9-1.3"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    ),
    trash: svg(
      '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
    ),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    refresh: svg('<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>'),
    check: svg('<path d="m4 12 5 5L20 6"/>'),
    rocket: svg(
      '<path d="M5 13c-1.5-1.5-1-5 1-7s5.5-2.5 7-1c0 0 6-2 8-1s-1 8-1 8c1.5 1.5 1 5.5-1 7.5s-5.5 2.5-7 1"/><path d="m9 15 6-6"/><path d="M5 19c-1 1-1.5 3-1.5 3s2-.5 3-1.5"/>',
    ),
    globe: svg(
      '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3.5 9h17M3.5 15h17"/>',
    ),
  };

  /**
   * Working copy being edited in the rail.
   * @type {any}
   */
  let draft = null;
  /**
   * Last server-acknowledged model (deep snapshot).
   * @type {any}
   */
  let saved = null;
  /** Section id whose card is highlighted + matched in the preview. */
  let selected = 'hero';
  /**
   * Section id whose card body is expanded (one at a time).
   * @type {string | null}
   */
  let open = 'hero';
  /** @type {'desktop' | 'phone'} */
  let device = 'desktop';
  /** True after a successful Save until the next Publish. */
  let savedNotLive = false;
  let wired = false;

  function root() {
    return document.getElementById('homepage-root');
  }

  /** @param {any} m */
  const clone = (m) => JSON.parse(JSON.stringify(m));

  function isDirty() {
    return JSON.stringify(draft) !== JSON.stringify(saved);
  }

  const esc = (/** @type {unknown} */ s) => TE.escape(s);

  /**
   * Set a dot-path (e.g. 'apps.items.0.name') on the draft.
   * @param {string} path
   * @param {string} value
   */
  function setPath(path, value) {
    const parts = path.split('.');
    let t = draft;
    for (let i = 0; i < parts.length - 1; i++) {
      // eslint-disable-next-line security/detect-object-injection -- path comes from our own data-path attributes
      t = t[parts[i]];
      if (t === null || typeof t !== 'object') return;
    }
    t[parts[parts.length - 1]] = value;
  }

  /**
   * Swap arr[i] and arr[i+d] in place (no-op when out of range).
   * @param {any[]} arr
   * @param {number} i
   * @param {number} d
   * @returns {boolean} whether a swap happened
   */
  function swap(arr, i, d) {
    const j = i + d;
    if (j < 0 || j >= arr.length) return false;
    // eslint-disable-next-line security/detect-object-injection -- bounds-checked indices
    [arr[i], arr[j]] = [arr[j], arr[i]];
    return true;
  }

  // ── Rail: section field editors ────────────────────────────
  function heroFields() {
    const words = draft.hero.words;
    return `
      <div class="hp-field-row">
        ${words
          .map(
            (/** @type {string} */ w, /** @type {number} */ i) => `
          <div class="hp-field">
            <label for="hp-word-${i}">Word ${i + 1}</label>
            <div class="hp-word">
              <input id="hp-word-${i}" type="text" maxlength="24" value="${esc(w)}" data-path="hero.words.${i}" />
              <button type="button" class="hp-mini-ic" data-act="word-del" data-i="${i}" title="Remove word" aria-label="Remove word ${i + 1}" ${words.length <= 1 ? 'disabled' : ''}>${IC.trash}</button>
            </div>
          </div>`,
          )
          .join('')}
      </div>
      <button type="button" class="hp-add" data-act="word-add" ${words.length >= MAX_WORDS ? 'disabled' : ''}>${IC.plus} Add word</button>
      <div class="hp-field" style="margin-top:8px">
        <label for="hp-hero-tagline">Tagline</label>
        <input id="hp-hero-tagline" type="text" maxlength="80" value="${esc(draft.hero.tagline)}" data-path="hero.tagline" />
      </div>`;
  }

  function appsFields() {
    const items = draft.apps.items;
    return `
      ${items
        .map(
          (/** @type {any} */ a, /** @type {number} */ i) => `
        <div class="hp-item">
          <div class="hp-item-head">
            <span class="hi-name">${esc(a.name) || 'Untitled'}</span>
            <span class="hi-tools">
              <button type="button" class="hp-mini-ic" data-act="app-up" data-i="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>${IC.chevUp}</button>
              <button type="button" class="hp-mini-ic" data-act="app-down" data-i="${i}" title="Move down" ${i === items.length - 1 ? 'disabled' : ''}>${IC.chevDown}</button>
              <button type="button" class="hp-mini-ic" data-act="app-del" data-i="${i}" title="Remove app">${IC.trash}</button>
            </span>
          </div>
          <div class="hp-field">
            <label for="hp-app-name-${i}">Name</label>
            <input id="hp-app-name-${i}" type="text" maxlength="40" value="${esc(a.name)}" data-path="apps.items.${i}.name" />
          </div>
          <div class="hp-field-row">
            <div class="hp-field">
              <label for="hp-app-status-${i}">Status</label>
              <select id="hp-app-status-${i}" data-path="apps.items.${i}.status">
                ${['live', 'soon', 'lab']
                  .map(
                    (s) =>
                      // eslint-disable-next-line security/detect-object-injection -- s from a constant list
                      `<option value="${s}" ${a.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`,
                  )
                  .join('')}
              </select>
            </div>
            <div class="hp-field">
              <label for="hp-app-icon-${i}">Icon path</label>
              <input id="hp-app-icon-${i}" type="text" placeholder="/assets/icon.png" value="${esc(a.icon)}" data-path="apps.items.${i}.icon" />
            </div>
          </div>
          <div class="hp-field">
            <label for="hp-app-link-${i}">Link</label>
            <input id="hp-app-link-${i}" type="text" placeholder="https://…" value="${esc(a.link)}" data-path="apps.items.${i}.link" />
          </div>
        </div>`,
        )
        .join('')}
      <button type="button" class="hp-add" data-act="app-add" ${items.length >= MAX_APPS ? 'disabled' : ''}>${IC.plus} Add app</button>`;
  }

  function videosFields() {
    return `
      <div class="hp-field-row">
        <div class="hp-field">
          <label for="hp-videos-episode">Episode</label>
          <input id="hp-videos-episode" type="text" maxlength="80" value="${esc(draft.videos.episode)}" data-path="videos.episode" />
        </div>
        <div class="hp-field">
          <label for="hp-videos-title">Film title</label>
          <input id="hp-videos-title" type="text" maxlength="80" value="${esc(draft.videos.film_title)}" data-path="videos.film_title" />
        </div>
      </div>`;
  }

  function socialsFields() {
    const order = draft.socials.order;
    const hidden = draft.socials.hidden;
    return order
      .map((/** @type {string} */ key, /** @type {number} */ i) => {
        const meta = Object.prototype.hasOwnProperty.call(SOCIAL_META, key)
          ? // eslint-disable-next-line security/detect-object-injection -- key checked via hasOwnProperty
            SOCIAL_META[key]
          : { name: key, brand: '' };
        const shown = !hidden.includes(key);
        return `
        <div class="hp-item${shown ? '' : ' off'}">
          <div class="hp-item-head">
            <span class="pv-social-ico"${meta.brand ? ` style="--brand:${meta.brand}"` : ''} aria-hidden="true">${esc(meta.name.charAt(0))}</span>
            <span class="hi-name">${esc(meta.name)}</span>
            <span class="hi-tools">
              <button type="button" class="hp-mini-ic${shown ? '' : ' off'}" data-act="soc-toggle" data-key="${esc(key)}" title="${shown ? 'Hide' : 'Show'}" aria-pressed="${shown}">${shown ? IC.eye : IC.eyeOff}</button>
              <button type="button" class="hp-mini-ic" data-act="soc-up" data-i="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>${IC.chevUp}</button>
              <button type="button" class="hp-mini-ic" data-act="soc-down" data-i="${i}" title="Move down" ${i === order.length - 1 ? 'disabled' : ''}>${IC.chevDown}</button>
            </span>
          </div>
        </div>`;
      })
      .join('');
  }

  function blogCtaFields() {
    return `
      <div class="hp-field">
        <label for="hp-cta-kicker">Kicker</label>
        <input id="hp-cta-kicker" type="text" maxlength="80" value="${esc(draft.blog_cta.kicker)}" data-path="blog_cta.kicker" />
      </div>
      <div class="hp-field-row">
        <div class="hp-field">
          <label for="hp-cta-title">Title</label>
          <input id="hp-cta-title" type="text" maxlength="80" value="${esc(draft.blog_cta.title)}" data-path="blog_cta.title" />
        </div>
        <div class="hp-field">
          <label for="hp-cta-accent">Title (accent)</label>
          <input id="hp-cta-accent" type="text" maxlength="80" value="${esc(draft.blog_cta.title_accent)}" data-path="blog_cta.title_accent" />
        </div>
      </div>
      <div class="hp-field">
        <label for="hp-cta-url">Link target</label>
        <input id="hp-cta-url" type="text" maxlength="80" value="${esc(draft.blog_cta.url)}" data-path="blog_cta.url" />
      </div>`;
  }

  /** @param {string} id */
  function sectionFields(id) {
    switch (id) {
      case 'hero':
        return heroFields();
      case 'apps':
        return appsFields();
      case 'videos':
        return videosFields();
      case 'socials':
        return socialsFields();
      case 'blog_cta':
        return blogCtaFields();
      default:
        return '';
    }
  }

  /** @param {string} id */
  function sectionSubtitle(id) {
    switch (id) {
      case 'hero':
        return 'wordmark + tagline';
      case 'apps':
        return `${draft.apps.items.length} apps`;
      case 'videos':
        return 'channel block';
      case 'socials': {
        const total = draft.socials.order.length;
        const shownCount = draft.socials.order.filter(
          (/** @type {string} */ k) => !draft.socials.hidden.includes(k),
        ).length;
        return `${shownCount} of ${total} shown`;
      }
      case 'blog_cta':
        return 'blog handoff';
      default:
        return '';
    }
  }

  function renderRail() {
    const scroll = document.getElementById('hp-rail-scroll');
    if (!scroll || !draft) return;
    scroll.innerHTML = draft.section_order
      .map((/** @type {string} */ id, /** @type {number} */ i) => {
        // eslint-disable-next-line security/detect-object-injection -- id validated against SECTION_LABELS
        const label = SECTION_LABELS[id] || id;
        // eslint-disable-next-line security/detect-object-injection -- id validated against SECTION_LABELS
        const on = draft.sections[id] !== false;
        const isOpen = open === id;
        return `
        <div class="hp-sec${selected === id ? ' sel' : ''}${isOpen ? ' open' : ''}${on ? '' : ' off'}" data-id="${esc(id)}">
          <div class="hp-sec-head" data-act="sec-head" data-id="${esc(id)}">
            <span class="hp-sec-grab" aria-hidden="true">${IC.drag}</span>
            <span class="hp-sec-name">${esc(label)}<span class="tiny">${esc(sectionSubtitle(id))}</span></span>
            <span class="hp-sec-tools">
              <button type="button" class="hp-mini-ic" data-act="sec-up" data-i="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>${IC.chevUp}</button>
              <button type="button" class="hp-mini-ic" data-act="sec-down" data-i="${i}" title="Move down" ${i === draft.section_order.length - 1 ? 'disabled' : ''}>${IC.chevDown}</button>
              <button type="button" class="hp-mini-ic${on ? '' : ' off'}" data-act="sec-toggle" data-id="${esc(id)}" title="${on ? 'Hide section' : 'Show section'}" aria-pressed="${on}">${on ? IC.eye : IC.eyeOff}</button>
            </span>
            <span class="hp-sec-chev" aria-hidden="true">${IC.chevDown}</span>
          </div>
          ${isOpen ? `<div class="hp-sec-body">${sectionFields(id)}</div>` : ''}
        </div>`;
      })
      .join('');
  }

  // ── Preview blocks ──────────────────────────────────────────
  function pvHero() {
    const words = draft.hero.words;
    const globeAfter = Math.floor((words.length - 1) / 2);
    return `
      <div class="pv-hero">
        <div class="pv-words">
          ${words
            .map(
              (/** @type {string} */ w, /** @type {number} */ i) =>
                `<span class="pv-word">${esc(w)}</span>` +
                (i === globeAfter ? `<span class="pv-globe">${IC.globe}</span>` : ''),
            )
            .join('')}
        </div>
        <div class="pv-tagline">${esc(draft.hero.tagline)}</div>
      </div>`;
  }

  /** @param {string} eyebrow */
  function pvApps(eyebrow) {
    return `
      <div class="pv-sec">
        <div class="pv-eyebrow">${eyebrow} — Apps</div>
        <div class="pv-apps">
          ${draft.apps.items
            .map((/** @type {any} */ a) => {
              const status = ['live', 'soon', 'lab'].includes(a.status) ? a.status : 'soon';
              const ph = `<span class="ph">${esc((a.name || '№').charAt(0))}</span>`;
              return `
              <div class="pv-app">
                <div class="pv-app-ico">${a.icon ? `<img src="${esc(a.icon)}" alt="" />` : ph}</div>
                <div class="pv-app-cap">${esc(a.name)}<span class="pv-app-status ${status}">${
                  // eslint-disable-next-line security/detect-object-injection -- status normalized above
                  STATUS_LABEL[status]
                }</span></div>
              </div>`;
            })
            .join('')}
        </div>
      </div>`;
  }

  /** @param {string} eyebrow */
  function pvVideos(eyebrow) {
    return `
      <div class="pv-sec">
        <div class="pv-eyebrow">${eyebrow} — Videos</div>
        <div class="pv-film">
          <div class="pv-film-handle"><span class="rec"></span>@web_world_wide</div>
          <div class="pv-film-meta"><span>${esc(draft.videos.episode)}</span><span>00:00</span></div>
          <div class="pv-play"><span class="tri"></span></div>
          <div class="pv-film-title">${esc(draft.videos.film_title)}</div>
        </div>
        <div class="pv-sub-row">
          <span class="pv-sub"><span class="g"></span> Subscribe</span>
          <span class="pv-yt-handle">@web_world_wide</span>
        </div>
      </div>`;
  }

  /** @param {string} eyebrow */
  function pvSocials(eyebrow) {
    const shown = draft.socials.order.filter(
      (/** @type {string} */ k) => !draft.socials.hidden.includes(k),
    );
    return `
      <div class="pv-sec">
        <div class="pv-eyebrow">${eyebrow} — Socials</div>
        <div class="pv-socials">
          ${shown
            .map((/** @type {string} */ key) => {
              const meta = Object.prototype.hasOwnProperty.call(SOCIAL_META, key)
                ? // eslint-disable-next-line security/detect-object-injection -- key checked via hasOwnProperty
                  SOCIAL_META[key]
                : { name: key, brand: '' };
              return `
              <div class="pv-social"${meta.brand ? ` style="--brand:${meta.brand}"` : ''}>
                <div class="pv-social-ico">${esc(meta.name.charAt(0))}</div>
                <div class="pv-social-txt">
                  <div class="pv-social-name">${esc(meta.name)}</div>
                  <div class="pv-social-handle">@${esc(meta.name.toLowerCase())}</div>
                </div>
              </div>`;
            })
            .join('')}
        </div>
      </div>`;
  }

  function pvBlogCta() {
    return `
      <div class="pv-footer">
        <div class="pv-footer-kicker">${esc(draft.blog_cta.kicker)}</div>
        <div class="pv-footer-card">
          <div class="pv-footer-label"><span>${esc(draft.blog_cta.title)}</span><span class="accent">${esc(draft.blog_cta.title_accent)}</span></div>
          <div class="pv-footer-arrow">→</div>
        </div>
      </div>`;
  }

  function renderPreview() {
    const canvas = document.getElementById('hp-canvas');
    if (!canvas || !draft) return;
    canvas.className = `hp-canvas${device === 'phone' ? ' phone' : ''}`;
    const visible = draft.section_order.filter(
      // eslint-disable-next-line security/detect-object-injection -- id from the model's own order
      (/** @type {string} */ id) => draft.sections[id] !== false,
    );
    // Eyebrow numbering follows display order of the numbered sections.
    let n = 0;
    const eyebrow = () => String(++n).padStart(2, '0');
    canvas.innerHTML = visible
      .map((/** @type {string} */ id) => {
        let inner = '';
        if (id === 'hero') inner = pvHero();
        else if (id === 'apps') inner = pvApps(eyebrow());
        else if (id === 'videos') inner = pvVideos(eyebrow());
        else if (id === 'socials') inner = pvSocials(eyebrow());
        else if (id === 'blog_cta') inner = pvBlogCta();
        // eslint-disable-next-line security/detect-object-injection -- id validated against SECTION_LABELS
        const label = SECTION_LABELS[id] || id;
        return `
        <div class="pv-block${selected === id ? ' sel' : ''}" data-pv="${esc(id)}">
          <span class="pv-tag">edit ${esc(label)}</span>
          ${inner}
        </div>`;
      })
      .join('');
  }

  // ── Dirty / action-row state ────────────────────────────────
  function renderDirty() {
    const dirty = isDirty();
    const ind = document.getElementById('hp-dirty');
    if (ind) {
      ind.classList.toggle('unsaved', dirty);
      const txt = document.getElementById('hp-dirty-text');
      if (txt) txt.textContent = dirty ? 'Unsaved changes' : 'All changes saved';
    }
    const discard = /** @type {HTMLButtonElement | null} */ (document.getElementById('hp-discard'));
    if (discard) discard.disabled = !dirty;
    const save = /** @type {HTMLButtonElement | null} */ (document.getElementById('hp-save'));
    if (save) {
      save.disabled = !dirty;
      save.classList.toggle('primary', dirty);
    }
    const hint = document.getElementById('hp-hint');
    if (hint) hint.hidden = !savedNotLive;
  }

  /** Re-render after a structural change (add/remove/reorder/toggle). */
  function renderAll() {
    renderRail();
    renderPreview();
    renderDirty();
  }

  // ── Actions ─────────────────────────────────────────────────
  /**
   * PATCH the full draft; on success both snapshots take the server's
   * normalized model.
   * @returns {Promise<boolean>} whether the save succeeded
   */
  async function saveDraft() {
    try {
      const updated = await TE.fetchJSON('/api/settings/homepage', {
        method: 'PATCH',
        body: JSON.stringify(draft),
      });
      saved = clone(updated);
      draft = clone(updated);
      savedNotLive = true;
      return true;
    } catch (err) {
      // Prefer the route's human-readable `message` (the joined validation
      // problems) over fetchJSON's terse `error` code.
      const e = /** @type {Error & {data?: {message?: string}}} */ (err);
      TE.toast((e.data && e.data.message) || e.message || 'Save failed', 'error');
      return false;
    }
  }

  async function onSave() {
    if (!(await saveDraft())) return;
    renderAll();
    TE.toast('Homepage saved to the Pi — publish to make it live.');
  }

  async function onPublish() {
    if (isDirty() && !(await saveDraft())) {
      renderAll();
      return;
    }
    try {
      const res = await TE.fetchJSON('/api/publish', { method: 'POST' });
      savedNotLive = false;
      renderAll();
      TE.toast((res && res.message) || 'Published.');
    } catch (err) {
      renderAll();
      TE.toast(/** @type {Error} */ (err).message || 'Publish failed', 'error');
    }
  }

  function onDiscard() {
    draft = clone(saved);
    renderAll();
  }

  /**
   * Select a section: highlight its preview block, expand + scroll its
   * rail card into view.
   * @param {string} id
   */
  function select(id) {
    selected = id;
    open = id;
    renderRail();
    renderPreview();
    const card = document.querySelector(`.hp-sec[data-id="${CSS.escape(id)}"]`);
    if (card && typeof card.scrollIntoView === 'function') {
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ── Event wiring (delegated on stable ancestors) ────────────
  /** @param {Element} el */
  function railAction(el) {
    const act = el.getAttribute('data-act');
    const i = Number(el.getAttribute('data-i'));
    switch (act) {
      case 'discard':
        onDiscard();
        return;
      case 'save':
        onSave();
        return;
      case 'publish':
        onPublish();
        return;
      case 'sec-head': {
        const id = el.getAttribute('data-id') || '';
        open = open === id ? null : id;
        selected = id;
        break;
      }
      case 'sec-up':
      case 'sec-down':
        if (!swap(draft.section_order, i, act === 'sec-up' ? -1 : 1)) return;
        break;
      case 'sec-toggle': {
        const id = el.getAttribute('data-id') || '';
        // eslint-disable-next-line security/detect-object-injection -- id rendered from the model's own order
        draft.sections[id] = draft.sections[id] === false;
        break;
      }
      case 'word-add':
        if (draft.hero.words.length >= MAX_WORDS) return;
        draft.hero.words.push('');
        break;
      case 'word-del':
        if (draft.hero.words.length <= 1) return;
        draft.hero.words.splice(i, 1);
        break;
      case 'app-add':
        if (draft.apps.items.length >= MAX_APPS) return;
        draft.apps.items.push({ name: 'New app', status: 'lab', link: '', icon: '' });
        break;
      case 'app-del':
        draft.apps.items.splice(i, 1);
        break;
      case 'app-up':
      case 'app-down':
        if (!swap(draft.apps.items, i, act === 'app-up' ? -1 : 1)) return;
        break;
      case 'soc-up':
      case 'soc-down':
        if (!swap(draft.socials.order, i, act === 'soc-up' ? -1 : 1)) return;
        break;
      case 'soc-toggle': {
        const key = el.getAttribute('data-key') || '';
        const idx = draft.socials.hidden.indexOf(key);
        if (idx >= 0) draft.socials.hidden.splice(idx, 1);
        else draft.socials.hidden.push(key);
        break;
      }
      default:
        return;
    }
    renderAll();
  }

  function wire() {
    if (wired) return;
    wired = true;
    const el = root();
    if (!el) return;

    el.addEventListener('click', (e) => {
      const target = /** @type {Element} */ (e.target);

      // Rail buttons / card heads (buttons win over the head they sit in).
      const actEl = target.closest('[data-act]');
      if (actEl && el.contains(actEl)) {
        railAction(actEl);
        return;
      }

      // Preview block → select the matching rail card.
      const block = target.closest('[data-pv]');
      if (block) {
        select(block.getAttribute('data-pv') || 'hero');
        return;
      }

      // Device segmented control.
      const seg = target.closest('[data-device]');
      if (seg) {
        device = /** @type {'desktop' | 'phone'} */ (seg.getAttribute('data-device') || 'desktop');
        document.querySelectorAll('.hp-seg [data-device]').forEach((b) => {
          const on = b.getAttribute('data-device') === device;
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', String(on));
        });
        renderPreview();
      }
    });

    // Text edits: update the draft + re-render only the preview so the
    // input keeps focus. 'change' covers <select>. The preview is a
    // full innerHTML rebuild — too heavy per keystroke on a Pi — so it
    // trails the typing by 180ms; the dirty indicator updates
    // immediately (a cheap class toggle).
    let previewTimer = 0;
    /** @param {Event} e */
    const onEdit = (e) => {
      const t = /** @type {HTMLInputElement | HTMLSelectElement} */ (e.target);
      const path = t && t.getAttribute && t.getAttribute('data-path');
      if (!path) return;
      setPath(path, t.value);
      renderDirty();
      window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(renderPreview, 180);
    };
    el.addEventListener('input', onEdit);
    el.addEventListener('change', onEdit);

    window.addEventListener('beforeunload', (e) => {
      if (draft && isDirty()) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    // beforeunload only fires on full page loads; the router consults
    // this guard before switching views on a hash change.
    window.TE.viewGuards = window.TE.viewGuards || {};
    window.TE.viewGuards.homepage = () =>
      draft && isDirty() ? 'You have unsaved homepage changes.' : null;
  }

  function renderShell() {
    const el = root();
    if (!el) return;
    el.innerHTML = `
      <div class="hp">
        <div class="hp-rail">
          <div class="hp-rail-head">
            <span class="hr-title">Homepage</span>
            <span class="hp-dirty" id="hp-dirty" role="status"><span class="d" aria-hidden="true"></span><span id="hp-dirty-text">All changes saved</span></span>
          </div>
          <div class="hp-rail-actions">
            <button type="button" class="btn" id="hp-discard" data-act="discard" disabled>${IC.refresh} Discard</button>
            <button type="button" class="btn" id="hp-save" data-act="save" disabled>${IC.check} Save</button>
            <button type="button" class="btn solid" id="hp-publish" data-act="publish">${IC.rocket} Publish</button>
          </div>
          <div class="hp-hint" id="hp-hint" hidden>Saved to Pi · not yet live — Publish pushes the site.</div>
          <div class="hp-rail-scroll" id="hp-rail-scroll"></div>
        </div>
        <div class="hp-preview">
          <div class="hp-preview-bar">
            <span class="pb-label"><span class="live" aria-hidden="true"></span>Live preview</span>
            <div class="hp-seg" role="group" aria-label="Preview device">
              <button type="button" class="on" data-device="desktop" aria-pressed="true">Desktop</button>
              <button type="button" data-device="phone" aria-pressed="false">Phone</button>
            </div>
            <a class="btn sm" href="${SITE_URL}" target="_blank" rel="noopener">Open site ↗</a>
          </div>
          <div class="hp-preview-scroll">
            <div class="hp-canvas" id="hp-canvas"></div>
          </div>
        </div>
      </div>`;
  }

  // ── Init ────────────────────────────────────────────────────
  async function init() {
    const el = root();
    if (!el) return;
    /** @type {any} */
    let model;
    try {
      model = await TE.fetchJSON('/api/settings/homepage');
    } catch (err) {
      el.innerHTML = `
        <div class="panel"><div class="empty">
          <div class="e-mark">∅</div>
          <div class="e-text">Couldn’t load the homepage model — ${esc(/** @type {Error} */ (err).message)}</div>
        </div></div>`;
      return;
    }
    saved = clone(model);
    draft = clone(model);
    selected = 'hero';
    open = 'hero';
    savedNotLive = false;
    renderShell();
    wire();
    renderAll();
  }

  window.TE = window.TE || {};
  window.TE.routes = window.TE.routes || {};
  window.TE.routes.homepage = init;
})();
