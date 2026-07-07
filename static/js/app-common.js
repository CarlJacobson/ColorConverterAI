// app-common.js
//
// Shared UI plumbing for the extractor and transfer pages: a Web Worker wrapper,
// an image "slot" that owns an upload + preview + invert state, and small helpers
// for the k slider, the color space helper, sessionStorage, and status messages.

import { decodeToRgb, invertRgb } from './image-io.js';

// ---------------------------------------------------------------------------
// Worker wrapper — one module worker shared per page, promise-per-request.
// ---------------------------------------------------------------------------

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker('static/js/palette-worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const { id, type } = e.data;
    const entry = pending.get(id);
    if (!entry) return;
    if (type === 'progress') {
      entry.onProgress && entry.onProgress(e.data);
    } else if (type === 'result') {
      pending.delete(id);
      entry.resolve(e.data);
    } else if (type === 'error') {
      pending.delete(id);
      entry.reject(new Error(e.data.message));
    }
  };
  worker.onerror = (e) => {
    // Fail every in-flight request; a worker-level error kills them all.
    for (const [, entry] of pending) entry.reject(new Error(e.message || 'Worker error'));
    pending.clear();
  };
  return worker;
}

/** Post a job to the worker and await its result. `transfer` lists ArrayBuffers to move. */
export function runWorker(message, transfer = [], onProgress) {
  const w = getWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ id, ...message }, transfer);
  });
}

// ---------------------------------------------------------------------------
// ImageSlot — wires a file input + preview div + optional invert button, and
// holds the decoded pixels so a compute can grab them synchronously.
// ---------------------------------------------------------------------------

export class ImageSlot {
  constructor({ input, display, invertButton, storageKey, onChange } = {}) {
    this.display = display;
    this.storageKey = storageKey || null;
    this.onChange = onChange || (() => {});
    this.rgb = null;
    this.width = 0;
    this.height = 0;
    this.inverted = false;
    this._previewUrl = null;

    this._input = input || null;
    if (input) {
      input.addEventListener('change', () => this._onFile(input.files[0]));
      // Clicking the preview area opens the file browser, same as the input itself.
      this.display.classList.add('is-uploadable');
      this.display.addEventListener('click', () => input.click());
    }
    if (invertButton) invertButton.addEventListener('click', () => this.toggleInvert());

    // The window's title-bar "Close" (X) button clears this slot's image.
    const closeButton = this.display.closest('.window')?.querySelector('button[aria-label="Close"]');
    if (closeButton) closeButton.addEventListener('click', () => this.clear());

    if (this.storageKey) this._restore();
  }

  get ready() {
    return this.rgb !== null;
  }

  async _onFile(file) {
    if (!file) return;
    try {
      const decoded = await decodeToRgb(file);
      this.rgb = decoded.rgb;
      this.width = decoded.width;
      this.height = decoded.height;
      this._setPreviewFromBlob(file);
      this._persist(file);
      this.onChange(this);
    } catch (err) {
      this.onChange(this, err);
    }
  }

  _setPreviewFromBlob(blob) {
    if (this._previewUrl) URL.revokeObjectURL(this._previewUrl);
    this._previewUrl = URL.createObjectURL(blob);
    this.display.style.backgroundImage = `url("${this._previewUrl}")`;
    this._applyInvertFilter();
  }

  /** Drop the current image and revert the preview to the default placeholder icon. */
  clear() {
    if (this._previewUrl) {
      URL.revokeObjectURL(this._previewUrl);
      this._previewUrl = null;
    }
    this.rgb = null;
    this.width = 0;
    this.height = 0;
    this.inverted = false;
    this.display.dataset.inverted = '0';
    this.display.style.backgroundImage = ''; // fall back to the CSS placeholder icon
    this.display.style.filter = '';
    if (this._input) this._input.value = ''; // let re-selecting the same file re-fire change
    if (this.storageKey) {
      try {
        sessionStorage.removeItem(this.storageKey);
      } catch (_) {
        /* ignore */
      }
    }
    this.onChange(this);
  }

  toggleInvert() {
    if (!this.ready) return;
    this.inverted = !this.inverted;
    this.display.dataset.inverted = this.inverted ? '1' : '0';
    this._applyInvertFilter();
  }

  _applyInvertFilter() {
    // Visual-only preview; the real inversion happens in pixelsForCompute().
    this.display.style.filter = this.inverted ? 'invert(1)' : '';
  }

  /** Returns a Float32Array ready for the worker, inverting a copy if needed. */
  pixelsForCompute() {
    if (!this.ready) return null;
    if (!this.inverted) return this.rgb;
    return invertRgb(Float32Array.from(this.rgb));
  }

