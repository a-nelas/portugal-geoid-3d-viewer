"""Build data/portugal.json, the single data file the viewer loads.

Inputs
  data/source/GeodPT08.dat         geoid grid, rows of "lon lat N" (metres)
  GISCO PT country polygon         downloaded once, cached in data/source/
  OpenTopoData elevation API       SRTM 90 m (public domain), cached in data/source/

Output (compact JSON, row-major grids, row 0 = southernmost latitude)
  lon0, lat0, step, nx, ny
  N        geoid undulation in centimetres (ints)
  H        ground height in metres (ints), -1 outside mainland Portugal
  outline  mainland Portugal outline ring [[lon, lat], ...]
  stats    nMin, nMax (m), hMax (m), land (node count)

Usage:  python tools/build_data.py
Standard library only.
"""

import json
import math
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "source"
DAT = SRC / "GeodPT08.dat"
PT_GEOJSON = SRC / "PT-region-20m-4326-2024.geojson"
ELEV_CACHE = SRC / "elevation_cache.json"
OUT = ROOT / "data" / "portugal.json"

PT_URL = ("https://gisco-services.ec.europa.eu/distribution/v2/countries/"
          "distribution/PT-region-20m-4326-2024.geojson")
ELEV_URL = "https://api.opentopodata.org/v1/srtm90m?locations={locs}"
USER_AGENT = "geoid-viewer-build/1.0"
BATCH = 100              # OpenTopoData accepts up to 100 locations per request
PAUSE = 1.1              # public API allows 1 request per second
LON_MIN_MAINLAND = -12   # drops Madeira and the Azores


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as res:
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


# ---------- Ground height ----------
def elevations(points):
    cache = json.loads(ELEV_CACHE.read_text()) if ELEV_CACHE.exists() else {}
    key = lambda p: f"{p[1]:.4f},{p[0]:.4f}"
    todo = [p for p in points if key(p) not in cache]
    batches = math.ceil(len(todo) / BATCH)
    if todo:
        print(f"Fetching {len(todo)} elevations in {batches} requests...")
    for b in range(batches):
        chunk = todo[b * BATCH:(b + 1) * BATCH]
        url = ELEV_URL.format(locs="|".join(f"{p[1]:.4f},{p[0]:.4f}" for p in chunk))
        for attempt in range(6):
            try:
                values = [r["elevation"] or 0 for r in json.loads(fetch(url))["results"]]
                break
            except urllib.error.HTTPError as e:
                if e.code != 429 or attempt == 5:
                    raise
                time.sleep(5 * (attempt + 1))
        for p, v in zip(chunk, values):
            cache[key(p)] = v
        if (b + 1) % 20 == 0 or b + 1 == batches:
            print(f"  {b + 1}/{batches}")
            ELEV_CACHE.write_text(json.dumps(cache, separators=(",", ":")))
        time.sleep(PAUSE)
    return [cache[key(p)] for p in points]


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

    heights = [-1] * (nx * ny)
    for (lon, lat, idx), h in zip(land, elevations(land)):
        heights[idx] = max(0, round(h))  # clamp estuary / below-datum cells to 0

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
    print(f"Wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
