import { Context, Hono } from "hono";

import { getOrigin, isBot } from "../utils/bot.js";
import { instagramCache } from "../utils/cache.js";
import { buildEmbedHtml, buildOEmbed } from "../utils/html.js";
import { createMosaic } from "../utils/image.js";

const INSTA_COLOR = "#E1306C";

interface InstaMedia { typeName: string; url: string; thumbnailUrl?: string; }
interface InstaData { postId: string; username: string; caption: string; medias: InstaMedia[]; }

const INSTAGRAM_MIRRORS = [
  "instafix.thororen.com",
  "kkinstagram.com",
  "vxinstagram.com",
  "eeinstagram.com",
  "uuinstagram.com",
];

function extractFromContextJSON(html: string): any {
  const initMatch = html.match(/"init",\[\],\[(.*?)\]\],/);
  if (!initMatch) return null;
  try {
    const item = JSON.parse(initMatch[1]);
    if (!item?.contextJSON) return null;
    const ctx = JSON.parse(item.contextJSON);
    const gqlData = ctx?.gql_data;
    if (!gqlData) return null;
    return gqlData.shortcode_media ?? gqlData.xdt_shortcode_media ?? null;
  } catch { return null; }
}

function parseGqlItem(item: any, postId: string): InstaData | null {
  if (!item) return null;

  const username = item.owner?.username ?? item.user?.username ?? "";
  const caption = item.edge_media_to_caption?.edges?.[0]?.node?.text ?? item.caption?.text ?? "";

  const medias: InstaMedia[] = [];
  const sidecar = item.edge_sidecar_to_children?.edges;

  const nodes = sidecar?.length ? sidecar.map((e: any) => e.node) : [item];

  for (const node of nodes) {
    const videoUrl = node.video_url;
    const displayUrl = node.display_url;
    const typeName = node.__typename ?? (videoUrl ? "GraphVideo" : "GraphImage");

    medias.push({
      typeName,
      url: videoUrl ?? displayUrl ?? "",
      thumbnailUrl: videoUrl ? displayUrl : undefined,
    });
  }

  if (!medias.length) return null;
  return { postId, username, caption, medias };
}

async function scrapeFromEmbed(postId: string): Promise<InstaData | null> {
  try {
    const res = await fetch(`https://www.instagram.com/p/${postId}/embed/captioned/`, {
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
    });
    if (!res.ok) return null;
    const html = await res.text();

    const gqlItem = extractFromContextJSON(html);
    if (gqlItem) {
      const parsed = parseGqlItem(gqlItem, postId);
      if (parsed) return parsed;
    }

    const usernameMatch = html.match(/class="UsernameText"[^>]*>([^<]+)/);
    const captionMatch = html.match(/class="Caption"[^>]*>([\s\S]*?)<\/div>/);

    const username = usernameMatch?.[1]?.trim() ?? "";
    let caption = (captionMatch?.[1] ?? "").replace(/<[^>]+>/g, "").trim();

    if (username && caption.startsWith(username)) caption = caption.slice(username.length).trim();
    caption = caption.replace(/View all \d+ comments|Add a comment\.\.\.$/i, "").trim();

    const isVideo = html.includes("EmbeddedMediaVideo");
    const mediaMatch = isVideo
      ? html.match(/class="EmbeddedMediaVideo"[^>]*src="([^"]+)"/)
      : html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/);

    if (!mediaMatch || !username) return null;

    const thumbnailMatch = isVideo ? html.match(/poster="([^"]+)"/) : null;

    return {
      postId,
      username,
      caption,
      medias: [{
        typeName: isVideo ? "GraphVideo" : "GraphImage",
        url: mediaMatch[1].replace(/&amp;/g, "&"),
        thumbnailUrl: thumbnailMatch?.[1]?.replace(/&amp;/g, "&")
      }]
    };
  } catch { return null; }
}

async function scrapeFromMirror(postId: string): Promise<InstaData | null> {
  const ua = "TelegramBot (like TwitterBot)";

  for (const mirror of INSTAGRAM_MIRRORS) {
    try {
      const medias: InstaMedia[] = [];
      let username = "";
      let caption = "";
      let lastMediaUrl = "";

      for (let n = 1; n <= 10; n++) {
        const res = await fetch(`https://${mirror}/p/${postId}/${n}`, { headers: { "User-Agent": ua } });
        if (!res.ok) break;
        const html = await res.text();
        if (!html.trim()) break;

        if (n === 1) {
          const titleMatch = html.match(/<meta\s+(?:property|name)="(?:og:title|twitter:title)"\s+content="([^"]*)"/);
          if (titleMatch) {
            const t = titleMatch[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
            const candidate = t.replace(/^@/, "").split(" (")[0];
            if (!INSTAGRAM_MIRRORS.some(m => m.split(".")[0] === candidate.toLowerCase())) {
              username = candidate;
            }
          }
          const descMatch = html.match(/<meta\s+(?:property|name)="og:description"\s+content="([^"]*)"/);
          if (descMatch) caption = descMatch[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
        }

        const vidMatch = html.match(/<meta\s+property="og:video"\s+content="([^"]*)"/);
        const imgMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]*)"/);

        let slideUrl = vidMatch?.[1] || imgMatch?.[1];
        if (!slideUrl) break;

        slideUrl = slideUrl.replace(/&amp;/g, "&");
        if (slideUrl.startsWith("/")) slideUrl = `https://${mirror}${slideUrl}`;

        if (lastMediaUrl === slideUrl) break;
        lastMediaUrl = slideUrl;

        medias.push({
          typeName: vidMatch ? "GraphVideo" : "GraphImage",
          url: slideUrl,
          thumbnailUrl: vidMatch ? imgMatch?.[1]?.replace(/&amp;/g, "&") : undefined
        });

        if (vidMatch) break;
      }

      if (medias.length > 0) {
        return { postId, username: username || "instagram", caption, medias };
      }
    } catch { continue; }
  }
  return null;
}

