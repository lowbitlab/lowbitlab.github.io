/* PS1-Style Filter: pure image functions (no DOM, no canvas), shared by the page and the unit tests.
 *
 * Everything here works on plain {data: Uint8ClampedArray (RGBA), width, height} objects, so it runs in Node too.
 * The look is made of low resolution, colour depth, ordered dither, fog, vignette and scanlines only.
 * Nothing in this tool moves, snaps or bends geometry or textures.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PS1Core = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** Bayer 4x4 threshold for pixel (x, y), in (-0.5, 0.5). */
  function bayerOffset(x, y) {
    return (BAYER4[((y & 3) << 2) | (x & 3)] + 0.5) / 16 - 0.5;
  }

  /** 5-bit value (0..31) to 8-bit (0..255) the way 15-bit colour is expanded: 0 stays 0, 31 becomes 255. */
  function expand5(q) { return (q << 3) | (q >> 2); }

  /** Quantise one 8-bit channel value to 5 bits and expand it back (the 15-bit colour step, no dither). */
  function quantize15(v) {
    return expand5(clamp(Math.round(clamp(v, 0, 255) * 31 / 255), 0, 31));
  }

  /** Quantise one channel to `levels` evenly spaced values (2..256). */
  function quantizeLevels(v, levels) {
    var m = levels - 1;
    return Math.round(Math.round(clamp(v, 0, 255) * m / 255) * 255 / m);
  }

  var MODES = {
    '15bit': { label: 'PS1 15-bit', colors: 32768 },
    '64': { label: '64 colours', colors: 64 },
    '16': { label: '16 colours', colors: 16 }
  };

  /** Size of the ordered-dither swing (in 0..255 units) at strength 1. About one quantisation step. */
  function ditherSpread(mode) {
    if (mode === '15bit') return 255 / 31;        // one 5-bit step: the classic +-4 swing
    var n = MODES[mode] ? MODES[mode].colors : 64;
    return 255 / Math.cbrt(n) * 0.75;
  }

  /* ---------- palette (median cut) ---------- */

  /** Build an adaptive palette of at most n colours from an RGBA image. Deterministic. */
  function medianCut(img, n) {
    var d = img.data, total = img.width * img.height;
    var stride = Math.max(1, Math.floor(total / 40000));
    var px = [];
    for (var i = 0; i < total; i += stride) px.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
    var boxes = [px];
    function range(box) {
      var lo = [255, 255, 255], hi = [0, 0, 0];
      for (var k = 0; k < box.length; k++) {
        for (var c = 0; c < 3; c++) {
          if (box[k][c] < lo[c]) lo[c] = box[k][c];
          if (box[k][c] > hi[c]) hi[c] = box[k][c];
        }
      }
      return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    }
    var W = [0.8, 1.0, 0.6];       // green counts most, blue least
    while (boxes.length < n) {
      var best = -1, bestScore = 0, bestCh = 0;
      for (var b = 0; b < boxes.length; b++) {
        if (boxes[b].length < 2) continue;
        var r = range(boxes[b]);
        for (var c = 0; c < 3; c++) {
          var score = r[c] * W[c] * Math.sqrt(boxes[b].length);
          if (score > bestScore) { bestScore = score; best = b; bestCh = c; }
        }
      }
      if (best < 0) break;
      var box = boxes[best], ch = bestCh;
      box.sort(function (a, c2) { return a[ch] - c2[ch]; });
      var mid = box.length >> 1;
      boxes.splice(best, 1, box.slice(0, mid), box.slice(mid));
    }
    var pal = [];
    for (var j = 0; j < boxes.length; j++) {
      var s = [0, 0, 0], bx = boxes[j];
      if (!bx.length) continue;
      for (var q = 0; q < bx.length; q++) { s[0] += bx[q][0]; s[1] += bx[q][1]; s[2] += bx[q][2]; }
      pal.push([Math.round(s[0] / bx.length), Math.round(s[1] / bx.length), Math.round(s[2] / bx.length)]);
    }
    return pal;
  }

  /** Index of the palette colour nearest to (r, g, b), perceptually weighted. */
  function nearestIndex(palette, r, g, b) {
    var bi = 0, bd = 1e9;
    for (var p = 0; p < palette.length; p++) {
      var dr = (r - palette[p][0]) * 0.8, dg = g - palette[p][1], db = (b - palette[p][2]) * 0.6;
      var dist = dr * dr + dg * dg + db * db;
      if (dist < bd) { bd = dist; bi = p; }
    }
    return bi;
  }

  /** 5-bit-per-channel lookup table palette lookups go through; filled on demand (255 = not computed yet), kept per palette object. */
  var lutCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function lutFor(palette) {
    var lut = lutCache && lutCache.get(palette);
    if (!lut) { lut = new Uint8Array(32768).fill(255); if (lutCache) lutCache.set(palette, lut); }
    return lut;
  }

  /* ---------- effects (all in place on a low resolution image) ---------- */

  function blur(img, amount) {
    if (amount <= 0) return;
    var w = img.width, h = img.height, d = img.data, src = new Uint8ClampedArray(d), tmp = new Float32Array(w * h * 3);
    var x, y, c, xm, xp, ym, yp;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      xm = x > 0 ? x - 1 : 0; xp = x < w - 1 ? x + 1 : w - 1;
      for (c = 0; c < 3; c++) tmp[(y * w + x) * 3 + c] = 0.25 * src[(y * w + xm) * 4 + c] + 0.5 * src[(y * w + x) * 4 + c] + 0.25 * src[(y * w + xp) * 4 + c];
    }
    for (y = 0; y < h; y++) {
      ym = y > 0 ? y - 1 : 0; yp = y < h - 1 ? y + 1 : h - 1;
      for (x = 0; x < w; x++) for (c = 0; c < 3; c++) {
        var v = 0.25 * tmp[(ym * w + x) * 3 + c] + 0.5 * tmp[(y * w + x) * 3 + c] + 0.25 * tmp[(yp * w + x) * 3 + c];
        d[(y * w + x) * 4 + c] = src[(y * w + x) * 4 + c] * (1 - amount) + v * amount;
      }
    }
  }

  /** Haze toward a colour. amount 0..1; a little stronger toward the top of the frame, like distance haze. */
  function fog(img, amount, color) {
    if (amount <= 0) return;
    var w = img.width, h = img.height, d = img.data;
    for (var y = 0; y < h; y++) {
      var f = amount * 0.8 * (0.7 + 0.3 * (1 - y / Math.max(1, h - 1)));
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        d[i] = d[i] + (color[0] - d[i]) * f;
        d[i + 1] = d[i + 1] + (color[1] - d[i + 1]) * f;
        d[i + 2] = d[i + 2] + (color[2] - d[i + 2]) * f;
      }
    }
  }

  function vignette(img, amount) {
    if (amount <= 0) return;
    var w = img.width, h = img.height, d = img.data, cx = (w - 1) / 2, cy = (h - 1) / 2;
    for (var y = 0; y < h; y++) {
      var dy = (y - cy) / (h / 2);
      for (var x = 0; x < w; x++) {
        var dx = (x - cx) / (w / 2);
        var r = Math.sqrt(dx * dx + dy * dy) / 1.4142;        // 0 centre, 1 corner
        var t = clamp((r - 0.35) / 0.65, 0, 1);
        var m = 1 - amount * 0.85 * t * t * (3 - 2 * t);
        var i = (y * w + x) * 4;
        d[i] *= m; d[i + 1] *= m; d[i + 2] *= m;
      }
    }
  }

  /**
   * Colour reduction with Bayer 4x4 ordered dither.
   * mode '15bit' | '64' | '16'; strength 0..1; palette (optional, for 64 / 16): array of [r,g,b] reused instead of recomputed.
   * Returns the palette used (or null for 15-bit).
   */
  function quantize(img, mode, strength, palette) {
    var w = img.width, h = img.height, d = img.data;
    var swing = ditherSpread(mode) * clamp(strength, 0, 1);
    var x, y, i, o;
    if (mode === '15bit') {
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
        o = bayerOffset(x, y) * swing; i = (y * w + x) * 4;
        d[i] = expand5(clamp(Math.round((clamp(d[i] + o, 0, 255)) * 31 / 255), 0, 31));
        d[i + 1] = expand5(clamp(Math.round((clamp(d[i + 1] + o, 0, 255)) * 31 / 255), 0, 31));
        d[i + 2] = expand5(clamp(Math.round((clamp(d[i + 2] + o, 0, 255)) * 31 / 255), 0, 31));
        d[i + 3] = 255;
      }
      return null;
    }
    var n = MODES[mode] ? MODES[mode].colors : 64;
    var pal = palette || medianCut(img, n);
    var lut = lutFor(pal);
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      o = bayerOffset(x, y) * swing; i = (y * w + x) * 4;
      var r = clamp(Math.round(d[i] + o), 0, 255) >> 3, g = clamp(Math.round(d[i + 1] + o), 0, 255) >> 3, b = clamp(Math.round(d[i + 2] + o), 0, 255) >> 3;
      var key = (r << 10) | (g << 5) | b, idx = lut[key];
      if (idx === 255) idx = lut[key] = nearestIndex(pal, expand5(r), expand5(g), expand5(b));
      var p = pal[idx];
      d[i] = p[0]; d[i + 1] = p[1]; d[i + 2] = p[2]; d[i + 3] = 255;
    }
    return pal;
  }

  /**
   * Whole filter on a low resolution RGBA image, in place.
   * opts: {blur, fog, fogColor, vignette, mode, dither, palette}; blur / fog / vignette / dither are 0..1.
   * Returns the palette (or null).
   */
  function process(img, opts) {
    var o = opts || {};
    blur(img, o.blur || 0);
    fog(img, o.fog || 0, o.fogColor || [150, 160, 180]);
    vignette(img, o.vignette || 0);
    return quantize(img, o.mode || '15bit', o.dither == null ? 1 : o.dither, o.palette || null);
  }

  /* ---------- sizes ---------- */

  var RES = {
    '240p': { label: '240p', height: 240 },
    '320x240': { label: '320 x 240', box: [320, 240] },
    '480p': { label: '480p', height: 480 }
  };

  var MAX_W = 1280;   // keeps x4 exports under the canvas size limit of phones (5120 px wide)

  /** Low resolution size for a source of srcW x srcH. The preset sets the height (or the box); very wide sources are capped to MAX_W wide. */
  function fitSize(srcW, srcH, preset) {
    var r = RES[preset] || RES['240p'], w, h;
    if (r.box) {
      var s = Math.min(r.box[0] / srcW, r.box[1] / srcH);
      w = srcW * s; h = srcH * s;
    } else {
      h = r.height; w = srcW * (h / srcH);
    }
    if (w > MAX_W) { h = h * MAX_W / w; w = MAX_W; }
    return { w: Math.max(8, Math.round(w)), h: Math.max(8, Math.round(h)) };
  }

  /** Scanline geometry for an upscale factor: band = dark rows at the bottom of each source pixel row. */
  function scanlineBand(scale) { return scale >= 2 ? Math.max(1, Math.round(scale / 2)) : 0; }

  /* ---------- pixel font watermark (3x5 capitals, drawn at low resolution so it scales with the image) ---------- */

  var GLYPHS = {
    A: ['010', '101', '111', '101', '101'], B: ['110', '101', '110', '101', '110'], D: ['110', '101', '101', '101', '110'],
    E: ['111', '100', '110', '100', '111'], F: ['111', '100', '110', '100', '100'], G: ['011', '100', '101', '101', '011'],
    H: ['101', '101', '111', '101', '101'], I: ['111', '010', '010', '010', '111'], L: ['100', '100', '100', '100', '111'],
    M: ['10001', '11011', '10101', '10001', '10001'], O: ['010', '101', '101', '101', '010'], P: ['110', '101', '110', '100', '100'],
    S: ['011', '100', '010', '001', '110'], T: ['111', '010', '010', '010', '010'], U: ['101', '101', '101', '101', '111'],
    W: ['10001', '10001', '10101', '11011', '10001'], Y: ['101', '101', '010', '010', '010'], '1': ['010', '110', '010', '010', '111'],
    '.': ['0', '0', '0', '0', '1'], '/': ['001', '001', '010', '100', '100'], ' ': ['00', '00', '00', '00', '00']
  };

  function textWidth(text) {
    var w = 0, t = text.toUpperCase();
    for (var i = 0; i < t.length; i++) w += (GLYPHS[t[i]] || GLYPHS[' '])[0].length + 1;
    return w - 1;
  }

  var WATERMARK = 'made with lowbitlab.github.io/ps1ify';
  var WATERMARK_SHORT = 'lowbitlab.github.io/ps1ify';

  /** Draw the corner watermark (white pixel text on a black plate) at the bottom right. Returns the text drawn, or '' if it does not fit. */
  function drawWatermark(img) {
    var text = [WATERMARK, WATERMARK_SHORT].filter(function (t) { return textWidth(t) + 4 <= img.width; })[0];
    if (!text) return '';
    var tw = textWidth(text), plateW = tw + 3, plateH = 7;
    var px0 = img.width - plateW - 1, py0 = img.height - plateH - 1, d = img.data;
    function set(x, y, v) { var i = (y * img.width + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    var x, y;
    for (y = 0; y < plateH; y++) for (x = 0; x < plateW; x++) set(px0 + x, py0 + y, 0);
    var cx = px0 + 1, t = text.toUpperCase();
    for (var i = 0; i < t.length; i++) {
      var g = GLYPHS[t[i]] || GLYPHS[' '];
      for (y = 0; y < 5; y++) for (x = 0; x < g[0].length; x++) if (g[y][x] === '1') set(cx + x, py0 + 1 + y, 255);
      cx += g[0].length + 1;
    }
    return text;
  }

  return {
    BAYER4: BAYER4, MODES: MODES, RES: RES, WATERMARK: WATERMARK,
    clamp: clamp, bayerOffset: bayerOffset, expand5: expand5, quantize15: quantize15, quantizeLevels: quantizeLevels,
    ditherSpread: ditherSpread, medianCut: medianCut, nearestIndex: nearestIndex,
    blur: blur, fog: fog, vignette: vignette, quantize: quantize, process: process,
    fitSize: fitSize, scanlineBand: scanlineBand, textWidth: textWidth, drawWatermark: drawWatermark
  };
}));
