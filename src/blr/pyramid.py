"""Build a Deep Zoom tile pyramid from a run's shots, for the site.

  uv run python -m blr.pyramid runs/pilot --version v1

Writes site/public/tiles/<version>/tiles.dzi, tiles_files/<level>/<col>_<row>.webp
and manifest.json, then points site/public/tiles/current.json at the version.
A version folder is never written into again once published: rebuild under a
new version name instead, so cached tiles can be served as immutable.

The image is the bounding box of the planned shots. Its pixel (0, 0) is canvas
pixel `origin`, so canvas coordinates (camera.py) and image coordinates differ
only by that offset. Full-resolution tiles are cut straight from the shots and
each coarser level is built from the four tiles under it, so memory stays at a
few tiles whatever the size of the map.
"""

import argparse
import json
import math
import os
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image

from blr.camera import ROOT

SITE_TILES = ROOT / "site" / "public" / "tiles"
BACKGROUND = (12, 18, 28)


def save_webp(img, path, quality, lossless):
  path.parent.mkdir(parents=True, exist_ok=True)
  tmp = path.with_suffix(".tmp")
  img.save(tmp, "WEBP", quality=quality, lossless=lossless, method=4)
  os.replace(tmp, path)


def cut_shot(job):
  src, col0, row0, per, t, level_dir, q = job
  shot = Image.open(src).convert("RGB") if src.exists() else None
  blank = Image.new("RGB", (t, t), BACKGROUND)
  for dy in range(per):
    for dx in range(per):
      tile = shot.crop((dx * t, dy * t, (dx + 1) * t, (dy + 1) * t)) if shot else blank
      save_webp(tile, level_dir / f"{col0 + dx}_{row0 + dy}.webp", **q)


def reduce_column(job):
  files, level, col, rows, w, h, t, q = job
  for row in range(rows):
    canvas = Image.new("RGB", (2 * t, 2 * t), BACKGROUND)
    for dx in (0, 1):
      for dy in (0, 1):
        child = files / str(level + 1) / f"{2 * col + dx}_{2 * row + dy}.webp"
        if child.exists():
          canvas.paste(Image.open(child).convert("RGB"), (dx * t, dy * t))
    tw, th = min(t, w - col * t), min(t, h - row * t)
    save_webp(canvas.reduce(2).crop((0, 0, tw, th)), files / str(level) / f"{col}_{row}.webp", **q)


def main():
  ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  ap.add_argument("run_dir")
  ap.add_argument("--version", required=True, help="folder name, e.g. v1; must not exist yet")
  ap.add_argument("--source", default="shots", help="subfolder of run_dir holding <i>_<j>.png shots")
  ap.add_argument("--tile", type=int, default=512)
  ap.add_argument("--quality", type=int, default=82)
  ap.add_argument("--lossless", action="store_true", help="for pixel art")
  ap.add_argument("--out", default=SITE_TILES)
  ap.add_argument("--jobs", type=int, default=os.cpu_count())
  args = ap.parse_args()

  run_dir = Path(args.run_dir)
  plan = json.loads((run_dir / "shots.json").read_text())
  cam = plan["camera"]
  s, t = cam["shot_px"], args.tile
  assert s % t == 0, "tile size must divide shot size"
  shots = [tuple(x) for x in plan["shots"]]
  i0, j0 = min(i for i, _ in shots), min(j for _, j in shots)
  i1, j1 = max(i for i, _ in shots), max(j for _, j in shots)
  width, height = (i1 - i0 + 1) * s, (j1 - j0 + 1) * s
  max_level = math.ceil(math.log2(max(width, height)))

  out = Path(args.out) / args.version
  if out.exists():
    raise SystemExit(f"{out} exists; published versions are immutable, pick a new --version")
  files = out / "tiles_files"
  q = dict(quality=args.quality, lossless=args.lossless)

  # full resolution: cut every shot into tiles, a shot per task
  per = s // t
  jobs = [(run_dir / args.source / f"{i}_{j}.png", (i - i0) * per, (j - j0) * per, per, t,
           files / str(max_level), q) for i in range(i0, i1 + 1) for j in range(j0, j1 + 1)]
  with ProcessPoolExecutor(args.jobs) as pool:
    list(pool.map(cut_shot, jobs, chunksize=4))
  print(f"level {max_level}: {width // t} x {height // t} tiles")

  # every coarser level from the four tiles under each tile, a column per task
  w, h = width, height
  for level in range(max_level - 1, -1, -1):
    w, h = math.ceil(w / 2), math.ceil(h / 2)
    cols, rows = math.ceil(w / t), math.ceil(h / t)
    jobs = [(files, level, col, rows, w, h, t, q) for col in range(cols)]
    with ProcessPoolExecutor(args.jobs) as pool:
      list(pool.map(reduce_column, jobs))
  print(f"levels {max_level}..0 written")

  (out / "tiles.dzi").write_text(
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    f'<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" Format="webp" Overlap="0" TileSize="{t}">'
    f'<Size Width="{width}" Height="{height}"/></Image>\n'
  )
  manifest = {
    "version": args.version,
    "width": width,
    "height": height,
    "tileSize": t,
    "maxLevel": max_level,
    "format": "webp",
    "origin": [i0 * s, j0 * s],
    "camera": cam,
    "groundHeight": plan["ground_h"],
    "background": "#%02x%02x%02x" % BACKGROUND,
  }
  (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
  (Path(args.out) / "current.json").write_text(json.dumps({"version": args.version}) + "\n")
  n = sum(1 for _ in files.rglob("*.webp"))
  mb = sum(f.stat().st_size for f in files.rglob("*.webp")) / 1e6
  print(f"{n} tiles, {mb:.1f} MB -> {out}")


if __name__ == "__main__":
  main()
