// The tile bucket on Backblaze B2 is private: a browser can fetch a tile only
// with a download token in its URL (?Authorization=...). This mints one token
// for the whole bucket, valid a week, and lets Vercel's CDN hand the same token
// to every visitor for six days, so tile URLs stay the same between visits and
// come from the browser's HTTP cache.
//
// Needs B2_KEY_ID and B2_APPLICATION_KEY: a key limited to the tile bucket,
// read-only is enough. B2_BUCKET names the bucket if the key is not limited.

const WEEK = 7 * 24 * 3600;
const SHARED = 6 * 24 * 3600;

export async function GET() {
  try {
    const { B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET } = process.env;
    const auth = await b2("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
      headers: { Authorization: `Basic ${btoa(`${B2_KEY_ID}:${B2_APPLICATION_KEY}`)}` },
    });
    const api = auth.apiInfo.storageApi;
    const call = (name, body) =>
      b2(`${api.apiUrl}/b2api/v3/${name}`, {
        method: "POST",
        headers: { Authorization: auth.authorizationToken },
        body: JSON.stringify(body),
      });

    let bucketId = api.bucketId;
    if (!bucketId) {
      const { buckets } = await call("b2_list_buckets", { accountId: auth.accountId, bucketName: B2_BUCKET });
      bucketId = buckets[0]?.bucketId;
    }
    const { authorizationToken: token } = await call("b2_get_download_authorization", {
      bucketId,
      fileNamePrefix: "",
      validDurationInSeconds: WEEK,
    });

    return Response.json(
      { token },
      { headers: { "Cache-Control": `public, max-age=3600, s-maxage=${SHARED}` } },
    );
  } catch (err) {
    console.error(err);
    return Response.json({ error: "no tile token" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

async function b2(url, init) {
  const res = await fetch(url, init);
  const data = await res.json();
  if (!res.ok) throw new Error(`${url}: ${res.status} ${data.code} ${data.message}`);
  return data;
}
