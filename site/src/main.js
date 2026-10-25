import { inject } from '@vercel/analytics';
import OpenSeadragon from "openseadragon";
import "./style.css";
import { makeCamera, project } from "./projection.js";
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
    // cloud data and the place index wait until the first view is complete
    clouds.set(true);
    hideIntro();
    loadIndex().then(updateHere);
  };
  item.addHandler("fully-loaded-change", settle);
});
viewer.addHandler("zoom", updateSmoothing);
viewer.addHandler("zoom", updateScale);
viewer.addHandler("animation-finish", writeHash);
viewer.addHandler("animation-finish", updateHere);
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
// OpenSeadragon pans on W/S by default; those keys are ours, and so is H
const ACTIONS = { h: () => $("home").click() };
viewer.addHandler("canvas-key", (e) => {
  const k = e.originalEvent.key?.toLowerCase();
  if (KEYS[k] || ACTIONS[k]) e.preventDefaultAction = true;
});
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest("input")) return;
  if (e.key === "?") openHelp();
  else if (ACTIONS[e.key.toLowerCase()] && help.hidden) ACTIONS[e.key.toLowerCase()]();
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
  const focused = document.activeElement === input;
  const open = input.value.trim() !== "" && focused;
  list.hidden = !open;
  explore.hidden = !(focused && !input.value.trim() && explore.querySelector(".chip"));
  input.setAttribute("aria-expanded", String(open));
  input.setAttribute("aria-activedescendant", active >= 0 ? `result-${active}` : "");
}

function choose(i) {
  const r = results[i];
  if (!r) return;
  flyTo(r);
  input.value = r.n;
  input.blur();
  results = [];
  render();
}

function flyTo(r) {
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
}

input.addEventListener("focus", () => loadIndex().then(fillExplore), { once: true });
input.addEventListener("focus", render);
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

// --- explore: famous places, one tap away ---
const explore = $("explore");
const FAMOUS = [
  ["Vidhana Soudha", "landmark"],
  ["Cubbon Park", "park"],
  ["Lalbagh Botanical Gardens", "park", "Lalbagh"],
  ["Bangalore Palace", "landmark"],
  ["Ulsoor Lake", "lake"],
  ["M Chinnaswamy Stadium", "landmark", "Chinnaswamy Stadium"],
  ["City Market", "landmark", "KR Market"],
  ["UB City", "landmark"],
  ["Sankey Tank", "lake"],
  ["ISKCON Sri Radha Krishna-Chandra Temple", "landmark", "ISKCON Temple"],
  ["Koramangala", "area"],
  ["Hebbal Lake", "lake"],
];

async function fillExplore() {
  const rows = await loadIndex();
  const chips = explore.querySelector(".chips");
  for (const [name, kind, label] of FAMOUS) {
    const r = rows.find((row) => row.n === name && row.k === kind);
    if (!r) continue;
    const b = document.createElement("button");
    b.className = "chip";
    b.innerHTML = `<span class="dot ${kind}"></span>`;
    b.append(label || name);
    b.onmousedown = (e) => e.preventDefault(); // keep the input focused until the click lands
    b.onclick = () => {
      flyTo(r);
      input.blur();
      render();
    };
    chips.append(b);
  }
  render();
}

// --- help ---
const help = $("help");
let helpReturn = null;
function openHelp() {
  helpReturn = document.activeElement;
  help.hidden = false;
  $("help-close").focus();
}
function closeHelp() {
  help.hidden = true;
  helpReturn?.focus?.();
}
$("help-btn").onclick = openHelp;
$("help-close").onclick = closeHelp;
help.addEventListener("click", (e) => e.target === help && closeHelp());
help.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeHelp();
  if (e.key === "Tab") e.preventDefault(); // one button: focus stays on it
});

// --- here: the neighbourhood at the centre of the view, and a scale bar ---
const hereName = document.querySelector(".here-name");
const hereSub = document.querySelector(".here-sub");
const NEAR_KINDS = new Set(["landmark", "park", "lake", "metro"]);
const CITY_NAME = /^(bengaluru|bangalore)\b/i;
const fmtDeg = (v, pos, neg) => `${Math.abs(v).toFixed(3)}°${v >= 0 ? pos : neg}`;

async function updateHere() {
  const rows = await loadIndex();
  const c = vp().viewportToImageCoordinates(vp().getCenter(true));
  const [lat, lon] = viewToLatLon(M, cam, c.x, c.y);
  const zoomedOut = imageScale() < 0.04;
  let area = null, areaD = Infinity, near = null, nearD = Infinity;
  for (const r of rows) {
    const d = Math.hypot(r.x - M.origin[0] - c.x, r.y - M.origin[1] - c.y);
    if (r.k === "area" && d < areaD && !CITY_NAME.test(r.n)) [area, areaD] = [r, d];
    else if (NEAR_KINDS.has(r.k) && d < nearD && !CITY_NAME.test(r.n)) [near, nearD] = [r, d];
  }
  // an area name means little 2 km away, and nothing once the whole city is in view
  const inArea = !zoomedOut && area && areaD < 7000;
  hereName.textContent = inArea ? area.n : "Greater Bengaluru";
  const alt = inArea ? area.a.find((a) => /[ಀ-೿]/.test(a)) : "ಬೆಂಗಳೂರು";
  if (alt) {
    const s = document.createElement("span");
    s.className = "alt";
    s.lang = "kn";
    s.textContent = alt;
    hereName.append(s);
  }
  const bits = [];
  if (!zoomedOut && near && nearD < 2500 && near.n !== hereName.firstChild.textContent) bits.push(`near ${near.n}`);
  bits.push(`${fmtDeg(lat, "N", "S")} ${fmtDeg(lon, "E", "W")}`);
  hereSub.textContent = bits.join(" · ");
}

const NICE_M = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const scaleBar = document.querySelector(".scalebar-bar");
const scaleText = document.querySelector(".scalebar-text");
function updateScale() {
  // ground metres across one screen px, along the map's horizontal
  const mPerPx = (M.camera.metres_per_px ?? 0.293) / imageScale();
  const m = NICE_M.filter((n) => n / mPerPx <= 110).pop() ?? NICE_M[0];
  scaleBar.style.width = `${Math.round(m / mPerPx)}px`;
  scaleText.textContent = m >= 1000 ? `${m / 1000} km` : `${m} m`;
}
updateScale();

// --- compass: the map is turned, so north is not straight up ---
{
  const { lat, lon } = site.home;
  const [x0, y0] = project(cam, lat, lon, M.groundHeight);
  const [x1, y1] = project(cam, lat + 0.01, lon, M.groundHeight);
  const deg = (Math.atan2(x1 - x0, y0 - y1) * 180) / Math.PI;
  document.querySelector(".compass .needle").setAttribute("transform", `rotate(${deg.toFixed(1)} 20 20)`);
  // the N stays upright, just beyond the needle's tip
  const r = (deg * Math.PI) / 180;
  const n = document.querySelector(".compass .n");
  n.setAttribute("x", (20 + Math.sin(r) * 15.5).toFixed(1));
  n.setAttribute("y", (20 - Math.cos(r) * 15.5).toFixed(1));
}

// --- intro card: shown while the first view draws, at least briefly ---
const intro = $("intro");
const introShown = performance.now();
function hideIntro() {
  const wait = Math.max(0, 900 - (performance.now() - introShown));
  setTimeout(() => {
    intro.classList.add("gone");
    setTimeout(() => intro.remove(), 700);
  }, wait);
}
setTimeout(() => intro.isConnected && hideIntro(), 6000); // never block the map for long
