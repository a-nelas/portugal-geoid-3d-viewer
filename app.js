(function () {
  'use strict';

  // ---------- Config ----------
  var DAT_URL = 'GeodPT08.dat';
  var BORDER_URL = 'CNTR_BN_20M_2024_4326.geojson';
  var LON_MIN_MAINLAND = -12;          // drop Madeira / Azores
  var LIFT = 0.4;                      // metres; keeps lines off the surfaces (z-fighting)
  var CURTAIN_EVERY = 3;               // one gap line every n border vertices

  var C = {
    geoid: '#4cc9f0', ellipsoid: '#b48cff', n: '#ef476f',
    ink: '#e8ebf4', muted: '#98a1b6', faint: '#6f7994', grid: '#222b45', line: '#323e60'
  };
  var GEOID_SCALE = [[0, '#173a7a'], [0.35, '#1f6fb8'], [0.7, '#4cc9f0'], [1, '#c4f1ff']];
  var FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

  var EXAG_MIN = 500, EXAG_MAX = 20000, EXAG_DEFAULT = 4000;
  var DEFAULT_PIN = { lon: -9.1393, lat: 38.7223, name: 'Lisbon' };

  var T = { ellipsoid: 0, geoid: 1, borderE: 2, borderG: 3, curtain: 4, probe: 5 };
  var LAYERS = { geoid: [T.geoid], ellipsoid: [T.ellipsoid], gap: [T.curtain], borders: [T.borderE, T.borderG] };

  var CAMERAS = {
    perspective: { eye: { x: -1.25, y: -1.45, z: 0.85 }, up: { x: 0, y: 0, z: 1 }, center: { x: 0, y: 0, z: -0.12 }, projection: { type: 'perspective' } },
    side:        { eye: { x: 0, y: -2.1, z: 0.02 },      up: { x: 0, y: 0, z: 1 }, center: { x: 0, y: 0, z: 0 },     projection: { type: 'orthographic' } },
    top:         { eye: { x: 0, y: 0, z: 2.1 },          up: { x: 0, y: 1, z: 0 }, center: { x: 0, y: 0, z: 0 },     projection: { type: 'orthographic' } }
  };

  var state = { grid: null, zTop: 60, exag: EXAG_DEFAULT, pin: null };

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  var plotEl = $('#plot');

  // ---------- Parsing ----------
  function roundN(num, n) { if (n === void 0) n = 8; return Math.round((+num) * Math.pow(10, n)) / Math.pow(10, n); }

  // Whitespace / comma separated "x y z" rows
  function parseDAT(text) {
    var pts = [], bad = 0, lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = (lines[i] || '').trim();
      if (!line || line.indexOf('#') === 0 || line.indexOf('//') === 0) continue;
      var s = line.split(/[\s,;]+/).filter(Boolean);
      if (s.length < 3) { bad++; continue; }
      var x = parseFloat(s[0]), y = parseFloat(s[1]), z = parseFloat(s[2]);
      if (isNaN(x) || isNaN(y) || isNaN(z)) { bad++; continue; }
      pts.push({ x: x, y: y, z: z });
    }
    return { pts: pts, bad: bad };
  }

  // Turns scattered points into X[], Y[], Z[y][x] if they form a complete regular grid
  function detectGrid(pts) {
    if (!pts.length) return null;
    var xKeys = new Map(), yKeys = new Map(), grid = new Map();
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], xk = roundN(p.x).toFixed(8), yk = roundN(p.y).toFixed(8);
      if (!xKeys.has(xk)) xKeys.set(xk, p.x);
      if (!yKeys.has(yk)) yKeys.set(yk, p.y);
      grid.set(yk + '|' + xk, p.z);
    }
    var xs = Array.from(xKeys.entries()).sort(function (a, b) { return a[1] - b[1]; });
    var ys = Array.from(yKeys.entries()).sort(function (a, b) { return a[1] - b[1]; });
    if (xs.length * ys.length !== pts.length) return null;
    var Z = [], min = Infinity, max = -Infinity;
    for (var yi = 0; yi < ys.length; yi++) {
      var row = [];
      for (var xi = 0; xi < xs.length; xi++) {
        var key = ys[yi][0] + '|' + xs[xi][0];
        if (!grid.has(key)) return null;
        var z = grid.get(key);
        if (z < min) min = z;
        if (z > max) max = z;
        row.push(z);
      }
      Z.push(row);
    }
    return { X: xs.map(function (e) { return e[1]; }), Y: ys.map(function (e) { return e[1]; }), Z: Z, min: min, max: max };
  }

  // ---------- Grid lookup ----------
  function findBracket(arr, v) {
    var n = arr.length;
    if (v < arr[0] || v > arr[n - 1]) return -1;
    for (var i = 0; i < n - 1; i++) { if (v >= arr[i] && v <= arr[i + 1]) return i; }
    return -1;
  }
  function bilinearZ(g, lon, lat) {
    var ix = findBracket(g.X, lon), iy = findBracket(g.Y, lat);
    if (ix < 0 || iy < 0) return null;
    var x0 = g.X[ix], x1 = g.X[ix + 1], y0 = g.Y[iy], y1 = g.Y[iy + 1];
    var z00 = g.Z[iy][ix], z10 = g.Z[iy][ix + 1], z01 = g.Z[iy + 1][ix], z11 = g.Z[iy + 1][ix + 1];
    var tx = (lon - x0) / (x1 - x0), ty = (lat - y0) / (y1 - y0);
    var z0 = z00 * (1 - tx) + z10 * tx, z1 = z01 * (1 - tx) + z11 * tx;
    return z0 * (1 - ty) + z1 * ty;
  }

  // ---------- Borders ----------
  function featureTouchesPortugalBN(props) {
    var p = props || {};
    var vals = [p.LEFT_URI, p.RIGHT_URI, p.LEFT_ISO3, p.RIGHT_ISO3, p.LEFT_CNTR_ID, p.RIGHT_CNTR_ID, p.CNTR_LEFT, p.CNTR_RIGHT, p.ADM0_A3_L, p.ADM0_A3_R, p.CNTR_ID_L, p.CNTR_ID_R]
      .filter(function (v) { return v != null; }).map(function (v) { return String(v).toUpperCase(); });
    for (var i = 0; i < vals.length; i++) { if (vals[i] === 'PRT' || vals[i] === 'PT') return true; }
    return false;
  }
  function linesFromGeometry(g) {
    if (!g) return [];
    if (g.type === 'LineString') return [g.coordinates];
    if (g.type === 'MultiLineString') return g.coordinates;
    if (g.type === 'Polygon') return g.coordinates;
    if (g.type === 'MultiPolygon') return g.coordinates.flat();
    return [];
  }

  // Mainland Portugal border runs, each vertex carrying its N; runs break where they leave the grid
  function borderRuns(geojson, grid) {
    if (!geojson) return [];
    var feats = geojson.type === 'FeatureCollection' ? geojson.features : [geojson];
    var runs = [];
    feats.filter(function (f) { return featureTouchesPortugalBN(f.properties); }).forEach(function (f) {
      linesFromGeometry(f.geometry).forEach(function (seg) {
        for (var i = 0; i < seg.length; i++) { if (seg[i][0] < LON_MIN_MAINLAND) return; }
        var run = [];
        for (var j = 0; j < seg.length; j++) {
          var lon = seg[j][0], lat = seg[j][1], n = bilinearZ(grid, lon, lat);
          if (n === null) { if (run.length > 1) runs.push(run); run = []; continue; }
          run.push({ lon: lon, lat: lat, n: n });
        }
        if (run.length > 1) runs.push(run);
      });
    });
    return runs;
  }

  // ---------- Traces ----------
  function stepped(a, b, s) {
    var out = [a];
    for (var v = Math.ceil(a / s) * s; v < b - 1e-9; v += s) { if (v > a + 1e-9) out.push(roundN(v, 6)); }
    out.push(b);
    return out;
  }

  function ellipsoidTrace(g) {
    var x0 = g.X[0], x1 = g.X[g.X.length - 1], y0 = g.Y[0], y1 = g.Y[g.Y.length - 1];
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
    return {
      type: 'surface', name: 'Geoid', x: g.X, y: g.Y, z: g.Z,
      colorscale: GEOID_SCALE, cmin: g.min, cmax: g.max, showscale: false, opacity: 1,
      lighting: { ambient: 0.72, diffuse: 0.6, specular: 0.08, roughness: 0.9, fresnel: 0.1 },
      lightposition: { x: -1e5, y: -1e5, z: 2e5 },
      contours: {
        z: { show: true, start: Math.floor(g.min), end: Math.ceil(g.max), size: 1, color: 'rgba(8,16,36,0.35)', width: 1,
             highlight: true, highlightcolor: 'rgba(255,255,255,0.85)', highlightwidth: 2 },
        x: { highlight: false }, y: { highlight: false }
      },
      hovertemplate: 'lat %{y:.3f}° · lon %{x:.3f}°<br><b>N = %{z:.2f} m</b><extra></extra>'
    };
  }

  function lineTrace(runs, zOf, line) {
    var x = [], y = [], z = [];
    runs.forEach(function (run) {
      run.forEach(function (p) { x.push(p.lon); y.push(p.lat); z.push(zOf(p)); });
      x.push(null); y.push(null); z.push(null);
    });
    return { type: 'scatter3d', mode: 'lines', x: x, y: y, z: z, line: line, hoverinfo: 'skip', showlegend: false };
  }

  function curtainTrace(runs) {
    var x = [], y = [], z = [];
    runs.forEach(function (run) {
      for (var i = 0; i < run.length; i += CURTAIN_EVERY) {
        var p = run[i];
        x.push(p.lon, p.lon, null); y.push(p.lat, p.lat, null); z.push(0, p.n, null);
      }
    });
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
    var g = state.grid;
    var midLat = (g.Y[0] + g.Y[g.Y.length - 1]) / 2 * Math.PI / 180;
    var kmX = (g.X[g.X.length - 1] - g.X[0]) * 111.32 * Math.cos(midLat);
    var kmY = (g.Y[g.Y.length - 1] - g.Y[0]) * 110.57;
    var kmZ = state.zTop / 1000 * state.exag;
    var m = Math.max(kmX, kmY);
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
        zaxis: axis('Height above ellipsoid (m)', { range: [0, state.zTop], dtick: 10 })
      }
    };
  }

  // ---------- Pin + converter ----------
  function fmtLat(v) { return Math.abs(v).toFixed(4) + '° ' + (v >= 0 ? 'N' : 'S'); }
  function fmtLon(v) { return Math.abs(v).toFixed(4) + '° ' + (v >= 0 ? 'E' : 'W'); }

  function setPin(lon, lat, name) {
    var n = bilinearZ(state.grid, lon, lat);
    if (n === null) return;
    state.pin = { lon: lon, lat: lat, n: n, name: name || '' };
    // Segment ellipsoid → geoid, then a gap, then a label point floating above the geoid so the surface can't hide it
    var labelZ = n + state.zTop * 0.12;
    Plotly.restyle(plotEl, {
      x: [[lon, lon, null, lon]], y: [[lat, lat, null, lat]], z: [[LIFT, n + LIFT, null, labelZ]],
      text: [['', '', '', 'N = ' + n.toFixed(2) + ' m']]
    }, [T.probe]);
    $('#pinName').textContent = state.pin.name;
    $('#pinLat').textContent = fmtLat(lat);
    $('#pinLon').textContent = fmtLon(lon);
    $('#pinN').textContent = n.toFixed(2) + ' m';
    updateConverter();
  }

  function updateConverter() {
    var out = $('#hOut'), h = parseFloat($('#hIn').value);
    if (!state.pin || isNaN(h)) { out.textContent = '—'; return; }
    out.textContent = (h - state.pin.n).toFixed(2) + ' m';
  }

  // ---------- Controls ----------
  function exagFromSlider(v) {
    var e = EXAG_MIN * Math.pow(EXAG_MAX / EXAG_MIN, v / 1000);
    var p = Math.pow(10, Math.floor(Math.log10(e)) - 1);   // two significant figures
    return Math.round(e / p) * p;
  }
  function sliderFromExag(e) { return Math.round(1000 * Math.log(e / EXAG_MIN) / Math.log(EXAG_MAX / EXAG_MIN)); }

  function bindControls() {
    $all('.chip[data-layer]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var on = btn.getAttribute('aria-pressed') !== 'true';
        btn.setAttribute('aria-pressed', String(on));
        Plotly.restyle(plotEl, { visible: on }, LAYERS[btn.dataset.layer]);
      });
    });

    $all('.seg button[data-cam]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        $all('.seg button[data-cam]').forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
        Plotly.relayout(plotEl, { 'scene.camera': CAMERAS[btn.dataset.cam] });
      });
    });

    var slider = $('#exag'), label = $('#exagOut'), pending = false;
    slider.value = sliderFromExag(EXAG_DEFAULT);
    label.textContent = '×' + EXAG_DEFAULT.toLocaleString('en-US');
    slider.addEventListener('input', function () {
      state.exag = exagFromSlider(+slider.value);
      label.textContent = '×' + state.exag.toLocaleString('en-US');
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        Plotly.relayout(plotEl, { 'scene.aspectratio': aspect() });
      });
    });

    $('#hIn').addEventListener('input', updateConverter);

    // Pin on a click, not at the start of a drag. Plotly's 3D plotly_click fires on every frame
    // the button is down, so a rotate that starts on the geoid would move the pin. Instead,
    // remember the hovered geoid point and pin it only on a short press that didn't move.
    var hovered = null, down = null;
    plotEl.on('plotly_hover', function (ev) {
      var p = ev && ev.points && ev.points[0];
      hovered = p && p.curveNumber === T.geoid ? { x: p.x, y: p.y } : null;
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
    var box = $('#loading');
    box.classList.add('error');
    $('#loadingText').innerHTML = msg;
  }

  function fetchText(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + ': HTTP ' + r.status); return r.text(); });
  }
  function fetchJSON(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + ': HTTP ' + r.status); return r.json(); });
  }

  function boot() {
    if (!window.Plotly) { fail('Couldn’t load Plotly from the CDN. Check your connection and reload.'); return; }

    var borders = fetchJSON(BORDER_URL).catch(function (e) { console.warn('Border overlay skipped:', e); return null; });

    fetchText(DAT_URL).then(function (text) {
      var parsed = parseDAT(text);
      if (!parsed.pts.length) throw new Error('no valid rows in ' + DAT_URL);
      var grid = detectGrid(parsed.pts);
      if (!grid) throw new Error(DAT_URL + ' is not a complete regular grid');
      state.grid = grid;
      state.zTop = Math.ceil((grid.max + 2) / 10) * 10;

      $('#nMin').textContent = grid.min.toFixed(1);
      $('#nMax').textContent = grid.max.toFixed(1) + ' m';
      var step = grid.X.length > 1 ? (grid.X[1] - grid.X[0]) : 0;
      $('#gridInfo').textContent = 'Loaded ' + grid.Y.length + ' × ' + grid.X.length + ' nodes at ' + roundN(step, 4) +
        '° spacing; N ranges from ' + grid.min.toFixed(1) + ' to ' + grid.max.toFixed(1) + ' m.' +
        (parsed.bad ? ' Skipped ' + parsed.bad + ' malformed line(s).' : '');

      return borders.then(function (gj) {
        var runs = borderRuns(gj, grid);
        var traces = [];
        traces[T.ellipsoid] = ellipsoidTrace(grid);
        traces[T.geoid] = geoidTrace(grid);
        traces[T.borderE] = lineTrace(runs, function () { return LIFT; }, { color: 'rgba(232,235,244,0.4)', width: 2 });
        traces[T.borderG] = lineTrace(runs, function (p) { return p.n + LIFT; }, { color: '#f4f6fb', width: 3.5 });
        traces[T.curtain] = curtainTrace(runs);
        traces[T.probe] = probeTrace();

        return Plotly.newPlot(plotEl, traces, layout(), { responsive: true, displayModeBar: false, scrollZoom: true });
      });
    }).then(function () {
      bindControls();
      setPin(DEFAULT_PIN.lon, DEFAULT_PIN.lat, DEFAULT_PIN.name);
      $('#loading').classList.add('done');
    }).catch(function (err) {
      console.error(err);
      fail('Couldn’t load the geoid grid (' + String(err.message).replace(/</g, '&lt;') + ').<br>Serve this folder over HTTP, for example <code>python -m http.server</code>, rather than opening the file directly.');
    });
  }

  boot();
})();
