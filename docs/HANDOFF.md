# Handoff: where tiny.blr stands and what is next

Last updated 2026-10-24. Read this first in a new session; the README covers how each tool works.

## Where things stand

- **The whole city is rendered.** `runs/city/shots/` holds 1,817 shots (2048 px, about 19 GB, not in git) covering the GBA boundary (`data/gba.geojson`, the five city corporations) plus a 3,072 px band. Imagery: Google Photorealistic 3D Tiles via Cesium ion (token in `.env` as `CESIUM_ION_TOKEN` / `VITE_CESIUM_ION_TOKEN`), credited "Google; Airbus".
- **Tiles are built locally.** `site/public/tiles/city1/` has 58,746 WebP tiles over 18 levels (2.47 GB). Only the images (`tiles_files/`) are git-ignored; `current.json`, manifests, `.dzi` files and `search.json` are tracked.
- **The site works locally** (`cd site && bun run dev`, http://127.0.0.1:5180): search (2,285 places, English and Kannada), metro lines and GBA wards, minimap, live weather and time of day, clouds round the city.
- **Vercel builds and serves the site, but the map is empty there**, because the tile images are not hosted anywhere public yet. `vercel.json` deploys `site/` only.
- **Not done:** the pixel-art step. `blr.teacher` is built and tested offline but has never called Gemini (no `GEMINI_API_KEY` or `OPENROUTER_API_KEY` yet). The live site shows the photoreal render.

## Next step: host the tiles on Cloudflare R2

Vercel cannot take the tiles (Hobby: 100 MB and 15,000 files per upload; the tiles are 2.5 GB and 58,746 files). R2 is built for this: 10 GB free and no egress fees.

1. **Bucket (in the Cloudflare dashboard):** R2 → create a bucket, e.g. `blr-tiles`, and enable its public **r2.dev** URL under the bucket's settings.
2. **API token:** R2 → Manage API tokens → Object Read & Write on that bucket. Put these in `.env` (never paste them into chat):
   ```
   R2_ACCOUNT_ID=""
   R2_ACCESS_KEY_ID=""
   R2_SECRET_ACCESS_KEY=""
   R2_BUCKET="blr-tiles"
   ```
3. **Upload** `site/public/tiles/city1/tiles_files/` to `<bucket>/city1/tiles_files/` with `rclone` (S3-compatible endpoint `https://<account_id>.r2.cloudflarestorage.com`, parallel transfers). Expect 15-40 minutes depending on upload speed. Set `Cache-Control: public, max-age=31536000, immutable` on the objects.
4. **CORS on the bucket:** allow GET from the Vercel domain (`https://blrmini-7yoj.vercel.app` and any custom domain). The viewer requests tiles with `crossOrigin = "anonymous"` because WebGL cannot draw cross-origin images without CORS.
5. **Vercel:** Project → Settings → Environment Variables → `TILE_BASE=https://<bucket>.r2.dev` (the URL whose path then continues `/city1/tiles_files/...`), then redeploy. `site/vite.config.js` bakes it into the page at build time.
6. **Check:** the minimap shows the city and the map draws; the browser console has no CORS errors.

## Before making it public: licensing

The tiles are renders of Google Photorealistic 3D Tiles. Google Maps Platform terms forbid storing or redistributing their content and creating content from it, and Cesium ion passes those terms on. Serving the stored render on a public site very likely breaches them and could get the Cesium or Google account flagged. tiny.london published a pixel-art redrawing (via the teacher step), not the photoreal render. Options: keep the deploy private or password-protected, or publish only once the pixel-art tiles exist.

## Prompt to continue in a new session

> Read docs/HANDOFF.md and README.md in this repo. The whole of Bengaluru is rendered and the site works locally; the Vercel deploy is empty because the tile images are not hosted. I have created the R2 bucket and put the R2 credentials in .env. Upload site/public/tiles/city1/tiles_files/ to R2 with rclone, set CORS for the Vercel domain and long cache headers, tell me the TILE_BASE value to set in Vercel, and verify the deployed site draws the map.

## Working preferences learned in this project

- Run long renders in 10-minute sessions with cool-down breaks; 4 workers (6 ran the 16 GB Mac out of memory and was slower). Resume with `uv run python -m blr.render runs/city --workers 4`.
- Report progress every 100 shots when rendering.
- Ask before deleting anything; the 19 GB of shots are kept for rebuilding tiles and for the pixel-art step.
- Commits use a `Co-authored-by:` trailer at column 0 of the last paragraph. Avatars appear only if the email belongs to a GitHub account; the `<id>+<login>@users.noreply.github.com` form always does.
