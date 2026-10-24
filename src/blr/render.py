"""Render every planned shot to runs/<name>/shots/<i>_<j>.png.

  uv run python -m blr.render runs/pilot --workers 2

Starts the Vite page in render/ (unless --url is given), opens one browser
page per worker, and moves each page's frustum from shot to shot without
reloading. Finished shots are skipped, so a crashed run resumes where it
stopped; every PNG is written to a temp file and renamed into place.
"""

import argparse
import asyncio
import base64
import io
import json
import os
import signal
import socket
import subprocess
import time
from pathlib import Path

import numpy as np
from PIL import Image
from playwright.async_api import async_playwright

from blr.camera import ROOT, Camera

CHROMIUM_ARGS = ["--enable-webgl", "--use-gl=angle", "--ignore-gpu-blocklist"]


def wait_for_port(port, timeout=30.0):
  end = time.time() + timeout
  while time.time() < end:
    with socket.socket() as s:
      if s.connect_ex(("127.0.0.1", port)) == 0:
        return True
    time.sleep(0.2)
  return False


def start_vite(port, log_path):
  # a log file, not a pipe: vite's node child outlives bun and would hold a pipe open
  with open(log_path, "w") as log:
    proc = subprocess.Popen(
      ["bunx", "vite", "--port", str(port), "--strictPort"],
      cwd=ROOT / "render",
      stdout=log,
      stderr=subprocess.STDOUT,
      start_new_session=True,
    )
  if not wait_for_port(port):
    stop_vite(proc)
    raise RuntimeError(f"vite did not start, see {log_path}")
  return proc


def stop_vite(proc):
  try:
    os.killpg(proc.pid, signal.SIGTERM)
  except ProcessLookupError:
    pass


def check_camera(browser_matrix, cam: Camera):
  """The browser and camera.py must agree, or every projection will be off."""
  m = np.array(browser_matrix).reshape(4, 4).T  # three.js is column-major
  rot_err = np.abs(m[:3, :3] - cam.matrix[:3, :3]).max()
  pos_err = np.abs(m[:3, 3] - cam.matrix[:3, 3]).max()
  if rot_err > 1e-9 or pos_err > 1e-3:
    raise RuntimeError(f"camera mismatch: rotation {rot_err:.2e}, position {pos_err:.2e} m")


# The renderer's clear colour (render/main.js). A shot that is nearly all of it
# drew no tiles: the page's tile session has gone bad, not the city.
SKY = np.array([0x87, 0xCE, 0xEB])


def blank_share(png: bytes) -> float:
  img = np.asarray(Image.open(io.BytesIO(png)).convert("RGB").resize((64, 64), Image.NEAREST)).astype(int)
  return float((np.abs(img - SKY).max(axis=2) <= 3).mean())


async def open_page(browser, url, s, n, first):
  ctx = await browser.new_context(viewport={"width": s, "height": s}, device_scale_factor=1)
  page = await ctx.new_page()
  page.on("pageerror", lambda e: print(f"[{n}] page error: {e}"))
  api_errors = []

  async def on_response(r):
    if ("googleapis.com" in r.url or "cesium.com" in r.url) and r.status >= 400:
      api_errors.append(f"{r.status}: {(await r.text())[:500]}")

  page.on("response", on_response)
  i, j = first
  await page.goto(f"{url}?export=true&shot={i},{j}")
  await page.wait_for_function("window.BLR !== undefined")
  try:
    await asyncio.wait_for(page.evaluate("BLR.ready"), 60)
  except TimeoutError:
    detail = api_errors[0] if api_errors else "check the key or token in .env"
    raise SystemExit(f"the root tileset never loaded: {detail}") from None
  return page


