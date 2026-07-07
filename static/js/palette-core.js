// palette-core.js
//
// Pure, DOM-free color-math for ColorConverter.ai. This is the JavaScript port of
// the old Python `PaletteConverter` (ColorExtractorFaiss.py):
//   - k-means to find a palette of `k` representative colors, and
//   - nearest-centroid recoloring to transfer a palette onto a target image.
//
// It runs identically on the main thread or inside a Web Worker; it only ever
// touches typed arrays, never a canvas or the DOM.
//
// Determinism note: this does NOT reproduce faiss bit-for-bit (different RNG and
// float summation order). It IS self-consistent — the same pixels + k + seed +
// options always produce the same centroids and the same output.

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Pre-cluster downsampling (methodology change M3). The clustering training set is
// thumbnailed so its longest side is at most this many pixels before k-means runs.
// This makes extraction dramatically faster with near-identical palettes. It
// affects ONLY the training pixels used to find the palette — the target image is
// always recolored at full resolution.
//   0   = disabled (cluster on every pixel)
//   256 = thumbnail to 256px before clustering (default)
// After downsampling, colors are further deduplicated into a weighted histogram
// (see buildHistogram), so k-means runs on unique colors weighted by frequency —
// lossless relative to clustering every (downsampled) pixel.
export const CLUSTER_DOWNSAMPLE_MAX_DIM = 256;

// Number of Lloyd iterations. faiss defaulted to 25.
export const KMEANS_ITERATIONS = 25;

// Default k-means initialization. 'kmeans++' (approved, M4) gives steadier
// clusters than random seeding; 'random' picks k distinct pixels at random.
export const DEFAULT_INIT = 'kmeans++';

// k clamps, matching validate_k() in the old application.py.
export const K_MIN = 2;
export const K_MAX = 200;

// ---------------------------------------------------------------------------
// k validation (port of application.py validate_k)
// ---------------------------------------------------------------------------

export function validateK(k) {
  k = parseInt(k, 10);
  if (!Number.isFinite(k)) return 20;
  if (k > K_MAX) k = K_MAX;
  if (k < K_MIN) k = K_MIN;
  return k;
}

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — small, fast, good enough for init reproducibility.
// ---------------------------------------------------------------------------

export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Color space conversions: sRGB (0..255) <-> CIELAB (D65). Used when the
// caller requests 'lab' clustering (methodology M1, exposed as a UI toggle).
// ---------------------------------------------------------------------------

function srgbChannelToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgbChannel(c) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(v * 255)));
}

// D65 reference white.
const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;

function labFwd(t) {
  return t > 0.008856451679035631 ? Math.cbrt(t) : 7.787037037037037 * t + 16 / 116;
}

function labInv(t) {
  const t3 = t * t * t;
  return t3 > 0.008856451679035631 ? t3 : (t - 16 / 116) / 7.787037037037037;
}

export function rgbToLab(r, g, b, out, o) {
  const rl = srgbChannelToLinear(r);
  const gl = srgbChannelToLinear(g);
  const bl = srgbChannelToLinear(b);
  const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / XN;
  const y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175) / YN;
  const z = (rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041) / ZN;
  const fx = labFwd(x);
  const fy = labFwd(y);
  const fz = labFwd(z);
  out[o] = 116 * fy - 16; // L
  out[o + 1] = 500 * (fx - fy); // a
  out[o + 2] = 200 * (fy - fz); // b
}

export function labToRgb(L, a, b, out, o) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const x = XN * labInv(fx);
  const y = YN * labInv(fy);
  const z = ZN * labInv(fz);
  const rl = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const gl = x * -0.969266 + y * 1.8760108 + z * 0.041556;
  const bl = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;
  out[o] = linearToSrgbChannel(rl);
  out[o + 1] = linearToSrgbChannel(gl);
  out[o + 2] = linearToSrgbChannel(bl);
}

