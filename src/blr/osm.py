"""OpenStreetMap water, projected into the map.

Water polygons come from Overpass for a run's lat/lon box and are cached in
the run directory. Each lake is projected at its own surface height: SRTM
elevation at the lake (from OpenTopoData) plus srtm_to_ellipsoid_m, which
turns it into the ellipsoidal height of Google's mesh. That offset is the
geoid plus any SRTM/mesh bias; -65 m was measured on the pilot by sliding
every OSM pool and lake outline up and down over the render (pools land on
blue within a few px there). At 45 degrees a surface moves about 2.4 px per
metre, so a single city-wide height would put lakes 100+ px off.

Two masks per frame:
- required: permanent water, shrunk a little, where the drawing must be water
- allowed: all water and swimming pools, grown a little, where water may be
"""

import json
import time
from pathlib import Path

import httpx
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from shapely.geometry import LineString, MultiPolygon, Polygon, box
from shapely.ops import polygonize, unary_union

from blr.camera import Camera

# the public servers are often busy, so try each a couple of times
OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
OPENTOPODATA = "https://api.opentopodata.org/v1/srtm30m"
USER_AGENT = "blr-map/0.1 (isometric pixel-art map of Bengaluru)"

WATER_QUERY = """
[out:json][timeout:120];
(
  nwr["natural"="water"]({b});
  nwr["landuse"="reservoir"]({b});
  nwr["landuse"="basin"]({b});
  nwr["waterway"="riverbank"]({b});
  nwr["leisure"="swimming_pool"]({b});
);
out geom;
"""


def _ring(geom):
  return [(p["lon"], p["lat"]) for p in geom]


def _element_polygon(el):
  """Shapely (lon/lat) polygon for a closed way or a multipolygon relation."""
  if el["type"] == "way":
    pts = _ring(el.get("geometry", []))
    if len(pts) >= 4 and pts[0] == pts[-1]:
      poly = Polygon(pts)
      return poly if poly.is_valid else poly.buffer(0)
    return None
  if el["type"] == "relation":
    outer, inner = [], []
    for m in el.get("members", []):
      if m.get("type") != "way" or "geometry" not in m:
        continue
      (inner if m.get("role") == "inner" else outer).append(LineString(_ring(m["geometry"])))
    polys = list(polygonize(outer))
    if not polys:
      return None
    shape = unary_union(polys)
    holes = list(polygonize(inner))
    if holes:
      shape = shape.difference(unary_union(holes))
    return shape
  return None


def _kind(tags):
  if tags.get("leisure") == "swimming_pool":
    return "pool"
  if tags.get("intermittent") == "yes" or tags.get("seasonal") not in (None, "no"):
    return "intermittent"
  return "water"


def _overpass(query):
  errors = []
  for attempt in range(2):
    for url in OVERPASS:
      try:
        r = httpx.post(url, data={"data": query}, headers={"User-Agent": USER_AGENT}, timeout=360)
        r.raise_for_status()
        return r.json()["elements"]
      except (httpx.HTTPError, ValueError, KeyError) as e:
        errors.append(f"{url}: {e}")
    time.sleep(10)
  raise RuntimeError("every Overpass server failed:\n" + "\n".join(errors))


def fetch_water(bbox, cache: Path):
  """[{id, name, kind, lonlat: [[lon, lat], ...] polygons}] for a (south, west, north, east) box."""
  if cache.exists():
    return json.loads(cache.read_text())
  q = WATER_QUERY.replace("{b}", ",".join(f"{v:.6f}" for v in bbox))
  elements = _overpass(q)
  out = []
  for el in elements:
    shape = _element_polygon(el)
    if shape is None or shape.is_empty:
      continue
    polys = list(shape.geoms) if isinstance(shape, MultiPolygon) else [shape]
    tags = el.get("tags", {})
    out.append({
      "id": f"{el['type'][0]}{el['id']}",
      "name": tags.get("name"),
      "kind": _kind(tags),
      "polygons": [
        {"exterior": list(p.exterior.coords), "holes": [list(h.coords) for h in p.interiors]}
        for p in polys if isinstance(p, Polygon)
      ],
    })
  cache.parent.mkdir(parents=True, exist_ok=True)
  cache.write_text(json.dumps(out))
  return out