function hasUsableMedia(data: InstaData | null, expectVideo: boolean): data is InstaData {
  if (!data?.medias?.length) return false;
  return !expectVideo || data.medias.some(m => m.typeName.includes("Video"));
}

async function getInstaData(postId: string, expectVideo = false): Promise<InstaData | null> {
  const cached = instagramCache.get(postId) as InstaData | undefined;
  if (cached && hasUsableMedia(cached, expectVideo)) return cached;

  let data = await scrapeFromEmbed(postId);
  if (!hasUsableMedia(data, expectVideo)) data = await scrapeFromMirror(postId);

  if (data?.medias?.length) {
    instagramCache.set(postId, data);
    return data;
  }
  return null;
}

export const instagramRouter = new Hono();

instagramRouter.get("/oembed", c => {
  const q = c.req.query();
  return c.json(buildOEmbed({
    type: "rich",
    author_url: q.url,
    provider_name: "LinkEmbedder / Instagram"
  }));
});

instagramRouter.get("/images/:id/:n", async c => {
  const id = c.req.param("id");
  const n = parseInt(c.req.param("n")) - 1;
  const data = await getInstaData(id);
  if (!data) return c.redirect(`https://www.instagram.com/p/${id}/`, 302);

  const media = data.medias[Math.max(0, n)] ?? data.medias[0];
  if (!media) return c.redirect(`https://www.instagram.com/p/${id}/`, 302);

  try {
    const res = await fetch(media.url, { headers: { Referer: "https://www.instagram.com/" } });
    if (!res.ok) return c.redirect(media.url, 302);
    return new Response(res.body, {
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "image/jpeg",
        "Cache-Control": "public, max-age=86400"
      }
    });
  } catch {
    return c.redirect(media.url, 302);
  }
});

instagramRouter.get("/thumb/:id/:n", async c => {
  const id = c.req.param("id");
  const n = parseInt(c.req.param("n")) - 1;
  const data = await getInstaData(id);
  if (!data) return c.redirect(`https://www.instagram.com/p/${id}/`, 302);

  const media = data.medias[Math.max(0, n)] ?? data.medias[0];
  const url = media?.thumbnailUrl ?? media?.url;
  if (!url) return c.redirect(`https://www.instagram.com/p/${id}/`, 302);

  return c.redirect(url, 302);
});

