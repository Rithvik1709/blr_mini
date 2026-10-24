"""Have the teacher model redraw render frames as pixel art, and keep what passes.

  uv run python -m blr.teacher runs/pilot --dry-run        # prompts only, no calls
  uv run python -m blr.teacher runs/pilot --limit 6        # six frames
  uv run python -m blr.teacher runs/pilot                  # every frame

Each frame gets up to max_attempts tries. Every attempt is saved under
teacher/attempts/ and logged with its check scores in teacher/attempts.jsonl;
the first one that passes is copied to teacher/targets/. Frames that are
accepted or out of tries are skipped on the next run, so it resumes.

Providers: "gemini" (GEMINI_API_KEY, Google's Interactions API) or
"openrouter" (OPENROUTER_API_KEY, the same models resold).
"""

import argparse
import asyncio
import base64
import io
import json
import os
import shutil
import time
from pathlib import Path

import httpx
import numpy as np
from PIL import Image

from blr.camera import ROOT
from blr.checks import run_checks

TEACHER_CONFIG = ROOT / "config" / "teacher.json"
PROMPT = ROOT / "prompts" / "teacher.txt"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
KEY_NAMES = {"gemini": "GEMINI_API_KEY", "openrouter": "OPENROUTER_API_KEY"}


class NoImage(Exception):
  """The model answered, but without an image (refusal, text only, ...)."""


def load_env(path=ROOT / ".env"):
  if not path.exists():
    return
  for line in path.read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
      continue
    k, v = line.split("=", 1)
    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def build_prompt(frame):
  return PROMPT.read_text().replace("{water}", frame["sentence"])


def _last_image_gemini(resp):
  """Base64 data of the final image in an Interactions API response."""
  found = []

  def walk(node, in_output):
    if isinstance(node, dict):
      if node.get("type") == "image" and isinstance(node.get("data"), str) and in_output:
        found.append(node["data"])
      inline = node.get("inlineData") or node.get("inline_data")  # generateContent shape
      if isinstance(inline, dict) and isinstance(inline.get("data"), str):
        found.append(inline["data"])
      out = in_output or node.get("type") == "model_output"
      for v in node.values():
        walk(v, out)
    elif isinstance(node, list):
      for v in node:
        walk(v, in_output)

  steps = resp.get("steps")
  if steps:
    walk([s for s in steps if s.get("type") == "model_output"] or steps, True)
  else:
    walk(resp, True)
  if not found:
    raise NoImage(json.dumps(resp)[:500])
  return found[-1]


def _last_image_openrouter(resp):
  try:
    images = resp["choices"][0]["message"].get("images") or []
    url = images[-1]["image_url"]["url"]
  except (KeyError, IndexError, TypeError):
    raise NoImage(json.dumps(resp)[:500]) from None
  return url.split(",", 1)[1]


