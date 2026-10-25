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
// a private bucket wants its token on every tile URL; the app awaits this too
site.tileQuery = "";
const token = site.tileToken
  ? fetch(site.tileToken)
      .then((r) => r.json())
      .then((d) => (d.token ? `?Authorization=${encodeURIComponent(d.token)}` : ""))
      .catch(() => "")
  : Promise.resolve("");
window.__tileQuery = token.then((q) => {
  site.tileQuery = q;
  window.__bootTiles = viewTiles(M, base, view, w, h, Math.min(2, window.devicePixelRatio || 1)).map((u) => {
    // same request the viewer will make, so it is answered from the HTTP cache
    const img = new Image();
    img.crossOrigin = "anonymous"; // as the viewer asks, so the cached copy is reused
    img.src = u + q;
    return img;
  });
  return q;
});
