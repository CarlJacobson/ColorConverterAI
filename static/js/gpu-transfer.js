// gpu-transfer.js
//
// Optional WebGL2 acceleration for the palette-transfer step. The per-pixel
// nearest-centroid recoloring is embarrassingly parallel, so a fragment shader
// does the whole target image in one GPU pass — milliseconds even for large,
// high-k images.
//
// This mirrors the contract of `transferPalette` in palette-core.js exactly
// (same inputs, same RGBA Uint8ClampedArray output) so callers can swap it in
// behind a feature check and fall back to the CPU worker if anything fails.
//
// Runs on the main thread: a GPU transfer is a few ms, so it won't jank the UI,
// and it avoids OffscreenCanvas-in-worker support gaps.

import { MAX_IMAGE_DIM } from './image-io.js';

// Force-disable the GPU path (e.g. for debugging / parity checks against the CPU).
export const GPU_ENABLED = true;

// Lazily-built, reused singleton. Nulled on context loss so the next call rebuilds
// or falls back.
let ctx = null;
let supportCache = null;

// GLSL ES 3.00. The RGB->CIELAB math MUST match rgbToLab() in palette-core.js
// (D65). Note: the sampler already returns rgb normalized to [0,1], which equals
// the palette-core value / 255, so we feed it straight into the linearization.
const VERT_SRC = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uImage;
uniform sampler2D uPalette;
uniform int uK;
uniform int uSpace;   // 0 = rgb, 1 = lab

in vec2 vUv;
out vec4 outColor;

// sRGB channel (already 0..1) -> linear. Matches srgbChannelToLinear in palette-core.
float toLinear(float c) {
  return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}

float labFwd(float t) {
  return t > 0.008856451679035631 ? pow(t, 1.0 / 3.0) : 7.787037037037037 * t + 16.0 / 116.0;
}

// RGB (0..1) -> CIELAB (D65). Mirrors rgbToLab in palette-core.js.
vec3 rgbToLab(vec3 c) {
  float rl = toLinear(c.r);
  float gl = toLinear(c.g);
  float bl = toLinear(c.b);
  float x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
  float y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175) / 1.0;
  float z = (rl * 0.0193339 + gl * 0.119192  + bl * 0.9503041) / 1.08883;
  float fx = labFwd(x);
  float fy = labFwd(y);
  float fz = labFwd(z);
  return vec3(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
}

void main() {
  vec3 px = texture(uImage, vUv).rgb;
  vec3 pxFeat = uSpace == 1 ? rgbToLab(px) : px;

  vec3 bestRgb = vec3(0.0);
  float bestD = 1.0e30;
  for (int i = 0; i < uK; i++) {
    vec3 pc = texelFetch(uPalette, ivec2(i, 0), 0).rgb;
    vec3 pcFeat = uSpace == 1 ? rgbToLab(pc) : pc;
    vec3 diff = pxFeat - pcFeat;
    float d = dot(diff, diff);
    if (d < bestD) {
      bestD = d;
      bestRgb = pc;
    }
  }
  outColor = vec4(bestRgb, 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile failed: ' + info);
  }
  return sh;
}

function initGL() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    preserveDrawingBuffer: false,
    premultipliedAlpha: false,
  });
  if (!gl) return null;

  canvas.addEventListener(
    'webglcontextlost',
    (e) => {
      e.preventDefault();
      ctx = null;
      supportCache = null;
    },
    false
  );

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT_SRC));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC));
  gl.bindAttribLocation(program, 0, 'aPos');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('Program link failed: ' + gl.getProgramInfoLog(program));
  }

  // Fullscreen triangle.
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const imageTex = gl.createTexture();
  const paletteTex = gl.createTexture();

  const uniforms = {
    uImage: gl.getUniformLocation(program, 'uImage'),
    uPalette: gl.getUniformLocation(program, 'uPalette'),
    uK: gl.getUniformLocation(program, 'uK'),
    uSpace: gl.getUniformLocation(program, 'uSpace'),
  };

  return { canvas, gl, program, vao, imageTex, paletteTex, uniforms, maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
}

function getCtx() {
  if (ctx) return ctx;
  ctx = initGL(); // may be null
  return ctx;
}

/** Whether a usable WebGL2 transfer path is available. Cached. */
export function isGpuTransferSupported() {
  if (supportCache !== null) return supportCache;
  try {
    const c = getCtx();
    supportCache = !!c && c.maxTex >= MAX_IMAGE_DIM;
  } catch (_) {
    supportCache = false;
  }
  return supportCache;
}

// Build a k x 1 RGBA8 palette texture from k*3 uint8 RGB.
function uploadPalette(gl, tex, paletteRgb) {
  const k = paletteRgb.length / 3;
  const rgba = new Uint8Array(k * 4);
  for (let i = 0; i < k; i++) {
    rgba[i * 4] = paletteRgb[i * 3];
    rgba[i * 4 + 1] = paletteRgb[i * 3 + 1];
    rgba[i * 4 + 2] = paletteRgb[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, k, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  return k;
}

// Build a width x height RGBA8 image texture from interleaved Float32 RGB (0..255).
function uploadImage(gl, tex, rgb, width, height) {
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
}

/**
 * GPU nearest-centroid transfer. Same contract as transferPalette in
 * palette-core.js. Throws on any GL failure so the caller can fall back.
 *
 * @param {Float32Array} rgb        Interleaved RGB (0..255) of the target.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} paletteRgb   k*3 uint8 RGB centroids.
 * @param {object} opts             { space: 'rgb' | 'lab' }
 * @returns {Uint8ClampedArray}     RGBA output, length width*height*4.
 */
export function transferPaletteGPU(rgb, width, height, paletteRgb, opts = {}) {
  const c = getCtx();
  if (!c) throw new Error('WebGL2 unavailable');
  const { gl, program, vao, imageTex, paletteTex, uniforms } = c;
  const space = opts.space === 'lab' ? 1 : 0;

  c.canvas.width = width;
  c.canvas.height = height;
  gl.viewport(0, 0, width, height);

  gl.useProgram(program);
  gl.bindVertexArray(vao);

  gl.activeTexture(gl.TEXTURE0);
  uploadImage(gl, imageTex, rgb, width, height);
  gl.uniform1i(uniforms.uImage, 0);

  gl.activeTexture(gl.TEXTURE1);
  const k = uploadPalette(gl, paletteTex, paletteRgb);
  gl.uniform1i(uniforms.uPalette, 1);

  gl.uniform1i(uniforms.uK, k);
  gl.uniform1i(uniforms.uSpace, space);

  gl.drawArrays(gl.TRIANGLES, 0, 3);

  const out = new Uint8ClampedArray(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out);

  const err = gl.getError();
  if (err !== gl.NO_ERROR) throw new Error('WebGL error 0x' + err.toString(16));

  return out;
}
