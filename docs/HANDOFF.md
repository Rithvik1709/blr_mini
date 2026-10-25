# Handoff: where tiny.blr stands and what is next

Last updated 2026-10-24. Read this first in a new session; the README covers how each tool works.

## Where things stand

- **The whole city is rendered.** `runs/city/shots/` holds 1,817 shots (2048 px, about 19 GB, not in git) covering the GBA boundary (`data/gba.geojson`, the five city corporations) plus a 3,072 px band. Imagery: Google Photorealistic 3D Tiles via Cesium ion (token in `.env` as `CESIUM_ION_TOKEN` / `VITE_CESIUM_ION_TOKEN`), credited "Google; Airbus".
- **Tiles are built locally.** `site/public/tiles/city1/` has 58,746 WebP tiles over 18 levels (2.47 GB). Only the images (`tiles_files/`) are git-ignored; `current.json`, manifests, `.dzi` files and `search.json` are tracked.
- **The site works locally** (`cd site && bun run dev`, http://127.0.0.1:5180): search (2,285 places, English and Kannada), metro lines and GBA wards, minimap, live weather and time of day, clouds round the city.
- **Tile images are hosted on Backblaze B2**, in the private bucket `Tinyblr` (region us-east-005) under `city1/tiles_files/`. Vercel serves the site (`vercel.json` deploys `site/` only) and `site/api/tile-token.js`, which gives browsers the download token a private bucket needs.
- **Not done:** the pixel-art step. `blr.teacher` is built and tested offline but has never called Gemini (no `GEMINI_API_KEY` or `OPENROUTER_API_KEY` yet). The live site shows the photoreal render.

## How tile hosting works (Backblaze B2)

Vercel cannot take the tiles (Hobby: 100 MB and 15,000 files per upload; the tiles are 2.5 GB and 58,746 files). B2 gives 10 GB free. A public bucket needs a card on file, so the bucket is private and tiles are fetched with a download token:

- `site/api/tile-token.js` (a Vercel function) mints a 7-day token for the whole bucket. Vercel's CDN caches the response for 6 days, so visitors share one token and tile URLs stay the same between visits.
- When the build has `B2_KEY_ID`, `site/vite.config.js` sets `site.tileToken`; the boot script fetches the token before the first tiles, and every tile URL (viewer, boot prefetch, minimap) ends in `?Authorization=<token>`. Without it (local dev) tiles come from `/tiles` as before.
- **Vercel environment variables:** `TILE_BASE=https://f005.backblazeb2.com/file/Tinyblr`, `B2_KEY_ID`, `B2_APPLICATION_KEY` (a Read Only key limited to `Tinyblr`), optionally `B2_BUCKET=Tinyblr`.
- **CORS on the bucket** (set through the B2 API, `b2_update_bucket`) allows `https://blrmini.vercel.app`, `https://blrmini-*.vercel.app` and local `127.0.0.1:5180/5181`. Add any custom domain there. The viewer needs CORS because WebGL cannot draw cross-origin images without it.
- **Uploading a new tile version:** with a Read and Write key in `.env` (`B2_KEY_ID`, `B2_APPLICATION_KEY`):
  ```
  set -a; source .env; set +a
  export RCLONE_CONFIG_B2_TYPE=b2 RCLONE_CONFIG_B2_ACCOUNT="$B2_KEY_ID" RCLONE_CONFIG_B2_KEY="$B2_APPLICATION_KEY"
  rclone copy site/public/tiles/<version>/tiles_files b2:Tinyblr/<version>/tiles_files \
    --header-upload "X-Bz-Info-b2-cache-control: public%2C%20max-age%3D31536000%2C%20immutable" \
    --transfers 32 --checkers 16 --fast-list --retries 5
  ```
  B2 takes `Cache-Control` as the file info `b2-cache-control`, and its value must be percent-encoded.
- **Check:** the minimap shows the city and the map draws; the browser console has no CORS or 401 errors.

## Before making it public: licensing

The tiles are renders of Google Photorealistic 3D Tiles. Google Maps Platform terms forbid storing or redistributing their content and creating content from it, and Cesium ion passes those terms on. Serving the stored render on a public site very likely breaches them and could get the Cesium or Google account flagged. tiny.london published a pixel-art redrawing (via the teacher step), not the photoreal render. Options: keep the deploy private or password-protected, or publish only once the pixel-art tiles exist.

## Prompt to continue in a new session

> Read docs/HANDOFF.md and README.md in this repo. The whole of Bengaluru is rendered, the tiles are on Backblaze B2 (private bucket `Tinyblr`) and the Vercel site fetches them with a token from site/api/tile-token.js. Check the deployed site draws the map, then pick up the next open item (the pixel-art step or licensing).

## Working preferences learned in this project

- Run long renders in 10-minute sessions with cool-down breaks; 4 workers (6 ran the 16 GB Mac out of memory and was slower). Resume with `uv run python -m blr.render runs/city --workers 4`.
- Report progress every 100 shots when rendering.
- Ask before deleting anything; the 19 GB of shots are kept for rebuilding tiles and for the pixel-art step.
- Commits use a `Co-authored-by:` trailer at column 0 of the last paragraph. Avatars appear only if the email belongs to a GitHub account; the `<id>+<login>@users.noreply.github.com` form always does.
