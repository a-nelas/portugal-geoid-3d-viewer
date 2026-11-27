(function () {
  'use strict';

  // ---------- Config ----------
  var DATA_URL = 'data/portugal.json';  // built by tools/build_data.py
  var GAP_AMP = 1000;                   // "Gap N ×1000": the geoid is drawn 1,000 times higher
  var LIFT_GROUND = 2;                  // metres; keeps lines off the ground (z-fighting)

  var C = {
    geoid: '#4cc9f0', ellipsoid: '#b48cff', n: '#ef476f', ground: '#7fb069',
    ink: '#e8ebf4', muted: '#98a1b6', faint: '#6f7994', grid: '#222b45', line: '#323e60'
  };
  var GEOID_SCALE = [[0, '#173a7a'], [0.35, '#1f6fb8'], [0.7, '#4cc9f0'], [1, '#c4f1ff']];
  // Hypsometric tints anchored to real heights (metres), so a colour always means the same
  // height. Half of mainland Portugal is below ~240 m, so the low end gets more stops.
  var GROUND_STOPS = [[0, '#2f5d34'], [100, '#46803f'], [250, '#7fa653'], [500, '#c2bd72'],
                      [800, '#b8925a'], [1200, '#8f6c4c'], [1600, '#b9aea0'], [2000, '#f1ece0']];
  var FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

  var DEFAULT_PIN = { lon: -9.1393, lat: 38.7223, name: 'Lisbon' };

  var T = { ellipsoid: 0, geoid: 1, ground: 2, outlineE: 3, outlineTop: 4, curtain: 5, probe: 6, ellipsoidGrid: 7 };
  var LAYERS = { geoid: [T.geoid], ellipsoid: [T.ellipsoid, T.ellipsoidGrid], ground: [T.ground], gap: [T.curtain], borders: [T.outlineE, T.outlineTop] };

  // All perspective: switching scene.camera.projection at runtime corrupts the WebGL scene
  // in Plotly 2.30 (surfaces vanish, axes garble), so the presets only move the eye.
  var CAMERAS = {
    perspective: { eye: { x: -1.25, y: -1.45, z: 0.85 }, up: { x: 0, y: 0, z: 1 }, center: { x: 0, y: 0, z: -0.12 } },
    side:        { eye: { x: 0.35, y: -2.2, z: 0.05 },   up: { x: 0, y: 0, z: 1 }, center: { x: 0, y: 0, z: 0 } },
    top:         { eye: { x: 0, y: -0.01, z: 2.2 },      up: { x: 0, y: 1, z: 0 }, center: { x: 0, y: 0, z: 0 } }
  };

  // g: grid ({lon0, lat0, step, nx, ny, N: Float32Array, H: Int16Array (-1 = no ground), X, Y, stats})
  // amp: true while the gap N is drawn ×GAP_AMP (heights above the geoid always stay 1:1)
  var state = { g: null, groundOn: true, geoidOn: true, amp: true, pin: null, samples: null, zCache: {} };

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  var plotEl = $('#plot');

  // Start downloading the data straight away (index.html also preloads it)
  var dataPromise = fetch(DATA_URL).then(function (r) {
    if (!r.ok) throw new Error(DATA_URL + ': HTTP ' + r.status);
    return r.json();
  });

  // ---------- Grid ----------
  function toGrid(d) {
    var size = d.nx * d.ny, N = new Float32Array(size), H = new Int16Array(size);
    for (var k = 0; k < size; k++) { N[k] = d.N[k] / 100; H[k] = d.H[k]; }
    var X = new Array(d.nx), Y = new Array(d.ny);
    for (var i = 0; i < d.nx; i++) X[i] = +(d.lon0 + i * d.step).toFixed(6);
    for (var j = 0; j < d.ny; j++) Y[j] = +(d.lat0 + j * d.step).toFixed(6);
    var hMin = Infinity, hMax = -Infinity;
    for (var m = 0; m < size; m++) { if (H[m] >= 0) { if (H[m] < hMin) hMin = H[m]; if (H[m] > hMax) hMax = H[m]; } }
    var stats = Object.assign({}, d.stats, { hMin: hMin, hMax: hMax });
    return { lon0: d.lon0, lat0: d.lat0, step: d.step, nx: d.nx, ny: d.ny, N: N, H: H, X: X, Y: Y, outline: d.outline, stats: stats };
  }

  // ---------- Ground colours ----------
  function hexToRgb(h) { return [1, 3, 5].map(function (i) { return parseInt(h.slice(i, i + 2), 16); }); }
  function rgbToHex(c) { return '#' + c.map(function (v) { return Math.round(v).toString(16).padStart(2, '0'); }).join(''); }

  // Colour of the tint ramp at height h (linear between the fixed stops)
  function tintAt(h) {
    var s = GROUND_STOPS;
    if (h <= s[0][0]) return s[0][1];
    for (var i = 1; i < s.length; i++) {
      if (h <= s[i][0]) {
        var t = (h - s[i - 1][0]) / (s[i][0] - s[i - 1][0]), a = hexToRgb(s[i - 1][1]), b = hexToRgb(s[i][1]);
        return rgbToHex(a.map(function (v, k) { return v + (b[k] - v) * t; }));
      }
    }
    return s[s.length - 1][1];
  }

  // Plotly colorscale spanning exactly the data's lowest to highest ground: [[0..1, colour], ...]
  function groundScale(hMin, hMax) {
    var span = Math.max(1, hMax - hMin), out = [[0, tintAt(hMin)]];
    GROUND_STOPS.forEach(function (s) { if (s[0] > hMin && s[0] < hMax) out.push([(s[0] - hMin) / span, s[1]]); });
    out.push([1, tintAt(hMax)]);
    return out;
  }

  // Cell containing (lon, lat): {i, j, tx, ty}, or null when outside the grid. O(1).
  function cell(g, lon, lat) {
    var fx = (lon - g.lon0) / g.step, fy = (lat - g.lat0) / g.step;
    if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) return null;
    var i = Math.min(Math.floor(fx), g.nx - 2), j = Math.min(Math.floor(fy), g.ny - 2);
    return { i: i, j: j, tx: fx - i, ty: fy - j };
  }

  function geoidAt(g, lon, lat) {
    var c = cell(g, lon, lat);
    if (!c) return null;
    var k = c.j * g.nx + c.i, N = g.N;
    var z0 = N[k] * (1 - c.tx) + N[k + 1] * c.tx;
    var z1 = N[k + g.nx] * (1 - c.tx) + N[k + g.nx + 1] * c.tx;
    return z0 * (1 - c.ty) + z1 * c.ty;
  }

  // Ground height at (lon, lat): bilinear where all four corners are land, else the
  // nearest land corner; null in the sea / Spain.
  function groundAt(g, lon, lat) {
    var c = cell(g, lon, lat);
    if (!c) return null;
    var k = c.j * g.nx + c.i, H = g.H;
    var h00 = H[k], h10 = H[k + 1], h01 = H[k + g.nx], h11 = H[k + g.nx + 1];
    if (h00 >= 0 && h10 >= 0 && h01 >= 0 && h11 >= 0) {
      var z0 = h00 * (1 - c.tx) + h10 * c.tx, z1 = h01 * (1 - c.tx) + h11 * c.tx;
      return z0 * (1 - c.ty) + z1 * c.ty;
    }
    var corners = [[h00, c.tx * c.tx + c.ty * c.ty], [h10, (1 - c.tx) * (1 - c.tx) + c.ty * c.ty],
                   [h01, c.tx * c.tx + (1 - c.ty) * (1 - c.ty)], [h11, (1 - c.tx) * (1 - c.tx) + (1 - c.ty) * (1 - c.ty)]];
    var best = null, bestD = Infinity;
    corners.forEach(function (p) { if (p[0] >= 0 && p[1] < bestD) { best = p[0]; bestD = p[1]; } });
    return best;
  }

  // Highest land corner of the cell (keeps outline lines above the ground surface)
  function groundMaxAt(g, lon, lat) {
    var c = cell(g, lon, lat);
    if (!c) return 0;
    var k = c.j * g.nx + c.i, H = g.H;
    return Math.max(0, H[k], H[k + 1], H[k + g.nx], H[k + g.nx + 1]);
  }

  // ---------- Vertical scale ----------
  function gapScale() { return state.amp ? GAP_AMP : 1; }
  // Lines drawn on the geoid sit this far above it. Amplified, the geoid's triangles bend
  // away from the bilinear line samples by up to a few metres, so the margin grows with it.
  function lift() { return state.amp ? 12 : 0.4; }

  function zTop() {
    var s = state.g.stats;
    // Amplified: one fixed range (~61 km), so toggling the ground doesn't rescale the scene.
    if (state.amp) return Math.ceil((s.nMax * GAP_AMP + s.hMax + 500) / 1000) * 1000;
    // True scale: up to ~1,940 m with the ground, or zoomed onto the 45-58 m geoid without it.
    return state.groundOn ? Math.ceil((s.nMax + s.hMax + 20) / 100) * 100 : Math.ceil((s.nMax + 2) / 10) * 10;
  }

  // ---------- Traces ----------
  function rows(g, fn) {
    var Z = new Array(g.ny);
    for (var j = 0; j < g.ny; j++) {
      var row = new Array(g.nx);
      for (var i = 0; i < g.nx; i++) row[i] = fn(j * g.nx + i);
      Z[j] = row;
    }
    return Z;
  }

  // Same, but column-major: [i][j]. Plotly 2.30 looks up a surface's %{text} as text[x][y],
  // although z is z[y][x], so hover text has to be passed transposed.
  function cols(g, fn) {
    var A = new Array(g.nx);
    for (var i = 0; i < g.nx; i++) {
      var col = new Array(g.ny);
      for (var j = 0; j < g.ny; j++) col[j] = fn(j * g.nx + i);
      A[i] = col;
    }
    return A;
  }

  // Points along the outline, sampled once: dense ones for the outline lines and sparse ones
  // (about every 0.2°) for the red ellipsoid → geoid "curtain".
  function sampleOutline(g) {
    var line = { x: [], y: [], n: [], top: [] }, curtain = { x: [], y: [], n: [] };
    densify(g.outline, g.step / 2).forEach(function (p) {
      var n = geoidAt(g, p[0], p[1]);
      if (n === null) return;
      line.x.push(p[0]); line.y.push(p[1]); line.n.push(n); line.top.push(groundMaxAt(g, p[0], p[1]));
    });
    var o = g.outline;
    for (var k = 0; k < o.length - 1; k++) {
      var a = o[k], b = o[k + 1];
      var steps = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.2));
      for (var s = 0; s < steps; s++) {
        var lon = a[0] + (b[0] - a[0]) * s / steps, lat = a[1] + (b[1] - a[1]) * s / steps;
        var n = geoidAt(g, lon, lat);
        if (n === null) continue;
        curtain.x.push(lon, lon, null); curtain.y.push(lat, lat, null); curtain.n.push(n);
      }
    }
    return { line: line, curtain: curtain };
  }

  // Split the coarse outline into steps no longer than `maxStep` degrees, so each sample
  // can take the surface height under it instead of a straight edge cutting through hills.
  function densify(ring, maxStep) {
    var out = [];
    for (var k = 0; k < ring.length - 1; k++) {
      var a = ring[k], b = ring[k + 1];
      var n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxStep));
      for (var s = 0; s < n; s++) out.push([a[0] + (b[0] - a[0]) * s / n, a[1] + (b[1] - a[1]) * s / n]);
    }
    out.push(ring[ring.length - 1]);
    return out;
  }

  // Every height array that depends on the gap scale, built once per scale and reused.
  function heights() {
    var f = gapScale();
    if (state.zCache[f]) return state.zCache[f];
    var g = state.g, L = state.samples.line, cu = state.samples.curtain, up = lift();
    var z = {
      geoid: rows(g, function (k) { return g.N[k] * f; }),
      lineGeoid: L.n.map(function (n) { return n * f + up; }),
      lineGround: L.n.map(function (n, k) { return n * f + L.top[k] + LIFT_GROUND + (up - 0.4); }),
      curtain: []
    };
    cu.n.forEach(function (n) { z.curtain.push(0, n * f, null); });
    return (state.zCache[f] = z);
  }

  // Ground heights. Cells outside Portugal have to vanish without nulls (they break 3D surface
  // picking, so no hover) or an opacityscale (that sends the surface through the transparent
  // pass, which doesn't depth-sort, so far peaks were drawn over near ones):
  //  - normally they go far below the height axis, where Plotly clips them. The coast then
  //    drops in a near-vertical wall down to the ellipsoid: invisible at true scale (~50 m),
  //    but a 45 km cliff with the gap amplified.
  //  - so with the gap amplified and the geoid shown, they sit just under the opaque geoid
  //    instead, which hides them, and the coast slopes down to sea level as it should.
  var CLIPPED = -1e6, UNDER_GEOID = 300;
  function groundZ() {
    var f = gapScale(), under = state.amp && state.geoidOn, key = f + (under ? 'u' : 'c');
    if (state.zCache[key]) return state.zCache[key];
    var g = state.g;
    return (state.zCache[key] = rows(g, function (k) {
      if (g.H[k] >= 0) return g.N[k] * f + g.H[k];
      return under ? g.N[k] * f - UNDER_GEOID : CLIPPED;
    }));
  }

  function contoursZ() {
    var s = state.g.stats, f = gapScale();
    return { show: true, start: Math.floor(s.nMin) * f, end: Math.ceil(s.nMax) * f, size: f, color: 'rgba(8,16,36,0.35)', width: 1, highlight: false };
  }

  // A flat 2×2 plane, with its 0.5° grid drawn as plain lines. Surface contours would need a
  // fine, evenly spaced grid: Plotly resamples anything else on every redraw (an unevenly
  // spaced version of this plane alone took ~450 ms each time).
  function ellipsoidTrace(g) {
    var x0 = g.X[0], x1 = g.X[g.nx - 1], y0 = g.Y[0], y1 = g.Y[g.ny - 1], ez = [[0, 0], [0, 0]];
    return {
      type: 'surface', name: 'Ellipsoid', x: [x0, x1], y: [y0, y1], z: ez, surfacecolor: ez,
      colorscale: [[0, C.ellipsoid], [1, C.ellipsoid]], showscale: false, opacity: 0.32,
      lighting: { ambient: 1, diffuse: 0, specular: 0, fresnel: 0 },
      contours: { x: { highlight: false }, y: { highlight: false }, z: { highlight: false } },
      hoverinfo: 'skip'
    };
  }

  function ellipsoidGridTrace(g) {
    var x0 = g.X[0], x1 = g.X[g.nx - 1], y0 = g.Y[0], y1 = g.Y[g.ny - 1], x = [], y = [], z = [];
    for (var lon = Math.ceil(x0 * 2) / 2; lon <= x1; lon += 0.5) { x.push(lon, lon, null); y.push(y0, y1, null); z.push(0.4, 0.4, null); }
    for (var lat = Math.ceil(y0 * 2) / 2; lat <= y1; lat += 0.5) { x.push(x0, x1, null); y.push(lat, lat, null); z.push(0.4, 0.4, null); }
    return { type: 'scatter3d', mode: 'lines', x: x, y: y, z: z, line: { color: 'rgba(206,180,255,0.55)', width: 1 }, hoverinfo: 'skip', showlegend: false };
  }

  // Hover text. z may be amplified, so the true N comes from `text`. The ground's sea cells
  // (hidden under the geoid) can win the hover there, so they carry the geoid's text too.
  var HOVER = 'lat %{y:.3f}° · lon %{x:.3f}°<br>%{text}<extra></extra>';
  function geoidLabel(g, k) { return '<b>Geoid</b>: N = ' + g.N[k].toFixed(2) + ' m'; }

  function geoidTrace(g) {
    var s = g.stats;
    // Coloured by the true N, so the colours mean the same at either scale
    return {
      type: 'surface', name: 'Geoid', x: g.X, y: g.Y, z: heights().geoid,
      surfacecolor: rows(g, function (k) { return g.N[k]; }),
      text: cols(g, function (k) { return geoidLabel(g, k); }),
      colorscale: GEOID_SCALE, cmin: s.nMin, cmax: s.nMax, showscale: false, opacity: 1,
      lighting: { ambient: 0.72, diffuse: 0.6, specular: 0.08, roughness: 0.9, fresnel: 0.1 },
      lightposition: { x: -1e5, y: -1e5, z: 2e5 },
      contours: { z: contoursZ(), x: { highlight: false }, y: { highlight: false } },
      hovertemplate: HOVER
    };
  }

  // (Text for 37k cells is already plenty, so the exact H is left to the pin readout.)
  function groundTrace(g) {
    var s = g.stats;
    var color = rows(g, function (k) { return g.H[k] < 0 ? s.hMin : g.H[k]; });
    return {
      type: 'surface', name: 'Ground', x: g.X, y: g.Y, z: groundZ(), surfacecolor: color,
      colorscale: groundScale(s.hMin, s.hMax), cmin: s.hMin, cmax: s.hMax, showscale: false, opacity: 1,
      lighting: { ambient: 0.6, diffuse: 0.8, specular: 0.05, roughness: 1, fresnel: 0.05 },
      lightposition: { x: -1e5, y: -1e5, z: 2e5 },
      contours: { x: { highlight: false }, y: { highlight: false }, z: { highlight: false } },
      text: cols(g, function (k) { return g.H[k] < 0 ? geoidLabel(g, k) : '<b>Ground</b>: click to read its height'; }),
      hovertemplate: HOVER
    };
  }

  function outlineTop() { var z = heights(); return state.groundOn ? z.lineGround : z.lineGeoid; }

  function outlineTraces() {
    var L = state.samples.line;
    var base = { type: 'scatter3d', mode: 'lines', x: L.x, y: L.y, hoverinfo: 'skip', showlegend: false };
    return [
      Object.assign({}, base, { z: L.x.map(function () { return 0.4; }), line: { color: 'rgba(232,235,244,0.4)', width: 2 } }),
      Object.assign({}, base, { z: outlineTop(), line: { color: '#f4f6fb', width: 3.5 } })
    ];
  }

  // Vertical lines ellipsoid → geoid along the outline
  function curtainTrace() {
    var cu = state.samples.curtain;
    return { type: 'scatter3d', mode: 'lines', x: cu.x, y: cu.y, z: heights().curtain, line: { color: 'rgba(239,71,111,0.55)', width: 2 }, hoverinfo: 'skip', showlegend: false };
  }

  // Segment ellipsoid → geoid at the pin, a gap, then a label point floating above the surfaces
  function probeData() {
    var p = state.pin;
    if (!p) return { x: [[null]], y: [[null]], z: [[null]], text: [['']] };
    var f = gapScale(), up = lift();
    var top = p.n * f + (state.groundOn && p.h !== null ? p.h : 0);
    var labelZ = top + zTop() * 0.08;
    return {
      x: [[p.lon, p.lon, null, p.lon]], y: [[p.lat, p.lat, null, p.lat]], z: [[up, p.n * f + up, null, labelZ]],
      text: [['', '', '', 'N = ' + p.n.toFixed(2) + ' m']]
    };
  }

  function probeTrace() {
    var d = probeData();
    return {
      type: 'scatter3d', mode: 'lines+markers+text', x: d.x[0], y: d.y[0], z: d.z[0], text: d.text[0],
      line: { color: C.n, width: 8 }, marker: { color: [C.ellipsoid, C.ink, C.ink, C.n], size: [4, 6, 0, 0.1], line: { width: 0 } },
      textposition: 'top center', textfont: { color: C.ink, size: 13, family: FONT },
      hoverinfo: 'skip', showlegend: false
    };
  }

  // ---------- Layout ----------
  function axis(title, extra) {
    return Object.assign({
      title: { text: title, font: { size: 11, color: C.muted } },
      tickfont: { size: 10, color: C.faint },
      gridcolor: C.grid, zerolinecolor: C.grid, linecolor: C.line,
      showbackground: false, showspikes: false
    }, extra || {});
  }

  function aspect() {
    var g = state.g;
    var midLat = (g.Y[0] + g.Y[g.ny - 1]) / 2 * Math.PI / 180;
    var kmX = (g.X[g.nx - 1] - g.X[0]) * 111.32 * Math.cos(midLat);
    var kmY = (g.Y[g.ny - 1] - g.Y[0]) * 110.57;
    var kmZ = zTop() / 1000;
    var m = Math.max(kmX, kmY);
    // Heights use the same km as the map, no vertical stretching (only N is scaled, when amplified)
    return { x: kmX / m, y: kmY / m, z: kmZ / m };
  }

  function layout() {
    return {
      paper_bgcolor: 'rgba(0,0,0,0)',
      margin: { l: 0, r: 0, t: 0, b: 0 },
      showlegend: false,
      uirevision: 'keep',
      font: { family: FONT, color: C.muted },
      hoverlabel: { bgcolor: '#10162a', bordercolor: '#323e60', font: { family: FONT, color: C.ink, size: 12 } },
      scene: {
        uirevision: 'keep',
        aspectmode: 'manual',
        aspectratio: aspect(),
        camera: CAMERAS.perspective,
        xaxis: axis('Longitude', { ticksuffix: '°', dtick: 1 }),
        yaxis: axis('Latitude', { ticksuffix: '°', dtick: 1 }),
        // The box is only a few pixels tall, so its ticks and title would pile up
        zaxis: axis('', { range: [0, zTop()], showticklabels: false, showgrid: false })
      }
    };
  }

  function scaleLayout() { return { 'scene.zaxis.range': [0, zTop()], 'scene.aspectratio': aspect() }; }

  // ---------- Redraws ----------
  // Every Plotly call re-renders the whole WebGL scene (several hundred ms with ~75k surface
  // vertices), so each user action makes exactly one. `changes` maps trace index → {attr: value}.
  function redraw(changes, layoutChanges) {
    var idx = Object.keys(changes).map(Number), upd = {};
    idx.forEach(function (t, pos) {
      Object.keys(changes[t]).forEach(function (a) {
        if (!upd[a]) upd[a] = idx.map(function () { return undefined; });  // undefined = leave as is
        upd[a][pos] = changes[t][a];
      });
    });
    return Plotly.update(plotEl, upd, layoutChanges || {}, idx);
  }

  function probeChange() {
    var d = probeData();
    return { x: d.x[0], y: d.y[0], z: d.z[0], text: d.text[0] };
  }

  // ---------- Pin + converter ----------
  function fmtLat(v) { return Math.abs(v).toFixed(4) + '° ' + (v >= 0 ? 'N' : 'S'); }
  function fmtLon(v) { return Math.abs(v).toFixed(4) + '° ' + (v >= 0 ? 'E' : 'W'); }

  // Updates the state and the readout; the caller draws the probe.
  function setPin(lon, lat, name) {
    var g = state.g, n = geoidAt(g, lon, lat);
    if (n === null) return false;
    var h = groundAt(g, lon, lat);
    state.pin = { lon: lon, lat: lat, n: n, h: h, name: name || '' };

    $('#pinName').textContent = state.pin.name;
    $('#pinLat').textContent = fmtLat(lat);
    $('#pinLon').textContent = fmtLon(lon);
    $('#pinN').textContent = n.toFixed(2) + ' m';
    var onLand = h !== null;
    $('#pinGroundRow').hidden = !onLand;
    $('#pinGroundVal').hidden = !onLand;
    if (onLand) {
      $('#pinGroundVal').textContent = Math.round(h).toLocaleString('en-US') + ' m';
      $('#hIn').value = (h + n).toFixed(1);   // what a GPS standing on this ground would read
    }
    $('#hHint').textContent = onLand
      ? 'Example: h is prefilled with H + N, the raw GPS height on this ground.'
      : 'Over the sea: type any raw GPS height.';
    updateConverter();
    return true;
  }

  function updateConverter() {
    var out = $('#hOut'), h = parseFloat($('#hIn').value);
    if (!state.pin || isNaN(h)) { out.textContent = '—'; return; }
    out.textContent = (h - state.pin.n).toFixed(1) + ' m';
  }

  function updateBadge() {
    $('#scaleBadge').textContent = state.amp
      ? 'Heights 1:1 · gap N ×' + GAP_AMP.toLocaleString('en-US')
      : 'Vertical scale: true 1:1 (heights not stretched)';
  }

  // ---------- Controls ----------
  function setGround(on) {
    state.groundOn = on;
    var c = {};
    c[T.ground] = { visible: on };
    c[T.outlineTop] = { z: outlineTop() };
    c[T.probe] = probeChange();
    redraw(c, scaleLayout());
  }

  function setAmp(on) {
    state.amp = on;
    var z = heights(), c = {};
    c[T.geoid] = { z: z.geoid, 'contours.z': contoursZ() };
    c[T.ground] = { z: groundZ() };
    c[T.outlineTop] = { z: outlineTop() };
    c[T.curtain] = { z: z.curtain };
    c[T.probe] = probeChange();
    redraw(c, scaleLayout());
    updateBadge();
  }

  function bindControls() {
    $all('.chip[data-layer]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var on = btn.getAttribute('aria-pressed') !== 'true';
        btn.setAttribute('aria-pressed', String(on));
        if (btn.dataset.layer === 'ground') { setGround(on); return; }
        var c = {};
        LAYERS[btn.dataset.layer].forEach(function (t) { c[t] = { visible: on }; });
        if (btn.dataset.layer === 'geoid') {
          state.geoidOn = on;
          c[T.ground] = { z: groundZ() };   // sea cells: hidden under the geoid, or clipped
        }
        redraw(c);
      });
    });

    $('#ampToggle').addEventListener('click', function () {
      var on = this.getAttribute('aria-pressed') !== 'true';
      this.setAttribute('aria-pressed', String(on));
      setAmp(on);
    });

    $all('.seg button[data-cam]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        $all('.seg button[data-cam]').forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
        Plotly.relayout(plotEl, { 'scene.camera': CAMERAS[btn.dataset.cam] });
      });
    });

    $('#hIn').addEventListener('input', updateConverter);

    // Pin on a click, not at the start of a drag. Plotly's 3D plotly_click fires on every frame
    // the button is down, so a rotate that starts on a surface would move the pin. Instead,
    // remember the hovered point and pin it only on a short press that didn't move.
    var hovered = null, down = null;
    plotEl.on('plotly_hover', function (ev) {
      var p = ev && ev.points && ev.points[0];
      hovered = p && (p.curveNumber === T.geoid || p.curveNumber === T.ground) ? { x: p.x, y: p.y } : null;
    });
    plotEl.on('plotly_unhover', function () { hovered = null; });
    plotEl.addEventListener('pointerdown', function (e) {
      down = { x: e.clientX, y: e.clientY, t: Date.now(), target: hovered };
    }, true);
    plotEl.addEventListener('pointerup', function (e) {
      if (!down) return;
      var still = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5 && Date.now() - down.t < 600;
      var target = down.target || hovered;
      down = null;
      if (still && target && setPin(target.x, target.y, '')) {
        var c = {};
        c[T.probe] = probeChange();
        redraw(c);
      }
    }, true);
  }

  // ---------- Boot ----------
  function fail(msg) {
    $('#loading').classList.add('error');
    $('#loadingText').innerHTML = msg;
  }

  function boot() {
    if (!window.Plotly) { fail('Couldn’t load Plotly from the CDN. Check your connection and reload.'); return; }

    dataPromise.then(function (d) {
      var g = state.g = toGrid(d), s = g.stats;
      state.samples = sampleOutline(g);
      $('#nMin').textContent = s.nMin.toFixed(1);
      $('#nMax').textContent = s.nMax.toFixed(1) + ' m';
      $('#hMin').textContent = s.hMin;
      $('#hMax').textContent = s.hMax.toLocaleString('en-US') + ' m';
      $('#groundRamp').style.background = 'linear-gradient(90deg, ' + groundScale(s.hMin, s.hMax).map(function (c) {
        return c[1] + ' ' + (c[0] * 100).toFixed(1) + '%';
      }).join(', ') + ')';
      $('#gridInfo').textContent = g.ny + ' × ' + g.nx + ' nodes at ' + g.step + '° spacing (about 2.8 km); N ranges from ' +
        s.nMin.toFixed(1) + ' to ' + s.nMax.toFixed(1) + ' m.';
      updateBadge();
      // Pin first, so the probe is part of the first render instead of a second full redraw
      setPin(DEFAULT_PIN.lon, DEFAULT_PIN.lat, DEFAULT_PIN.name);

      var traces = [];
      traces[T.ellipsoid] = ellipsoidTrace(g);
      traces[T.geoid] = geoidTrace(g);
      traces[T.ground] = groundTrace(g);
      var outlines = outlineTraces();
      traces[T.outlineE] = outlines[0];
      traces[T.outlineTop] = outlines[1];
      traces[T.curtain] = curtainTrace();
      traces[T.probe] = probeTrace();
      traces[T.ellipsoidGrid] = ellipsoidGridTrace(g);

      return Plotly.newPlot(plotEl, traces, layout(), { responsive: true, displayModeBar: false, scrollZoom: true });
    }).then(function () {
      bindControls();
      $('#loading').classList.add('done');
    }).catch(function (err) {
      console.error(err);
      fail('Couldn’t load the data (' + String(err.message).replace(/</g, '&lt;') + ').<br>Serve this folder over HTTP, for example <code>python -m http.server</code>, rather than opening the file directly.');
    });
  }

  boot();
})();
