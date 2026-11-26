(function () {
  'use strict';

  // ---------- Config ----------
  var DATA_URL = 'data/portugal.json';  // built by tools/build_data.py
  var LIFT = 0.4;                       // metres; keeps lines off the surfaces (z-fighting)
  var LIFT_GROUND = 8;                  // same, for lines on the ground (height axis spans ~2 km)
  var BOX_Z = 0.4;                      // box height relative to its longest side (auto-fit)

  var C = {
    geoid: '#4cc9f0', ellipsoid: '#b48cff', n: '#ef476f', ground: '#7fb069',
    ink: '#e8ebf4', muted: '#98a1b6', faint: '#6f7994', grid: '#222b45', line: '#323e60'
  };
  var GEOID_SCALE = [[0, '#173a7a'], [0.35, '#1f6fb8'], [0.7, '#4cc9f0'], [1, '#c4f1ff']];
  var GROUND_SCALE = [[0, '#2f4a33'], [0.15, '#4f7a45'], [0.4, '#8fae6a'], [0.7, '#c9b98a'], [1, '#f1ece0']];
  var FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

  var DEFAULT_PIN = { lon: -9.1393, lat: 38.7223, name: 'Lisbon' };

  var T = { ellipsoid: 0, geoid: 1, ground: 2, outlineE: 3, outlineTop: 4, curtain: 5, probe: 6 };
  var LAYERS = { geoid: [T.geoid], ellipsoid: [T.ellipsoid], ground: [T.ground], gap: [T.curtain], borders: [T.outlineE, T.outlineTop] };

  // All perspective: switching scene.camera.projection at runtime corrupts the WebGL scene
  // in Plotly 2.30 (surfaces vanish, axes garble), so the presets only move the eye.
  var CAMERAS = {
    perspective: { eye: { x: -1.25, y: -1.45, z: 0.85 }, up: { x: 0, y: 0, z: 1 }, center: { x: 0, y: 0, z: -0.12 } },
    side:        { eye: { x: 0.35, y: -2.2, z: 0.05 },   up: { x: 0, y: 0, z: 1 }, center: { x: 0, y: 0, z: 0 } },
    top:         { eye: { x: 0, y: -0.01, z: 2.2 },      up: { x: 0, y: 1, z: 0 }, center: { x: 0, y: 0, z: 0 } }
  };

  // g: grid ({lon0, lat0, step, nx, ny, N: Float32Array, H: Int16Array (-1 = no ground), X, Y, stats})
  var state = { g: null, groundOn: true, pin: null, outlineZ: null };

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
    return { lon0: d.lon0, lat0: d.lat0, step: d.step, nx: d.nx, ny: d.ny, N: N, H: H, X: X, Y: Y, outline: d.outline, stats: d.stats };
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

  function zTop() {
    var s = state.g.stats;
    // Ground on: true heights up to ~1,940 m. Ground off: axis zooms onto the 45-58 m geoid.
    return state.groundOn ? Math.ceil((s.nMax + s.hMax + 20) / 100) * 100 : Math.ceil((s.nMax + 2) / 10) * 10;
  }

  // ---------- Traces ----------
  function stepped(a, b, s) {
    var out = [a];
    for (var v = Math.ceil(a / s) * s; v < b - 1e-9; v += s) { if (v > a + 1e-9) out.push(+v.toFixed(6)); }
    out.push(b);
    return out;
  }

  function rows(g, fn) {
    var Z = new Array(g.ny);
    for (var j = 0; j < g.ny; j++) {
      var row = new Array(g.nx);
      for (var i = 0; i < g.nx; i++) row[i] = fn(j * g.nx + i);
      Z[j] = row;
    }
    return Z;
  }

  function ellipsoidTrace(g) {
    var x0 = g.X[0], x1 = g.X[g.nx - 1], y0 = g.Y[0], y1 = g.Y[g.ny - 1];
    var ex = stepped(x0, x1, 0.5), ey = stepped(y0, y1, 0.5);
    var ez = ey.map(function () { return ex.map(function () { return 0; }); });
    var gridLine = { show: true, size: 0.5, color: 'rgba(206,180,255,0.55)', width: 1, highlight: false };
    return {
      type: 'surface', name: 'Ellipsoid', x: ex, y: ey, z: ez, surfacecolor: ez,
      colorscale: [[0, C.ellipsoid], [1, C.ellipsoid]], showscale: false, opacity: 0.32,
      lighting: { ambient: 1, diffuse: 0, specular: 0, fresnel: 0 },
      contours: {
        x: Object.assign({ start: Math.ceil(x0 * 2) / 2, end: x1 }, gridLine),
        y: Object.assign({ start: Math.ceil(y0 * 2) / 2, end: y1 }, gridLine),
        z: { highlight: false }
      },
      hoverinfo: 'skip'
    };
  }

  function geoidTrace(g) {
    var s = g.stats;
    return {
      type: 'surface', name: 'Geoid', x: g.X, y: g.Y, z: rows(g, function (k) { return g.N[k]; }),
      colorscale: GEOID_SCALE, cmin: s.nMin, cmax: s.nMax, showscale: false, opacity: 1,
      lighting: { ambient: 0.72, diffuse: 0.6, specular: 0.08, roughness: 0.9, fresnel: 0.1 },
      lightposition: { x: -1e5, y: -1e5, z: 2e5 },
      contours: {
        z: { show: true, start: Math.floor(s.nMin), end: Math.ceil(s.nMax), size: 1, color: 'rgba(8,16,36,0.35)', width: 1,
             highlight: true, highlightcolor: 'rgba(255,255,255,0.85)', highlightwidth: 2 },
        x: { highlight: false }, y: { highlight: false }
      },
      hovertemplate: 'lat %{y:.3f}° · lon %{x:.3f}°<br><b>N = %{z:.2f} m</b><extra>Geoid</extra>'
    };
  }

  // Plotly's 3D surface picking breaks (stack overflow, no hover) when z has nulls, so cells
  // outside Portugal sit just under the geoid and are made invisible with an opacity scale:
  // they get surfacecolor -SEA, which maps below the `cut` where opacity drops to 0.
  // (Surface hovertemplates only expose x/y/z, so the exact H is shown in the pin readout.)
  var SEA = 60;
  function groundTrace(g) {
    var hMax = g.stats.hMax, cut = SEA / (hMax + SEA);
    var z = rows(g, function (k) { return g.H[k] < 0 ? g.N[k] - 1 : g.N[k] + g.H[k]; });
    var color = rows(g, function (k) { return g.H[k] < 0 ? -SEA : g.H[k]; });
    var scale = [[0, GROUND_SCALE[0][1]]].concat(GROUND_SCALE.map(function (s) { return [cut + s[0] * (1 - cut), s[1]]; }));
    return {
      type: 'surface', name: 'Ground', x: g.X, y: g.Y, z: z, surfacecolor: color,
      colorscale: scale, cmin: -SEA, cmax: hMax, showscale: false,
      opacityscale: [[0, 0], [cut * 0.98, 0], [cut, 1], [1, 1]],
      lighting: { ambient: 0.6, diffuse: 0.8, specular: 0.05, roughness: 1, fresnel: 0.05 },
      lightposition: { x: -1e5, y: -1e5, z: 2e5 },
      contours: { x: { highlight: false }, y: { highlight: false }, z: { highlight: false } },
      hovertemplate: 'lat %{y:.3f}° · lon %{x:.3f}°<br><b>Ground</b>: click to read its height<extra></extra>'
    };
  }

  function outlineTraces(g) {
    var x = [], y = [], zE = [], zGeoid = [], zGround = [];
    g.outline.forEach(function (p) {
      var n = geoidAt(g, p[0], p[1]);
      if (n === null) return;
      x.push(p[0]); y.push(p[1]); zE.push(LIFT);
      zGeoid.push(n + LIFT);
      zGround.push(n + groundMaxAt(g, p[0], p[1]) + LIFT_GROUND);
    });
    state.outlineZ = { geoid: zGeoid, ground: zGround };
    var base = { type: 'scatter3d', mode: 'lines', x: x, y: y, hoverinfo: 'skip', showlegend: false };
    return [
      Object.assign({}, base, { z: zE, line: { color: 'rgba(232,235,244,0.4)', width: 2 } }),
      Object.assign({}, base, { z: state.groundOn ? zGround : zGeoid, line: { color: '#f4f6fb', width: 3.5 } })
    ];
  }

  // Vertical lines ellipsoid → geoid, about every 0.2° along the outline
  function curtainTrace(g) {
    var x = [], y = [], z = [], o = g.outline;
    for (var k = 0; k < o.length - 1; k++) {
      var a = o[k], b = o[k + 1];
      var steps = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.2));
      for (var s = 0; s < steps; s++) {
        var lon = a[0] + (b[0] - a[0]) * s / steps, lat = a[1] + (b[1] - a[1]) * s / steps;
        var n = geoidAt(g, lon, lat);
        if (n === null) continue;
        x.push(lon, lon, null); y.push(lat, lat, null); z.push(0, n, null);
      }
    }
    return { type: 'scatter3d', mode: 'lines', x: x, y: y, z: z, line: { color: 'rgba(239,71,111,0.55)', width: 2 }, hoverinfo: 'skip', showlegend: false };
  }

  function probeTrace() {
    return {
      type: 'scatter3d', mode: 'lines+markers+text', x: [null], y: [null], z: [null], text: [''],
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
    var m = Math.max(kmX, kmY);
    // Horizontal proportions are true; the height axis is fitted to a fixed box height
    return { x: kmX / m, y: kmY / m, z: BOX_Z };
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
        zaxis: axis('Height above ellipsoid (m)', { range: [0, zTop()] })
      }
    };
  }

  // ---------- Pin + converter ----------
  function fmtLat(v) { return Math.abs(v).toFixed(4) + '° ' + (v >= 0 ? 'N' : 'S'); }
  function fmtLon(v) { return Math.abs(v).toFixed(4) + '° ' + (v >= 0 ? 'E' : 'W'); }

  function drawProbe() {
    var p = state.pin;
    if (!p) return;
    var top = p.n + (state.groundOn && p.h !== null ? p.h : 0);
    var labelZ = top + zTop() * 0.08;
    // Segment ellipsoid → geoid, a gap, then a label point floating above the surfaces
    Plotly.restyle(plotEl, {
      x: [[p.lon, p.lon, null, p.lon]], y: [[p.lat, p.lat, null, p.lat]], z: [[LIFT, p.n + LIFT, null, labelZ]],
      text: [['', '', '', 'N = ' + p.n.toFixed(2) + ' m']]
    }, [T.probe]);
  }

  function setPin(lon, lat, name) {
    var g = state.g, n = geoidAt(g, lon, lat);
    if (n === null) return;
    var h = groundAt(g, lon, lat);
    state.pin = { lon: lon, lat: lat, n: n, h: h, name: name || '' };
    drawProbe();

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
  }

  function updateConverter() {
    var out = $('#hOut'), h = parseFloat($('#hIn').value);
    if (!state.pin || isNaN(h)) { out.textContent = '—'; return; }
    out.textContent = (h - state.pin.n).toFixed(1) + ' m';
  }

  // ---------- Controls ----------
  function setGround(on) {
    state.groundOn = on;
    Plotly.restyle(plotEl, { z: [on ? state.outlineZ.ground : state.outlineZ.geoid] }, [T.outlineTop]);
    Plotly.relayout(plotEl, { 'scene.zaxis.range': [0, zTop()] });
    drawProbe();
  }

  function bindControls() {
    $all('.chip[data-layer]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var on = btn.getAttribute('aria-pressed') !== 'true';
        btn.setAttribute('aria-pressed', String(on));
        Plotly.restyle(plotEl, { visible: on }, LAYERS[btn.dataset.layer]);
        if (btn.dataset.layer === 'ground') setGround(on);
      });
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
      if (still && target) setPin(target.x, target.y, '');
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
      $('#nMin').textContent = s.nMin.toFixed(1);
      $('#nMax').textContent = s.nMax.toFixed(1) + ' m';
      $('#gridInfo').textContent = g.ny + ' × ' + g.nx + ' nodes at ' + g.step + '° spacing (about 2.8 km); N ranges from ' +
        s.nMin.toFixed(1) + ' to ' + s.nMax.toFixed(1) + ' m.';

      var traces = [];
      traces[T.ellipsoid] = ellipsoidTrace(g);
      traces[T.geoid] = geoidTrace(g);
      traces[T.ground] = groundTrace(g);
      var outlines = outlineTraces(g);
      traces[T.outlineE] = outlines[0];
      traces[T.outlineTop] = outlines[1];
      traces[T.curtain] = curtainTrace(g);
      traces[T.probe] = probeTrace();

      return Plotly.newPlot(plotEl, traces, layout(), { responsive: true, displayModeBar: false, scrollZoom: true });
    }).then(function () {
      bindControls();
      setPin(DEFAULT_PIN.lon, DEFAULT_PIN.lat, DEFAULT_PIN.name);
      $('#loading').classList.add('done');
    }).catch(function (err) {
      console.error(err);
      fail('Couldn’t load the data (' + String(err.message).replace(/</g, '&lt;') + ').<br>Serve this folder over HTTP, for example <code>python -m http.server</code>, rather than opening the file directly.');
    });
  }

  boot();
})();
