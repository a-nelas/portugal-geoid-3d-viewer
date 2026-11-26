# Geoid vs ellipsoid: Portugal

Interactive 3D view of mainland Portugal's terrain, the **GeodPT08 geoid** (mean sea level) and the **GRS80 ellipsoid** that GPS measures from. Over Portugal the geoid sits 45–58 m above the ellipsoid, so a raw GPS height reads that much higher than the height on a map. The page shows that gap and explains it, and its converter turns a GPS height into a sea-level height at any point you pick.

## What you see

| Layer | Meaning |
| --- | --- |
| **Ground** (green) | Real terrain (SRTM) at its true height above the geoid. |
| **Geoid** (blue) | Where gravity puts "sea level". Height zero for maps and road signs. |
| **Ellipsoid** (purple) | A smooth mathematical surface. Height zero for GPS. |
| **Gap N** (red) | The geoid undulation: how far the geoid sits above the ellipsoid. |

Horizontal proportions are true; the height axis is fitted to the box (0–2,000 m with the ground on, 0–70 m with it off, so the geoid's shape shows). Click the ground or the geoid to pin a point and read its N and ground height, and see **H = h − N** worked out.

## Run it

The page is static, but browsers block `fetch` from `file://`, so serve the folder:

```sh
python -m http.server 8791
```

Then open <http://localhost:8791>.

## Rebuild the data

`data/portugal.json` (about 300 KB) is the only data file the page loads. It merges the geoid grid, the terrain heights and the mainland outline. To regenerate it:

```sh
python tools/build_data.py
```

The script uses the Python standard library only. It downloads the outline and about 15,000 elevation samples once (around 3 minutes, at one request per second) and caches them in `data/source/`.

## Files

```
index.html             page and guide text
styles.css             layout and theme
app.js                 3D scene (Plotly gl3d) and controls
icon.svg               favicon / logo
data/portugal.json     built data the page loads
data/source/           GeodPT08.dat, GISCO outline, elevation cache
tools/build_data.py    builds data/portugal.json
```

## Data sources

- **GeodPT08** geoid model: Direção-Geral do Território (DGT), Portugal.
- **Terrain**: SRTM 90 m (NASA, public domain), retrieved through [OpenTopoData](https://www.opentopodata.org/).
- **Outline**: GISCO country polygons, 1:20 million. © EuroGeographics for the administrative boundaries.
- **Rendering**: [Plotly.js](https://plotly.com/javascript/) 2.30 (gl3d bundle).