async def call_teacher(client, provider, model, key, prompt, png, image_size):
  b64 = base64.b64encode(png).decode()
  if provider == "gemini":
    body = {
      "model": model,
      "input": [
        {"type": "text", "text": prompt},
        {"type": "image", "mime_type": "image/png", "data": b64},
      ],
      "response_format": {"type": "image", "aspect_ratio": "1:1", "image_size": image_size},
    }
    r = await client.post(GEMINI_URL, json=body, headers={"x-goog-api-key": key})
    r.raise_for_status()
    data = _last_image_gemini(r.json())
  else:
    body = {
      "model": model,
      "messages": [{
        "role": "user",
        "content": [
          {"type": "text", "text": prompt},
          {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
        ],
      }],
      "modalities": ["image", "text"],
      "image_config": {"aspect_ratio": "1:1", "image_size": image_size},
    }
    r = await client.post(OPENROUTER_URL, json=body, headers={"Authorization": f"Bearer {key}"})
    r.raise_for_status()
    data = _last_image_openrouter(r.json())
  return base64.b64decode(data)


def _transient(e):
  if isinstance(e, httpx.HTTPStatusError):
    return e.response.status_code in (408, 429) or e.response.status_code >= 500
  return isinstance(e, httpx.TransportError)


async def teach_frame(frame, ctx, done_attempts):
  run_dir, cfg, sem, log = ctx["run_dir"], ctx["cfg"], ctx["sem"], ctx["log"]
  name = frame["name"]
  render_img = Image.open(run_dir / "frames" / f"{name}.png").convert("RGB")
  render = np.asarray(render_img)
  required = np.asarray(Image.open(run_dir / "masks" / f"{name}_required.png")) > 0
  allowed = np.asarray(Image.open(run_dir / "masks" / f"{name}_allowed.png")) > 0
  buf = io.BytesIO()
  render_img.save(buf, "PNG")
  png = buf.getvalue()
  prompt = build_prompt(frame)

  for attempt in range(done_attempts + 1, cfg["max_attempts"] + 1):
    async with sem:
      start = time.time()
      entry = {"name": name, "attempt": attempt, "provider": ctx["provider"], "model": ctx["model"]}
      out = None
      for retry in range(5):
        try:
          out = await call_teacher(
            ctx["client"], ctx["provider"], ctx["model"], ctx["key"], prompt, png, cfg["image_size"]
          )
          break
        except NoImage as e:
          entry["error"] = f"no image: {e}"
          break
        except Exception as e:
          if not _transient(e) or retry == 4:
            body = e.response.text[:500] if isinstance(e, httpx.HTTPStatusError) else ""
            raise RuntimeError(f"{name}: {e} {body}") from e
          await asyncio.sleep(10 * 2**retry)
      entry["seconds"] = round(time.time() - start, 1)

    if out is None:
      entry.update(accepted=False, reasons=["no image"])
    else:
      img = Image.open(io.BytesIO(out)).convert("RGB")
      entry["returned_size"] = list(img.size)
      if img.size != render_img.size:
        img = img.resize(render_img.size, Image.LANCZOS)
      path = run_dir / "teacher" / "attempts" / f"{name}_{attempt}.png"
      tmp = path.with_suffix(".tmp")
      img.save(tmp, "PNG")
      os.replace(tmp, path)
      scores, reasons = run_checks(render, np.asarray(img), required, allowed, cfg)
      entry.update(accepted=not reasons, reasons=reasons, scores=scores)
      if not reasons:
        shutil.copyfile(path, run_dir / "teacher" / "targets" / f"{name}.png")

    log.write(json.dumps(entry) + "\n")
    log.flush()
    verdict = "ACCEPTED" if entry["accepted"] else "rejected: " + ", ".join(entry["reasons"])
    print(f"{name} #{attempt}  {entry['seconds']}s  {verdict}  {entry.get('scores', '')}")
    if entry["accepted"]:
      return True
  return False


async def run(args):
  run_dir = Path(args.run_dir)
  cfg = json.loads(Path(args.config).read_text())
  provider = args.provider or cfg["provider"]
  model = args.model or cfg["models"][provider]
  frames = json.loads((run_dir / "frames.json").read_text())
  if args.frames:
    wanted = set(args.frames.split(","))
    frames = [f for f in frames if f["name"] in wanted]

  tdir = run_dir / "teacher"
  for sub in ("attempts", "targets", "prompts"):
    (tdir / sub).mkdir(parents=True, exist_ok=True)

  tried = {}
  log_path = tdir / "attempts.jsonl"
  if log_path.exists():
    for line in log_path.read_text().splitlines():
      e = json.loads(line)
      tried[e["name"]] = max(tried.get(e["name"], 0), e["attempt"])
  todo = [
    f for f in frames
    if not (tdir / "targets" / f"{f['name']}.png").exists() and tried.get(f["name"], 0) < cfg["max_attempts"]
  ]
  if args.limit:
    todo = todo[: args.limit]

  for f in todo:
    (tdir / "prompts" / f"{f['name']}.txt").write_text(build_prompt(f))
  worst = sum(cfg["max_attempts"] - tried.get(f["name"], 0) for f in todo)
  price = cfg.get("usd_per_image", {}).get(model)
  cost = f", at most ${worst * price:.2f}" if price else ""
  print(f"{len(frames)} frames, {len(todo)} to draw with {provider}:{model} (at most {worst} calls{cost})")
  if args.dry_run or not todo:
    if todo:
      print(f"prompts in {tdir / 'prompts'}; first one:\n\n{build_prompt(todo[0])}")
    return

  load_env()
  key = os.environ.get(KEY_NAMES[provider])
  if not key:
    raise SystemExit(f"set {KEY_NAMES[provider]} in .env (or pass --provider)")

  async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=30)) as client:
    with open(log_path, "a") as log:
      ctx = {
        "run_dir": run_dir, "cfg": cfg, "client": client, "log": log, "key": key,
        "provider": provider, "model": model,
        "sem": asyncio.Semaphore(args.concurrency or cfg["concurrency"]),
      }
      results = await asyncio.gather(*(teach_frame(f, ctx, tried.get(f["name"], 0)) for f in todo))
  print(f"{sum(results)}/{len(todo)} frames accepted -> {tdir / 'targets'}")


def main():
  ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  ap.add_argument("run_dir")
  ap.add_argument("--config", default=TEACHER_CONFIG)
  ap.add_argument("--provider", choices=sorted(KEY_NAMES))
  ap.add_argument("--model")
  ap.add_argument("--frames", help="comma-separated frame names, e.g. -1_-2,0_-3")
  ap.add_argument("--limit", type=int)
  ap.add_argument("--concurrency", type=int)
  ap.add_argument("--dry-run", action="store_true", help="write the prompts and stop")
  asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
  main()
