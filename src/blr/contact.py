"""Contact sheet of a teacher run: render, OSM water, and the latest drawing per frame.

  uv run python -m blr.contact runs/pilot            # every frame tried
  uv run python -m blr.contact runs/pilot --rejected # only frames with a rejected attempt

Writes runs/<name>/teacher/contact.png, three columns per row at half size.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage


def water_overlay(frame, mask):
  a = np.asarray(frame).copy()
  edge = mask ^ ndimage.binary_erosion(mask, iterations=3)
  a[edge] = [255, 0, 255]
  return Image.fromarray(a)


def main():
  ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  ap.add_argument("run_dir")
  ap.add_argument("--rejected", action="store_true")
  ap.add_argument("--size", type=int, default=512)
  args = ap.parse_args()

  run_dir = Path(args.run_dir)
  tdir = run_dir / "teacher"
  latest = {}
  for line in (tdir / "attempts.jsonl").read_text().splitlines():
    e = json.loads(line)
    if args.rejected and e["accepted"]:
      continue
    latest[e["name"]] = e
  if not latest:
    raise SystemExit("no attempts to show")

  s = args.size
  font = ImageFont.load_default(size=16)
  sheet = Image.new("RGB", (3 * s, len(latest) * (s + 28)), "white")
  for row, (name, e) in enumerate(sorted(latest.items())):
    y = row * (s + 28)
    frame = Image.open(run_dir / "frames" / f"{name}.png").convert("RGB")
    mask = np.asarray(Image.open(run_dir / "masks" / f"{name}_water.png")) > 0
    tiles = [frame, water_overlay(frame, mask)]
    att = tdir / "attempts" / f"{name}_{e['attempt']}.png"
    tiles.append(Image.open(att).convert("RGB") if att.exists() else Image.new("RGB", frame.size, "grey"))
    for col, im in enumerate(tiles):
      sheet.paste(im.resize((s, s), Image.LANCZOS), (col * s, y + 28))
    verdict = "ACCEPTED" if e["accepted"] else "REJECTED " + ", ".join(e["reasons"])
    sc = e.get("scores", {})
    text = f"{name} #{e['attempt']}  {verdict}  " + "  ".join(f"{k}={v}" for k, v in sc.items())
    ImageDraw.Draw(sheet).text((6, y + 5), text, fill="black", font=font)
  out = tdir / "contact.png"
  sheet.save(out)
  print(f"{len(latest)} frames -> {out}")


if __name__ == "__main__":
  main()
