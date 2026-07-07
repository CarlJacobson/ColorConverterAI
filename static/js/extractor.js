// extractor.js — wires the Palette Extractor page to the worker + palette card.

import {
  ImageSlot,
  runWorker,
  setupKSlider,
  setStatus,
  setupOutputClose,
  progressLabel,
} from './app-common.js';
import { validateK } from './palette-core.js';
import { renderPaletteCard } from './palette-card.js';

const $ = (id) => document.getElementById(id);

const outputDisplay = $('output-display-image');
const outputLink = $('output-display-link');
const downloadBtn = $('download-btn');
const extractBtn = $('extract-btn');
const kSlider = $('k_slider');
const status = $('status');

const slot = new ImageSlot({
  input: $('extraction-image-input'),
  display: $('extraction-display-image'),
  invertButton: $('invert-extraction'),
  storageKey: 'palette_img',
  onChange: (s, err) => {
    if (err) setStatus(status, 'Could not read that image. Try a JPG or PNG.', true);
    else setStatus(status, '');
  },
});

setupKSlider(kSlider, $('k_disp'));

// Transfer a copy of the pixel buffer so the slot keeps its own data intact.
function sendableBuffer(px) {
  const copy = px === slot.rgb ? px.slice() : px;
  return copy.buffer;
}

async function onExtract() {
  if (!slot.ready) {
    setStatus(status, 'Upload an image first.', true);
    return;
  }
  extractBtn.disabled = true;
  downloadBtn.disabled = true;
  const k = validateK(kSlider.value);
  // Color space is fixed to CIELAB (the perceptual space). The RGB path is still
  // fully supported by the worker but is no longer exposed as a UI toggle.
  const space = 'lab';

  try {
    const px = slot.pixelsForCompute();
    const buf = sendableBuffer(px);
    const res = await runWorker(
      {
        type: 'extract',
        rgb: buf,
        width: slot.width,
        height: slot.height,
        k,
        seed: 0,
        space,
      },
      [buf],
      (p) => setStatus(status, progressLabel(p))
    );

    setStatus(status, 'Rendering palette…');
    const centroids = new Uint8Array(res.centroids);
    const { url } = await renderPaletteCard(centroids);

    outputDisplay.style.backgroundImage = `url("${url}")`;
    outputLink.href = url;
    outputLink.download = `palette_${k}.png`;
    downloadBtn.disabled = false;
    setStatus(status, '');
  } catch (err) {
    setStatus(status, 'Something went wrong: ' + err.message, true);
  } finally {
    extractBtn.disabled = false;
  }
}

extractBtn.addEventListener('click', onExtract);
downloadBtn.addEventListener('click', () => outputLink.href && outputLink.click());
setupOutputClose(outputDisplay, { link: outputLink, downloadButton: downloadBtn, status });
