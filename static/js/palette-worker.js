// palette-worker.js
//
// Module Web Worker. Keeps the heavy k-means / nearest-centroid math off the UI
// thread. It only handles typed arrays — the main thread owns all canvas work
// (decode/encode) and transfers raw pixel buffers in and out of here.
//
// Message protocol (main -> worker):
//   { id, type: 'extract',  rgb: ArrayBuffer, width, height, k, seed, space, downsampleMaxDim }
//   { id, type: 'transfer', rgb: ArrayBuffer, palette: ArrayBuffer, space }
// Replies (worker -> main):
//   { id, type: 'progress', stage, ... }
//   { id, type: 'result',   ... }        (transferable buffers returned)
//   { id, type: 'error',    message }

import { extractPalette, transferPalette } from './palette-core.js';

self.onmessage = (e) => {
  const msg = e.data;
  const { id, type } = msg;
  const onProgress = (p) => self.postMessage({ id, type: 'progress', ...p });

  try {
    if (type === 'extract') {
      const rgb = new Float32Array(msg.rgb);
      const { centroids } = extractPalette(rgb, msg.width, msg.height, {
        k: msg.k,
        seed: msg.seed,
        space: msg.space,
        downsampleMaxDim: msg.downsampleMaxDim,
        onProgress,
      });
      // centroids is a Uint8Array; hand its buffer back zero-copy.
      const buf = centroids.buffer;
      self.postMessage({ id, type: 'result', centroids: buf, k: centroids.length / 3 }, [buf]);
    } else if (type === 'transfer') {
      const rgb = new Float32Array(msg.rgb);
      const palette = new Uint8Array(msg.palette);
      const { pixels } = transferPalette(rgb, palette, {
        space: msg.space,
        onProgress,
      });
      const buf = pixels.buffer;
      self.postMessage({ id, type: 'result', pixels: buf }, [buf]);
    } else {
      throw new Error('Unknown worker message type: ' + type);
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
