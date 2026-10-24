// The map projection, ported from src/blr/camera.py (tests/test_site.py keeps
// them in step). A WGS84 point goes to ECEF, then into the single camera's
// frame; its x/y there over metres_per_px is its canvas pixel.
// No imports, so vite.config.js can inline this file into the page.

const A = 6378137.0;
const B = 6356752.314245179;
const E2 = 1 - (B * B) / (A * A);
const RAD = Math.PI / 180;

function mul(a, b) {
  const r = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

const rx = (a) => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const ry = (a) => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const rz = (a) => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];

function ecef(lat, lon, h) {
  const la = lat * RAD, lo = lon * RAD;
  const n = A / Math.sqrt(1 - E2 * Math.sin(la) ** 2);
  return [(n + h) * Math.cos(la) * Math.cos(lo), (n + h) * Math.cos(la) * Math.sin(lo), (n * (1 - E2) + h) * Math.sin(la)];
}

// Same matrix as Camera.from_config: rotation R (row-major 3x3) and position t.
export function makeCamera(cfg) {
  const { lat, lon, height_m } = cfg.anchor;
  const la = lat * RAD, lo = lon * RAD;
  const east = [-Math.sin(lo), Math.cos(lo), 0];
  const up = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  const north = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];
  const enu = [east[0], north[0], up[0], east[1], north[1], up[1], east[2], north[2], up[2]];
  let R = mul(enu, rz(-cfg.azimuth_deg * RAD));
  R = mul(R, rx(cfg.elevation_deg * RAD));
  R = mul(R, ry(cfg.roll_deg * RAD));
  R = mul(R, rx(Math.PI / 2));
  const o = ecef(lat, lon, height_m);
  const d = cfg.camera_distance_m;
  const t = [o[0] + R[2] * d, o[1] + R[5] * d, o[2] + R[8] * d];
  return { R, t, m: cfg.metres_per_px };
}

// Canvas pixel [x, y] of a point h metres above the WGS84 ellipsoid.
export function project(cam, lat, lon, h) {
  const p = ecef(lat, lon, h);
  const v = [p[0] - cam.t[0], p[1] - cam.t[1], p[2] - cam.t[2]];
  const R = cam.R;
  const x = R[0] * v[0] + R[3] * v[1] + R[6] * v[2];
  const y = R[1] * v[0] + R[4] * v[1] + R[7] * v[2];
  return [x / cam.m, -y / cam.m];
}

// [lat, lon] whose canvas pixel at height h is (x, y): the camera ray through
// that pixel, met with the ellipsoid inflated by h.
export function unproject(cam, x, y, h) {
  const R = cam.R, m = cam.m;
  const o = [0, 1, 2].map((i) => cam.t[i] + R[i * 3] * x * m - R[i * 3 + 1] * y * m);
  const d = [-R[2], -R[5], -R[8]];
  const s = [1 / (A + h) ** 2, 1 / (A + h) ** 2, 1 / (B + h) ** 2];
  let qa = 0, qb = 0, qc = -1;
  for (let i = 0; i < 3; i++) {
    qa += d[i] * d[i] * s[i];
    qb += 2 * o[i] * d[i] * s[i];
    qc += o[i] * o[i] * s[i];
  }
  const k = (-qb - Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa);
  const p = [o[0] + k * d[0], o[1] + k * d[1], o[2] + k * d[2]];
  const lon = Math.atan2(p[1], p[0]) / RAD;
  const pxy = Math.hypot(p[0], p[1]);
  const ep2 = (A * A - B * B) / (B * B);
  const th = Math.atan2(p[2] * A, pxy * B);
  const lat = Math.atan2(p[2] + ep2 * B * Math.sin(th) ** 3, pxy - E2 * A * Math.cos(th) ** 3) / RAD;
  return [lat, lon];
}
