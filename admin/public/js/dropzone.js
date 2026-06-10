// @ts-check
/**
 * dropzone.js — reusable drop-target factory.
 *
 * Exposes `window.TE.dropzone(target, options)`. The factory makes any
 * element act as a drop target *and* a click-to-pick file input. It
 * doesn't actually upload anything — it just funnels files into the
 * caller-provided `onUpload(files)` callback. That keeps uploads
 * cancellable, retryable, and observable from the page that knows the
 * UI context.
 *
 * Capabilities:
 *   - drag-over highlights via the `is-dragover` CSS class
 *   - drop hands the FileList to `onUpload`
 *   - click or Enter/Space opens a hidden `<input type=file multiple>`
 *     (INLINE targets only — never when the target is document.body, or
 *     every click on the page would pop the OS file chooser)
 *   - if `target === document.body`, the zone is drag + paste ONLY:
 *     capture-phase `paste` events with `clipboardData.files.length > 0`
 *     are routed through onUpload, but clicks are left alone
 *   - keyboard reachable (inline targets): `role="button"`, `tabindex=0`,
 *     `aria-label`
 *   - returns `{ destroy() }` so callers can tear listeners down when
 *     unmounting (used by the library page when switching views)
 *
 * Options:
 *   onUpload(files)      required; receives a FileList or File[]
 *   accept               optional MIME hint string (e.g. "image/*")
 *   multiple             default true
 *   label                visible label (only rendered if target is empty
 *                        when the factory mounts)
 *   ariaLabel            aria-label override; defaults to `label`
 *   pasteOnBody          force-enable body-paste handler (auto-true when
 *                        target === document.body)
 */

