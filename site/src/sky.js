// Bengaluru's weather and time of day: a small widget, a tint over the map for
// dawn, evening, dusk and night, a haze for fog and overcast, and pixel rain.
// Weather comes from Open-Meteo (free, no key), refreshed every 10 minutes.
import { addPane, prefs } from "./overlay.js";

const URL_ =
  "https://api.open-meteo.com/v1/forecast?latitude=12.9716&longitude=77.5946" +
  "&current=weather_code,temperature_2m&daily=sunrise,sunset&timezone=Asia%2FKolkata&forecast_days=1";
const TZ = "Asia/Kolkata";
const MIN = 60e3;

// WMO weather code -> label, icon, rain 0..1, haze 0..1
function weather(code) {
  if (code === 0) return ["Clear", "clear", 0, 0];
  if (code === 1) return ["Mostly clear", "clear", 0, 0];
  if (code === 2) return ["Partly cloudy", "cloud", 0, 0.05];
  if (code === 3) return ["Overcast", "cloud", 0, 0.14];
  if (code === 45 || code === 48) return ["Fog", "fog", 0, 0.38];
  if (code >= 51 && code <= 57) return ["Drizzle", "rain", 0.25, 0.12];
  if (code === 61 || code === 80) return ["Light rain", "rain", 0.4, 0.14];
  if (code === 63 || code === 66 || code === 81) return ["Rain", "rain", 0.65, 0.16];
  if (code === 65 || code === 67 || code === 82) return ["Heavy rain", "rain", 1, 0.2];
  if (code >= 71 && code <= 86) return ["Snow", "cloud", 0, 0.2];
  if (code >= 95) return ["Thunderstorm", "storm", 0.9, 0.22];
  return ["", "cloud", 0, 0];
}

// Time of day from the day's sunrise and sunset (ms), and its tint (multiply).
function phase(now, rise, set) {
  if (now < rise - 30 * MIN || now > set + 40 * MIN) return ["Night", "rgb(98, 112, 170)"];
  if (now < rise + 40 * MIN) return ["Dawn", "rgb(255, 214, 196)"];
  if (now > set) return ["Dusk", "rgb(222, 168, 168)"];
  if (now > set - 60 * MIN) return ["Evening", "rgb(255, 226, 186)"];
  return ["Day", null];
}

const CLOUD = '<path d="M7 15h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 6.6 4.2 4.2 0 0 0 7 15z"/>';
const ICONS = {
  clear: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  night: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 9.6 4.2 4.2 0 0 0 7 18z"/>',
  rain: `${CLOUD}<path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>`,
  storm: `${CLOUD}<path d="M12.5 15l-2 4h3l-2 4"/>`,
  fog: '<path d="M4 8h13M6 12h14M3 16h13M7 20h10"/>',
};

const fmtTime = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const istMs = (s) => Date.parse(`${s}:00+05:30`);

export function createSky(viewer) {
  const tint = addPane(viewer, "div", "sky-tint");
  const haze = addPane(viewer, "div", "sky-haze");
  const rain = addPane(viewer, "canvas", "sky-rain");
  const widget = document.querySelector(".sky");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let data = null;
  let on = false;
  let drops = [];
  let raf = 0;
  let lastFrame = 0;
  let intensity = 0;

  async function fetchSky() {
    const cached = prefs.get("skyData", null);
    if (cached && typeof cached.at === "number" && Date.now() - cached.at < 10 * MIN) return cached;
    const j = await fetch(URL_).then((r) => r.json());
    const fresh = {
      at: Date.now(),
      code: j.current.weather_code,
      temp: j.current.temperature_2m,
      rise: istMs(j.daily.sunrise[0]),
      set: istMs(j.daily.sunset[0]),
    };
    prefs.set("skyData", fresh);
    return fresh;
  }

  function render() {
    const now = Date.now();
    const [label, icon, rainAmt, hazeAmt] = data ? weather(data.code) : ["", "cloud", 0, 0];
    const [part, colour] = data ? phase(now, data.rise, data.set) : ["", null];
    const night = part === "Night";
    const shownIcon = icon === "clear" && night ? "night" : icon;
    widget.querySelector(".sky-icon").innerHTML = ICONS[shownIcon];
    widget.querySelector(".sky-time").textContent =
      fmtTime.format(now) + (data ? ` · ${Math.round(data.temp)}°C` : "");
    widget.querySelector(".sky-text").textContent = data ? `${label} · ${part}` : "Bengaluru";
    const sun = widget.querySelector(".sun");
    if (data) {
      // 0 at sunrise, 1 at sunset; the dot rests at an end through the night
      const t = Math.min(1, Math.max(0, (now - data.rise) / (data.set - data.rise)));
      sun.style.setProperty("--sun", t.toFixed(3));
      sun.classList.toggle("night", night);
      sun.querySelector(".sun-rise").textContent = `↑ ${fmtTime.format(data.rise)}`;
      sun.querySelector(".sun-set").textContent = `${fmtTime.format(data.set)} ↓`;
      sun.hidden = false;
    }
    widget.hidden = false;

    tint.style.background = on && colour ? colour : "transparent";
    haze.style.opacity = on ? String(hazeAmt) : "0";
    intensity = on && !reduced.matches ? rainAmt : 0;
    rain.hidden = intensity === 0;
    if (intensity && !raf) raf = requestAnimationFrame(tick);
  }

  function resize() {
    rain.width = Math.ceil(window.innerWidth / 2);
    rain.height = Math.ceil(window.innerHeight / 2);
    const n = Math.round((rain.width * rain.height) / 900);
    drops = Array.from({ length: n }, () => ({
      x: Math.random() * rain.width,
      y: Math.random() * rain.height,
      v: 7 + Math.random() * 5,
      l: 3 + Math.floor(Math.random() * 4),
    }));
  }

  // pixel rain at half resolution, 30 frames a second, only while it rains
  function tick(t) {
    raf = 0;
    if (!intensity || document.hidden) return;
    raf = requestAnimationFrame(tick);
    if (t - lastFrame < 33) return;
    lastFrame = t;
    const ctx = rain.getContext("2d");
    ctx.clearRect(0, 0, rain.width, rain.height);
    ctx.fillStyle = "rgba(214, 228, 240, 0.55)";
    const count = Math.round(drops.length * intensity);
    for (let i = 0; i < count; i++) {
      const d = drops[i];
      d.y += d.v;
      d.x -= d.v * 0.25;
      if (d.y > rain.height) {
        d.y = -d.l;
        d.x = Math.random() * (rain.width + 40);
      }
      for (let k = 0; k < d.l; k++) ctx.fillRect(Math.round(d.x + k * 0.25), Math.round(d.y - k), 1, 1);
    }
  }

  resize();
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", () => !document.hidden && render());
  reduced.addEventListener?.("change", render);
  const refresh = () =>
    fetchSky()
      .then((d) => (data = d))
      .catch(() => {})
      .finally(render);
  refresh();
  setInterval(refresh, 10 * MIN);
  setInterval(render, 15e3);
  widget.addEventListener("click", () => document.dispatchEvent(new CustomEvent("toggle-setting", { detail: "sky" })));

  return {
    set(v) {
      on = v;
      render();
    },
    get: () => on,
  };
}