// Convert an interleaved RGB Float32Array (0..255) into the working space.
// Returns the same array untouched for 'rgb', or a new Lab array for 'lab'.
function toWorkingSpace(rgb, space) {
  if (space !== 'lab') return rgb;
  const n = rgb.length / 3;
  const lab = new Float32Array(rgb.length);
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    rgbToLab(rgb[o], rgb[o + 1], rgb[o + 2], lab, o);
  }
  return lab;
}

// Convert working-space centroids back to uint8 RGB triples.
function centroidsToRgb(centroids, space) {
  const k = centroids.length / 3;
  const rgb = new Uint8Array(centroids.length);
  if (space === 'lab') {
    const tmp = new Float64Array(3);
    for (let c = 0; c < k; c++) {
      const o = c * 3;
      labToRgb(centroids[o], centroids[o + 1], centroids[o + 2], tmp, 0);
      rgb[o] = tmp[0];
      rgb[o + 1] = tmp[1];
      rgb[o + 2] = tmp[2];
    }
  } else {
    for (let i = 0; i < centroids.length; i++) {
      rgb[i] = Math.min(255, Math.max(0, Math.round(centroids[i])));
    }
  }
  return rgb;
}

// ---------------------------------------------------------------------------
// Downsampling for the clustering training set (M3). Uniform stride subsample —
// cheap and order-preserving. Only used to pick the palette, never for output.
// ---------------------------------------------------------------------------

function maybeDownsample(points, width, height, maxDim) {
  if (!maxDim || (width <= maxDim && height <= maxDim)) return points;
  const scale = maxDim / Math.max(width, height);
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const out = new Float32Array(outW * outH * 3);
  let o = 0;
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const si = (sy * width + sx) * 3;
      out[o++] = points[si];
      out[o++] = points[si + 1];
      out[o++] = points[si + 2];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Color histogram: collapse the (downsampled) training pixels into unique 8-bit
// RGB colors weighted by how many pixels have them. Clustering on these weighted
// unique colors is mathematically identical to clustering every pixel (a weighted
// mean equals the mean of the duplicated points), but with far fewer points —
// especially on limited-palette art. Map insertion order keeps it deterministic.
// ---------------------------------------------------------------------------

function buildHistogram(rgb) {
  const n = rgb.length / 3;
  const map = new Map();
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const key = ((rgb[o] | 0) << 16) | ((rgb[o + 1] | 0) << 8) | (rgb[o + 2] | 0);
    map.set(key, (map.get(key) || 0) + 1);
  }
  const m = map.size;
  const colors = new Float32Array(m * 3);
  const weights = new Float64Array(m);
  let idx = 0;
  for (const [key, count] of map) {
    colors[idx * 3] = (key >> 16) & 255;
    colors[idx * 3 + 1] = (key >> 8) & 255;
    colors[idx * 3 + 2] = key & 255;
    weights[idx] = count;
    idx++;
  }
  return { colors, weights };
}

// Pick an index with probability proportional to its weight.
function weightedPick(weights, n, rng) {
  let total = 0;
  for (let i = 0; i < n; i++) total += weights[i];
  let t = rng() * total;
  for (let i = 0; i < n; i++) {
    t -= weights[i];
    if (t <= 0) return i;
  }
  return n - 1;
}

// ---------------------------------------------------------------------------
// Distance helper (squared L2 in 3D).
// ---------------------------------------------------------------------------

