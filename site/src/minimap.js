// The whole map in a corner, from the pyramid's own small level, with the
// current view as a box. Click or drag on it to move the map.
import OpenSeadragon from "openseadragon";
import { onViewChange } from "./overlay.js";

const MAX_PX = 168;

export function createMinimap(viewer, M) {
  // the largest pyramid level that fits, which is always a single tile
  let level = M.maxLevel;
  while (level > 0 && Math.max(M.width, M.height) * 2 ** (level - M.maxLevel) > MAX_PX) level--;
  const f = 2 ** (level - M.maxLevel);
  const w = Math.ceil(M.width * f);
  const h = Math.ceil(M.height * f);

  const box = document.createElement("div");
  box.className = "panel minimap";
  box.hidden = true;
  box.setAttribute("role", "img");
  box.setAttribute("aria-label", "Minimap: click or drag to move the map");
  box.innerHTML = `<img alt="" width="${w}" height="${h}" draggable="false"><div class="minimap-view"></div>`;
  box.style.width = `${w + 4}px`;
  document.body.append(box);
  const img = box.querySelector("img");
  const view = box.querySelector(".minimap-view");

  const update = onViewChange(viewer, () => {
    if (box.hidden) return;
    const b = viewer.viewport.viewportToImageRectangle(viewer.viewport.getBounds(true));
    const x0 = Math.max(0, b.x * f), y0 = Math.max(0, b.y * f);
    const x1 = Math.min(w, (b.x + b.width) * f), y1 = Math.min(h, (b.y + b.height) * f);
    view.style.transform = `translate(${x0}px, ${y0}px)`;
    view.style.width = `${Math.max(3, x1 - x0)}px`;
    view.style.height = `${Math.max(3, y1 - y0)}px`;
  });

  function panTo(e) {
    const r = img.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * M.width;
    const y = ((e.clientY - r.top) / r.height) * M.height;
    viewer.viewport.panTo(viewer.viewport.imageToViewportCoordinates(new OpenSeadragon.Point(x, y)), e.type !== "pointerdown");
  }
  box.addEventListener("pointerdown", (e) => {
    box.setPointerCapture(e.pointerId);
    panTo(e);
  });
  box.addEventListener("pointermove", (e) => {
    if (box.hasPointerCapture(e.pointerId)) panTo(e);
  });

  return {
    set(on) {
      if (on && !img.src) img.src = `${window.__SITE.tileBase}/${M.version}/tiles_files/${level}/0_0.webp`;
      box.hidden = !on;
      update();
    },
    get: () => !box.hidden,
  };
}
