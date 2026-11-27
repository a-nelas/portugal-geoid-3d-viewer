# Geoid vs ellipsoid: Portugal

Interactive 3D view of mainland Portugal's terrain, the **GeodPT08 geoid** (mean sea level) and the **GRS80 ellipsoid** that GPS measures from. Over Portugal the geoid sits 45–58 m above the ellipsoid, so a raw GPS height reads that much higher than the height on a map. The page shows that gap and explains it, and its converter turns a GPS height into a sea-level height at any point you pick.

## What you see

| Layer | Meaning |
| --- | --- |
| **Ground** (green) | Real terrain (Copernicus DEM, averaged per 2.8 km cell) at its true height above the geoid. |
| **Geoid** (blue) | Where gravity puts "sea level". Height zero for maps and road signs. |
| **Ellipsoid** (purple) | A smooth mathematical surface. Height zero for GPS. |
| **Gap N** (red) | The geoid undulation: how far the geoid sits above the ellipsoid. |

By default the gap N is exaggerated 1,000 times, so the geoid floats 45–58 km above the ellipsoid and its tilt across the country shows; the ground on top of it stays at true scale. Switch **Exaggerate gap N ×1,000** off to draw everything at true 1:1 scale, heights in the same units as distances: the country looks almost flat and the 50 m gap is too thin to see. Either way the pinned-point panel reads the true N. Click the ground or the geoid to pin a point and read its N and ground height, and see **H = h − N** worked out.

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

The script needs Python with numpy. The first run downloads the outline and about 30 Copernicus DEM tiles (about 130 MB, cached in the git-ignored `data/source/dem/`), then averages the 90 m pixels inside each 2.8 km grid cell.

## Files

```
index.html             page and guide text
styles.css             layout and theme
app.js                 3D scene (Plotly gl3d) and controls
icon.svg               favicon / logo
data/portugal.json     built data the page loads
data/source/           GeodPT08.dat, GISCO outline (DEM tiles cached in dem/)
tools/build_data.py    builds data/portugal.json
```

## Data sources

- **GeodPT08** geoid model: Direção-Geral do Território (DGT), Portugal.
- **Terrain**: [Copernicus DEM GLO-90](https://registry.opendata.aws/copernicus-dem/). © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA; all rights reserved.
- **Outline**: GISCO country polygons, 1:20 million. © EuroGeographics for the administrative boundaries.
- **Rendering**: [Plotly.js](https://plotly.com/javascript/) 2.30 (gl3d bundle).
