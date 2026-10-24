"""Map layers for the site: Namma Metro lines and GBA corporations and wards.

  uv run python -m blr.layers runs/pilot

Everything is projected into canvas pixels with the map camera, at its own
height: SRTM ground (plus srtm_to_ellipsoid_m) at every vertex, and elevated
metro track a viaduct's height above that. Ward borders are merged into one
set of lines first, so a border two wards share is drawn once, not twice.
Writes site/public/layers.json.
"""

import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
from shapely.geometry import LineString, MultiLineString, Polygon, box
from shapely.ops import linemerge, unary_union

from blr.camera import ROOT, Camera
from blr.frames import TEACHER_CONFIG, run_bbox
from blr.osm import _element_polygon, _overpass, fetch_heights

OUT = ROOT / "site" / "public" / "layers.json"
VIADUCT_M = 12.0  # Namma Metro's elevated track runs roughly this far above the road
SIMPLIFY_DEG = 0.00003  # about 3 m

QUERY = """
[out:json][timeout:300];
(
  relation["route"="subway"]["network"~"Namma Metro"]({b});
  relation["boundary"="administrative"]["admin_level"~"^(8|10)$"]({b});
);
out geom;
"""


class Projector:
  """Projects lon/lat polylines at SRTM ground height, fetching heights in bulk."""

  def __init__(self, cam, offset, cache):
    self.cam, self.offset, self.cache = cam, offset, cache
    self.heights = {}

  @staticmethod
  def key(lon, lat):
    return (round(lat, 4), round(lon, 4))  # ~11 m, finer than SRTM's 30 m

  def want(self, coords):
    for lon, lat in coords:
      self.heights.setdefault(self.key(lon, lat), None)

  def fetch(self):
    keys = [k for k, v in self.heights.items() if v is None]
    for k, h in zip(keys, fetch_heights(keys, self.cache)):
      self.heights[k] = (h if h is not None else 900.0) + self.offset

  def project(self, coords, lift=0.0):
    c = np.asarray(coords, float)
    h = np.array([self.heights[self.key(lon, lat)] for lon, lat in coords]) + lift
    xy = self.cam.project(c[:, 1], c[:, 0], h)
    return [[round(float(x)), round(float(y))] for x, y in xy]


def lines_of(geom):
  if geom.is_empty:
    return []
  if isinstance(geom, LineString):
    return [geom]
  if isinstance(geom, MultiLineString):
    return list(geom.geoms)
  return [g for part in getattr(geom, "geoms", []) for g in lines_of(part)]


