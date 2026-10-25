import { inject } from '@vercel/analytics';
import OpenSeadragon from "openseadragon";
import "./style.css";
import { makeCamera } from "./projection.js";
import { createClouds } from "./clouds.js";
import { createLayers } from "./layers.js";
import { createMinimap } from "./minimap.js";
import { prefs } from "./overlay.js";
import { kindLabel, loadIndex, search } from "./search.js";
import { createSky } from "./sky.js";
import { clampScale, formatHash, initialView, viewToLatLon } from "./view.js";

// Initialize Vercel Web Analytics
inject();

const M = window.__MANIFEST;
const site = window.__SITE;
const cam = makeCamera(M.camera);
const $ = (id) => document.getElementById(id);
const tileQuery = await window.__tileQuery;

const viewer = OpenSeadragon({
  element: $("map"),
  // Deep Zoom source built inline: no tiles.dzi request before the first tile
  tileSources: new OpenSeadragon.DziTileSource({
    width: M.width,
    height: M.height,
    tileSize: M.tileSize,
    tileOverlap: 0,
    tilesUrl: `${site.tileBase}/${M.version}/tiles_files/`,
    fileFormat: M.format,
    queryParams: tileQuery,
  }),
  // WebGL can only draw images from another origin (a tile bucket) with CORS
  crossOriginPolicy: "Anonymous",
  showNavigationControl: false,
  drawer: "webgl",
  blendTime: 0,
  animationTime: 0.9,
  springStiffness: 8,
  maxZoomPixelRatio: site.maxScale,
  minZoomImageRatio: 0.4,
  visibilityRatio: 0.3,
  constrainDuringPan: true,
  zoomPerScroll: 1.25,
  gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true },
  gestureSettingsTouch: { pinchRotate: false },
  // first view: only its sharpest level, as the boot script fetched
  immediateRender: true,
});

const vp = () => viewer.viewport;
const imageScale = () => vp().viewportToImageZoom(vp().getZoom(true));

function goTo({ x, y, scale }, immediately = false) {
  const s = clampScale(M, site, scale, window.innerWidth, window.innerHeight);
  vp().zoomTo(vp().imageToViewportZoom(s), null, immediately);
  vp().panTo(vp().imageToViewportCoordinates(x, y), immediately);
}

// Pixel art is drawn pixel for pixel at 1:1 and closer, smoothly when smaller.
let smoothing = null;
function updateSmoothing() {
  const want = imageScale() < 1;
  if (want !== smoothing) {
    smoothing = want;
    viewer.drawer.setImageSmoothingEnabled(want);
    viewer.forceRedraw();
  }
}

// The view lives in the URL: #lat,lon,scale.
let writingHash = false;
function writeHash() {
  const c = vp().viewportToImageCoordinates(vp().getCenter(true));
  const [lat, lon] = viewToLatLon(M, cam, c.x, c.y);
  writingHash = true;
  history.replaceState(null, "", formatHash(lat, lon, imageScale()));
  writingHash = false;
}

viewer.addHandler("open", () => {
  goTo(window.__bootView, true);
  updateSmoothing();
  // once it is drawn, go back to keeping coarser levels under the view, so
  // panning and zooming out show a soft map rather than nothing
  const item = viewer.world.getItemAt(0);
  const settle = (e) => {
    if (!e.fullyLoaded) return;
    item.removeHandler("fully-loaded-change", settle);
    item.immediateRender = false;
    viewer.forceRedraw();
    // cloud data waits until the first view is complete
    clouds.set(true);
  };
  item.addHandler("fully-loaded-change", settle);
});
viewer.addHandler("zoom", updateSmoothing);
viewer.addHandler("animation-finish", writeHash);
window.addEventListener("hashchange", () => {
  if (!writingHash) goTo(initialView(M, site, cam, location.hash, window.innerWidth, window.innerHeight));
});

// --- layers, minimap, sky and clouds ---
const clouds = createClouds(viewer, M);
const layers = createLayers(viewer, M);
const settings = {
  minimap: createMinimap(viewer, M),
  metro: { set: (v) => layers.set("metro", v), get: () => layers.get("metro") },
  wards: { set: (v) => layers.set("wards", v), get: () => layers.get("wards") },
  sky: createSky(viewer),
};
const defaults = { minimap: window.innerWidth > 640, metro: false, wards: false, sky: true };
const KEYS = { m: "minimap", l: "metro", w: "wards", t: "sky" };