(function () {
  if (!window.TE) window.TE = {};
  if (window.TE.dropzone) return;

  /**
   * @typedef {object} DropzoneOptions
   * @property {(files: File[]) => any} onUpload
   * @property {string} [accept]
   * @property {boolean} [multiple]
   * @property {string} [label]
   * @property {string} [ariaLabel]
   * @property {boolean} [pasteOnBody]
   */

  /**
   * @param {HTMLElement | string} targetOrId
   * @param {DropzoneOptions} options
   * @returns {{ destroy: () => void, refresh: () => void, element: HTMLElement }}
   */
  function createDropzone(targetOrId, options) {
    const target =
      typeof targetOrId === 'string' ? document.getElementById(targetOrId) : targetOrId;
    if (!target) {
      throw new Error('TE.dropzone: target element not found');
    }
    if (!options || typeof options.onUpload !== 'function') {
      throw new Error('TE.dropzone: options.onUpload is required');
    }
    const multiple = options.multiple !== false;
    const accept = options.accept || '';
    const label = options.label || 'Drop files here';
    const ariaLabel = options.ariaLabel || label;

    // A whole-page (body) dropzone exists only for "drop/paste anywhere".
    // It must NOT become click-to-pick or keyboard-actionable, otherwise
    // every click (or Space/Enter) on the page opens the OS file chooser.
    // Inline dropzones keep the full click/keyboard affordance.
    const isBody = target === document.body;

    // Make non-button inline targets keyboard-actionable. We don't override
    // <button>/<a> etc. — they're already focusable and self-describing.
    const isNative =
      target instanceof HTMLButtonElement ||
      target instanceof HTMLAnchorElement ||
      target instanceof HTMLInputElement;
    if (!isBody) {
      if (!isNative) {
        if (!target.hasAttribute('role')) target.setAttribute('role', 'button');
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '0');
      }
      if (!target.hasAttribute('aria-label')) target.setAttribute('aria-label', ariaLabel);
    }

    // Body drop zones don't render a label (they're invisible until
    // drag-over). Inline dropzones get a default label if empty.
    if (target !== document.body && target.children.length === 0 && !target.textContent.trim()) {
      const lbl = document.createElement('span');
      lbl.className = 'te-dz-label';
      lbl.textContent = label;
      target.appendChild(lbl);
    }

    // Hidden file picker so click/Enter open the OS chooser.
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.position = 'absolute';
    fileInput.style.left = '-9999px';
    fileInput.style.width = '1px';
    fileInput.style.height = '1px';
    fileInput.style.opacity = '0';
    fileInput.setAttribute('aria-hidden', 'true');
    fileInput.tabIndex = -1;
    if (multiple) fileInput.multiple = true;
    if (accept) fileInput.accept = accept;
    // Sibling, not child: the dropzone container carries role="button",
    // and an interactive descendant (even one with tabindex=-1) trips
    // axe's nested-interactive. Body dropzones keep the child append
    // (document.body has no interactive role).
    if (target === document.body) {
      target.appendChild(fileInput);
    } else {
      target.insertAdjacentElement('afterend', fileInput);
    }

    // ── State ──
    let depth = 0; // dragenter/leave counter; required for nested children

    function emit(fileList) {
      if (!fileList || !fileList.length) return;
      const arr = /** @type {File[]} */ (Array.from(fileList));
      try {
        options.onUpload(arr);
      } catch (err) {
        // We never want a thrown handler to leave us stuck in dragover.
        target.classList.remove('is-dragover');
        depth = 0;
        console.error('[dropzone] onUpload threw:', err);
      }
    }

    function onDragEnter(e) {
      // Only react to drags that actually carry files. Dragging text
      // around the editor shouldn't light up the dropzone.
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      depth += 1;
      target.classList.add('is-dragover');
    }
    function onDragOver(e) {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
    function onDragLeave() {
      depth = Math.max(0, depth - 1);
      if (depth === 0) target.classList.remove('is-dragover');
    }
    function onDrop(e) {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      depth = 0;
      target.classList.remove('is-dragover');
      emit(e.dataTransfer.files);
    }
    function onClick(e) {
      // Don't double-fire when the click came from the hidden input itself.
      if (e.target === fileInput) return;
      fileInput.click();
    }
    function onKey(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    }
    function onInputChange() {
      if (!fileInput.files) return;
      emit(fileInput.files);
      fileInput.value = '';
    }

    // Paste handler — body-only. We swallow paste events that don't
    // carry files so editor paste of HTML/text still flows through to
    // TipTap or whatever else is listening.
    function onPaste(e) {
      const ce = /** @type {ClipboardEvent} */ (e);
      const items = ce.clipboardData && ce.clipboardData.files;
      if (!items || !items.length) return;
      emit(items);
    }

    target.addEventListener('dragenter', onDragEnter);
    target.addEventListener('dragover', onDragOver);
    target.addEventListener('dragleave', onDragLeave);
    target.addEventListener('drop', onDrop);
    // Click/keyboard-to-pick is for inline dropzones only — NEVER body
    // (would hijack every click on the page into a file dialog).
    if (!isBody) {
      target.addEventListener('click', onClick);
      if (!isNative) target.addEventListener('keydown', onKey);
    }
    fileInput.addEventListener('change', onInputChange);

    const wantsPaste = options.pasteOnBody !== false && target === document.body;
    if (wantsPaste) {
      document.addEventListener('paste', onPaste);
    }

    function destroy() {
      target.removeEventListener('dragenter', onDragEnter);
      target.removeEventListener('dragover', onDragOver);
      target.removeEventListener('dragleave', onDragLeave);
      target.removeEventListener('drop', onDrop);
      if (!isBody) {
        target.removeEventListener('click', onClick);
        if (!isNative) target.removeEventListener('keydown', onKey);
      }
      fileInput.removeEventListener('change', onInputChange);
      if (wantsPaste) document.removeEventListener('paste', onPaste);
      if (fileInput.parentNode) fileInput.parentNode.removeChild(fileInput);
      target.classList.remove('is-dragover');
    }

    function refresh() {
      // No-op for now; provided so callers can rebind to a new onUpload
      // (e.g. when the editor swaps which TipTap instance is mounted)
      // without destroying the listeners. Reserved for Phase 5.
    }

    return { destroy, refresh, element: target };
  }

  window.TE.dropzone = createDropzone;
})();
