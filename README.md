# ColorConverter.ai

A **100% client-side** web app that **extracts color palettes from images** and
**transfers one image's palette onto another**, using k-means clustering in color
space. All computation runs in the browser — **images never leave the device** and
there is no server or backend.

- **Palette Extractor** — upload an image, get its dominant *k* colors back as a
  downloadable palette card (PNG) with hex codes.
- **Palette Transfer** — recolor a *target* image using the palette extracted from
  a *palette* image.

> For how the algorithm works (and its limitations), see
> [METHODOLOGY.md](METHODOLOGY.md). For outstanding work / known issues, see
> [TODO.md](TODO.md).

---

## Tech stack

| Layer      | Choice                                                                 |
|------------|------------------------------------------------------------------------|
| UI         | Static HTML + vanilla ES modules (no framework, no build step)         |
| Compute    | Hand-written k-means + nearest-centroid in a **Web Worker**            |
| Transfer   | **WebGL2** GPU fragment shader for the recolor step, CPU-worker fallback|
| Imaging    | Browser **Canvas** APIs (`createImageBitmap`, `getImageData`, `toBlob`)|
| Hosting    | Any static host (GitHub Pages, Netlify, S3 + CloudFront, …)            |

There is **no Python, no Flask, no faiss, and no dependency install** — the entire
app is the static files in this repo.

## Project structure

```
index.html            # Home
extractor.html        # Palette Extractor UI
transfer.html         # Palette Transfer UI
about.html            # How-it-works / FAQ
tests/
  tests.html          # Browser unit tests for the core math + worker
  e2e.html            # Browser end-to-end test (canvas pipeline + GPU parity)
static/
  js/
    palette-core.js   # Pure math: seeded k-means (++/random), nearest-centroid,
                      #   RGB<->CIELAB, k validation. No DOM. (the algorithm)
    palette-worker.js # Module Web Worker wrapping palette-core (keeps UI responsive)
    gpu-transfer.js   # WebGL2 GPU nearest-centroid transfer (auto, CPU fallback)
    image-io.js       # Canvas decode->RGB, invert, PNG encode, size guard
    palette-card.js   # Renders the palette card (bands + hex) to a PNG
    app-common.js     # Shared UI: worker wrapper, ImageSlot, slider, storage helpers
    extractor.js      # Wires the extractor page
    transfer.js       # Wires the transfer page
  styles/98.css       # Windows-98 retro theme + fonts
  ...                 # sample images, icons
```

## Running locally

Because the app uses ES modules and a module Web Worker, it must be served over
**HTTP** (opening the files via `file://` will not work). There is no build step —
any static file server does the job:

```bash
# Python (any 3.x)
python -m http.server 8000
# then open http://127.0.0.1:8000/

# or Node, if you have it
npx serve
```

## Tests

Open the test harnesses in a browser (served over HTTP as above):

- `tests/tests.html` — unit tests for `palette-core.js` and the worker
  (determinism, k clamping, CIELAB round-trip, transfer correctness, edge cases).
- `tests/e2e.html` — end-to-end test of the real canvas pipeline (decode → extract
  → palette card → transfer → PNG encode) plus GPU-vs-CPU transfer parity.

Each page shows `N passed, M failed` and sets the document title to
`ALL_TESTS_PASSED` / `TESTS_FAILED_<n>` for automated runners.

## Configuration

A couple of knobs live as constants at the top of `static/js/palette-core.js`:

- `CLUSTER_DOWNSAMPLE_MAX_DIM` — thumbnail the clustering training set to this many
  pixels on its longest side before k-means (default **256**; `0` = use every pixel).
  Speeds up extraction on large images with near-identical palettes. Only affects
  palette-finding; the target image is always recolored at full resolution.
- `DEFAULT_INIT` — `'kmeans++'` (default) or `'random'` k-means initialization.

The working color space is fixed to **CIELAB** (the perceptual space) on both pages.
The RGB clustering/assignment path is still fully supported by the worker and
`readColorSpace()` helper, but is no longer exposed as a UI toggle.

## Deployment

Copy the repo contents to any static host — no server runtime required:

- **GitHub Pages**: serve from the repo root (or `/docs`). Links use relative
  `*.html` paths, so no clean-URL config is required.
- **Netlify / Vercel / S3+CloudFront**: drag-and-drop or point at the repo; no build
  command, publish directory is the repo root.

## Privacy

No image data is ever uploaded. Decoding, clustering, and recoloring all happen in
the browser via Canvas and a Web Worker. The only network calls are for the static
assets and Google Analytics page views.
