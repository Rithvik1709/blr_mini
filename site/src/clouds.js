// Clouds round the city (site/public/clouds/, built by blr.clouds). The field
// is 0 over the city and rises to 1 far outside it; the shader adds drifting
// puffs (cell noise) only where the field is above 0, so no cloud can ever
// appear over the city. Clouds are drawn as chunky pixels anchored to the map,
// with an outline and three tones lit from the top left.
import { addPane, onViewChange } from "./overlay.js";

const VERT = `#version 300 es
in vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_field;
uniform vec4 u_rect;      // field: x, y, width, height in image px
uniform vec4 u_image;     // the map: x, y, width, height in image px
uniform vec3 u_view;      // css px of image (0,0), css px per image px
uniform vec2 u_res;       // canvas px
uniform float u_ratio;    // canvas px per css px
uniform float u_q;        // cloud pixel size in image px
uniform float u_size;     // big puff size in image px
uniform float u_time;
uniform float u_threshold;
out vec4 o;

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
// round puffs: 1 at a puff's centre, 0 between puffs
float cells(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  float d = 8.0;
  for (int y = -1; y <= 1; y++)
    for (int k = -1; k <= 1; k++) {
      vec2 g = vec2(float(k), float(y));
      vec2 r = g + hash2(i + g) * 0.7 + 0.15 - f;
      d = min(d, dot(r, r));
    }
  return 1.0 - smoothstep(0.1, 0.95, sqrt(d));
}
float puffs(vec2 p) {
  vec2 drift = vec2(u_time * 9.0, u_time * 3.0);
  return 0.65 * cells((p + drift) / u_size) + 0.35 * cells((p + drift * 1.5) / (u_size * 0.42) + 31.0);
}
// smooth value noise, for pushing the cloud front in and out
float vnoise(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i).x, hash2(i + vec2(1.0, 0.0)).x, f.x), mix(hash2(i + vec2(0.0, 1.0)).x, hash2(i + vec2(1.0)).x, f.x), f.y);
}
float field(vec2 p) {
  vec2 uv = (p - u_rect.xy) / u_rect.zw;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 1.0;
  return texture(u_field, uv).r;
}
float cover(vec2 p) {
  float f = field(p);
  if (f <= 0.0) return -1.0;
  // the field sets where clouds may be; large-scale noise moves the front so it
  // runs parallel to nothing, and puffs make its edge bumpy
  vec2 drift = vec2(u_time * 4.0, u_time * 1.5);
  float front = vnoise((p + drift) / (u_size * 1.7)) * 0.65 + vnoise((p + drift) / (u_size * 0.8) + 7.0) * 0.35;
  float c = f * 1.5 + ((front - 0.5) * 0.3 + (puffs(p) - 0.5) * 0.2) * smoothstep(0.0, 0.03, f);
  vec2 d = max(u_image.xy - p, p - (u_image.xy + u_image.zw));
  if (max(d.x, d.y) > 0.0) c = max(c, u_threshold + 0.02);
  return c;
}
void main() {
  vec2 css = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y) / u_ratio;
  vec2 p = (floor((css - u_view.xy) / u_view.z / u_q) + 0.5) * u_q;
  float c = cover(p);
  float t = u_threshold;
  if (c < t) { o = vec4(0.0); return; }
  vec3 line = vec3(0.13, 0.18, 0.26);
  vec3 light = vec3(0.96, 0.975, 0.985), mid = vec3(0.84, 0.885, 0.925), shade = vec3(0.67, 0.75, 0.83);
  if (c < t + 0.25 && (cover(p + vec2(u_q, 0.0)) < t || cover(p - vec2(u_q, 0.0)) < t ||
                       cover(p + vec2(0.0, u_q)) < t || cover(p - vec2(0.0, u_q)) < t)) {
    o = vec4(line, 1.0);
    return;
  }
  // which way is the cloud's inside? rims facing the top left are lit, the rest shaded
  float e = max(u_q, u_size * 0.06);
  vec2 g = vec2(cover(p + vec2(e, 0.0)) - cover(p - vec2(e, 0.0)), cover(p + vec2(0.0, e)) - cover(p - vec2(0.0, e)));
  float facing = dot(normalize(g + 1e-6), vec2(0.7071));
  float depth = c - t;
  // rims: lit towards the top left, shaded away from it; inside, puffs in two tones
  vec3 col;
  if (depth < 0.07) col = facing > -0.2 ? light : shade;
  else col = puffs(p * 1.3 + 50.0) > 0.3 ? light : mid;
  o = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export function createClouds(viewer, M) {
  const canvas = addPane(viewer, "canvas", "clouds");
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, antialias: false });
  if (!gl) return { set() {}, get: () => false };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let on = false;
  let ready = null;
  let meta = null;
  let fieldPx = null; // the field's bytes, to tell on the CPU whether any cloud is in view
  let view = null;
  let raf = 0;
  let lastFrame = 0;
  const start = performance.now();

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = (n) => gl.getUniformLocation(prog, n);

  async function load() {
    meta = await fetch("/clouds/clouds.json").then((r) => r.json());
    const img = new Image();
    img.src = "/clouds/field.png";
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    fieldPx = ctx.getImageData(0, 0, c.width, c.height).data;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, img.width, img.height, 0, gl.RED, gl.UNSIGNED_BYTE, toRed(fieldPx));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  function toRed(rgba) {
    const r = new Uint8Array(rgba.length / 4);
    for (let i = 0; i < r.length; i++) r[i] = rgba[i * 4];
    return r;
  }

  // Is any of the window (plus a little) outside the clear city? Sampled on a grid.
  function cloudsInView(t) {
    const w = window.innerWidth, h = window.innerHeight;
    for (let gy = -1; gy <= 9; gy++)
      for (let gx = -1; gx <= 9; gx++) {
        const ix = ((gx / 8) * w - t.x) / t.s + M.origin[0];
        const iy = ((gy / 8) * h - t.y) / t.s + M.origin[1];
        const fx = Math.floor((ix - meta.x) / meta.scale), fy = Math.floor((iy - meta.y) / meta.scale);
        if (fx < 0 || fy < 0 || fx >= meta.width || fy >= meta.height) return true;
        if (fieldPx[(fy * meta.width + fx) * 4] > 0) return true;
      }
    return false;
  }

  function draw() {
    if (!on || !meta || !view) return;
    const visible = cloudsInView(view);
    canvas.hidden = !visible;
    if (!visible) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.round(window.innerWidth * ratio), h = Math.round(window.innerHeight * ratio);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    // view in image px of the whole canvas (origin offset folded in)
    gl.uniform4f(u("u_rect"), meta.x - M.origin[0], meta.y - M.origin[1], meta.width * meta.scale, meta.height * meta.scale);
    gl.uniform3f(u("u_view"), view.x, view.y, view.s);
    gl.uniform2f(u("u_res"), w, h);
    gl.uniform1f(u("u_ratio"), ratio);
    // cloud pixels 3-6 css px across at every zoom, on a grid fixed to the map
    gl.uniform1f(u("u_q"), 2 ** Math.ceil(Math.log2(3 / view.s)));
    gl.uniform1f(u("u_time"), reduced.matches ? 0 : (performance.now() - start) / 1000);
    gl.uniform1f(u("u_threshold"), meta.threshold);
    const [ix, iy, iw, ih] = meta.image;
    gl.uniform4f(u("u_image"), ix - M.origin[0], iy - M.origin[1], iw, ih);
    gl.uniform1f(u("u_size"), meta.margin * 0.3);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (!reduced.matches && !raf) raf = requestAnimationFrame(tick);
  }

  // drift at 15 frames a second, only while clouds are on screen
  function tick(t) {
    raf = 0;
    if (!on || canvas.hidden || document.hidden) return;
    if (t - lastFrame >= 66) {
      lastFrame = t;
      draw();
    } else {
      raf = requestAnimationFrame(tick);
    }
  }

  onViewChange(viewer, (t) => {
    view = t;
    draw();
  });

  return {
    async set(v) {
      on = v;
      canvas.hidden = !v;
      if (v && !ready) ready = load();
      if (v) await ready;
      draw();
    },
    get: () => on,
  };
}
