import json
import shutil
import subprocess

import numpy as np
import pytest

from blr.camera import DEFAULT_CONFIG, ROOT, Camera
from blr.plan import shots_for_box

CAM = Camera.load()
H = CAM.config["anchor"]["height_m"]


def test_anchor_is_canvas_origin():
  a = CAM.config["anchor"]
  np.testing.assert_allclose(CAM.project(a["lat"], a["lon"], H), [0, 0], atol=1e-6)


@pytest.mark.skipif(
  not (ROOT / "render" / "node_modules").exists() or shutil.which("node") is None,
  reason="needs node and render/node_modules",
)
def test_matches_3d_tiles_renderer():
  out = subprocess.run(
    ["node", "camera-matrix.mjs", str(DEFAULT_CONFIG)],
    cwd=ROOT / "render", capture_output=True, text=True, check=True,
  ).stdout
  m = np.array(json.loads(out)).reshape(4, 4).T
  np.testing.assert_allclose(m[:3, :3], CAM.matrix[:3, :3], atol=1e-12)
  np.testing.assert_allclose(m[:3, 3], CAM.matrix[:3, 3], atol=1e-6)


def test_unproject_round_trip():
  # points across a 40 km square, the size of the city
  rng = np.random.default_rng(0)
  lat = 12.97 + rng.uniform(-0.2, 0.2, 200)
  lon = 77.59 + rng.uniform(-0.2, 0.2, 200)
  h = H + rng.uniform(-80, 80, 200)
  xy = CAM.project(lat, lon, h)
  lat2, lon2 = CAM.unproject(xy[:, 0], xy[:, 1], h)
  back = CAM.project(lat2, lon2, h)
  np.testing.assert_allclose(back, xy, atol=0.01)  # pixels


def test_scale_and_height_shift():
  m = CAM.metres_per_px
  # 45 deg tilt: one metre of height moves a point sin(45)/m pixels up the image
  y0 = CAM.project(12.97, 77.59, H)[1]
  y1 = CAM.project(12.97, 77.59, H + 1)[1]
  assert y0 - y1 == pytest.approx(np.sin(np.radians(45)) / m, rel=1e-3)
  # ground east-west is close to metres / m after the 15 deg turn
  d = CAM.project(12.97, [77.59, 77.60], H)
  metres = 0.01 * np.radians(1) * 6378137 * np.cos(np.radians(12.97))
  assert np.hypot(*(d[1] - d[0])) == pytest.approx(metres / m, rel=0.3)


def test_shots_tile_the_canvas():
  s = CAM.shot_px
  assert shots_for_box(CAM, 0, 0, s, s) == [(0, 0)]
  assert shots_for_box(CAM, -1, -1, s + 1, 1) == [(-1, -1), (0, -1), (1, -1), (-1, 0), (0, 0), (1, 0)]
  assert CAM.shot_of(s - 1, 0) == (0, 0) and CAM.shot_of(s, 0) == (1, 0)
