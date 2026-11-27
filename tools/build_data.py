"""Build data/portugal.json, the single data file the viewer loads.

Inputs
  data/source/GeodPT08.dat         geoid grid, rows of "lon lat N" (metres)
  GISCO PT country polygon         downloaded once, cached in data/source/
  Copernicus DEM GLO-90 tiles      90 m elevation, averaged over each grid cell;
                                   downloaded once (~100 MB) to data/source/dem/

Output (compact JSON, row-major grids, row 0 = southernmost latitude)
  lon0, lat0, step, nx, ny
  N        geoid undulation in centimetres (ints)
  H        ground height in metres (ints), -1 outside mainland Portugal
  outline  mainland Portugal outline ring [[lon, lat], ...]
  stats    nMin, nMax (m), hMax (m), land (node count)

Usage:  python tools/build_data.py
Standard library + numpy.
"""

import json
import math
import struct
import urllib.error
import urllib.request
import warnings
import zlib
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "source"
DAT = SRC / "GeodPT08.dat"
PT_GEOJSON = SRC / "PT-region-20m-4326-2024.geojson"
DEM_DIR = SRC / "dem"
OUT = ROOT / "data" / "portugal.json"

PT_URL = ("https://gisco-services.ec.europa.eu/distribution/v2/countries/"
          "distribution/PT-region-20m-4326-2024.geojson")
DEM_URL = "https://copernicus-dem-90m.s3.amazonaws.com/{name}/{name}.tif"
USER_AGENT = "geoid-viewer-build/1.0"
LON_MIN_MAINLAND = -12   # drops Madeira and the Azores
DEM_LON_MIN = -10        # westernmost DEM tile needed (Cabo da Roca is at -9.5)
PEAKS = {"Torre": (-7.6114, 40.3217), "Marao": (-7.8869, 41.2489),
         "Foia": (-8.5944, 37.3153), "Montejunto": (-9.0567, 39.1767)}


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as res:
        return res.read()


# ---------- Geoid grid ----------
def read_grid():
    rows = []
    for line in DAT.read_text().splitlines():
        parts = line.replace(",", " ").split()
        if len(parts) < 3 or line.lstrip().startswith(("#", "//")):
            continue
        rows.append((float(parts[0]), float(parts[1]), float(parts[2])))

    lons = sorted({round(r[0], 6) for r in rows})
    lats = sorted({round(r[1], 6) for r in rows})
    nx, ny = len(lons), len(lats)
    if nx * ny != len(rows):
        raise SystemExit(f"{DAT.name} is not a complete grid ({nx} x {ny} != {len(rows)} rows)")
    step = round(lons[1] - lons[0], 6)
    for axis in (lons, lats):
        for a, b in zip(axis, axis[1:]):
            if abs((b - a) - step) > 1e-6:
                raise SystemExit(f"{DAT.name} spacing is not uniform")

    n = [0.0] * (nx * ny)
    for lon, lat, val in rows:
        i = round((lon - lons[0]) / step)
        j = round((lat - lats[0]) / step)
        n[j * nx + i] = val
    return lons[0], lats[0], step, nx, ny, n


# ---------- Mainland outline ----------
def ring_area(ring):
    return abs(sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]))) / 2


