// View maths shared by the inline boot script and the app. No imports beyond
// projection.js, so vite.config.js can inline it.
import { project, unproject } from "./projection.js";

// URL hash: #lat,lon,scale where scale is screen px per map px (1 = 1:1).
export function parseHash(hash) {
  const m = /^#?(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)x?$/.exec(hash || "");
  return m ? { lat: +m[1], lon: +m[2], scale: +m[3] } : null;
}

export function formatHash(lat, lon, scale) {
  return `#${lat.toFixed(5)},${lon.toFixed(5)},${scale >= 1 ? scale.toFixed(2) : scale.toPrecision(2)}`;
}

// Smallest scale at which the whole map fits the window.
export function fitScale(M, w, h) {
  return Math.min(w / M.width, h / M.height);
}

export function clampScale(M, site, scale, w, h) {
  // room to zoom out past the edge, into the clouds
  return Math.min(site.maxScale, Math.max(fitScale(M, w, h) * 0.4, scale));
}

// {x, y} in image px and scale, from the hash or else the configured home.
export function initialView(M, site, cam, hash, w, h) {
  const v = parseHash(hash) || site.home;
  const [cx, cy] = project(cam, v.lat, v.lon, M.groundHeight);
  return { x: cx - M.origin[0], y: cy - M.origin[1], scale: clampScale(M, site, v.scale, w, h) };
}

export function viewToLatLon(M, cam, x, y) {
  return unproject(cam, x + M.origin[0], y + M.origin[1], M.groundHeight);
}

// The sharpest level OpenSeadragon will draw at this many device px per map px
// (it stops at half a screen pixel per level pixel).
export function bootLevel(M, devicePxPerMapPx) {
  return Math.max(0, Math.min(M.maxLevel, Math.floor(M.maxLevel + Math.log2(2 * devicePxPerMapPx) + 1e-9)));
}

// Tile URLs covering a w x h window centred on view at the boot level.
export function viewTiles(M, base, view, w, h, dpr) {
  const level = bootLevel(M, view.scale * dpr);
  const f = 2 ** (level - M.maxLevel);
  const cols = Math.ceil((M.width * f) / M.tileSize);
  const rows = Math.ceil((M.height * f) / M.tileSize);
  const idx = (px, n) => Math.max(0, Math.min(n - 1, Math.floor((px * f) / M.tileSize)));
  const urls = [];
  for (let r = idx(view.y - h / 2 / view.scale, rows); r <= idx(view.y + h / 2 / view.scale, rows); r++)
    for (let c = idx(view.x - w / 2 / view.scale, cols); c <= idx(view.x + w / 2 / view.scale, cols); c++)
      urls.push(`${base}/${level}/${c}_${r}.webp`);
  return urls;
}
