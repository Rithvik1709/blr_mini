"""The map's single camera, and the projection it defines.

The map is not a lat/lon grid. A point goes WGS84 -> ECEF -> the camera's own
frame (east/north/up at the anchor, then rotated to the isometric view), and
its x/y in that frame, divided by metres_per_px, is its pixel on the canvas.
This mirrors render/main.js, which builds the same matrix with
3d-tiles-renderer's Ellipsoid.getObjectFrame(..., CAMERA_FRAME).

Canvas pixel (0, 0) is the anchor. x grows right, y grows down, and shot
(i, j) covers x in [i*S, (i+1)*S) and y in [j*S, (j+1)*S).
"""

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "config" / "camera.json"

# WGS84, as in 3d-tiles-renderer's WGS84_ELLIPSOID
A = 6378137.0
B = 6356752.314245179
E2 = 1 - (B * B) / (A * A)


def geodetic_to_ecef(lat_deg, lon_deg, h):
  lat_deg, lon_deg, h = np.broadcast_arrays(*(np.asarray(v, float) for v in (lat_deg, lon_deg, h)))
  lat = np.radians(lat_deg)
  lon = np.radians(lon_deg)
  n = A / np.sqrt(1 - E2 * np.sin(lat) ** 2)
  x = (n + h) * np.cos(lat) * np.cos(lon)
  y = (n + h) * np.cos(lat) * np.sin(lon)
  z = (n * (1 - E2) + h) * np.sin(lat)
  return np.stack([x, y, z], axis=-1)


def _rx(a):
  c, s = math.cos(a), math.sin(a)
  return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def _ry(a):
  c, s = math.cos(a), math.sin(a)
  return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def _rz(a):
  c, s = math.cos(a), math.sin(a)
  return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def enu_rotation(lat_deg, lon_deg):
  """Columns are east, north and up at (lat, lon), in ECEF."""
  lat, lon = math.radians(lat_deg), math.radians(lon_deg)
  east = np.array([-math.sin(lon), math.cos(lon), 0.0])
  # geodetic up is the ellipsoid normal
  up = np.array([math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)])
  north = np.cross(up, east)
  return np.stack([east, north, up], axis=1)


@dataclass(frozen=True)
class Camera:
  config: dict
  matrix: np.ndarray  # 4x4 camera -> ECEF; the camera looks down its -Z

  @classmethod
  def load(cls, path=DEFAULT_CONFIG):
    return cls.from_config(json.loads(Path(path).read_text()))

  @classmethod
  def from_config(cls, cfg):
    a = cfg["anchor"]
    az = math.radians(cfg["azimuth_deg"])
    el = math.radians(cfg["elevation_deg"])
    roll = math.radians(cfg["roll_deg"])
    # getObjectFrame: ENU * Euler(el, roll, -az, 'ZXY'), then +90 deg about X
    # for CAMERA_FRAME. three.js builds a 'ZXY' Euler as Rz @ Rx @ Ry.
    rot = enu_rotation(a["lat"], a["lon"]) @ _rz(-az) @ _rx(el) @ _ry(roll) @ _rx(math.pi / 2)
    origin = geodetic_to_ecef(a["lat"], a["lon"], a["height_m"])
    m = np.eye(4)
    m[:3, :3] = rot
    m[:3, 3] = origin + rot @ np.array([0.0, 0.0, cfg["camera_distance_m"]])
    return cls(cfg, m)

  @property
  def metres_per_px(self) -> float:
    return self.config["metres_per_px"]

  @property
  def shot_px(self) -> int:
    return self.config["shot_px"]

  def project(self, lat, lon, h):
    """Canvas pixel (x, y) of a WGS84 point; h is height above the ellipsoid."""
    p = geodetic_to_ecef(lat, lon, h)
    rot, t = self.matrix[:3, :3], self.matrix[:3, 3]
    q = (p - t) @ rot  # == rot.T @ (p - t), row-wise
    m = self.metres_per_px
    return np.stack([q[..., 0] / m, -q[..., 1] / m], axis=-1)

  def unproject(self, x, y, h):
    """WGS84 (lat, lon) whose canvas pixel is (x, y) at height h, by ray-ellipsoid intersection."""
    rot, t = self.matrix[:3, :3], self.matrix[:3, 3]
    m = self.metres_per_px
    x, y, h = np.broadcast_arrays(*(np.asarray(v, float) for v in (x, y, h)))
    origin = t + np.stack([x * m, -y * m, np.zeros_like(x)], axis=-1) @ rot.T
    d = -rot[:, 2]
    # intersect with the ellipsoid inflated by h (good to well under a pixel for |h| < 2 km)
    ah, bh = A + h, B + h
    s = np.stack([1 / ah**2, 1 / ah**2, 1 / bh**2], axis=-1)
    qa = np.sum(d * d * s, axis=-1)
    qb = 2 * np.sum(origin * d * s, axis=-1)
    qc = np.sum(origin * origin * s, axis=-1) - 1
    k = (-qb - np.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa)
    p = origin + k[..., None] * d
    lon = np.degrees(np.arctan2(p[..., 1], p[..., 0]))
    # Bowring's single iteration is enough at these heights
    pxy = np.hypot(p[..., 0], p[..., 1])
    ep2 = (A * A - B * B) / (B * B)
    theta = np.arctan2(p[..., 2] * A, pxy * B)
    lat = np.degrees(
      np.arctan2(
        p[..., 2] + ep2 * B * np.sin(theta) ** 3,
        pxy - E2 * A * np.cos(theta) ** 3,
      )
    )
    return lat, lon

  def shot_of(self, x, y):
    s = self.shot_px
    return int(math.floor(x / s)), int(math.floor(y / s))

  def shot_bounds(self, i, j):
    """Canvas pixel box (x0, y0, x1, y1) of shot (i, j)."""
    s = self.shot_px
    return i * s, j * s, (i + 1) * s, (j + 1) * s
