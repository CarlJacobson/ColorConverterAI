// transfer.js — wires the Palette Transfer page: extract a palette from one image
// and recolor a full-resolution target image with it.

import {
  ImageSlot,
  runWorker,
  setupKSlider,
  setStatus,
  setupOutputClose,
  saveImage,
  progressLabel,
} from './app-common.js';
import { validateK } from './palette-core.js';
import { rgbaToPngUrl } from './image-io.js';
import { GPU_ENABLED, isGpuTransferSupported, transferPaletteGPU } from './gpu-transfer.js';

const $ = (id) => document.getElementById(id);

const outputDisplay = $('output-display-image');
const outputLink = $('output-display-link');
const downloadBtn = $('download-btn');
const convertBtn = $('convert-btn');
const kSlider = $('k_slider');
const status = $('status');

const targetSlot = new ImageSlot({
  input: $('target-image-input'),
  display: $('target-display-image'),
  invertButton: $('invert-target'),
  onChange: (s, err) => reportSlot(err),
});

const paletteSlot = new ImageSlot({
  input: $('palette-image-input'),
  display: $('palette-display-image'),
  invertButton: $('invert-palette'),
  storageKey: 'palette_img',
  onChange: (s, err) => reportSlot(err),
});

function reportSlot(err) {
  if (err) setStatus(status, 'Could not read that image. Try a JPG or PNG.', true);
  else setStatus(status, '');
}

// Own key for this page; fall back to the extractor page's value (clamped) so the
// choice carries across navigation. 'k_value' is the pre-split legacy key.
setupKSlider(kSlider, $('k_disp'), 'k_value_transfer', ['k_value_extractor', 'k_value']);

function sendableBuffer(px, slot) {
  const copy = px === slot.rgb ? px.slice() : px;
  return copy.buffer;
}

// Swap the two images (matches the old FlipImages()).
$('flip-btn').addEventListener('click', () => {
  for (const key of ['rgb', 'width', 'height', 'inverted', '_previewUrl']) {
    const tmp = targetSlot[key];
    targetSlot[key] = paletteSlot[key];
    paletteSlot[key] = tmp;
  }
  const tb = targetSlot.display.style.backgroundImage;
  targetSlot.display.style.backgroundImage = paletteSlot.display.style.backgroundImage;
  paletteSlot.display.style.backgroundImage = tb;
  // Keep each preview's invert filter *and* its dataset flag in sync with the
  // swapped `inverted` state (the dataset flag isn't covered by the loop above).
  for (const s of [targetSlot, paletteSlot]) {
    s.display.dataset.inverted = s.inverted ? '1' : '0';
    s._applyInvertFilter();
  }
});

async function onConvert() {
  if (!targetSlot.ready || !paletteSlot.ready) {
    setStatus(status, 'Upload both a target image and a palette image.', true);
    return;
  }
  convertBtn.disabled = true;
  downloadBtn.disabled = true;
  const k = validateK(kSlider.value);
  // Color space is fixed to CIELAB (the perceptual space). The RGB path is still
  // fully supported by the worker but is no longer exposed as a UI toggle.
  const space = 'lab';

  try {
    // 1) Extract the palette from the palette image.
    const pPx = paletteSlot.pixelsForCompute();
    const pBuf = sendableBuffer(pPx, paletteSlot);
    const pal = await runWorker(
      {
        type: 'extract',
        rgb: pBuf,
        width: paletteSlot.width,
        height: paletteSlot.height,
        k,
        seed: 0,
        space,
      },
      [pBuf],
      (p) => setStatus(status, progressLabel(p))
    );

    // 2) Recolor the full-resolution target with that palette. Prefer the GPU
    // (WebGL2) path; fall back to the CPU worker on any failure. Only one of the
    // two consumes pal.centroids, so the transferable buffer isn't double-used.
    const tPx = targetSlot.pixelsForCompute();
    let rgba = null;

    if (GPU_ENABLED && isGpuTransferSupported()) {
      try {
        setStatus(status, 'Recoloring (GPU)…');
        const paletteRgb = new Uint8Array(pal.centroids);
        rgba = transferPaletteGPU(tPx, targetSlot.width, targetSlot.height, paletteRgb, { space });
      } catch (_) {
        rgba = null; // fall through to the CPU worker
      }
    }

    if (!rgba) {
      const tBuf = sendableBuffer(tPx, targetSlot);
      const out = await runWorker(
        {
          type: 'transfer',
          rgb: tBuf,
          palette: pal.centroids, // ArrayBuffer, transferred below
          space,
        },
        [tBuf, pal.centroids],
        (p) => setStatus(status, progressLabel(p))
      );
      rgba = new Uint8ClampedArray(out.pixels);
    }

    setStatus(status, 'Encoding image…');
    const url = await rgbaToPngUrl(rgba, targetSlot.width, targetSlot.height);

    outputDisplay.style.backgroundImage = `url("${url}")`;
    outputLink.href = url;
    outputLink.download = 'colorconverter_output.png';
    downloadBtn.disabled = false;
    setStatus(status, '');
  } catch (err) {
    setStatus(status, 'Something went wrong: ' + err.message, true);
  } finally {
    convertBtn.disabled = false;
  }
}

convertBtn.addEventListener('click', onConvert);
downloadBtn.addEventListener('click', () => saveImage(outputLink.href, outputLink.download || 'colorconverter_output.png'));
// Clicking the output image itself saves via the share sheet too (not a raw file download).
outputLink.addEventListener('click', (e) => {
  if (!outputLink.href) return;
  e.preventDefault();
  saveImage(outputLink.href, outputLink.download || 'colorconverter_output.png');
});
setupOutputClose(outputDisplay, { link: outputLink, downloadButton: downloadBtn, status });
