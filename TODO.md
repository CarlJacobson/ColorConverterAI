# TODO / Known issues

Outstanding work for the client-side app. The old server-era items (Flask secret
handling, WSGI concurrency, base64-through-CSS hacks, EB/nginx) are gone with the
rewrite and have been removed from this list.

## 🟡 Methodology / output quality

See [METHODOLOGY.md](METHODOLOGY.md) for rationale.

- [ ] **Optional dithering** (Floyd–Steinberg) on transfer to reduce gradient
      banding (methodology item **M5**).
- [ ] **Optional luminance-preserving transfer mode** — keep the target's *L*, map
      chroma from the palette, so outputs don't go flat (**M6**).
- [ ] **Palette-card readability.** Hex text is hardcoded white
      (`palette-card.js`) — unreadable on light swatches. Choose black/white per
      swatch by luminance (**M7**).
- [ ] **Consider a better downsample filter.** `CLUSTER_DOWNSAMPLE_MAX_DIM` uses a
      cheap stride subsample; an area-average thumbnail would be slightly higher
      quality (it only affects palette-finding, so impact is small).

## 🟢 Performance

- [ ] **GPU k-means extraction.** The transfer step now runs on the GPU, but
      clustering still runs in the CPU worker and gates the *k* slider. Moving
      k-means to the GPU (parallel reductions for centroid means) is the path to a
      fully real-time slider. Larger, harder effort than the transfer port.
- [ ] **WebGPU backend** as a faster/cleaner alternative to the current WebGL2
      transfer path, for browsers that support it.
- [ ] **Progress granularity.** The worker reports coarse stages; per-iteration
      progress for the transfer assignment on very large images would feel smoother
      (CPU fallback path only).

## 🟢 Repo hygiene

- [ ] Add a `LICENSE` file.
- [ ] Verify the bundled fonts (`coolvetica`, `Sofia Pro`, Poppins, etc.) are
      licensed for web redistribution.
- [ ] `tests.html` / `e2e.html` now live under `tests/`; decide whether to exclude
      that dir from the published build.
- [ ] The old `.env` (local, gitignored) is now unused and can be deleted.

## Edge cases handled (for reference)

- **Determinism** via seeded RNG (not bit-identical to the old faiss output).
- **EXIF orientation** auto-applied on decode (`imageOrientation: 'from-image'`) —
  note this differs from the old PIL path, which ignored EXIF.
- **Alpha** dropped to mirror PIL `.convert('RGB')`; animated GIFs decode to frame 1.
- **k > pixels / empty clusters**: `k` clamped to pixel count, empty clusters
  reseeded; `k` still clamped to `[2, 200]`.
- **Large images**: `MAX_IMAGE_DIM` guard in `image-io.js` against decompression
  bombs / tab OOM.
- **`sessionStorage` quota** wrapped in `try/catch` so a big image can't break the
  page.

---

## ✅ Done — client-side rewrite

- **Removed the entire server stack.** Flask, faiss, Pillow, NumPy, uv, Elastic
  Beanstalk, and nginx are gone; the app is now static files hosted anywhere.
- **Ported the algorithm to JavaScript** (`static/js/palette-core.js`): seeded
  k-means (k-means++ default) + nearest-centroid transfer on typed arrays, running
  in a **Web Worker** so the UI never blocks. Images are processed entirely in the
  browser — **nothing is uploaded**.
- **Canvas replaces PIL** (`image-io.js`, `palette-card.js`) for decode, invert,
  palette-card rendering, and PNG encode.
- **Methodology changes landed:** PNG output (**M2**), k-means++ init (**M4**),
  configurable pre-cluster downsample (**M3**), and perceptual **CIELAB** clustering
  (**M1**) — now the fixed default (the RGB path remains in code but is no longer a
  UI toggle).
- **Frontend rewritten** as small ES modules with real loading/error states, a
  proper inversion flag, wired-up Download buttons, and safe `sessionStorage`.
- **Browser test harnesses** added: `tests.html` (core + worker) and `e2e.html`
  (full canvas pipeline).
- **GPU-accelerated transfer** (`gpu-transfer.js`, WebGL2 fragment shader) for the
  per-pixel nearest-centroid recoloring, with automatic silent fallback to the CPU
  worker. RGB and CIELAB both supported; GPU/CPU parity is checked in `e2e.html`.
- **Faster clustering.** `CLUSTER_DOWNSAMPLE_MAX_DIM` now defaults to 256, and
  k-means runs on a **weighted color histogram** (unique colors × frequency) —
  lossless vs. clustering every downsampled pixel, much faster on limited-palette
  images. Extraction is no longer the dominant cost for typical images.