def fetch_heights(points, cache: Path):
  """SRTM elevation (metres above the geoid) for [(lat, lon)], 100 per request, cached by key."""
  known = json.loads(cache.read_text()) if cache.exists() else {}
  keys = [f"{lat:.5f},{lon:.5f}" for lat, lon in points]
  missing = sorted({k for k in keys if k not in known})
  for i in range(0, len(missing), 100):
    batch = missing[i : i + 100]
    r = httpx.get(
      OPENTOPODATA,
      params={"locations": "|".join(batch)},
      headers={"User-Agent": USER_AGENT},
      timeout=60,
    )
    r.raise_for_status()
    for k, res in zip(batch, r.json()["results"]):
      known[k] = res["elevation"]
    cache.write_text(json.dumps(known))
    if i + 100 < len(missing):
      time.sleep(1.1)  # the public API allows one request a second
  return [known[k] for k in keys]


def project_water(cam: Camera, water, heights_cache: Path, srtm_to_ellipsoid_m):
  """Water features with polygons in canvas pixels, each at its own surface height."""
  centres = []
  for w in water:
    allpts = [pt for p in w["polygons"] for pt in p["exterior"]]
    lon = float(np.mean([pt[0] for pt in allpts]))
    lat = float(np.mean([pt[1] for pt in allpts]))
    centres.append((lat, lon))
  heights = fetch_heights(centres, heights_cache) if centres else []
  out = []
  for w, h_msl in zip(water, heights):
    h = (h_msl if h_msl is not None else 900.0) + srtm_to_ellipsoid_m

    def proj(coords):
      c = np.asarray(coords, float)
      return cam.project(c[:, 1], c[:, 0], h)

    polys = []
    for p in w["polygons"]:
      poly = Polygon(proj(p["exterior"]), [proj(hole) for hole in p["holes"]])
      polys.append(poly if poly.is_valid else poly.buffer(0))
    out.append({**w, "height_m": h, "pixels": unary_union(polys)})
  return out


def _rasterize(shapes, x0, y0, size):
  img = Image.new("L", (size, size), 0)
  d = ImageDraw.Draw(img)
  frame = box(x0, y0, x0 + size, y0 + size)
  for s in shapes:
    s = s.intersection(frame)
    for p in getattr(s, "geoms", [s]):
      if not isinstance(p, Polygon) or p.is_empty:
        continue
      d.polygon([(x - x0, y - y0) for x, y in p.exterior.coords], fill=255)
      for hole in p.interiors:
        d.polygon([(x - x0, y - y0) for x, y in hole.coords], fill=0)
  return np.asarray(img) > 0


def frame_masks(projected, x0, y0, size, dilate_px, erode_px):
  """(water, required, allowed) boolean masks for the frame whose top-left canvas pixel is (x0, y0).

  water is permanent water as mapped; required is it shrunk, allowed is all water grown.
  """
  water = _rasterize([w["pixels"] for w in projected if w["kind"] == "water"], x0, y0, size)
  allowed = _rasterize([w["pixels"] for w in projected], x0, y0, size)
  required = ndimage.binary_erosion(water, iterations=erode_px) if erode_px else water
  if dilate_px:
    allowed = ndimage.binary_dilation(allowed, iterations=dilate_px)
  return water, required, allowed


REGIONS = [
  ["top-left", "top", "top-right"],
  ["left", "centre", "right"],
  ["bottom-left", "bottom", "bottom-right"],
]


def water_sentence(mask):
  """The one line of ground truth the teacher gets about water."""
  share = float(mask.mean())
  if share < 0.002:
    return (
      "WATER IN THIS VIEW: none. Nothing in this view is water, "
      "so nothing in it uses the water colour."
    )
  n = mask.shape[0] // 3
  cells = {
    REGIONS[r][c]: mask[r * n : (r + 1) * n, c * n : (c + 1) * n].mean()
    for r in range(3)
    for c in range(3)
  }
  # name every ninth that is a tenth water, or failing that the wettest one
  where = [k for k, v in cells.items() if v > 0.1] or [max(cells, key=cells.get)]
  pct = max(1, round(share * 100))
  return (
    f"WATER IN THIS VIEW: about {pct}% of the view is open water, in the {', '.join(where)}. "
    "Only that water uses the water colour. Lakes here can look green, brown or weedy in the render; "
    "draw them as water all the same. Nothing else in the view is water."
  )