async def worker(n, ctx, queue, out_dir, log, timeout_ms):
  page = ctx["pages"][n]
  while True:
    try:
      i, j = queue.get_nowait()
    except asyncio.QueueEmpty:
      return
    for attempt in range(1, 4):
      res = await page.evaluate("([i, j, t]) => BLR.setShot(i, j, { timeoutMs: t })", [i, j, timeout_ms])
      png = base64.b64decode((await page.evaluate("BLR.capture()")).split(",", 1)[1])
      res["blank"] = round(blank_share(png), 3)
      if res["visible"] > 0 and res["blank"] < 0.9:
        break
      # a fresh page means a fresh tile session
      print(f"[{n}] {i},{j} came out blank (visible tiles {res['visible']}), reopening the page, try {attempt}")
      await page.context.close()
      page = ctx["pages"][n] = await open_page(ctx["browser"], ctx["url"], ctx["s"], n, (i, j))
    else:
      res.update(worker=n, skipped=True)
      log.write(json.dumps(res) + "\n")
      log.flush()
      print(f"[{n}] {i},{j} still blank after 3 tries; left for the next run")
      continue
    final = out_dir / f"{i}_{j}.png"
    tmp = final.with_suffix(".png.tmp")
    tmp.write_bytes(png)
    os.replace(tmp, final)
    res["worker"] = n
    log.write(json.dumps(res) + "\n")
    log.flush()
    flag = "  TIMED OUT" if res["timedOut"] else ""
    print(f"[{n}] {i},{j}  {res['ms'] / 1000:.1f}s  tiles={res['visible']}{flag}  ({queue.qsize()} left)", flush=True)


async def run(args):
  run_dir = Path(args.run_dir)
  plan = json.loads((run_dir / "shots.json").read_text())
  cam = Camera.from_config(plan["camera"])
  if plan["camera"] != json.loads((ROOT / "config" / "camera.json").read_text()):
    raise SystemExit("config/camera.json changed since this run was planned; re-plan or restore it")

  out_dir = run_dir / "shots"
  out_dir.mkdir(exist_ok=True)
  if args.recheck:
    blanks = [f for f in sorted(out_dir.glob("*.png")) if blank_share(f.read_bytes()) >= 0.9]
    for f in blanks:
      f.unlink()
    print(f"removed {len(blanks)} blank shots")
  todo = [tuple(s) for s in plan["shots"] if not (out_dir / f"{s[0]}_{s[1]}.png").exists()]
  if args.limit:
    todo = todo[: args.limit]
  print(f"{len(plan['shots'])} planned, {len(todo)} to render")
  if not todo:
    return

  if not args.url and not (ROOT / ".env").exists():
    raise SystemExit("no .env: copy .env.example and set GOOGLE_TILES_API_KEY or CESIUM_ION_TOKEN")
  vite = None
  url = args.url
  if not url:
    vite = start_vite(args.port, run_dir / "vite.log")
    url = f"http://127.0.0.1:{args.port}/"
  s = cam.shot_px
  try:
    async with async_playwright() as p:
      browser = await p.chromium.launch(headless=not args.headed, args=CHROMIUM_ARGS)
      pages = [await open_page(browser, url, s, n, todo[n]) for n in range(min(args.workers, len(todo)))]
      check_camera(await pages[0].evaluate("BLR.cameraMatrix()"), cam)
      print("tiles via", await pages[0].evaluate("BLR.source"))

      queue = asyncio.Queue()
      for shot in todo:
        queue.put_nowait(shot)
      ctx = {"pages": pages, "browser": browser, "url": url, "s": s}
      with open(run_dir / "render_log.jsonl", "a") as log:
        await asyncio.gather(*(worker(n, ctx, queue, out_dir, log, args.timeout * 1000) for n in range(len(pages))))
      pages = ctx["pages"]

      attributions = await pages[0].evaluate("BLR.attributions()")
      (run_dir / "attributions.json").write_text(json.dumps(attributions, indent=2))
      await browser.close()
  finally:
    if vite:
      stop_vite(vite)


def main():
  ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  ap.add_argument("run_dir")
  ap.add_argument("--workers", type=int, default=2)
  ap.add_argument("--port", type=int, default=5173)
  ap.add_argument("--url", help="use an already running render page instead of starting vite")
  ap.add_argument("--timeout", type=float, default=120, help="seconds to wait for one shot's tiles")
  ap.add_argument("--limit", type=int, help="render at most this many shots")
  ap.add_argument("--headed", action="store_true", help="show the browser windows")
  ap.add_argument("--recheck", action="store_true", help="first delete finished shots that came out blank")
  asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
  main()
