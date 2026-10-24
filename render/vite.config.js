import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  // .env and config/ live at the repo root
  envDir: resolve(import.meta.dirname, ".."),
  server: { host: "127.0.0.1", fs: { allow: [resolve(import.meta.dirname, "..")] } },
});
