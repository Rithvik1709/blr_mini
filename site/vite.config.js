import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const here = (p) => resolve(import.meta.dirname, p);

// Inline the map manifest, site config and the boot script (projection.js +
// view.js + boot.js, imports and exports stripped) into index.html, so the
// first view's tiles start downloading before any JavaScript bundle arrives.
function inlineBoot() {
  return {
    name: "inline-boot",
    transformIndexHtml(html) {
      const { version } = JSON.parse(readFileSync(here("public/tiles/current.json"), "utf8"));
      const manifest = readFileSync(here(`public/tiles/${version}/manifest.json`), "utf8");
      const site = readFileSync(here("site.config.json"), "utf8");
      const strip = (f) =>
        readFileSync(here(f), "utf8")
          .replace(/^import .*$/gm, "")
          .replace(/^export /gm, "");
      const code = ["src/projection.js", "src/view.js", "src/boot.js"].map(strip).join("\n");
      const script =
        `<script>window.__MANIFEST=${JSON.stringify(JSON.parse(manifest))};` +
        `window.__SITE=${JSON.stringify(JSON.parse(site))};` +
        `(()=>{${code}})();</script>`;
      return html.replace("<!-- boot -->", script);
    },
  };
}

export default defineConfig({
  plugins: [inlineBoot()],
  // render/ (the renderer) uses vite's default 5173; the site gets its own port
  server: { host: "127.0.0.1", port: 5180, strictPort: true },
  preview: { host: "127.0.0.1", port: 5181, strictPort: true },
});
