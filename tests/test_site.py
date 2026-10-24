import json
import shutil
import subprocess

import numpy as np
import pytest

from blr.camera import ROOT, Camera

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="needs node")

SCRIPT = """
import { makeCamera, project, unproject } from "./src/projection.js";
import { parseHash, formatHash } from "./src/view.js";
const { cfg, pts } = JSON.parse(process.argv[1]);
const cam = makeCamera(cfg);
const xy = pts.map(([la, lo, h]) => project(cam, la, lo, h));
const back = xy.map(([x, y], i) => unproject(cam, x, y, pts[i][2]));
const hash = formatHash(12.9796, 77.5907, 0.5);
console.log(JSON.stringify({ xy, back, hash, parsed: parseHash(hash) }));
"""


def test_js_projection_matches_python():
  cam = Camera.load()
  rng = np.random.default_rng(1)
  pts = np.stack([12.97 + rng.uniform(-0.2, 0.2, 50), 77.59 + rng.uniform(-0.2, 0.2, 50), 835 + rng.uniform(-80, 80, 50)], 1)
  out = subprocess.run(
    ["node", "--input-type=module", "-e", SCRIPT, json.dumps({"cfg": cam.config, "pts": pts.tolist()})],
    cwd=ROOT / "site", capture_output=True, text=True, check=True,
  ).stdout
  r = json.loads(out)
  np.testing.assert_allclose(r["xy"], cam.project(pts[:, 0], pts[:, 1], pts[:, 2]), atol=1e-4)
  np.testing.assert_allclose(r["back"], pts[:, :2], atol=1e-7)
  assert r["hash"] == "#12.97960,77.59070,0.50"
  assert r["parsed"] == {"lat": 12.9796, "lon": 77.5907, "scale": 0.5}
