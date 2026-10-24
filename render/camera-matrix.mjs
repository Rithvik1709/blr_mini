// Prints the camera-to-ECEF matrix that main.js builds, using the same
// library calls, so tests/test_camera.py can check camera.py against it.
import { readFileSync } from "node:fs";
import { WGS84_ELLIPSOID, CAMERA_FRAME } from "3d-tiles-renderer/three";
import { Matrix4, MathUtils } from "three";

const cfg = JSON.parse(readFileSync(process.argv[2] ?? new URL("../config/camera.json", import.meta.url)));
const D2R = MathUtils.DEG2RAD;
const m = new Matrix4();
WGS84_ELLIPSOID.getObjectFrame(
  cfg.anchor.lat * D2R,
  cfg.anchor.lon * D2R,
  cfg.anchor.height_m,
  cfg.azimuth_deg * D2R,
  cfg.elevation_deg * D2R,
  cfg.roll_deg * D2R,
  m,
  CAMERA_FRAME,
);
m.multiply(new Matrix4().makeTranslation(0, 0, cfg.camera_distance_m));
console.log(JSON.stringify(m.elements));
