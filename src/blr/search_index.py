"""Build the site's search index from OpenStreetMap.

  uv run python -m blr.search_index runs/pilot

Areas, metro and rail stations, notable places (anything with a Wikidata tag),
parks and lakes inside the map, each with its English and Kannada names and its
position in canvas pixels at its own ground height (SRTM + srtm_to_ellipsoid_m),
so a search pin lands where the thing is drawn. Writes site/public/search.json.
"""

import argparse
import json
from pathlib import Path

from blr.camera import ROOT, Camera
from blr.frames import TEACHER_CONFIG, run_bbox
from blr.osm import _overpass, fetch_heights

OUT = ROOT / "site" / "public" / "search.json"

QUERY = """
[out:json][timeout:300];
(
  node["place"~"^(suburb|neighbourhood|quarter|locality)$"]({b});
  nwr["railway"="station"]({b});
  nwr["public_transport"="station"]({b});
  nwr["name"]["wikidata"]({b});
  nwr["leisure"~"^(park|stadium|golf_course)$"]["name"]({b});
  nwr["natural"="water"]["name"]({b});
);
out center tags;
"""


def kind_of(tags):
  if tags.get("station") == "subway" or "metro" in tags.get("network", "").lower():
    return "metro"
  if tags.get("railway") == "station" or tags.get("public_transport") == "station":
    return "station"
  if "place" in tags:
    return "area"
  if tags.get("natural") == "water":
    return "lake"
  if tags.get("leisure") in ("park", "golf_course"):
    return "park"
  return "landmark"


def main():
  ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  ap.add_argument("run_dir")
  ap.add_argument("--out", default=OUT)
  args = ap.parse_args()

  run_dir = Path(args.run_dir)
  plan = json.loads((run_dir / "shots.json").read_text())
  cam = Camera.from_config(plan["camera"])
  offset = json.loads(TEACHER_CONFIG.read_text())["water"]["srtm_to_ellipsoid_m"]
  bbox = run_bbox(cam, plan["shots"], plan["ground_h"])
  s = cam.shot_px
  x0 = min(i for i, _ in plan["shots"]) * s
  y0 = min(j for _, j in plan["shots"]) * s
  x1 = (max(i for i, _ in plan["shots"]) + 1) * s
  y1 = (max(j for _, j in plan["shots"]) + 1) * s

  cache = run_dir / "osm" / "search.json"
  cache.parent.mkdir(parents=True, exist_ok=True)
  if cache.exists():
    elements = json.loads(cache.read_text())
  else:
    elements = _overpass(QUERY.replace("{b}", ",".join(f"{v:.6f}" for v in bbox)))
    cache.write_text(json.dumps(elements))

  items = {}
  for el in elements:
    tags = el.get("tags", {})
    name = tags.get("name:en") or tags.get("name")
    pos = el.get("center") or ({"lat": el["lat"], "lon": el["lon"]} if "lat" in el else None)
    if not name or not pos:
      continue
    kind = kind_of(tags)
    key = (name.lower(), kind)
    if key in items:  # one entry per name and kind (e.g. a station's node and its area)
      continue
    alt = sorted({v for k, v in tags.items() if k in ("name", "name:kn", "alt_name", "old_name") and v != name})
    items[key] = {"n": name, "a": alt, "k": kind, "lat": pos["lat"], "lon": pos["lon"]}

  items = list(items.values())
  heights = fetch_heights([(it["lat"], it["lon"]) for it in items], run_dir / "osm" / "heights.json")
  out = []
  for it, h in zip(items, heights):
    x, y = cam.project(it["lat"], it["lon"], (h if h is not None else 900.0) + offset)
    if x0 <= x < x1 and y0 <= y < y1:
      out.append({"n": it["n"], "a": it["a"], "k": it["k"], "x": round(float(x)), "y": round(float(y))})
  order = {"area": 0, "metro": 1, "station": 2, "landmark": 3, "park": 4, "lake": 5}
  out.sort(key=lambda r: (order[r["k"]], r["n"]))
  Path(args.out).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
  counts = {k: sum(r["k"] == k for r in out) for k in order}
  print(f"{len(out)} places {counts} -> {args.out}")


if __name__ == "__main__":
  main()
