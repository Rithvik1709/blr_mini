// Keeps things drawn over the map in step with it. A view transform maps image
// pixels to CSS pixels in the viewer: css = image * s + (x, y).
import OpenSeadragon from "openseadragon";

export function viewTransform(viewer) {
  const vp = viewer.viewport;
  const p0 = vp.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0));
  return { x: p0.x, y: p0.y, s: vp.viewportToImageZoom(vp.getZoom(true)) };
}

// Calls fn(transform) on every frame the map moves, and on resize.
export function onViewChange(viewer, fn) {
  const run = () => fn(viewTransform(viewer));
  viewer.addHandler("update-viewport", run);
  viewer.addHandler("resize", run);
  return run;
}

// An element stacked over the map at a given layer (see style.css for order).
export function addPane(viewer, tag, className) {
  const el = document.createElementNS(tag === "svg" ? "http://www.w3.org/2000/svg" : "http://www.w3.org/1999/xhtml", tag);
  el.setAttribute("class", `pane ${className}`);
  viewer.element.append(el);
  return el;
}

// Small persistent settings; storage can be missing or throw (private mode).
export const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`blr.${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`blr.${key}`, JSON.stringify(value));
    } catch {
      /* not remembered, still works */
    }
  },
};
