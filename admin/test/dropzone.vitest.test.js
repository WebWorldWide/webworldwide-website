// @ts-nocheck
/**
 * dropzone.vitest.test.js — jsdom Vitest tests for the Phase 4 dropzone.
 *
 * Covers:
 *   - drag-enter (carrying Files) adds .is-dragover
 *   - dragenter without Files in dataTransfer.types is ignored
 *   - drop with a FileList fires onUpload with the same files
 *   - click on the zone triggers the hidden <input type=file> click
 *   - destroy() removes all listeners (a subsequent drag is a no-op)
 *
 * The module is loaded by reading its source and `eval`-ing inside the
 * jsdom window so the IIFE attaches to `window.TE.dropzone` without
 * needing a bundler.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dropzoneSrc = readFileSync(join(__dirname, '..', 'public', 'js', 'dropzone.js'), 'utf8');

function loadDropzone() {
  // The module is a plain IIFE that attaches to window.TE.dropzone. We
  // run it in the current jsdom environment via Function() so each test
  // can isolate its own copy by re-running on a fresh window.TE.
  delete window.TE;
  new Function(dropzoneSrc).call(window);
  return window.TE.dropzone;
}

function makeFile(name = 'a.txt', type = 'text/plain', content = 'hi') {
  return new File([content], name, { type });
}

function fakeFileDataTransfer(files) {
  // jsdom's DataTransfer doesn't accept items synchronously; we expose
  // just enough surface for the dropzone's checks (`types.includes`,
  // `files`, `dropEffect`).
  return {
    types: ['Files'],
    files,
    dropEffect: 'none',
  };
}

describe('TE.dropzone', () => {
  let target;
  let dropzone;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.createElement('div');
    target.id = 'dz';
    document.body.appendChild(target);
    dropzone = loadDropzone();
  });

  it('throws when target is missing', () => {
    expect(() => dropzone('does-not-exist', { onUpload: () => {} })).toThrow();
  });

  it('throws when onUpload is missing', () => {
    expect(() => dropzone(target, /** @type {any} */ ({}))).toThrow();
  });

  it('adds .is-dragover on dragenter with Files', () => {
    dropzone(target, { onUpload: () => {} });
    const evt = new Event('dragenter', { bubbles: true, cancelable: true });
    /** @type {any} */ (evt).dataTransfer = fakeFileDataTransfer([]);
    target.dispatchEvent(evt);
    expect(target.classList.contains('is-dragover')).toBe(true);
  });

  it('ignores dragenter without Files (drag-text in editor etc.)', () => {
    dropzone(target, { onUpload: () => {} });
    const evt = new Event('dragenter', { bubbles: true, cancelable: true });
    /** @type {any} */ (evt).dataTransfer = { types: ['text/plain'], files: [] };
    target.dispatchEvent(evt);
    expect(target.classList.contains('is-dragover')).toBe(false);
  });

  it('fires onUpload with files on drop', () => {
    const onUpload = vi.fn();
    dropzone(target, { onUpload });
    const file = makeFile();
    const evt = new Event('drop', { bubbles: true, cancelable: true });
    /** @type {any} */ (evt).dataTransfer = fakeFileDataTransfer([file]);
    target.dispatchEvent(evt);
    expect(onUpload).toHaveBeenCalledTimes(1);
    const arg = onUpload.mock.calls[0][0];
    expect(Array.isArray(arg)).toBe(true);
    expect(arg[0]).toBe(file);
    // dragover state should clear after drop.
    expect(target.classList.contains('is-dragover')).toBe(false);
  });

  it('clears .is-dragover on dragleave back to depth=0', () => {
    dropzone(target, { onUpload: () => {} });
    const enter = new Event('dragenter');
    /** @type {any} */ (enter).dataTransfer = fakeFileDataTransfer([]);
    target.dispatchEvent(enter);
    expect(target.classList.contains('is-dragover')).toBe(true);
    target.dispatchEvent(new Event('dragleave'));
    expect(target.classList.contains('is-dragover')).toBe(false);
  });

  it('click on the zone triggers the hidden file input click', () => {
    dropzone(target, { onUpload: () => {} });
    const hidden = target.querySelector('input[type=file]');
    expect(hidden).toBeTruthy();
    const clickSpy = vi.spyOn(/** @type {HTMLElement} */ (hidden), 'click');
    target.click();
    expect(clickSpy).toHaveBeenCalled();
  });

  it('Enter/Space on a non-native target opens the file picker', () => {
    dropzone(target, { onUpload: () => {} });
    const hidden = target.querySelector('input[type=file]');
    const clickSpy = vi.spyOn(/** @type {HTMLElement} */ (hidden), 'click');
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(clickSpy).toHaveBeenCalled();
  });

  it('exposes role=button and tabindex for keyboard reach', () => {
    dropzone(target, { onUpload: () => {}, label: 'Upload here' });
    expect(target.getAttribute('role')).toBe('button');
    expect(target.getAttribute('tabindex')).toBe('0');
    expect(target.getAttribute('aria-label')).toBe('Upload here');
  });

  it('destroy() removes listeners; later drag does nothing', () => {
    const onUpload = vi.fn();
    const handle = dropzone(target, { onUpload });
    handle.destroy();
    const evt = new Event('drop');
    /** @type {any} */ (evt).dataTransfer = fakeFileDataTransfer([makeFile()]);
    target.dispatchEvent(evt);
    expect(onUpload).not.toHaveBeenCalled();
  });
});
