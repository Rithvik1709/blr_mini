"""Stitch a run's shots into one image, to check that they line up.

  uv run python -m blr.mosaic runs/pilot --scale 0.25

Missing shots are left black. Writes runs/<name>/mosaic.png.
"""

import argparse
import json
from pathlib import Path

from PIL import Image


def main():
  ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  ap.add_argument("run_dir")
  ap.add_argument("--scale", type=float, default=0.25)
  args = ap.parse_args()

  run_dir = Path(args.run_dir)
  plan = json.loads((run_dir / "shots.json").read_text())
  s = plan["camera"]["shot_px"]
  t = round(s * args.scale)
  shots = plan["shots"]
  i0 = min(i for i, _ in shots)
  j0 = min(j for _, j in shots)
  w = (max(i for i, _ in shots) - i0 + 1) * t
  h = (max(j for _, j in shots) - j0 + 1) * t

  out = Image.new("RGB", (w, h))
  found = 0
  for i, j in shots:
    f = run_dir / "shots" / f"{i}_{j}.png"
    if f.exists():
      img = Image.open(f).convert("RGB")
      if t != s:
        img = img.resize((t, t), Image.LANCZOS)
      out.paste(img, ((i - i0) * t, (j - j0) * t))
      found += 1
  out.save(run_dir / "mosaic.png")
  print(f"{found}/{len(shots)} shots, {w}x{h} -> {run_dir / 'mosaic.png'}")


if __name__ == "__main__":
  main()
