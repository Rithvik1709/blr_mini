// Inlined into index.html by vite.config.js, so it runs before the app has
// downloaded: works out the first view and starts its tiles right away.
import { makeCamera } from "./projection.js";
import { initialView, viewTiles } from "./view.js";

const M = window.__MANIFEST;
const site = window.__SITE;
const w = window.innerWidth;
const h = window.innerHeight;
const view = initialView(M, site, makeCamera(M.camera), location.hash, w, h);
const base = `${site.tileBase}/${M.version}/tiles_files`;
window.__bootView = view;
window.__bootTiles = viewTiles(M, base, view, w, h, Math.min(2, window.devicePixelRatio || 1)).map((u) => {
  // same request the viewer will make, so it is answered from the HTTP cache
  const img = new Image();
  img.crossOrigin = "anonymous"; // as the viewer asks, so the cached copy is reused
  img.src = u;
  return img;
});