def main():
  ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  ap.add_argument("run_dir")
  ap.add_argument("--out", default=OUT)
  ap.add_argument("--margin-px", type=int, default=2048, help="keep lines this far past the map, under the clouds")
  args = ap.parse_args()

  run_dir = Path(args.run_dir)
  plan = json.loads((run_dir / "shots.json").read_text())
  cam = Camera.from_config(plan["camera"])
  offset = json.loads(TEACHER_CONFIG.read_text())["water"]["srtm_to_ellipsoid_m"]
  s = cam.shot_px
  shots = plan["shots"]
  m = args.margin_px
  image = box(
    min(i for i, _ in shots) * s, min(j for _, j in shots) * s,
    (max(i for i, _ in shots) + 1) * s, (max(j for _, j in shots) + 1) * s,
  )
  frame = image.buffer(m, join_style=2)

  cache = run_dir / "osm" / "layers.json"
  cache.parent.mkdir(parents=True, exist_ok=True)
  if cache.exists():
    elements = json.loads(cache.read_text())
  else:
    bbox = run_bbox(cam, shots, plan["ground_h"])
    pad = 0.02
    bbox = (bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad)
    elements = _overpass(QUERY.replace("{b}", ",".join(f"{v:.6f}" for v in bbox)))
    cache.write_text(json.dumps(elements))

  proj = Projector(cam, offset, run_dir / "osm" / "heights.json")

  # metro: one set of track per line, whichever direction's relation listed it
  metro_ways = defaultdict(dict)
  colours = {}
  for el in elements:
    t = el.get("tags", {})
    if t.get("route") != "subway":
      continue
    line = t.get("ref") or t.get("colour") or t.get("name")
    colours[line] = t.get("colour", "#888888")
    for mem in el.get("members", []):
      if mem.get("type") == "way" and mem.get("role", "") == "" and "geometry" in mem:
        metro_ways[line][mem["ref"]] = mem
  # way tags are not in relation members, so ask once for tunnel/bridge
  way_ids = [wid for ways in metro_ways.values() for wid in ways]
  way_tags = {}
  if way_ids:
    tag_cache = run_dir / "osm" / "metro_way_tags.json"
    if tag_cache.exists():
      way_tags = {int(k): v for k, v in json.loads(tag_cache.read_text()).items()}
    else:
      for i in range(0, len(way_ids), 500):
        ids = ",".join(map(str, way_ids[i : i + 500]))
        for w in _overpass(f"[out:json][timeout:120];way(id:{ids});out tags;"):
          way_tags[w["id"]] = w.get("tags", {})
      tag_cache.write_text(json.dumps(way_tags))

  metro_raw = []
  for line, ways in metro_ways.items():
    for wid, mem in ways.items():
      tags = way_tags.get(wid, {})
      tunnel = tags.get("tunnel") in ("yes", "building_passage") or tags.get("layer", "0").lstrip("-").isdigit() and int(tags.get("layer", "0")) < 0
      bridge = tags.get("bridge") in ("yes", "viaduct") or (not tunnel and tags.get("layer", "0").isdigit() and int(tags.get("layer", "0")) > 0)
      ls = LineString([(p["lon"], p["lat"]) for p in mem["geometry"]]).simplify(SIMPLIFY_DEG)
      proj.want(ls.coords)
      metro_raw.append((line, ls, tunnel, VIADUCT_M if bridge else 0.0))

  # GBA: corporations (8) and wards (10), borders merged per level
  admin = {"8": [], "10": []}
  for el in elements:
    t = el.get("tags", {})
    lvl = t.get("admin_level")
    if t.get("boundary") != "administrative" or lvl not in admin:
      continue
    poly = _element_polygon(el)
    if poly is not None and not poly.is_empty:
      admin[lvl].append((t.get("name:en") or t.get("name") or "", poly))
  borders = {}
  for lvl, items in admin.items():
    merged = linemerge(lines_of(unary_union([p.boundary for _, p in items]))) if items else None
    borders[lvl] = [ls.simplify(SIMPLIFY_DEG) for ls in lines_of(merged)] if merged else []
    for ls in borders[lvl]:
      proj.want(ls.coords)
    for _, p in items:
      for ring in getattr(p, "geoms", [p]):
        proj.want(ring.exterior.simplify(SIMPLIFY_DEG).coords)

  proj.fetch()

  def clip(pts):
    """Pixel polylines cut to the frame."""
    return [[[round(x), round(y)] for x, y in ls.coords] for ls in lines_of(LineString(pts).intersection(frame)) if len(ls.coords) > 1]

  out = {"metro": [], "corporations": {"lines": [], "labels": []}, "wards": {"lines": [], "labels": []}}
  by_line = defaultdict(list)
  for line, ls, tunnel, lift in metro_raw:
    for seg in clip(proj.project(list(ls.coords), lift)):
      by_line[line].append({"pts": seg, "tunnel": bool(tunnel)})
  for line, segs in sorted(by_line.items()):
    out["metro"].append({"name": line, "colour": colours[line], "segments": segs})

  for lvl, key in (("8", "corporations"), ("10", "wards")):
    for ls in borders[lvl]:
      out[key]["lines"] += clip(proj.project(list(ls.coords)))
    for name, p in admin[lvl]:
      # label the part of the area that is on the map, not its far-off centre
      rings = [Polygon(proj.project(list(r.exterior.simplify(SIMPLIFY_DEG).coords))) for r in getattr(p, "geoms", [p])]
      shown = unary_union([r.buffer(0) for r in rings]).intersection(image)
      if name and not shown.is_empty and shown.area > 0:
        pt = shown.representative_point()
        out[key]["labels"].append({"n": name.replace(" City Corporation", ""), "x": round(pt.x), "y": round(pt.y)})

  Path(args.out).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
  print(
    f"metro {[(l['name'], len(l['segments'])) for l in out['metro']]}, "
    f"corporations {len(out['corporations']['labels'])}, wards {len(out['wards']['labels'])} "
    f"-> {args.out}"
  )


if __name__ == "__main__":
  main()
