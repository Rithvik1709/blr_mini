// One orthographic camera for all of Bengaluru.
//
// The camera never moves. A "shot" (i, j) is a 2048 px window of the camera
// plane, selected by offsetting the orthographic frustum by whole shots, so
// every shot lines up with its neighbours to the pixel. Shot (0, 0) has its
// top-left corner on the anchor point in config/camera.json; i grows to the
// right of the image and j grows down.
//
// Everything stays in ECEF (no group rotation): the camera matrix is the
// anchor's camera frame, which src/blr/camera.py rebuilds independently.
//
// URL params: ?export=true hides the HUD; ?shot=i,j picks the first shot;
// ?error=N overrides the tiles error target.

import { TilesRenderer, WGS84_ELLIPSOID, CAMERA_FRAME } from "3d-tiles-renderer";
import {
  CesiumIonAuthPlugin,
  GoogleCloudAuthPlugin,
  GLTFExtensionsPlugin,
  TileCompressionPlugin,
} from "3d-tiles-renderer/plugins";
import { Matrix4, MathUtils, OrthographicCamera, Scene, WebGLRenderer } from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

import cfg from "../config/camera.json";

const API_KEY = import.meta.env.VITE_GOOGLE_TILES_API_KEY;
// Google's Photorealistic 3D Tiles, streamed through Cesium ion instead of a
// Google Cloud key. Used whenever a Cesium ion token is set.
const ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN;
const ION_GOOGLE_3D_TILES = "2275207";
const params = new URLSearchParams(window.location.search);
const EXPORT = params.get("export") === "true";
const S = cfg.shot_px;
const M = cfg.metres_per_px;

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
// Holes in Google's mesh show this colour, as on tiny.london.
renderer.setClearColor(0x87ceeb);
renderer.setPixelRatio(1);
renderer.setSize(S, S);
document.body.appendChild(renderer.domElement);

const scene = new Scene();
const camera = new OrthographicCamera(0, 1, 0, -1, cfg.near_m, cfg.far_m);

const tiles = new TilesRenderer();
tiles.registerPlugin(
  ION_TOKEN
    ? new CesiumIonAuthPlugin({ apiToken: ION_TOKEN, assetId: ION_GOOGLE_3D_TILES, autoRefreshToken: true })
    : new GoogleCloudAuthPlugin({ apiToken: API_KEY, autoRefreshToken: true }),
);
tiles.registerPlugin(new TileCompressionPlugin());
tiles.registerPlugin(
  new GLTFExtensionsPlugin({
    dracoLoader: new DRACOLoader().setDecoderPath(
      "https://unpkg.com/three@0.186.1/examples/jsm/libs/draco/gltf/",
    ),
  }),
);
tiles.errorTarget = parseFloat(params.get("error")) || cfg.error_target || 20;
scene.add(tiles.group);

// The single camera: anchor frame, pulled back along its own +Z (it looks down -Z).
const D2R = MathUtils.DEG2RAD;
WGS84_ELLIPSOID.getObjectFrame(
  cfg.anchor.lat * D2R,
  cfg.anchor.lon * D2R,
  cfg.anchor.height_m,
  cfg.azimuth_deg * D2R,
  cfg.elevation_deg * D2R,
  cfg.roll_deg * D2R,
  camera.matrix,
  CAMERA_FRAME,
);
camera.matrix.multiply(new Matrix4().makeTranslation(0, 0, cfg.camera_distance_m));
camera.matrix.decompose(camera.position, camera.quaternion, camera.scale);
camera.updateMatrixWorld(true);

tiles.setCamera(camera);
tiles.setResolution(camera, S, S);

let shot = (params.get("shot") || "0,0").split(",").map(Number);

function applyShot(i, j) {
  shot = [i, j];
  camera.left = i * S * M;
  camera.right = (i + 1) * S * M;
  camera.top = -j * S * M;
  camera.bottom = -(j + 1) * S * M;
  camera.updateProjectionMatrix();
}

function busy() {
  const s = tiles.stats;
  return tiles.isLoading || s.queued + s.downloading + s.parsing > 0;
}

function frame() {
  tiles.update();
  renderer.render(scene, camera);
}

// Moves the frustum to shot (i, j) and resolves once nothing has been queued,
// downloaded or parsed for `stableFrames` frames in a row.
function setShot(i, j, { stableFrames = 20, timeoutMs = 120000 } = {}) {
  applyShot(i, j);
  const start = performance.now();
  return new Promise((resolve) => {
    let stable = 0;
    const step = () => {
      frame();
      stable = busy() ? 0 : stable + 1;
      const timedOut = performance.now() - start > timeoutMs;
      if (stable >= stableFrames || timedOut) {
        resolve({
          shot: [i, j],
          timedOut,
          failed: tiles.stats.failed,
          visible: tiles.visibleTiles.size,
          ms: performance.now() - start,
        });
      } else {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  });
}

// The root tileset only loads once update() runs, so spin until it arrives.
const rootLoaded = new Promise((resolve) => {
  let done = false;
  tiles.addEventListener("load-root-tileset", () => {
    done = true;
    resolve();
  });
  const spin = () => {
    if (done) return;
    tiles.update();
    requestAnimationFrame(spin);
  };
  spin();
});

window.BLR = {
  config: cfg,
  ready: rootLoaded,
  setShot,
  capture: () => renderer.domElement.toDataURL("image/png"),
  // Column-major camera-to-ECEF matrix, for checking camera.py against the browser.
  cameraMatrix: () => Array.from(camera.matrixWorld.elements),
  source: ION_TOKEN ? "cesium-ion" : "google",
  attributions: () => tiles.getAttributions().map((a) => a.value),
};

applyShot(...shot);

if (!EXPORT) {
  const hud = document.createElement("div");
  hud.id = "hud";
  document.body.appendChild(hud);
  window.addEventListener("keydown", (e) => {
    const n = e.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: [-n, 0], ArrowRight: [n, 0], ArrowUp: [0, -n], ArrowDown: [0, n] };
    const d = moves[e.key];
    if (d) applyShot(shot[0] + d[0], shot[1] + d[1]);
  });
  const loop = () => {
    frame();
    const s = tiles.stats;
    hud.textContent =
      `shot ${shot[0]},${shot[1]}   ${busy() ? "loading" : "ready"}\n` +
      `queued ${s.queued}  downloading ${s.downloading}  parsing ${s.parsing}  failed ${s.failed}\n` +
      `arrows: move one shot (shift: 10)`;
    requestAnimationFrame(loop);
  };
  loop();
}