def mainland_outline():
    if not PT_GEOJSON.exists():
        print("Downloading GISCO Portugal outline...")
        PT_GEOJSON.write_bytes(fetch(PT_URL))
    gj = json.loads(PT_GEOJSON.read_text(encoding="utf-8"))
    feats = gj["features"] if gj.get("type") == "FeatureCollection" else [gj]
    polys = []
    for f in feats:
        g = f["geometry"]
        polys += [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    outers = [[(p[0], p[1]) for p in poly[0]] for poly in polys]
    outers = [r for r in outers if min(p[0] for p in r) > LON_MIN_MAINLAND]
    return max(outers, key=ring_area)


def inside(ring, x, y):
    hit = False
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            hit = not hit
    return hit


# ---------- Ground height: Copernicus DEM GLO-90, averaged per grid cell ----------
def tile_name(lat, lon):
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    return f"Copernicus_DSM_COG_30_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM"


def get_tile(lat, lon):
    """Raw bytes of the 1x1 degree tile whose south-west corner is (lat, lon), or None for sea."""
    name = tile_name(lat, lon)
    path, missing = DEM_DIR / f"{name}.tif", DEM_DIR / f"{name}.missing"
    if path.exists():
        return path.read_bytes()
    if missing.exists():
        return None
    DEM_DIR.mkdir(parents=True, exist_ok=True)
    try:
        data = fetch(DEM_URL.format(name=name))
    except urllib.error.HTTPError as e:
        if e.code in (403, 404):      # no tile: open sea
            missing.touch()
            return None
        raise
    path.write_bytes(data)
    print(f"  downloaded {name} ({len(data) / 1e6:.1f} MB)")
    return data


def read_tiff(b):
    """Decode a Copernicus COG: float32, Deflate, floating-point predictor (3), tiled.

    Returns (array north-up, west longitude, north latitude). numpy + zlib only.
    """
    bo = "<" if b[:2] == b"II" else ">"
    u = lambda fmt, off: struct.unpack_from(bo + fmt, b, off)
    ifd = u("I", 4)[0]
    sizes = {1: 1, 2: 1, 3: 2, 4: 4, 12: 8, 16: 8}
    codes = {1: "B", 2: "c", 3: "H", 4: "I", 12: "d", 16: "Q"}
    tags = {}
    for k in range(u("H", ifd)[0]):
        tag, typ, cnt = u("HHI", ifd + 2 + 12 * k)
        if typ not in codes:
            continue
        size = sizes[typ] * cnt
        off = ifd + 10 + 12 * k if size <= 4 else u("I", ifd + 10 + 12 * k)[0]
        tags[tag] = u(f"{cnt}{codes[typ]}", off)
    w, h = tags[256][0], tags[257][0]
    tw, th = tags[322][0], tags[323][0]
    if tags[259][0] != 8 or tags[339][0] != 3 or tags[258][0] != 32:
        raise SystemExit("unexpected DEM tile format (need float32 + Deflate)")
    predictor = tags.get(317, (1,))[0]

    out = np.empty((math.ceil(h / th) * th, math.ceil(w / tw) * tw), dtype=np.float32)
    across = math.ceil(w / tw)
    for t, (off, cnt) in enumerate(zip(tags[324], tags[325])):
        raw = np.frombuffer(zlib.decompress(b[off:off + cnt]), dtype=np.uint8)
        if predictor == 3:
            # byte-wise running sum along each row, then regroup the 4 byte planes (MSB first)
            rows = np.cumsum(raw.reshape(th, tw * 4), axis=1, dtype=np.uint8)
            tile = rows.reshape(th, 4, tw).transpose(0, 2, 1).copy().view(">f4").reshape(th, tw)
        else:
            tile = raw.view(bo + "f4").reshape(th, tw)
        r, c = divmod(t, across)
        out[r * th:(r + 1) * th, c * tw:(c + 1) * tw] = tile
    tie = tags[33922]          # (i, j, k, lon, lat, z) of the top-left corner
    return out[:h, :w], tie[3], tie[4]


def cell_means(lon0, lat0, step, nx, ny):
    """Mean DEM height of each grid cell (NaN where there is no DEM data)."""
    means = np.full((ny, nx), np.nan)
    lat_lo, lat_hi = math.floor(lat0), math.floor(lat0 + (ny - 1) * step)
    lon_lo, lon_hi = math.floor(lon0), math.floor(lon0 + (nx - 1) * step)
    print(f"Reading DEM tiles, latitude {lat_lo}..{lat_hi}, longitude {lon_lo}..{lon_hi}")
    for lat in range(lat_lo, lat_hi + 1):
        for lon in range(lon_lo, lon_hi + 1):
            if lon < DEM_LON_MIN:
                continue
            data = get_tile(lat, lon)
            if data is None:
                continue
            arr, west, north = read_tiff(data)
            west, north = round(west), round(north)          # tiles start on whole degrees
            per = round(1 / step)                            # cells per degree (40)
            px = arr.shape[0] // per                         # pixels per cell (30)
            arr = np.where(arr < -1000, np.nan, arr)         # nodata
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)  # all-nodata cells -> NaN
                blocks = np.nanmean(arr.reshape(per, px, per, px), axis=(1, 3))
            for r in range(per):
                j = round((north - (r + 0.5) * step - lat0) / step)
                if not 0 <= j < ny:
                    continue
                for c in range(per):
                    i = round((west + (c + 0.5) * step - lon0) / step)
                    if 0 <= i < nx:
                        means[j, i] = blocks[r, c]
    return means


def main():
    lon0, lat0, step, nx, ny, n = read_grid()
    ring = mainland_outline()

    land = []  # (lon, lat, index)
    for j in range(ny):
        lat = lat0 + j * step
        for i in range(nx):
            lon = lon0 + i * step
            if inside(ring, lon, lat):
                land.append((lon, lat, j * nx + i))

    means = cell_means(lon0, lat0, step, nx, ny)
    heights = [-1] * (nx * ny)
    gaps = 0
    for lon, lat, idx in land:
        h = means[idx // nx, idx % nx]
        if np.isnan(h):
            gaps += 1
            h = 0
        heights[idx] = max(0, round(float(h)))  # clamp estuary / below-datum cells to 0

    out = {
        "lon0": lon0, "lat0": lat0, "step": step, "nx": nx, "ny": ny,
        "N": [round(v * 100) for v in n],
        "H": heights,
        "outline": [[round(x, 4), round(y, 4)] for x, y in ring],
        "stats": {"nMin": min(n), "nMax": max(n), "hMax": max(heights), "land": len(land)},
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")))

    s = out["stats"]
    print(f"Grid {nx} x {ny} at {step} deg; {s['land']} land nodes; "
          f"N {s['nMin']:.3f}..{s['nMax']:.3f} m; H max {s['hMax']} m; "
          f"outline {len(ring)} vertices")
    H = np.array(heights).reshape(ny, nx)
    pairs = (H[:, :-1] >= 0) & (H[:, 1:] >= 0)
    diffs = np.abs(H[:, :-1] - H[:, 1:])[pairs]
    print(f"Neighbour difference: median {np.median(diffs):.0f} m, 90th pct {np.percentile(diffs, 90):.0f} m; "
          f"{gaps} land cells without DEM data")
    for name, (lon, lat) in PEAKS.items():
        i, j = round((lon - lon0) / step), round((lat - lat0) / step)
        print(f"  {name:10s} cell mean {H[j, i]} m")
    print(f"Wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