  // Best-effort persistence of the preview across page navigation. Wrapped so a
  // large image throwing QuotaExceededError can never break the page.
  _persist(blob) {
    if (!this.storageKey) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        sessionStorage.setItem(this.storageKey, reader.result);
      } catch (_) {
        /* quota exceeded — skip; the app still works without persistence. */
      }
    };
    reader.readAsDataURL(blob);
  }

  async _restore() {
    let dataUrl = null;
    try {
      dataUrl = sessionStorage.getItem(this.storageKey);
    } catch (_) {
      return;
    }
    if (!dataUrl) return;
    // Paint the stored preview right away so the image appears instantly on
    // navigation; the (main-thread) decode below only feeds the pixel buffer
    // needed for a later compute, so it can finish in the background.
    this.display.style.backgroundImage = `url("${dataUrl}")`;
    try {
      const decoded = await decodeToRgb(dataUrl);
      this.rgb = decoded.rgb;
      this.width = decoded.width;
      this.height = decoded.height;
      this.onChange(this);
    } catch (_) {
      /* bad stored value — drop the preview we optimistically showed */
      this.display.style.backgroundImage = '';
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Wire the k slider to its readout and persist the value safely. */
export function setupKSlider(slider, readout, storageKey = 'k_value') {
  let stored = null;
  try {
    stored = sessionStorage.getItem(storageKey);
  } catch (_) {}
  if (stored !== null) {
    slider.value = stored;
    readout.textContent = stored;
  } else {
    readout.textContent = slider.value;
  }
  slider.addEventListener('input', () => {
    readout.textContent = slider.value;
    try {
      sessionStorage.setItem(storageKey, slider.value);
    } catch (_) {}
  });
}

/**
 * Read the selected working color space from a select/checkbox, defaulting to rgb.
 * NOTE: no longer wired to the UI — the color space is now fixed to CIELAB in the
 * page scripts. Kept for the RGB path (still supported by the worker) and tests.
 */
export function readColorSpace(el) {
  if (!el) return 'rgb';
  if (el.type === 'checkbox') return el.checked ? 'lab' : 'rgb';
  return el.value === 'lab' ? 'lab' : 'rgb';
}

/** Set a status/loading message on an element (creates a simple text overlay). */
export function setStatus(el, message, isError = false) {
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('is-error', !!isError);
  el.style.display = message ? '' : 'none';
}

/**
 * Wire an output window's title-bar Close (X) button to clear its rendered result:
 * revert the preview to its placeholder and disable the download.
 */
export function setupOutputClose(display, { link, downloadButton, status } = {}) {
  const closeButton = display.closest('.window')?.querySelector('button[aria-label="Close"]');
  if (!closeButton) return;
  closeButton.addEventListener('click', () => {
    display.style.backgroundImage = ''; // fall back to the CSS placeholder
    if (link) {
      link.removeAttribute('href');
      link.removeAttribute('download');
    }
    if (downloadButton) downloadButton.disabled = true;
    setStatus(status, '');
  });
}

// True on phones/tablets, where there's no "Downloads folder" and the native share
// sheet ("Save Image" → Photos on iOS, "Save"/Gallery on Android) is the right target.
// iPadOS reports a desktop UA, so also treat touch-capable "Macintosh" as iOS.
function prefersShareSheet() {
  const ua = navigator.userAgent || '';
  const iOS = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return iOS || /Android/.test(ua);
}

/**
 * Save a rendered image. On mobile devices that can share files, this opens the
 * native share sheet so the user can save straight to Photos/Gallery; everywhere
 * else it falls back to a normal file download.
 */
export async function saveImage(url, filename) {
  if (!url) return;
  if (prefersShareSheet() && navigator.canShare) {
    try {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], filename, { type: blob.type || 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return; // user saved (e.g. to Photos) or dismissed the sheet
      }
    } catch (err) {
      // AbortError = user dismissed the sheet on purpose; don't then force a download.
      if (err && err.name === 'AbortError') return;
      // Any other failure falls through to the download fallback below.
    }
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const PROGRESS_LABELS = {
  init: 'Preparing…',
  clustering: 'Finding colors…',
  assigning: 'Recoloring…',
  done: 'Finishing…',
};

export function progressLabel(p) {
  if (p.stage === 'clustering' && p.iteration) {
    return `Finding colors… (${p.iteration}/${p.total})`;
  }
  return PROGRESS_LABELS[p.stage] || 'Working…';
}