function dist2(pts, pi, cts, ci) {
  const dr = pts[pi] - cts[ci];
  const dg = pts[pi + 1] - cts[ci + 1];
  const db = pts[pi + 2] - cts[ci + 2];
  return dr * dr + dg * dg + db * db;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

// Pick k distinct initial centroids at random, each color weighted by frequency
// (so it approximates picking k random *pixels*).
function initRandom(points, weights, n, k, rng) {
  const centroids = new Float32Array(k * 3);
  const chosen = new Set();
  for (let c = 0; c < k; c++) {
    let idx;
    let tries = 0;
    do {
      idx = weightedPick(weights, n, rng);
      tries++;
    } while (chosen.has(idx) && tries < 8 && chosen.size < n);
    chosen.add(idx);
    centroids[c * 3] = points[idx * 3];
    centroids[c * 3 + 1] = points[idx * 3 + 1];
    centroids[c * 3 + 2] = points[idx * 3 + 2];
  }
  return centroids;
}

// Weighted k-means++ : first centroid chosen ∝ weight, each subsequent one ∝
// weight × squared distance from the nearest already-chosen centroid.
function initPlusPlus(points, weights, n, k, rng) {
  const centroids = new Float32Array(k * 3);
  const minD = new Float64Array(n).fill(Infinity);

  let idx = weightedPick(weights, n, rng);
  centroids[0] = points[idx * 3];
  centroids[1] = points[idx * 3 + 1];
  centroids[2] = points[idx * 3 + 2];

  for (let c = 1; c < k; c++) {
    // Update running nearest-distance to the centroid we just added.
    const prev = (c - 1) * 3;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const d = dist2(points, i * 3, centroids, prev);
      if (d < minD[i]) minD[i] = d;
      total += weights[i] * minD[i];
    }
    // Weighted pick. If everything collapsed (total 0 => all remaining colors
    // already coincide with centroids), fall back to a weighted-random pick.
    let target = rng() * total;
    let picked = n - 1;
    if (total > 0) {
      for (let i = 0; i < n; i++) {
        target -= weights[i] * minD[i];
        if (target <= 0) {
          picked = i;
          break;
        }
      }
    } else {
      picked = weightedPick(weights, n, rng);
    }
    centroids[c * 3] = points[picked * 3];
    centroids[c * 3 + 1] = points[picked * 3 + 1];
    centroids[c * 3 + 2] = points[picked * 3 + 2];
  }
  return centroids;
}

// ---------------------------------------------------------------------------
// k-means (Lloyd's algorithm)
// ---------------------------------------------------------------------------

// Assign each point to its nearest centroid; write labels into `labels`.
function assign(points, n, centroids, k, labels) {
  for (let i = 0; i < n; i++) {
    const pi = i * 3;
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < k; c++) {
      const d = dist2(points, pi, centroids, c * 3);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    labels[i] = best;
  }
}

