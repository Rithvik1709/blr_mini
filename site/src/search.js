// Search over site/public/search.json (built by blr.search_index): English,
// Kannada and alternative names, ranked by how well the query matches.

const KIND_ORDER = { area: 0, metro: 1, station: 2, landmark: 3, park: 4, lake: 5 };
const KIND_LABEL = { area: "Area", metro: "Metro", station: "Station", landmark: "Landmark", park: "Park", lake: "Lake" };

const norm = (s) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

let index = null;

export async function loadIndex() {
  if (!index) {
    index = fetch("/search.json")
      .then((r) => r.json())
      .then((rows) => rows.map((r) => ({ ...r, keys: [r.n, ...r.a].map(norm) })));
  }
  return index;
}

// 0: a name starts with the query, 1: a word in a name does, 2: a name contains it.
function rank(keys, q) {
  let best = 3;
  for (const k of keys) {
    if (k.startsWith(q)) return 0;
    if (k.includes(" " + q)) best = Math.min(best, 1);
    else if (k.includes(q)) best = Math.min(best, 2);
  }
  return best;
}

export async function search(query, limit = 8) {
  const q = norm(query);
  if (!q) return [];
  const rows = await loadIndex();
  return rows
    .map((r) => ({ r, s: rank(r.keys, q) }))
    .filter((x) => x.s < 3)
    .sort((a, b) => a.s - b.s || KIND_ORDER[a.r.k] - KIND_ORDER[b.r.k] || a.r.n.length - b.r.n.length)
    .slice(0, limit)
    .map((x) => x.r);
}

export function kindLabel(k) {
  return KIND_LABEL[k] || k;
}
