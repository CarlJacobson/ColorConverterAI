// palette-card.js
//
// Renders the shareable palette card (colored bands + hex codes) on a canvas,
// reproducing the old PIL make_palette_image(). Output is PNG (approved, M2).
//
// Layout reproduction of the Python version:
//   - The Python code built vertical 1px stripes in centroid order, resized to
//     1200x1200, then rotate(90) — which turns them into horizontal bands with
//     centroid 0 at the BOTTOM and centroid n-1 at the TOP, and its reversed
//     `centroids[::-1]` label loop puts each hex on its own band. We draw the
//     horizontal bands directly (top band = last centroid) for the same result.
//   - Font-size ladder and the >=100-colors tall-card case are matched exactly.
//   - Hex text is white, matching current behavior (per-swatch contrast is a
//     deferred TODO, M7).

import { rgbToHex } from './palette-core.js';

const FONT_URL = 'static/styles/coolvetica rg.otf';
const FONT_FAMILY = 'CoolveticaPalette';
let fontPromise = null;

function ensureFont() {
  if (fontPromise) return fontPromise;
  if (typeof FontFace === 'undefined') {
    fontPromise = Promise.resolve(false);
    return fontPromise;
  }
  const face = new FontFace(FONT_FAMILY, `url("${FONT_URL}")`);
  fontPromise = face
    .load()
    .then((loaded) => {
      document.fonts.add(loaded);
      return true;
    })
    .catch(() => false); // fall back to a system font if it can't load
  return fontPromise;
}

/**
 * Render the palette card and return it as a PNG object URL.
 * @param {Uint8Array} centroids  k*3 uint8 RGB triples.
 * @returns {Promise<{ url: string, canvas: HTMLCanvasElement }>}
 */
export async function renderPaletteCard(centroids) {
  const num = centroids.length / 3;

  const cardW = 1200;
  let fontSize;
  let cardH;
  if (num === 1) {
    fontSize = 325;
    cardH = 1200;
  } else if (num === 2) {
    fontSize = 300;
    cardH = 1200;
  } else if (num < 100) {
    fontSize = Math.floor(1000 / num);
    cardH = 1200;
  } else {
    fontSize = 10;
    cardH = 10 * num;
  }

  const bandH = cardH / num;

  const canvas = document.createElement('canvas');
  canvas.width = cardW;
  canvas.height = cardH;
  const ctx = canvas.getContext('2d');

  await ensureFont();
  ctx.textBaseline = 'top';
  ctx.font = `${fontSize}px "${FONT_FAMILY}", sans-serif`;

  // Top band is the last centroid, bottom band is the first — matches the
  // Python rotate(90) + reversed-label result.
  for (let i = 0; i < num; i++) {
    const ci = (num - 1 - i) * 3;
    const r = centroids[ci];
    const g = centroids[ci + 1];
    const b = centroids[ci + 2];
    const y = bandH * i;

    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, Math.floor(y), cardW, Math.ceil(bandH) + 1);

    ctx.fillStyle = 'rgb(255,255,255)';
    ctx.fillText(rgbToHex(r, g, b), 10, y - 1);
  }

  const url = await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('Failed to encode palette PNG.'));
      resolve(URL.createObjectURL(blob));
    }, 'image/png');
  });

  return { url, canvas };
}