instagramRouter.get("/videos/:id/:n/video.mp4", async c => {
  const id = c.req.param("id");
  instagramCache.delete(id);

  const data = await getInstaData(id, true);
  if (!data) return c.redirect(`https://www.instagram.com/p/${id}/`, 302);

  const n = parseInt(c.req.param("n")) - 1;
  const mediaUrl = data.medias[Math.max(0, n)]?.url;
  if (!mediaUrl) return c.redirect(`https://www.instagram.com/p/${id}/`, 302);

  const range = c.req.header("range");
  const upstreamHeaders: Record<string, string> = {
    Referer: "https://www.instagram.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    Accept: "*/*",
    "sec-fetch-site": "cross-site",
  };
  if (range) upstreamHeaders.Range = range;

  try {
    let videoRes = await fetch(mediaUrl, { headers: upstreamHeaders, redirect: "manual" });

    if (videoRes.status === 301 || videoRes.status === 302) {
      const location = videoRes.headers.get("location");
      if (location) videoRes = await fetch(location, { headers: upstreamHeaders, redirect: "manual" });
    }

    if (!videoRes.ok && videoRes.status !== 206) {
      return c.redirect(mediaUrl, 302);
    }

    const proxyHeaders = new Headers();
    ["Content-Type", "Content-Length", "Accept-Ranges", "Content-Range"].forEach(h => {
      if (videoRes.headers.has(h)) proxyHeaders.set(h, videoRes.headers.get(h)!);
    });
    if (!proxyHeaders.has("Accept-Ranges")) proxyHeaders.set("Accept-Ranges", "bytes");

    return new Response(videoRes.body, { status: videoRes.status, headers: proxyHeaders });
  } catch {
    return c.redirect(mediaUrl, 302);
  }
});

instagramRouter.get("/grid/:id", async c => {
  const id = c.req.param("id");
  const data = await getInstaData(id);
  if (!data) return new Response("Not found", { status: 404 });

  const images = data.medias.filter(m => !m.typeName.includes("Video")).map(m => m.url);
  if (!images.length) return new Response("Not found", { status: 404 });

  const buffer = await createMosaic(images);
  if (!buffer) return c.redirect(images[0], 302);

  return new Response(buffer as any, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" }
  });
});

async function handleEmbed(c: Context, manualId?: string, manualMediaNum?: string): Promise<Response> {
  const ua = c.req.header("user-agent");
  const postId = manualId || c.req.param("id") || c.req.path.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)?.[1];
  if (!postId) return c.redirect("https://www.instagram.com/", 302);

  const typeMatch = c.req.path.match(/\/(p|reel|reels|tv)\//) ?? c.req.query("url")?.match(/\/(p|reel|reels|tv)\//);
  const type = typeMatch ? typeMatch[1] : "p";
  const originalUrl = `https://www.instagram.com/${type}/${postId}/`;
  const dParam = c.req.query("d") ?? c.req.query("dir") ?? c.req.query("direct");
  const isDirect = dParam !== undefined;

  if (!isBot(ua) && !isDirect) return c.redirect(originalUrl, 302);

  const data = await getInstaData(postId, ["reel", "reels", "tv"].includes(type));
  if (!data?.medias?.length) return c.redirect(originalUrl, 302);

  const host = getOrigin(c);
  const imgIndexParam = c.req.param("mediaNum") || c.req.query("index");
  // instagram has a zero-indexed param for index
  const idx = manualMediaNum
    ? Math.max(0, parseInt(manualMediaNum))
    : Math.max(0, (parseInt(imgIndexParam || "1") - 1));
  const media = data.medias[Math.min(idx, data.medias.length - 1)];
  const isGrid = data.medias.length > 1 && !(imgIndexParam || manualMediaNum);
  const isVideo = media.typeName.includes("Video") || ["reel", "reels", "tv"].includes(type);

  if (isDirect) {
    if (isVideo) return c.redirect(`${host}/ig/videos/${postId}/${idx + 1}/video.mp4`, 302);
    return c.redirect(`${host}/ig/images/${postId}/${idx + 1}`, 302);
  }

  const description = data.caption.slice(0, 280) + (data.caption.length > 280 ? "…" : "");
  const oembedUrl = `${host}/ig/oembed?url=${encodeURIComponent(originalUrl)}&type=${isVideo ? "video" : "link"}&desc=${encodeURIComponent(description)}`;
  const title = `@${data.username}`;

  if (isVideo) {
    return c.html(buildEmbedHtml({
      title,
      description,
      url: originalUrl,
      imageUrl: `${host}/ig/thumb/${postId}/${idx + 1}`,
      videoUrl: `${host}/ig/videos/${postId}/${idx + 1}/video.mp4`,
      color: INSTA_COLOR,
      siteName: "Instagram",
      oembedUrl
    }));
  }

  if (isGrid) {
    return c.html(buildEmbedHtml({
      title,
      description,
      url: originalUrl,
      imageUrl: `${host}/ig/grid/${postId}`,
      color: INSTA_COLOR,
      siteName: "Instagram",
      largeImage: true,
      oembedUrl
    }));
  }

  return c.html(buildEmbedHtml({
    title,
    description,
    url: originalUrl,
    imageUrl: `${host}/ig/images/${postId}/1`,
    color: INSTA_COLOR,
    siteName: "Instagram",
    largeImage: true,
    oembedUrl
  }));
}

instagramRouter.get("/:username", async c => {
  const username = c.req.param("username");
  if (["p", "reel", "reels", "tv", "images", "videos", "thumb", "oembed", "grid"].includes(username)) return c.notFound();
  return c.redirect(`https://www.instagram.com/${username}/`, 302);
});

for (const pattern of [
  "/p/:id", "/p/:id/:mediaNum",
  "/reel/:id", "/reel/:id/:mediaNum",
  "/reels/:id", "/reels/:id/:mediaNum",
  "/tv/:id",
  "/:username/p/:id", "/:username/p/:id/:mediaNum",
  "/:username/reel/:id"
]) {
  instagramRouter.get(pattern, c => handleEmbed(c));
}

function extractInstaParams(urlStr: string): { id: string; mediaNum?: string; } | null {
  try {
    const url = new URL(urlStr);
    if (url.hostname.includes("instagram.com")) {
      const match = url.pathname.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
      if (match) return { id: match[1], mediaNum: url.searchParams.get("img_index") ?? undefined };
    }
  } catch {
    const match = urlStr.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    if (match) return { id: match[1] };
  }
  return null;
}

instagramRouter.get("/", c => {
  const url = c.req.query("url");
  if (url) {
    const p = extractInstaParams(url);
    if (p) return handleEmbed(c, p.id, p.mediaNum);
  }
  return new Response("Not found", { status: 404 });
});

instagramRouter.get("/*", c => {
  const { path } = c.req;
  const httpMatch = path.match(/(https?:\/\/[^\s]+)/);
  if (httpMatch) {
    const p = extractInstaParams(httpMatch[1]);
    if (p) return handleEmbed(c, p.id, p.mediaNum);
  }
  return new Response("Not found", { status: 404 });
});
