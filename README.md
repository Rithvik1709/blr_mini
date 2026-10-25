# blr

An isometric pixel-art map of Bengaluru, made the way [tiny.london](https://tiny.london/how/) was made. This repo has stage 1 so far: one camera that renders the whole city from Google's Photorealistic 3D Tiles in shots that line up to the pixel.

## Setup

```bash
cp .env.example .env          # set GOOGLE_TILES_API_KEY (Map Tiles API + billing)
                              # or CESIUM_ION_TOKEN (same Google tiles via Cesium ion, free account)
uv sync
uv run playwright install chromium
cd render && bun install && cd ..
```

## Render a pilot

```bash
# 9 shots around Vidhana Soudha and Cubbon Park
uv run python -m blr.plan --center 12.9796,77.5907 --size-px 4096 --out runs/pilot
uv run python -m blr.render runs/pilot --workers 2
uv run python -m blr.mosaic runs/pilot --scale 0.25    # runs/pilot/mosaic.png
```

To look around by hand, run `cd render && bun run dev` and open `http://127.0.0.1:5173/?shot=-1,-2`. The arrow keys move one shot, and shift+arrow moves ten.

For the whole city, pass a boundary GeoJSON (BBMP/GBA, e.g. from OpenCity or DataMeet) to `blr.plan --boundary`, with `--margin-px` to grow the edge band.

## Site

```bash
uv run python -m blr.pyramid runs/pilot --version v1   # tiles -> site/public/tiles/v1
uv run python -m blr.search_index runs/pilot           # site/public/search.json
cd site && bun install && bun run dev                  # http://127.0.0.1:5180
bun run build && bun run preview                       # production build
```

- `blr.pyramid` builds a Deep Zoom pyramid of 512 px WebP tiles from the shots (use `--source` and `--lossless` for pixel art later). It refuses to write into an existing version, so tiles can be cached forever. `site/public/_headers` sets `immutable` for Cloudflare.
- The map manifest and a small boot script are inlined into `index.html` (`vite.config.js`). The boot script works out the first view and requests exactly the tiles the viewer will draw before the app bundle loads. The viewer loads only that level first, and coarser levels after.
- The view lives in the URL as `#lat,lon,scale` (scale is screen px per map px), so any address can be shared. Share copies it.
- Search covers OSM areas, metro and rail stations, landmarks, parks and lakes, in English and Kannada. Each place is positioned at its own ground height, and `/` focuses the search box.
- **Layers** (`uv run python -m blr.layers runs/pilot` → `site/public/layers.json`): Namma Metro lines in their official colours, with tunnels dashed and elevated track lifted 12 m. GBA city corporations and wards, with shared borders merged so each draws once, and labels placed on the visible part of each area. Every vertex is projected at its own SRTM ground height.
- **Clouds** (`uv run python -m blr.clouds runs/pilot` → `site/public/clouds/`): a harmonic field, solved from Laplace's equation, that is 0 over the city and 1 far outside it, so no cloud can appear over the city and the cloud edge never traces the boundary's zigzags. The shader in `src/clouds.js` adds drifting puffs and draws chunky pixels anchored to the map, with an outline and lit and shaded rims. It runs at 15 fps and only while clouds are on screen, and stays still if the user prefers reduced motion. For the full city, pass `--region <GBA boundary.geojson>`.
- **Sky**: the time in IST and Bangalore weather from Open-Meteo (free, no key), with a tint for dawn, evening, dusk and night, haze for fog and overcast, and pixel rain.
- **Minimap**: the pyramid's own smallest single-tile level. Click or drag to move the map.
- **Keys:** M minimap, L metro, W wards, T weather and time. The ⚙ panel has the same toggles, and they're remembered per browser.
- `src/projection.js` is `camera.py` ported to JavaScript, and `tests/test_site.py` keeps the two identical.
- Pixel art is drawn unsmoothed at 1:1 and closer, and smoothed when shown smaller.

### Deploying

`vercel.json` deploys `site/` only. Tile images are not in git (the version pointer, manifests and `search.json` are), so host `site/public/tiles/<version>/tiles_files/` somewhere built for many static files, such as a Backblaze B2 bucket with CORS allowed for the site's domain (see `docs/HANDOFF.md`), and set `TILE_BASE` in the build environment to its URL (the folder holding `<version>/tiles_files/`). Without `TILE_BASE`, tiles load from the site's own `/tiles`. If the build also has `B2_KEY_ID` and `B2_APPLICATION_KEY`, the bucket is treated as private and `site/api/tile-token.js` supplies a download token for the tile URLs.

## Teacher: pixel-art targets

```bash
uv run python -m blr.frames runs/pilot                 # 1,024 px frames + OSM water masks
uv run python -m blr.teacher runs/pilot --dry-run      # write prompts, show the cost cap
uv run python -m blr.teacher runs/pilot --limit 6      # draw six frames
uv run python -m blr.contact runs/pilot                # runs/pilot/teacher/contact.png
```

- `blr.frames` cuts each shot into four 1,024 px frames. It fetches OSM water (Overpass) and places each lake at its own SRTM height plus `srtm_to_ellipsoid_m` (−65 m, measured on the pilot from pools and lakes). Each frame gets a "WATER IN THIS VIEW" sentence and three masks.
- `blr.teacher` sends each frame with `prompts/teacher.txt`, which says how to draw, never what to draw. Each attempt is checked against ground truth:
  - **photo copy:** too few pixels with a flat 3×3 neighbourhood
  - **moved / structure:** the drawing's edges compared with the render's edges
  - **invented / missing water:** compared with the OSM masks
- A frame gets up to 3 tries. Every attempt and its scores go to `teacher/attempts.jsonl`, and accepted drawings go to `teacher/targets/`. Rerunning resumes where it stopped.
- Set the provider in `config/teacher.json` (`gemini` or `openrouter`) or with `--provider`. Gemini 3 Pro Image costs about $0.135 per call.
- The thresholds in `config/teacher.json` are first guesses. Tune them on contact sheets.

## How the camera works

- `config/camera.json` defines the only camera. It is anchored at 12.9716 N, 77.5946 E, tilted 45°, turned 15°, at 0.293 m per pixel, the same as tiny.london and isometric.nyc.
- The camera never moves. Shot (i, j) offsets the orthographic frustum by whole 2,048 px steps (`render/main.js`), so neighbouring shots share edges exactly.
- `src/blr/camera.py` builds the same camera matrix in Python (WGS84 → ECEF → camera frame) and defines the map projection: `project(lat, lon, h)` gives canvas pixels and `unproject` goes back. Search, OSM water masks and the planner all go through it.
- `tests/test_camera.py` checks `camera.py` against 3d-tiles-renderer's own maths. `blr.render` also checks it against the live browser before it renders anything.
- Heights are ellipsoidal. Bengaluru's ground is about 835 m above the WGS84 ellipsoid (about 920 m above sea level, with a geoid undulation of about −86 m), and at 45° each metre of height moves a point about 2.4 px.
- Renders are resumable: finished shots are skipped, and each PNG is written to a temp file and renamed into place. Per-shot timings and failed-tile counts go to `runs/<name>/render_log.jsonl`.

## Credits

The renderer setup follows Andy Coenen's [isometric-nyc](https://github.com/cannoneyed/isometric-nyc) (MIT), and the method follows Boris Starkov's [tiny.london](https://tiny.london/how/). Imagery is derived from Google Photorealistic 3D Tiles, so keep Google's attribution (saved per run in `attributions.json`).
