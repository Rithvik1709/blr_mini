"""The field that says where clouds may be: 0 over the city, 1 far outside it.

  uv run python -m blr.clouds runs/pilot                         # region: an island in the map
  uv run python -m blr.clouds runs/city --region data/gba.geojson

Like tiny.london, this is a harmonic field: Laplace's equation solved between
the city (held at 0) and the edge of a wider domain (held at 1). Its level sets
smooth out the city's bays the further they get from it, so a cloud front drawn
at a level never follows the boundary's zigzags, and inside the city the field
is exactly 0, so no cloud pixel can appear there. The site's cloud shader adds
noise and draws the clouds; this only decides where they are allowed.

Writes site/public/clouds/field.png (8-bit, one texel per `scale` map pixels)
and clouds.json describing where it sits on the canvas.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.sparse import coo_matrix
from scipy.sparse.linalg import spsolve
from shapely.geometry import shape
from shapely.ops import transform, unary_union

from blr.camera import ROOT, Camera

OUT = ROOT / "site" / "public" / "clouds"


def solve_laplace(fixed, values):
  """Harmonic interpolation of `values` at `fixed` cells over the rest of the grid."""
  h, w = fixed.shape
  free = ~fixed
  idx = -np.ones((h, w), int)
  idx[free] = np.arange(free.sum())
  rows, cols, data = [], [], []
  b = np.zeros(free.sum())
  ys, xs = np.nonzero(free)
  me = idx[ys, xs]
  rows.append(me)
  cols.append(me)
  data.append(np.full(me.size, 4.0))
  for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
    ny, nx = np.clip(ys + dy, 0, h - 1), np.clip(xs + dx, 0, w - 1)
    nb = idx[ny, nx]
    inner = nb >= 0
    rows.append(me[inner])
    cols.append(nb[inner])
    data.append(np.full(inner.sum(), -1.0))
    np.add.at(b, me[~inner], values[ny[~inner], nx[~inner]])
  a = coo_matrix((np.concatenate(data), (np.concatenate(rows), np.concatenate(cols))), shape=(me.size, me.size)).tocsr()
  out = values.astype(float).copy()
  out[free] = spsolve(a, b)
  return out


def main():
  ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  ap.add_argument("run_dir")
  ap.add_argument("--region", help="GeoJSON of the city; default is an ellipse in the map, inset by --inset-px")
  ap.add_argument("--inset-px", type=int, default=256)
  ap.add_argument("--margin-px", type=int, default=6144, help="how far past the map the clouds thicken to full")
  ap.add_argument("--scale", type=int, default=32, help="map pixels per field texel")
  ap.add_argument("--out", default=OUT)
  args = ap.parse_args()

  run_dir = Path(args.run_dir)
  plan = json.loads((run_dir / "shots.json").read_text())
  cam = Camera.from_config(plan["camera"])
  s, k = cam.shot_px, args.scale
  shots = plan["shots"]
  ix0, iy0 = min(i for i, _ in shots) * s, min(j for _, j in shots) * s
  ix1, iy1 = (max(i for i, _ in shots) + 1) * s, (max(j for _, j in shots) + 1) * s
  x0, y0 = ix0 - args.margin_px, iy0 - args.margin_px
  w = (ix1 - ix0 + 2 * args.margin_px) // k
  h = (iy1 - iy0 + 2 * args.margin_px) // k

  mask = Image.new("L", (w, h), 0)
  d = ImageDraw.Draw(mask)
  if args.region:
    gj = json.loads(Path(args.region).read_text())
    geom = unary_union([shape(f.get("geometry", f)) for f in gj.get("features") or [gj]])

    def proj(lon, lat, z=None):
      xy = cam.project(lat, lon, plan["ground_h"])
      return (xy[..., 0] - x0) / k, (xy[..., 1] - y0) / k

    region = transform(proj, geom)
    for p in getattr(region, "geoms", [region]):
      d.polygon(list(p.exterior.coords), fill=255)
  else:
    # no boundary yet (a pilot): an island inset in the map, so the square
    # corners of the render stay under cloud
    n = args.inset_px
    d.ellipse(((ix0 + n - x0) / k, (iy0 + n - y0) / k, (ix1 - n - x0) / k - 1, (iy1 - n - y0) / k - 1), fill=255)
  city = np.asarray(mask) > 0

  fixed = city.copy()
  fixed[0, :] = fixed[-1, :] = fixed[:, 0] = fixed[:, -1] = True
  values = np.where(city, 0.0, 1.0)
  field = solve_laplace(fixed, values)
  field[city] = 0.0
  # keep a hair of clear sky at the city's edge even after bilinear filtering
  field = np.where(ndimage.binary_dilation(city, iterations=1), 0.0, field)

  out = Path(args.out)
  out.mkdir(parents=True, exist_ok=True)
  Image.fromarray(np.round(field * 255).astype(np.uint8)).save(out / "field.png")
  meta = {
    "x": x0, "y": y0, "scale": k, "width": w, "height": h, "threshold": 0.08,
    "margin": args.margin_px,
    # the map image on the canvas; beyond it there is nothing to show, so always cloud
    "image": [ix0, iy0, ix1 - ix0, iy1 - iy0],
  }
  (out / "clouds.json").write_text(json.dumps(meta, indent=2))
  inside_max = float(field[city].max()) if city.any() else 0.0
  print(f"field {w}x{h} at 1/{k}, max inside city {inside_max:.3f}, 0.08 level {np.mean(field > 0.08):.0%} of domain -> {out}")


if __name__ == "__main__":
  main()
