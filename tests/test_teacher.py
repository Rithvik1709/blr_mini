import json

import numpy as np

from blr.checks import flat_share, run_checks, structure
from blr.osm import water_sentence
from blr.teacher import NoImage, _last_image_gemini, _last_image_openrouter

CFG = json.loads(open("config/teacher.json").read())
RNG = np.random.default_rng(0)


def blocky(n=256, block=16, colours=8):
  small = RNG.integers(0, colours, (n // block, n // block))
  palette = RNG.integers(0, 256, (colours, 3))
  return palette[np.kron(small, np.ones((block, block), int))].astype(np.uint8)


def test_flat_share_separates_art_from_photo():
  art = blocky()
  photo = (art.astype(int) + RNG.normal(0, 12, art.shape)).clip(0, 255).astype(np.uint8)
  assert flat_share(art, 6) > 0.7
  assert flat_share(photo, 6) < 0.1


def test_structure_finds_shift():
  art = blocky()
  shift, corr = structure(art, art)
  assert shift == 0 and corr > 0.99
  shift, _ = structure(art, np.roll(art, (12, -8), (0, 1)))
  assert abs(shift - np.hypot(12, 8)) < 4.5  # measured at 1/4 scale


def test_invented_water_is_rejected():
  art = blocky(512)
  art[..., 2] //= 4  # no blue anywhere to start with
  none = np.zeros((512, 512), bool)
  scores, reasons = run_checks(art, art, none, none, CFG)
  assert reasons == []
  pond = art.copy()
  pond[100:160, 100:160] = (40, 110, 200)
  scores, reasons = run_checks(art, pond, none, none, CFG)
  assert "invented water" in reasons
  allowed = none.copy()
  allowed[90:170, 90:170] = True
  scores, reasons = run_checks(art, pond, none, allowed, CFG)
  assert "invented water" not in reasons


def test_water_sentence():
  m = np.zeros((900, 900), bool)
  assert "none" in water_sentence(m)
  m[:300, :300] = True
  s = water_sentence(m)
  assert "11%" in s and "top-left" in s


def test_parse_gemini_interactions():
  resp = {"steps": [
    {"type": "thought", "content": [{"type": "image", "data": "VGhvdWdodA=="}]},
    {"type": "model_output", "content": [{"type": "text", "text": "here"}, {"type": "image", "data": "RmluYWw="}]},
  ]}
  assert _last_image_gemini(resp) == "RmluYWw="
  try:
    _last_image_gemini({"steps": [{"type": "model_output", "content": [{"type": "text", "text": "no"}]}]})
    raise AssertionError("expected NoImage")
  except NoImage:
    pass


def test_parse_openrouter():
  resp = {"choices": [{"message": {"images": [{"image_url": {"url": "data:image/png;base64,QUJD"}}]}}]}
  assert _last_image_openrouter(resp) == "QUJD"
