// image-io.js
//
// Main-thread canvas I/O, replacing everything PIL used to do server-side:
// decode an uploaded file to RGB pixels, invert, and encode results to PNG.
// The worker never touches a canvas, so all of this stays here.

// Hard ceiling on decoded dimensions to avoid tab OOM on decompression bombs.
// This is a *safety guard* (clamps the whole pipeline), distinct from the
// optional clustering downsample in palette-core.js (which only speeds up
// palette-finding). Set generously; most photos are well under this.
export const MAX_IMAGE_DIM = 6000;

/**
 * Decode a File/Blob (or data URL) into interleaved RGB pixels.
 *
 * Uses createImageBitmap with EXIF orientation applied, so phone photos come out
 * upright — note this differs from the old PIL path, which ignored EXIF. Alpha is
 * dropped (matching PIL's `.convert('RGB')`); animated GIFs decode to frame 1.
 *
 * @param {Blob|string} source
 * @returns {Promise<{ rgb: Float32Array, width: number, height: number }>}
 */
export async function decodeToRgb(source) {
  const blob = typeof source === 'string' ? await (await fetch(source)).blob() : source;

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (_) {
    // Older engines choke on the options bag; retry without it.
    bitmap = await createImageBitmap(blob);
  }

  let { width, height } = bitmap;
  if (width < 1 || height < 1) throw new Error('Image has no pixels.');

  // Clamp oversized images down to the safety ceiling.
  let scale = 1;
  const longest = Math.max(width, height);
  if (longest > MAX_IMAGE_DIM) scale = MAX_IMAGE_DIM / longest;
  const drawW = Math.max(1, Math.round(width * scale));
  const drawH = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = drawW;
  canvas.height = drawH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, drawW, drawH);
  bitmap.close && bitmap.close();

  const { data } = ctx.getImageData(0, 0, drawW, drawH); // RGBA Uint8ClampedArray
  const n = drawW * drawH;
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const si = i * 4;
    const di = i * 3;
    rgb[di] = data[si];
    rgb[di + 1] = data[si + 1];
    rgb[di + 2] = data[si + 2];
  }
  return { rgb, width: drawW, height: drawH };
}

/** Invert RGB pixels in place (port of PIL ImageOps.invert). */
export function invertRgb(rgb) {
  for (let i = 0; i < rgb.length; i++) rgb[i] = 255 - rgb[i];
  return rgb;
}

/**
 * Encode a recolored RGBA pixel buffer to a PNG data URL.
 * @param {Uint8ClampedArray} rgba  length = width*height*4
 */
export async function rgbaToPngUrl(rgba, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvasToPngUrl(canvas);
}

/** Encode an existing canvas to a PNG object URL (preferred over toDataURL for size). */
export function canvasToPngUrl(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('Failed to encode PNG.'));
      resolve(URL.createObjectURL(blob));
    }, 'image/png');
  });
}
