// Metro lines and GBA borders, drawn as SVG over the map (site/public/layers.json,
// built by blr.layers). Lines are in image pixels under one transform, with
// strokes that keep their screen width; labels are HTML placed each frame.
import { addPane, onViewChange } from "./overlay.js";

const SVG = "http://www.w3.org/2000/svg";

function pathData(lines, ox, oy) {
  return lines.map((pts) => "M" + pts.map(([x, y]) => `${x - ox} ${y - oy}`).join("L")).join("");
}

function path(d, cls, extra = {}) {
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", d);
  p.setAttribute("class", cls);
  for (const [k, v] of Object.entries(extra)) p.setAttribute(k, v);
  return p;
}

export function createLayers(viewer, M) {
  const svg = addPane(viewer, "svg", "layers-svg");
  const g = document.createElementNS(SVG, "g");
  svg.append(g);
  const labelPane = addPane(viewer, "div", "layers-labels");
  const groups = { metro: document.createElementNS(SVG, "g"), wards: document.createElementNS(SVG, "g") };
  g.append(groups.wards, groups.metro);
  const labels = { metro: [], wards: [] };
  const state = { metro: false, wards: false };
  let loaded = null;
  let last = null;

  function label(kind, text, x, y, cls) {
    const el = document.createElement("div");
    el.className = `map-label ${cls}`;
    el.textContent = text;
    labelPane.append(el);
    labels[kind].push({ el, x: x - M.origin[0], y: y - M.origin[1], cls });
  }

  async function load() {
    const [data, places] = await Promise.all([
      fetch("/layers.json").then((r) => r.json()),
      fetch("/search.json").then((r) => r.json()),
    ]);
    const [ox, oy] = M.origin;
    for (const line of data.metro) {
      for (const tunnel of [false, true]) {
        const d = pathData(line.segments.filter((s) => s.tunnel === tunnel).map((s) => s.pts), ox, oy);
        if (!d) continue;
        groups.metro.append(path(d, `metro-casing${tunnel ? " tunnel" : ""}`));
        groups.metro.append(path(d, `metro-line${tunnel ? " tunnel" : ""}`, { stroke: line.colour }));
      }
    }
    for (const p of places.filter((p) => p.k === "metro")) {
      label("metro", p.n.replace(/ (Station|Stn\.),?/, ","), p.x, p.y, "station");
    }
    groups.wards.append(path(pathData(data.wards.lines, ox, oy), "ward-casing"));
    groups.wards.append(path(pathData(data.wards.lines, ox, oy), "ward-line"));
    groups.wards.append(path(pathData(data.corporations.lines, ox, oy), "corp-casing"));
    groups.wards.append(path(pathData(data.corporations.lines, ox, oy), "corp-line"));
    for (const l of data.wards.labels) label("wards", l.n, l.x, l.y, "ward");
    for (const l of data.corporations.labels) label("wards", l.n, l.x, l.y, "corp");
  }

  const update = onViewChange(viewer, (t) => {
    last = t;
    if (!state.metro && !state.wards) return;
    g.setAttribute("transform", `matrix(${t.s} 0 0 ${t.s} ${t.x} ${t.y})`);
    for (const kind of ["metro", "wards"]) {
      for (const l of labels[kind]) {
        // ward names only once they are big enough to mean something
        const shown = state[kind] && (l.cls === "corp" ? t.s < 0.3 : l.cls === "ward" ? t.s >= 0.06 : t.s >= 0.08);
        l.el.hidden = !shown;
        if (shown) l.el.style.transform = `translate(${l.x * t.s + t.x}px, ${l.y * t.s + t.y}px) translate(-50%, -50%)`;
      }
    }
  });

  return {
    async set(kind, on) {
      state[kind] = on;
      if (on && !loaded) loaded = load();
      if (on) await loaded;
      groups[kind].style.display = on ? "" : "none";
      for (const l of labels[kind]) l.el.hidden = !on;
      if (last) update();
    },
    get: (kind) => state[kind],
  };
}
