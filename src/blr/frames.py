"""Cut a run's shots into teacher frames, with OpenStreetMap water for each.

  uv run python -m blr.frames runs/pilot

Frames are frame_px squares on the canvas lattice (four per 2,048 px shot),
so a frame lines up with the render, OSM and every other frame exactly.
Writes runs/<name>/frames/<fx>_<fy>.png, masks/<fx>_<fy>_{water,required,allowed}.png
and frames.json, which holds each frame's water sentence for the prompt.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

from blr.camera import ROOT, Camera
from blr.osm import fetch_water, frame_masks, project_water, water_sentence

TEACHER_CONFIG = ROOT / "config" / "teacher.json"


def run_bbox(cam: Camera, shots, ground_h):
  """(south, west, north, east) covering every shot, padded for relief and lakes at the edge."""
  s = cam.shot_px
  xs = [i * s for i, _ in shots] + [(i + 1) * s for i, _ in shots]
  ys = [j * s for _, j in shots] + [(j + 1) * s for _, j in shots]
  cx = [min(xs), max(xs), min(xs), max(xs)]
  cy = [min(ys), min(ys), max(ys), max(ys)]
  lats, lons = [], []
  for dh in (-150, 150):
    lat, lon = cam.unproject(cx, cy, ground_h + dh)
    lats += list(lat)
    lons += list(lon)
  pad = 0.01
  return min(lats) - pad, min(lons) - pad, max(lats) + pad, max(lons) + pad


def save_mask(mask, path):
  Image.fromarray((mask * 255).astype(np.uint8)).save(path)


def main():
  ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  ap.add_argument("run_dir")
  ap.add_argument("--config", default=TEACHER_CONFIG)
  args = ap.parse_args()

  run_dir = Path(args.run_dir)
  tcfg = json.loads(Path(args.config).read_text())
  wcfg = tcfg["water"]
  plan = json.loads((run_dir / "shots.json").read_text())
  cam = Camera.from_config(plan["camera"])
  fp = tcfg["frame_px"]
  per = cam.shot_px // fp
  assert per * fp == cam.shot_px, "frame_px must divide shot_px"

  bbox = run_bbox(cam, plan["shots"], plan["ground_h"])
  water = fetch_water(bbox, run_dir / "osm" / "water.json")
  projected = project_water(cam, water, run_dir / "osm" / "heights.json", wcfg["srtm_to_ellipsoid_m"])
  print(f"{len(water)} OSM water features in {', '.join(f'{v:.4f}' for v in bbox)}")

  (run_dir / "frames").mkdir(exist_ok=True)
  (run_dir / "masks").mkdir(exist_ok=True)
  frames = []
  for i, j in plan["shots"]:
    shot_path = run_dir / "shots" / f"{i}_{j}.png"
    if not shot_path.exists():
      continue
    shot = Image.open(shot_path).convert("RGB")
    for dy in range(per):
      for dx in range(per):
        fx, fy = i * per + dx, j * per + dy
        name = f"{fx}_{fy}"
        shot.crop((dx * fp, dy * fp, (dx + 1) * fp, (dy + 1) * fp)).save(run_dir / "frames" / f"{name}.png")
        wat, req, allow = frame_masks(
          projected, fx * fp, fy * fp, fp, wcfg["allowed_dilate_px"], wcfg["required_erode_px"]
        )
        for tag, m in (("water", wat), ("required", req), ("allowed", allow)):
          save_mask(m, run_dir / "masks" / f"{name}_{tag}.png")
        frames.append({
          "name": name,
          "fx": fx,
          "fy": fy,
          "water_share": round(float(wat.mean()), 4),
          "sentence": water_sentence(wat),
        })

  (run_dir / "frames.json").write_text(json.dumps(frames, indent=2))
  wet = sum(f["water_share"] > 0.002 for f in frames)
  print(f"{len(frames)} frames, {wet} with water -> {run_dir / 'frames.json'}")


if __name__ == "__main__":
  main()
