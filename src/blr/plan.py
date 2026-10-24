"""Choose which shots to render.

Either a square around a point (for pilots):

  uv run python -m blr.plan --center 12.9796,77.5907 --size-px 4096 --out runs/pilot

or every shot touching a boundary polygon, grown by a margin (for the city):

  uv run python -m blr.plan --boundary data/boundary.geojson --margin-px 3072 --out runs/city

The boundary is projected at a single ground height. Bengaluru's ground moves
about 2.4 px per metre of height at 45 degrees, so the margin also has to
absorb the city's relief (roughly +-60 m around the anchor height).
"""

import argparse
import json
from pathlib import Path

from shapely.geometry import box, shape
from shapely.ops import transform, unary_union

from blr.camera import DEFAULT_CONFIG, Camera


def shots_for_box(cam: Camera, x0, y0, x1, y1):
  i0, j0 = cam.shot_of(x0, y0)
  i1, j1 = cam.shot_of(x1 - 1, y1 - 1)
  return [(i, j) for j in range(j0, j1 + 1) for i in range(i0, i1 + 1)]


def shots_for_polygon(cam: Camera, geom, ground_h, margin_px):
  def proj(lon, lat, z=None):
    xy = cam.project(lat, lon, ground_h)
    return xy[..., 0], xy[..., 1]

  area = transform(proj, geom).buffer(margin_px)
  x0, y0, x1, y1 = area.bounds
  return [
    (i, j)
    for i, j in shots_for_box(cam, x0, y0, x1, y1)
    if area.intersects(box(*cam.shot_bounds(i, j)))
  ]


def main():
  ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  ap.add_argument("--config", default=DEFAULT_CONFIG)
  ap.add_argument("--out", required=True, help="run directory; shots.json is written here")
  g = ap.add_mutually_exclusive_group(required=True)
  g.add_argument("--center", help="lat,lon")
  g.add_argument("--boundary", help="GeoJSON file (Feature, FeatureCollection or geometry)")
  ap.add_argument("--size-px", type=int, default=4096, help="side of the square for --center")
  ap.add_argument("--margin-px", type=int, default=3072, help="growth around --boundary")
  ap.add_argument("--ground-h", type=float, help="ellipsoidal ground height; defaults to the anchor's")
  args = ap.parse_args()

  cam = Camera.load(args.config)
  ground_h = args.ground_h if args.ground_h is not None else cam.config["anchor"]["height_m"]

  if args.center:
    lat, lon = map(float, args.center.split(","))
    cx, cy = cam.project(lat, lon, ground_h)
    half = args.size_px / 2
    shots = shots_for_box(cam, cx - half, cy - half, cx + half, cy + half)
    source = {"center": [lat, lon], "size_px": args.size_px}
  else:
    gj = json.loads(Path(args.boundary).read_text())
    feats = gj.get("features") or [gj]
    geom = unary_union([shape(f.get("geometry", f)) for f in feats])
    shots = shots_for_polygon(cam, geom, ground_h, args.margin_px)
    source = {"boundary": str(args.boundary), "margin_px": args.margin_px}

  out = Path(args.out)
  out.mkdir(parents=True, exist_ok=True)
  plan = {"camera": cam.config, "ground_h": ground_h, "source": source, "shots": shots}
  (out / "shots.json").write_text(json.dumps(plan, indent=2))
  ii = [s[0] for s in shots]
  jj = [s[1] for s in shots]
  print(
    f"{len(shots)} shots, i {min(ii)}..{max(ii)}, j {min(jj)}..{max(jj)} "
    f"-> {out / 'shots.json'}"
  )


if __name__ == "__main__":
  main()
