# Methodology

How ColorConverter.ai extracts and transfers color palettes, and the trade-offs
behind each step. Everything runs **client-side in the browser**; the algorithm
lives in [`static/js/palette-core.js`](static/js/palette-core.js) and runs inside a
Web Worker ([`static/js/palette-worker.js`](static/js/palette-worker.js)) so the UI
stays responsive.

## Color as a 3D space

Every pixel has a Red, Green, and Blue value in `[0, 255]`. Treat those three
numbers as coordinates and each pixel becomes a **point in a 3D "color space"**
(R, G, B on the X, Y, Z axes). An image is then just a cloud of points in that
cube. "Finding an image's palette" means finding a small set of representative
points in that cloud.

## Step 1 — Palette extraction (k-means)

Given a palette image and a target number of colors *k*:

1. Every pixel is turned into a 3D point (`float32`).
2. **k-means** partitions the cloud into *k* clusters, each summarized by its
   center of mass (**centroid**). Centroids land in the densest regions of the
   cloud, so they approximate the image's most prominent colors.
3. The *k* centroids are rounded to `uint8` RGB — that list **is** the palette.

We use a hand-written **Lloyd's k-means** (25 iterations) with typed arrays,
running in a Web Worker. It is plenty fast for this workload and needs no native
library.

### Implementation details

- **Initialization.** k-means++ by default (probability-weighted seeding), which
  gives steadier clusters than picking random pixels. Selectable via `DEFAULT_INIT`
  in `palette-core.js`.
- **Determinism.** A seeded RNG (`seed = 0`) means the same image + same *k* +
  same options yields the same palette every run. Note this does **not** reproduce
  the old faiss output bit-for-bit (different RNG and float-summation order) — it is
  self-consistent and visually equivalent.
- **Downsampling.** `CLUSTER_DOWNSAMPLE_MAX_DIM` (default **256**) thumbnails the
  *clustering training set* before k-means for a big speedup with near-identical
  palettes (`0` = use every pixel). It never affects the full-resolution target
  recoloring.
- **Weighted color histogram.** After downsampling, identical colors are collapsed
  into a histogram and k-means runs on the **unique colors weighted by frequency**.
  A weighted mean equals the mean of the duplicated pixels, so this is *lossless*
  relative to clustering every (downsampled) pixel — it just runs on far fewer
  points, which is a large speedup on limited-palette art. A consequence: `k` is
  clamped to the number of distinct colors (you can't get 20 centroids from a
  5-color image).
- **Empty clusters** are reseeded to the worst-served pixel so *k* is always
  honored and there is no divide-by-zero, and *k* is clamped to the pixel count for
  tiny images.
- **Color space.** Clustering and assignment run in
  **CIELAB** (the perceptual space; see the note below). The raw-RGB path is still
  supported in `palette-core.js` but is no longer exposed as a UI toggle.

## Step 2 — Palette transfer (nearest-centroid recoloring)

To apply a palette to a target image:

1. Build a nearest-neighbor index over the *k* palette centroids.
2. For **each pixel** in the target image, find the centroid closest to it (L2 /
   Euclidean distance in RGB) and replace the pixel with that centroid's color.
3. Reshape the recolored pixels back into an image.

The result is the target image redrawn using only the palette's *k* colors. This
is really **color quantization against another image's palette** — a specific,
legitimate technique, though narrower than "style transfer."

## Step 3 — Palette card rendering

The extractor also produces a shareable palette image: one colored stripe per
centroid, resized/rotated into a card, with each color's hex code drawn on top.

## Quality options & remaining trade-offs

Some perceptual improvements are now built in; others remain future work. Fuller
notes and priorities live in [TODO.md](TODO.md).

**Now available:**

- **CIELAB clustering** (now the default). RGB Euclidean distance doesn't match human
  color perception; clustering and assignment run in a perceptual space, then convert
  back to RGB. The RGB path remains in `palette-core.js` but is no longer a UI toggle.
- **PNG output.** The point of transfer is exactly *k* flat colors; PNG preserves
  that quantization (JPEG re-introduced off-palette noise). Output is now PNG.
- **Optional pre-cluster downsample** (`CLUSTER_DOWNSAMPLE_MAX_DIM`) for speed with
  near-identical palettes.

**Still open:**

| Limitation | Why it matters | Better approach |
|------------|----------------|-----------------|
| **Hard nearest-centroid assignment** | Smooth gradients posterize into visible bands. | **Dithering** (e.g. Floyd–Steinberg) trades banding for noise. |
| **Transfer ignores target luminance** | Each pixel maps by absolute color proximity, so the target's light/dark structure isn't preserved; outputs can look flat when the palette's tonal range differs. | Offer a luminance-preserving mode (keep target *L*, map chroma from palette). |
| **Palette-card hex text is always white** | Unreadable on light swatches. | Choose black/white per swatch by luminance. |

## Choosing *k* (number of colors)

- **Higher *k*** suits realistic photos/paintings with many colors.
- **Lower *k*** suits low-dynamic-range art (cartoons, digital/generated images).

There is no single right value — the UI slider is meant for experimentation.

## References

- k-means clustering / Lloyd's algorithm
- CIELAB color space & ΔE (perceptual color difference)
- Floyd–Steinberg dithering
- faiss: <https://github.com/facebookresearch/faiss>
