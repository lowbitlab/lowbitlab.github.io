/* PS1-Style Filter: page logic. Everything runs locally: no network request carries your image, no storage, no analytics. */
(function () {
  'use strict';
  var C = window.PS1Core;
  var BASE = document.baseURI;       // the page folder; the site may live under /ps1ify/
  var $ = function (id) { return document.getElementById(id); };

  var el = {
    frame: $('frame'), out: $('out'), before: $('before'), split: $('split'), stage: $('stage'), msg: $('msg'), info: $('info'),
    res: $('res'), aspect: $('aspect'), mode: $('mode'), dither: $('dither'), blur: $('blur'), scan: $('scan'), fog: $('fog'),
    fogcolor: $('fogcolor'), vignette: $('vignette'), bg: $('bg'), wm: $('wm'), scale: $('scale'),
    download: $('download'), copy: $('copy'), share: $('share')
  };

  var state = {
    mode: 'photo', source: null, base: null, split: 0.5,
    lowCanvas: document.createElement('canvas'), viewer: null, viewerPromise: null, modelLoaded: false,
    palette3d: null, interacting: false, scheduled: false, lowW: 0, lowH: 0, loadGen: 0
  };
  var lowCtx = state.lowCanvas.getContext('2d', { willReadFrequently: true });

  /* ---------- settings ---------- */

  function settings() {
    return {
      res: el.res.value, aspect: el.aspect.value, mode: el.mode.value,
      dither: el.dither.value / 100, blur: el.blur.value / 100, scan: el.scan.value / 100, fog: el.fog.value / 100,
      fogColor: hexToRgb(el.fogcolor.value), vignette: el.vignette.value / 100, wm: el.wm.checked, scale: +el.scale.value
    };
  }
  function hexToRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }

  /* ---------- sample photo (generated, so the page works at once without a file) ---------- */

  function makeSample() {
    var W = 1280, H = 960, c = document.createElement('canvas');
    c.width = W; c.height = H;
    var g = c.getContext('2d'), seed = 7;
    function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
    var hor = H * 0.62, sx = W * 0.66, sy = H * 0.5, grad;
    grad = g.createLinearGradient(0, 0, 0, hor);
    grad.addColorStop(0, '#1d2260'); grad.addColorStop(0.45, '#6a4a9c'); grad.addColorStop(0.8, '#f08e6a'); grad.addColorStop(1, '#ffd08a');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    var sun = g.createRadialGradient(sx, sy, 0, sx, sy, W * 0.42);
    sun.addColorStop(0, 'rgba(255,250,220,1)'); sun.addColorStop(0.05, 'rgba(255,236,180,0.95)'); sun.addColorStop(0.12, 'rgba(255,190,120,0.5)'); sun.addColorStop(1, 'rgba(255,140,100,0)');
    g.fillStyle = sun; g.fillRect(0, 0, W, hor);
    for (var i = 0; i < 9; i++) {                       // long soft clouds
      var cx = rnd() * W, cy = hor * (0.15 + rnd() * 0.55), cw = 160 + rnd() * 260;
      var cg = g.createRadialGradient(cx, cy, 0, cx, cy, cw);
      cg.addColorStop(0, 'rgba(255,200,170,0.38)'); cg.addColorStop(1, 'rgba(255,200,170,0)');
      g.save(); g.translate(cx, cy); g.scale(1, 0.14); g.translate(-cx, -cy); g.fillStyle = cg; g.fillRect(cx - cw, cy - cw, cw * 2, cw * 2); g.restore();
    }
    function ridge(base, amp, phase, colTop, colBot) {
      var gr = g.createLinearGradient(0, base - amp * 1.6, 0, hor);
      gr.addColorStop(0, colTop); gr.addColorStop(1, colBot);
      g.fillStyle = gr; g.beginPath(); g.moveTo(0, hor);
      for (var x = 0; x <= W; x += 8) {
        var y = base - amp * (0.55 * Math.sin(x * 0.004 + phase) + 0.3 * Math.sin(x * 0.011 + phase * 2.3) + 0.15 * Math.sin(x * 0.027 + phase * 5.1) + 0.6);
        g.lineTo(x, y);
      }
      g.lineTo(W, hor); g.closePath(); g.fill();
    }
    ridge(hor - 20, 150, 1.0, '#8d6fa0', '#d88c86');
    ridge(hor - 6, 120, 2.7, '#4f4a86', '#8a6a98');
    ridge(hor + 4, 90, 4.4, '#262a5c', '#4d4580');
    var lake = g.createLinearGradient(0, hor, 0, H);
    lake.addColorStop(0, '#f2a27c'); lake.addColorStop(0.35, '#7d5d9a'); lake.addColorStop(1, '#161a44');
    g.fillStyle = lake; g.fillRect(0, hor, W, H - hor);
    var refl = g.createLinearGradient(0, hor, 0, H);       // sun path on the water
    refl.addColorStop(0, 'rgba(255,236,170,0.85)'); refl.addColorStop(1, 'rgba(255,200,140,0)');
    for (var y = hor; y < H; y += 6) {
      var k = (y - hor) / (H - hor), wd = 18 + k * 120 + rnd() * 40;
      g.globalAlpha = (1 - k) * (0.35 + rnd() * 0.5); g.fillStyle = refl;
      g.fillRect(sx - wd / 2 + (rnd() - 0.5) * 30, y, wd, 3);
    }
    g.globalAlpha = 1;
    function pine(x, base, h) {
      g.fillStyle = '#0b0d22'; g.beginPath(); g.moveTo(x, base - h);
      var tiers = 6;
      for (var t = 1; t <= tiers; t++) { var yy = base - h + (h * t) / tiers, half = (h * 0.16) * (t / tiers) + 4; g.lineTo(x + half, yy); g.lineTo(x + half * 0.45, yy); }
      g.lineTo(x + 5, base); g.lineTo(x - 5, base);
      for (t = tiers; t >= 1; t--) { var y2 = base - h + (h * t) / tiers, hf = (h * 0.16) * (t / tiers) + 4; g.lineTo(x - hf * 0.45, y2); g.lineTo(x - hf, y2); }
      g.closePath(); g.fill();
    }
    g.fillStyle = '#0b0d22'; g.beginPath(); g.moveTo(0, H); g.lineTo(0, H * 0.9); g.lineTo(W * 0.3, H * 0.93); g.lineTo(W * 0.6, H * 0.97); g.lineTo(W, H * 0.92); g.lineTo(W, H); g.fill();
    [[60, 0.93, 520], [150, 0.95, 380], [235, 0.93, 300], [1190, 0.94, 560], [1090, 0.96, 400], [1010, 0.95, 250], [330, 0.96, 190]].forEach(function (p) { pine(p[0], H * p[1], p[2]); });
    return c;
  }

  /* ---------- reading a photo ---------- */

  function loadImageFile(file) {
    var p = window.createImageBitmap ? createImageBitmap(file) : new Promise(function (res, rej) {
      var im = new Image(), u = URL.createObjectURL(file);
      im.onload = function () { URL.revokeObjectURL(u); res(im); };
      im.onerror = function () { URL.revokeObjectURL(u); rej(new Error('decode')); };
      im.src = u;
    });
    return p.then(function (bmp) {
      var w = bmp.width || bmp.naturalWidth;
      if (!w) throw new Error('empty');
      return bmp;
    });
  }

  function setPhoto(src) {
    state.source = src; state.base = null;
    drawBefore();
    schedule();
  }

  /** Shrink with repeated halving (a box filter), then one last draw to the exact size. */
  function downscale(src, w, h) {
    var cur = src, cw = src.width || src.naturalWidth, ch = src.height || src.naturalHeight;
    while (cw >= w * 2 && ch >= h * 2) {
      var nw = Math.ceil(cw / 2), nh = Math.ceil(ch / 2), t = document.createElement('canvas');
      t.width = nw; t.height = nh;
      var tg = t.getContext('2d'); tg.imageSmoothingQuality = 'high'; tg.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
      cur = t; cw = nw; ch = nh;
    }
    var out = document.createElement('canvas'); out.width = w; out.height = h;
    var og = out.getContext('2d', { willReadFrequently: true });
    og.fillStyle = '#fff'; og.fillRect(0, 0, w, h);          // transparent areas become white
    og.imageSmoothingQuality = 'high'; og.drawImage(cur, 0, 0, cw, ch, 0, 0, w, h);
    return og.getImageData(0, 0, w, h);
  }

  function drawBefore() {
    var s = state.source;
    if (!s) return;
    var sw = s.width || s.naturalWidth, sh = s.height || s.naturalHeight, k = Math.min(1, 1280 / Math.max(sw, sh));
    el.before.width = Math.max(1, Math.round(sw * k)); el.before.height = Math.max(1, Math.round(sh * k));
    var g = el.before.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, el.before.width, el.before.height);
    g.imageSmoothingQuality = 'high'; g.drawImage(s, 0, 0, el.before.width, el.before.height);
  }

  /* ---------- rendering ---------- */

  function schedule() {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(function () { state.scheduled = false; render(); });
  }

  function render() {
    var s = settings(), img;
    if (state.mode === 'photo') {
      if (!state.source) return;
      var sw = state.source.width || state.source.naturalWidth, sh = state.source.height || state.source.naturalHeight;
      var size = C.fitSize(sw, sh, s.res);
      if (!state.base || state.base.width !== size.w || state.base.height !== size.h) state.base = downscale(state.source, size.w, size.h);
      img = { data: new Uint8ClampedArray(state.base.data), width: size.w, height: size.h };
      C.process(img, { blur: s.blur, fog: s.fog, fogColor: s.fogColor, vignette: s.vignette, mode: s.mode, dither: s.dither });
    } else {
      if (!state.viewer || !state.modelLoaded) return;
      var ar = s.aspect.split(':'), sz = C.fitSize(+ar[0], +ar[1], s.res);
      if (sz.w !== state.lowW || sz.h !== state.lowH) { state.viewer.setSize(sz.w, sz.h); }
      state.viewer.setFog(s.fog);
      var cnv = state.viewer.render();
      if (state.lowCanvas.width !== sz.w || state.lowCanvas.height !== sz.h) { state.lowCanvas.width = sz.w; state.lowCanvas.height = sz.h; }
      lowCtx.drawImage(cnv, 0, 0, sz.w, sz.h);
      img = lowCtx.getImageData(0, 0, sz.w, sz.h);
      var reuse = state.interacting && state.palette3d;
      var pal = C.process(img, { blur: s.blur, vignette: s.vignette, mode: s.mode, dither: s.dither, palette: reuse ? state.palette3d : null });
      if (!reuse) state.palette3d = pal;
    }
    state.wmDrawn = s.wm ? C.drawWatermark(img) !== '' : true;
    if (state.lowCanvas.width !== img.width || state.lowCanvas.height !== img.height) { state.lowCanvas.width = img.width; state.lowCanvas.height = img.height; }
    lowCtx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    state.lowW = img.width; state.lowH = img.height;
    present(s);
  }

  function scanStrength(s) { return s.scale >= 2 ? s.scan : 0; }

  function drawFinal(dst, low, scale, scan) {
    var w = low.width * scale, h = low.height * scale;
    if (dst.width !== w || dst.height !== h) { dst.width = w; dst.height = h; }
    var g = dst.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(low, 0, 0, w, h);
    var band = C.scanlineBand(scale);
    if (band && scan > 0) {
      g.fillStyle = 'rgba(0,0,0,' + (0.65 * scan).toFixed(3) + ')';
      for (var y = 0; y < low.height; y++) g.fillRect(0, y * scale + scale - band, w, band);
    }
  }

  function present(s) {
    var low = state.lowCanvas;
    el.frame.style.setProperty('--ratio', (low.width / low.height).toFixed(5));
    var want = Math.ceil(((el.frame.clientWidth || 640) * (window.devicePixelRatio || 1)) / low.width);
    var pv = Math.max(Math.min(want, 6), s.scale === 1 ? 1 : 2);
    drawFinal(el.out, low, pv, scanStrength(s));
    var out = { w: low.width * s.scale, h: low.height * s.scale };
    el.info.textContent = low.width + ' x ' + low.height + ' px, ' + C.MODES[s.mode].label + (s.scale > 1 ? ', download ' + out.w + ' x ' + out.h + ' px' : '') + (state.wmDrawn ? '' : '. The credit is too wide for this image and is left out');
    $('scan-note').hidden = !(s.scale === 1 && s.scan > 0);
  }

  function setSplit(v) {
    state.split = Math.max(0, Math.min(1, v));
    var pct = (state.split * 100).toFixed(2);
    el.out.style.clipPath = state.mode === 'photo' ? 'inset(0 0 0 ' + pct + '%)' : 'none';
    el.split.style.left = pct + '%';
    el.split.setAttribute('aria-valuenow', Math.round(state.split * 100));
  }

  /* ---------- messages ---------- */

  var msgTimer = 0;
  function say(text, sticky) {
    clearTimeout(msgTimer);
    if (!text) { el.msg.hidden = true; return; }
    el.msg.textContent = text; el.msg.hidden = false;
    if (!sticky) msgTimer = setTimeout(function () { el.msg.hidden = true; }, 3500);
  }

  /* ---------- 3D mode ---------- */

  function ensureViewer() {
    if (state.viewerPromise) return state.viewerPromise;
    state.viewerPromise = import(new URL('js/mode3d.js', BASE).href).then(function (m) {
      var v = m.createViewer(function (kind) {
        if (kind === 'orbit') { state.interacting = true; schedule(); }
        else { state.interacting = false; schedule(); }
      });
      v.attach(el.out);
      state.viewer = v;
      return v;
    }).catch(function (e) { state.viewerPromise = null; throw e; });
    return state.viewerPromise;
  }

  // Only the latest request is applied: a model chosen while another one is still loading wins, whatever order they finish in.
  function loadModel(bufferPromise, name) {
    var gen = ++state.loadGen;
    say('Loading the model...', true);
    return Promise.all([ensureViewer(), bufferPromise]).then(function (r) {
      if (gen !== state.loadGen) return null;
      return r[0].load(r[1]).then(function (info) {
        if (gen !== state.loadGen) return null;
        state.modelLoaded = true; state.palette3d = null; state.lowW = 0;
        document.body.dataset.model = name || '';
        say('');
        schedule();
        return info;
      });
    }).catch(function (e) {
      if (gen !== state.loadGen) return null;
      console.warn('3D load failed', e && e.message);
      say(e && e.message === 'fetch' ? 'The sample model could not be loaded. Check your connection and try again.' :
        'This file could not be read as a .glb 3D model. Compressed files (Draco, meshopt, KTX2) are not supported. Try another file.', true);
      throw e;
    });
  }

  function loadSampleModel() {
    var path = $('sample-model').value;
    return loadModel(fetch(new URL(path, BASE).href).then(function (r) { if (!r.ok) throw new Error('fetch'); return r.arrayBuffer(); }), path.split('/').pop());
  }

  function setMode(mode, noSample) {
    if (state.mode === mode) return;
    state.mode = mode;
    var three = mode === '3d';
    document.querySelectorAll('.tabs [role=tab]').forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.mode === mode)); });
    $('row-photo').hidden = three; $('row-3d').hidden = !three;
    el.before.hidden = three; el.split.hidden = three;
    $('f-aspect').hidden = !three; $('f-bg').hidden = !three; $('fogcolor-row').hidden = three;
    $('l-fog').firstChild.textContent = three ? 'Fog (depth) ' : 'Fog (haze) ';
    document.body.classList.toggle('mode3d', three);
    setSplit(state.split);
    state.lowW = 0; state.palette3d = null;
    say('');
    if (three) {
      if (!state.modelLoaded && !noSample) loadSampleModel().catch(function () {});
      else schedule();
    } else schedule();
  }

  /* ---------- export ---------- */

  function exportBlob() {
    var s = settings(), c = document.createElement('canvas');
    drawFinal(c, state.lowCanvas, s.scale, scanStrength(s));
    return new Promise(function (res, rej) { c.toBlob(function (b) { b ? res(b) : rej(new Error('toBlob')); }, 'image/png'); });
  }
  function fileName() {
    var s = settings();
    return 'ps1-style-' + state.lowCanvas.width + 'x' + state.lowCanvas.height + (s.scale > 1 ? '-x' + s.scale : '') + '.png';
  }

  function flash(btn, text) {
    var old = btn.dataset.label || btn.textContent;
    btn.dataset.label = old; btn.textContent = text;
    clearTimeout(btn._t); btn._t = setTimeout(function () { btn.textContent = old; }, 1600);
  }

  el.download.addEventListener('click', function () {
    exportBlob().then(function (b) {
      var a = document.createElement('a'), u = URL.createObjectURL(b);
      a.href = u; a.download = fileName(); document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
    }).catch(function () { say('Could not make the PNG.'); });
  });

  el.copy.addEventListener('click', function () {
    if (!navigator.clipboard || !window.ClipboardItem) { say('This browser cannot copy images. Use Download PNG.'); return; }
    navigator.clipboard.write([new ClipboardItem({ 'image/png': exportBlob() })]).then(
      function () { flash(el.copy, 'Copied'); },
      function () { say('Copying was refused by the browser. Use Download PNG.'); });
  });

  if (navigator.canShare && navigator.share) {
    try {
      if (navigator.canShare({ files: [new File([new Blob(['x'], { type: 'image/png' })], 'a.png', { type: 'image/png' })] })) el.share.hidden = false;
    } catch (e) { /* no file sharing here */ }
    el.share.addEventListener('click', function () {
      exportBlob().then(function (b) {
        return navigator.share({ files: [new File([b], fileName(), { type: 'image/png' })], title: 'PS1-style image' });
      }).catch(function () { /* cancelled */ });
    });
  }

  /* ---------- events ---------- */

  document.querySelectorAll('.tabs [role=tab]').forEach(function (t) { t.addEventListener('click', function () { setMode(t.dataset.mode); }); });

  $('controls').addEventListener('input', function (e) {
    var t = e.target, o = $('o-' + t.id);
    if (o) o.textContent = t.value;
    if (t === el.bg) { if (state.viewer) state.viewer.setBackground(el.bg.value); }
    state.palette3d = null;
    schedule();
  });
  el.scale.addEventListener('change', schedule);
  $('sample-model').addEventListener('change', function () { loadSampleModel().catch(function () {}); });

  $('file-photo').addEventListener('change', function (e) { var f = e.target.files[0]; e.target.value = ''; if (f) handleFile(f); });
  $('file-3d').addEventListener('change', function (e) { var f = e.target.files[0]; e.target.value = ''; if (f) handleFile(f); });
  $('sample-photo').addEventListener('click', function () { say(''); setPhoto(makeSample()); });

  function handleFile(f) {
    var isModel = /\.(glb|gltf)$/i.test(f.name) || f.type === 'model/gltf-binary';
    if (isModel) {
      if (/\.gltf$/i.test(f.name)) {
        setMode('3d');
        var warn = function () { say('Only .glb files work (one file with everything inside). Export as glTF Binary.', true); };
        if (state.modelLoaded) warn(); else loadSampleModel().then(warn, warn);
        return;
      }
      setMode('3d', true);
      loadModel(f.arrayBuffer(), f.name).catch(function () {});
    } else if (/^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name)) {
      setMode('photo');
      say('Reading the photo...', true);
      loadImageFile(f).then(function (bmp) { say(''); document.body.dataset.photo = f.name; setPhoto(bmp); }).catch(function () { say('This file could not be read as an image. Try a JPG or PNG.', true); });
    } else {
      say('This file type is not supported. Use a photo (JPG, PNG, WebP) or a .glb model.', true);
    }
  }

  ['dragenter', 'dragover'].forEach(function (n) {
    document.addEventListener(n, function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) { e.preventDefault(); el.stage.classList.add('dragover'); } });
  });
  document.addEventListener('dragleave', function (e) { if (!e.relatedTarget) el.stage.classList.remove('dragover'); });
  document.addEventListener('drop', function (e) {
    el.stage.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }
  });
  document.addEventListener('paste', function (e) {
    var f = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0];
    if (f) { e.preventDefault(); handleFile(f); }
  });

  // before / after handle
  (function () {
    var dragging = false;
    function move(e) { var r = el.frame.getBoundingClientRect(); setSplit((e.clientX - r.left) / r.width); }
    el.split.addEventListener('pointerdown', function (e) { dragging = true; el.split.setPointerCapture(e.pointerId); move(e); });
    el.split.addEventListener('pointermove', function (e) { if (dragging) move(e); });
    el.split.addEventListener('pointerup', function () { dragging = false; });
    el.split.addEventListener('pointercancel', function () { dragging = false; });
    el.split.addEventListener('keydown', function (e) {
      var k = { ArrowLeft: -0.05, ArrowRight: 0.05, Home: -1, End: 1 }[e.key];
      if (k === undefined) return;
      e.preventDefault(); setSplit(e.key === 'Home' ? 0 : e.key === 'End' ? 1 : state.split + k);
    });
  }());

  var rt = 0;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(schedule, 120); });

  /* ---------- start ---------- */

  setSplit(0.5);
  setPhoto(makeSample());
}());