// Recompute centroids as the weighted mean of their assigned colors (weight =
// pixel frequency). Float64 accumulators avoid drift; empty clusters are reseeded
// to the worst-served color so k stays honored and we never divide by zero.
function update(points, weights, n, centroids, k, labels) {
  const sums = new Float64Array(k * 3);
  const counts = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    const c = labels[i];
    const pi = i * 3;
    const w = weights[i];
    sums[c * 3] += w * points[pi];
    sums[c * 3 + 1] += w * points[pi + 1];
    sums[c * 3 + 2] += w * points[pi + 2];
    counts[c] += w;
  }
  for (let c = 0; c < k; c++) {
    if (counts[c] > 0) {
      centroids[c * 3] = sums[c * 3] / counts[c];
      centroids[c * 3 + 1] = sums[c * 3 + 1] / counts[c];
      centroids[c * 3 + 2] = sums[c * 3 + 2] / counts[c];
    } else {
      // Empty cluster: steal the color that is worst-served by its centroid,
      // weighted by frequency (a frequent, poorly-served color is the best steal).
      let worst = 0;
      let worstD = -1;
      for (let i = 0; i < n; i++) {
        const d = weights[i] * dist2(points, i * 3, centroids, labels[i] * 3);
        if (d > worstD) {
          worstD = d;
          worst = i;
        }
      }
      centroids[c * 3] = points[worst * 3];
      centroids[c * 3 + 1] = points[worst * 3 + 1];
      centroids[c * 3 + 2] = points[worst * 3 + 2];
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract a palette of `k` colors from an image's pixels.
 *
 * @param {Float32Array} rgb   Interleaved RGB (0..255), length = width*height*3.
 * @param {number} width
 * @param {number} height
 * @param {object} opts        { k, seed=0, space='rgb'|'lab', init, iterations,
 *                               downsampleMaxDim, onProgress }
 * @returns {{ centroids: Uint8Array }}  k*3 uint8 RGB triples.
 */
export function extractPalette(rgb, width, height, opts = {}) {
  const k = validateK(opts.k);
  const seed = (opts.seed >>> 0) || 0;
  const space = opts.space === 'lab' ? 'lab' : 'rgb';
  const init = opts.init || DEFAULT_INIT;
  const iterations = opts.iterations || KMEANS_ITERATIONS;
  const maxDim =
    opts.downsampleMaxDim !== undefined ? opts.downsampleMaxDim : CLUSTER_DOWNSAMPLE_MAX_DIM;
  const onProgress = opts.onProgress || (() => {});

  onProgress({ stage: 'init' });

  // Downsample the training set, collapse to a weighted histogram of unique
  // colors, then convert those colors to the working space.
  const sampledRgb = maybeDownsample(rgb, width, height, maxDim);
  const { colors, weights } = buildHistogram(sampledRgb);
  const points = toWorkingSpace(colors, space);
  const n = points.length / 3; // number of unique colors

  // Guard: k can't exceed the number of distinct colors available.
  const effectiveK = Math.min(k, n);
  const rng = makeRng(seed);

  const centroids =
    init === 'random'
      ? initRandom(points, weights, n, effectiveK, rng)
      : initPlusPlus(points, weights, n, effectiveK, rng);

  const labels = new Int32Array(n);
  for (let it = 0; it < iterations; it++) {
    assign(points, n, centroids, effectiveK, labels);
    update(points, weights, n, centroids, effectiveK, labels);
    onProgress({ stage: 'clustering', iteration: it + 1, total: iterations });
  }

  return { centroids: centroidsToRgb(centroids, space) };
}

/**
 * Recolor a target image by mapping each pixel to its nearest palette color.
 *
 * @param {Float32Array} rgb        Interleaved RGB (0..255) of the target.
 * @param {Uint8Array} paletteRgb   k*3 uint8 RGB centroids from extractPalette.
 * @param {object} opts             { space='rgb'|'lab', onProgress }
 * @returns {{ pixels: Uint8ClampedArray }}  RGBA output ready for ImageData.
 */
export function transferPalette(rgb, paletteRgb, opts = {}) {
  const space = opts.space === 'lab' ? 'lab' : 'rgb';
  const onProgress = opts.onProgress || (() => {});
  const n = rgb.length / 3;
  const k = paletteRgb.length / 3;

  onProgress({ stage: 'assigning' });

  // Put both the target pixels and the palette into the same working space.
  const target = toWorkingSpace(rgb, space);
  let palette;
  if (space === 'lab') {
    palette = new Float32Array(paletteRgb.length);
    for (let c = 0; c < k; c++) {
      const o = c * 3;
      rgbToLab(paletteRgb[o], paletteRgb[o + 1], paletteRgb[o + 2], palette, o);
    }
  } else {
    palette = Float32Array.from(paletteRgb);
  }

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const pi = i * 3;
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < k; c++) {
      const d = dist2(target, pi, palette, c * 3);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    // Output the *RGB* of the winning centroid (not the working-space value).
    const co = best * 3;
    const oi = i * 4;
    out[oi] = paletteRgb[co];
    out[oi + 1] = paletteRgb[co + 1];
    out[oi + 2] = paletteRgb[co + 2];
    out[oi + 3] = 255;
  }

  onProgress({ stage: 'done' });
  return { pixels: out };
}

// Convenience: "#rrggbb" from an rgb triple (port of rgb_to_hex).
export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}
