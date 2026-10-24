"""Automatic checks on a teacher drawing, each against something known to be true.

- photo copy: pixel art is mostly flat fills and a photo is not, so measure the
  share of pixels whose 3x3 neighbourhood is flat (tiny.london: careful
  redraws 0.42-0.55, half copies 0.18-0.35)
- structure: the drawing must keep the render's layout and framing, so align
  the two edge maps (phase correlation) and require a small shift and a fair
  correlation
- water: water colour outside OSM water (grown) is invented; permanent OSM
  water (shrunk) that is not water colour is missing

Every threshold is in config/teacher.json, and every score is logged, so the
thresholds can be tuned on contact sheets.
"""

import numpy as np
from scipy import ndimage


def flat_share(rgb, tolerance):
  a = rgb.astype(np.int16)
  spread = ndimage.maximum_filter(a, size=(3, 3, 1)) - ndimage.minimum_filter(a, size=(3, 3, 1))
  return float((spread.max(axis=2) <= tolerance).mean())


def _edges(rgb, scale):
  g = rgb.astype(np.float32).mean(axis=2)
  g = ndimage.gaussian_filter(g, 1.5 * scale)
  g = g[::scale, ::scale]
  e = np.hypot(ndimage.sobel(g, 0), ndimage.sobel(g, 1))
  return (e - e.mean()) / (e.std() + 1e-6)


def structure(render, target, scale=4):
  """(shift_px, edge_corr): how far the drawing moved, and how well its edges follow the render's."""
  a, b = _edges(render, scale), _edges(target, scale)
  fa, fb = np.fft.fft2(a), np.fft.fft2(b)
  r = fa * np.conj(fb)
  corr = np.fft.ifft2(r / (np.abs(r) + 1e-9)).real
  dy, dx = np.unravel_index(np.argmax(corr), corr.shape)
  h, w = a.shape
  dy = dy - h if dy > h // 2 else dy
  dx = dx - w if dx > w // 2 else dx
  b_aligned = np.roll(b, (dy, dx), axis=(0, 1))
  edge_corr = float((a * b_aligned).mean())
  return float(np.hypot(dx, dy) * scale), edge_corr


def water_colour(rgb):
  """Pixels that read as water: clearly blue or teal, not grey."""
  hsv_r, hsv_g, hsv_b = (rgb[..., k].astype(np.int16) for k in range(3))
  return (hsv_b > hsv_r + 30) & (hsv_b >= hsv_g - 10) & (hsv_b > 60)


def water(target, required, allowed, min_component_px):
  """(invented_share, required_cover): water colour outside OSM water, and OSM water drawn as water."""
  wet = water_colour(target)
  stray = wet & ~allowed
  labels, n = ndimage.label(stray)
  if n:
    sizes = ndimage.sum(stray, labels, index=np.arange(1, n + 1))
    big = np.isin(labels, np.flatnonzero(sizes >= min_component_px) + 1)
  else:
    big = stray
  invented = float(big.mean())
  cover = float(wet[required].mean()) if required.any() else 1.0
  return invented, cover


def run_checks(render, target, required, allowed, cfg):
  """Scores, and the list of reasons to reject (empty means accepted)."""
  c = cfg["checks"]
  scores = {}
  reasons = []
  if target.shape != render.shape:
    return {"shape": list(target.shape)}, ["wrong size"]

  scores["flat_share"] = round(flat_share(target, c["flat_tolerance"]), 3)
  scores["render_flat_share"] = round(flat_share(render, c["flat_tolerance"]), 3)
  if scores["flat_share"] < c["min_flat_share"]:
    reasons.append("photo copy")

  shift, corr = structure(render, target)
  scores["shift_px"] = round(shift, 1)
  scores["edge_corr"] = round(corr, 3)
  if shift > c["max_shift_px"]:
    reasons.append("moved")
  if corr < c["min_edge_corr"]:
    reasons.append("structure")

  invented, cover = water(target, required, allowed, c["min_water_component_px"])
  scores["invented_water"] = round(invented, 4)
  scores["water_cover"] = round(cover, 3)
  if invented > c["max_invented_water_share"]:
    reasons.append("invented water")
  if required.sum() >= c["min_required_water_px"] and cover < c["min_water_cover"]:
    reasons.append("missing water")
  return scores, reasons
