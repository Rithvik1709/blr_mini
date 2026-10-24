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

const ICONS = {
  clear: '<path d="M6 1h2v2H6zM6 11h2v2H6zM1 6h2v2H1zM11 6h2v2h-2zM5 4h4v1h1v4H9v1H5V9H4V5h1z"/>',
  night: '<path d="M5 2h3v1H6v1H5v4h1v1h1v1h4v1h-1v1H5v-1H4v-1H3V8H2V5h1V4h1V3h1z"/>',
  cloud: '<path d="M5 4h3v1h1v1h2v1h1v3H1V8h1V7h1V5h2z"/>',
  rain: '<path d="M5 2h3v1h1v1h2v1h1v3H1V6h1V5h1V3h2zM3 10h1v2H3zM6 10h1v2H6zM9 10h1v2H9z"/>',
  storm: '<path d="M5 2h3v1h1v1h2v1h1v3H1V6h1V5h1V3h2zM6 9h2v1H7v1h2v1H8v1H6v-1h1v-1H5v-1h1z"/>',
  fog: '<path d="M2 3h9v1H2zM3 6h9v1H3zM1 9h9v1H1zM4 12h7v1H4z"/>',
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
