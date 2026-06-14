// @ts-check
/**
 * image-picker.js — a shared "choose an image" modal.
 *
 * Exposes `window.TE.pickImage(onChoose)`: opens a visual grid of the
 * media library's images (with search + upload) and calls
 * `onChoose(mediaItem)` with the chosen record (`{ url, alt_text, … }`).
 *
 * Self-contained: it lazily injects its own `.modal` into <body> the
 * first time it's opened, so it works on any admin page that loads
 * common.js (modal helpers), media.js (upload), and this file — the
 * homepage editor included, which has no inline picker markup.
 */
(function () {
  const TE = (window.TE = window.TE || {});
  const MODAL_ID = 'te-imgpick-modal';
  /** @type {((m: any) => void) | null} */
  let onChooseCb = null;
  /** @type {ReturnType<typeof setTimeout> | number} */
  let searchTimer = 0;

  function ensureModal() {
    let modal = document.getElementById(MODAL_ID);
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = MODAL_ID;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-hidden', 'true');
    modal.setAttribute('aria-labelledby', 'te-imgpick-title');
    modal.innerHTML = `
      <div class="modal-card te-imgpick-card">
        <div class="modal-head">
          <h3 id="te-imgpick-title">Choose an image</h3>
          <button type="button" class="btn ghost" data-modal-close="${MODAL_ID}" aria-label="Cancel">
            <span class="ico" aria-hidden="true" data-icon="close"></span>
          </button>
        </div>
        <div class="modal-body">
          <div class="te-imgpick-bar">
            <label class="te-imgpick-search">
              <span class="sr-only">Search images</span>
              <input type="search" id="te-imgpick-search" placeholder="Search images…" autocomplete="off" />
            </label>
            <label class="btn sm te-imgpick-upload">
              <span class="ico" aria-hidden="true" data-icon="upload"></span>
              <span>Upload</span>
              <input type="file" id="te-imgpick-file" accept="image/*" multiple hidden />
            </label>
          </div>
          <div class="te-imgpick-grid" id="te-imgpick-grid" role="listbox" aria-label="Images"></div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    if (typeof TE.fillIcons === 'function') TE.fillIcons(modal);

    const search = /** @type {HTMLInputElement} */ (modal.querySelector('#te-imgpick-search'));
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadGrid(search.value.trim()), 250);
    });

    const file = /** @type {HTMLInputElement} */ (modal.querySelector('#te-imgpick-file'));
    file.addEventListener('change', async () => {
      if (!file.files || !file.files.length) return;
      if (TE.media && typeof TE.media.upload === 'function') {
        try {
          await TE.media.upload(file.files, {});
          await loadGrid(search.value.trim());
        } catch (_e) {
          if (TE.toast) TE.toast('Upload failed', 'error');
        }
      }
      file.value = '';
    });

    return modal;
  }

  /** @param {string} q */
  async function loadGrid(q) {
    const grid = document.getElementById('te-imgpick-grid');
    if (!grid) return;
    grid.innerHTML = '<p class="te-imgpick-hint"><span class="te-spinner"></span> Loading…</p>';
    try {
      const qs = new URLSearchParams({ type: 'image', limit: '60' });
      if (q) qs.set('q', q);
      const list = await TE.fetchJSON('/api/media?' + qs.toString());
      const items = (list && list.items) || [];
      if (!items.length) {
        grid.innerHTML = `<p class="te-imgpick-hint">${q ? 'No images match.' : 'No images in the library yet — upload one above.'}</p>`;
        return;
      }
      grid.innerHTML = '';
      items.forEach((/** @type {any} */ m) => {
        const name = m.original_name || m.filename || '';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'te-imgpick-item';
        btn.setAttribute('role', 'option');
        btn.title = name;
        btn.innerHTML =
          `<img src="${TE.escape(m.url || '')}" alt="" loading="lazy" decoding="async" />` +
          `<span class="te-imgpick-name">${TE.escape(name)}</span>`;
        btn.addEventListener('click', () => {
          const cb = onChooseCb;
          TE.closeModal(MODAL_ID);
          if (cb) cb(m);
        });
        grid.appendChild(btn);
      });
    } catch (_e) {
      grid.innerHTML = '<p class="te-imgpick-hint">Couldn’t load images.</p>';
    }
  }

  /**
   * Open the picker.
   * @param {(m: any) => void} onChoose called with the chosen media record
   */
  TE.pickImage = function pickImage(onChoose) {
    onChooseCb = typeof onChoose === 'function' ? onChoose : null;
    ensureModal();
    const search = /** @type {HTMLInputElement | null} */ (
      document.getElementById('te-imgpick-search')
    );
    if (search) search.value = '';
    TE.openModal(MODAL_ID);
    loadGrid('');
  };
})();