function setSetting(key, on) {
  settings[key].set(on);
  prefs.set(key, on);
  const box = document.querySelector(`[data-setting="${key}"]`);
  if (box) box.checked = on;
}
for (const key of Object.keys(settings)) setSetting(key, prefs.get(key, defaults[key]));

document.querySelectorAll("[data-setting]").forEach((box) => {
  box.addEventListener("change", () => setSetting(box.dataset.setting, box.checked));
});
document.addEventListener("toggle-setting", (e) => setSetting(e.detail, !settings[e.detail].get()));
document.addEventListener("keydown", (e) => {
  const key = KEYS[e.key.toLowerCase()];
  if (!key || e.metaKey || e.ctrlKey || e.altKey || e.target.closest("input")) return;
  setSetting(key, !settings[key].get());
  toast(`${document.querySelector(`[data-setting="${key}"]`).parentElement.textContent.trim().slice(0, -2)} ${settings[key].get() ? "on" : "off"}`);
});
// OpenSeadragon pans on W/S by default; those keys are ours
viewer.addHandler("canvas-key", (e) => {
  if (KEYS[e.originalEvent.key?.toLowerCase()]) e.preventDefaultAction = true;
});

const settingsBtn = $("settings-btn");
const settingsPanel = $("settings");
settingsBtn.onclick = () => {
  settingsPanel.hidden = !settingsPanel.hidden;
  settingsBtn.setAttribute("aria-expanded", String(!settingsPanel.hidden));
};
document.addEventListener("pointerdown", (e) => {
  if (!settingsPanel.hidden && !e.target.closest("#settings, #settings-btn")) {
    settingsPanel.hidden = true;
    settingsBtn.setAttribute("aria-expanded", "false");
  }
});

// --- controls ---
$("zoom-in").onclick = () => vp().zoomBy(2);
$("zoom-out").onclick = () => vp().zoomBy(0.5);
$("home").onclick = () => goTo(initialView(M, site, cam, "", window.innerWidth, window.innerHeight));

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

$("share").onclick = async () => {
  writeHash();
  const url = location.href;
  try {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      await navigator.share({ title: document.title, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    toast("Link copied");
  } catch {
    toast("Copy the address bar to share");
  }
};

// --- search ---
const input = $("search");
const list = $("results");
let results = [];
let active = -1;
let pin = null;

function render() {
  list.innerHTML = "";
  results.forEach((r, i) => {
    const li = document.createElement("li");
    li.role = "option";
    li.id = `result-${i}`;
    li.setAttribute("aria-selected", String(i === active));
    const alt = r.a.find((a) => /[ಀ-೿]/.test(a));
    li.innerHTML = `<span class="name"></span><span class="kind ${r.k}">${kindLabel(r.k)}</span>`;
    li.querySelector(".name").textContent = r.n;
    if (alt) {
      const s = document.createElement("span");
      s.className = "alt";
      s.textContent = alt;
      li.querySelector(".name").append(s);
    }
    li.onmousedown = (e) => {
      e.preventDefault();
      choose(i);
    };
    list.append(li);
  });
  if (!results.length && input.value.trim()) {
    list.innerHTML = '<li class="empty">Nothing here by that name yet</li>';
  }
  const open = input.value.trim() !== "" && document.activeElement === input;
  list.hidden = !open;
  input.setAttribute("aria-expanded", String(open));
  input.setAttribute("aria-activedescendant", active >= 0 ? `result-${active}` : "");
}

function choose(i) {
  const r = results[i];
  if (!r) return;
  const x = r.x - M.origin[0];
  const y = r.y - M.origin[1];
  if (pin) viewer.removeOverlay(pin);
  pin = document.createElement("div");
  pin.className = "pin";
  viewer.addOverlay({
    element: pin,
    location: vp().imageToViewportCoordinates(x, y),
    placement: OpenSeadragon.Placement.BOTTOM,
  });
  goTo({ x, y, scale: r.k === "area" ? 0.5 : 1 });
  input.value = r.n;
  input.blur();
  results = [];
  render();
}

input.addEventListener("focus", loadIndex, { once: true });
input.addEventListener("input", async () => {
  const q = input.value;
  const found = await search(q);
  if (q !== input.value) return; // a newer keystroke won
  results = found;
  active = results.length ? 0 : -1;
  render();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (results.length) active = (active + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
    render();
  } else if (e.key === "Enter") {
    choose(active);
  } else if (e.key === "Escape") {
    input.value = "";
    input.blur();
    results = [];
    render();
  }
});
input.addEventListener("blur", render);
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== input) {
    e.preventDefault();
    input.focus();
  }
});
