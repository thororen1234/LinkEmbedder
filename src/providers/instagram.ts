import { Context, Hono } from "hono";

import { getOrigin, isBot } from "../utils/bot.js";
import { instagramCache } from "../utils/cache.js";
import { buildEmbedHtml, buildOEmbed } from "../utils/html.js";
import { createMosaic } from "../utils/image.js";

const INSTA_COLOR = "#E1306C";

interface InstaMedia { typeName: string; url: string; thumbnailUrl?: string; }
interface InstaData { postId: string; username: string; caption: string; medias: InstaMedia[]; date?: string; }

const GQL_HEADERS: Record<string, string> = {
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Content-Type": "application/x-www-form-urlencoded",
  Origin: "https://www.instagram.com",
  Referer: "https://www.instagram.com/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "X-Ig-App-Id": "936619743392459",
  "X-Fb-Friendly-Name": "PolarisPostActionLoadPostQueryQuery",
  "sec-fetch-site": "same-origin",
};

function extractGqlData(html: string): any {
  const marker = '\\"gql_data\\":\\"';
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) return null;

  const start = startIdx + marker.length;
  let end = start;
  while (end < html.length) {
    if (html[end] === "\\" && html[end + 1] === '"') {
      end += 2;
      continue;
    }
    if (html[end] === '"' && html[end - 1] !== "\\") {
      break;
    }
    end++;
  }

  try {
    const escaped = html.substring(start, end);
    const unescaped = JSON.parse('"' + escaped + '"');
    return JSON.parse(unescaped);
  } catch {
    return null;
  }
}

function parseGqlItem(item: any, postId: string): InstaData | null {
  if (!item) return null;

  const username = item.owner?.username ?? item.user?.username ?? "";
  const caption = item.edge_media_to_caption?.edges?.[0]?.node?.text ?? item.caption?.text ?? "";

  const medias: InstaMedia[] = [];
  const sidecar = item.edge_sidecar_to_children?.edges;

  const nodes = sidecar?.length ? sidecar.map((e: any) => e.node) : [item];

  for (const node of nodes) {
    let videoUrl = node.video_url;
    if (!videoUrl && node.video_versions?.length) {
      videoUrl = node.video_versions[0].url;
    }

    const displayUrl = node.display_url;
    const isVideoNode = node.is_video || node.__typename?.includes("Video");

    if (isVideoNode && !videoUrl) return null;

    const typeName = node.__typename ?? (videoUrl || isVideoNode ? "GraphVideo" : "GraphImage");

    medias.push({
      typeName,
      url: videoUrl ?? displayUrl ?? "",
      thumbnailUrl: videoUrl ? displayUrl : undefined,
    });
  }

  if (!medias.length) return null;

  let date: string | undefined;
  if (item.taken_at_timestamp) {
    date = new Date(item.taken_at_timestamp * 1000).toLocaleDateString();
  }

  return { postId, username, caption, medias, date };
}

async function scrapeFromEmbed(postId: string): Promise<InstaData | null> {
  try {
    const res = await fetch(`https://www.instagram.com/p/${postId}/embed/captioned/`, {
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
    });
    if (!res.ok) return null;
    const html = await res.text();

    if (html.includes("WatchOnInstagram")) return null;

    const gqlData = extractGqlData(html);
    if (gqlData) {
      const item = gqlData.shortcode_media ?? gqlData.xdt_shortcode_media;
      if (item) {
        const parsed = parseGqlItem(item, postId);
        if (parsed) return parsed;
      }
    }

    const usernameMatch = html.match(/class="UsernameText"[^>]*>([^<]+)/);
    const captionMatch = html.match(/class="Caption"[^>]*>([\s\S]*?)<\/div>/);

    const username = usernameMatch?.[1]?.trim() ?? "";
    let caption = (captionMatch?.[1] ?? "").replace(/<[^>]+>/g, "").trim();

    if (username && caption.startsWith(username)) caption = caption.slice(username.length).trim();
    caption = caption.replace(/View all \d+ comments|Add a comment\.\.\.$/i, "").trim();

    let isVideo = false;
    let mediaUrl = "";
    let thumbnailUrl: string | undefined = undefined;

    const videoUrlMatch = html.match(/"video_url"\s*:\s*"([^"]+)"/);
    const videoElementMatch = html.match(/class="EmbeddedMediaVideo"[^>]*src="([^"]+)"/) || html.match(/<video[^>]*src="([^"]+)"/);

    if (videoUrlMatch) {
      isVideo = true;
      try {
        mediaUrl = JSON.parse(`"${videoUrlMatch[1]}"`).replace(/&amp;/g, "&");
      } catch {
        mediaUrl = videoUrlMatch[1].replace(/\\/g, "").replace(/&amp;/g, "&");
      }
      const posterMatch = html.match(/"thumbnail_src"\s*:\s*"([^"]+)"/) || html.match(/"display_url"\s*:\s*"([^"]+)"/);
      if (posterMatch) {
        try {
          thumbnailUrl = JSON.parse(`"${posterMatch[1]}"`).replace(/&amp;/g, "&");
        } catch {
          thumbnailUrl = posterMatch[1].replace(/\\/g, "").replace(/&amp;/g, "&");
        }
      }
    } else if (videoElementMatch) {
      isVideo = true;
      mediaUrl = videoElementMatch[1].replace(/&amp;/g, "&");
      const posterMatch = html.match(/poster="([^"]+)"/);
      if (posterMatch) thumbnailUrl = posterMatch[1].replace(/&amp;/g, "&");
    } else {
      const imgMatch = html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/) || html.match(/<img[^>]*src="([^"]+)"/);
      if (imgMatch) {
        mediaUrl = imgMatch[1].replace(/&amp;/g, "&");
      }
    }

    if (!mediaUrl || !username) return null;

    const timeMatch = html.match(/datetime="([^"]+)"/);
    let date: string | undefined;
    if (timeMatch?.[1]) {
      date = new Date(timeMatch[1]).toLocaleDateString();
    }

    return {
      postId,
      username,
      caption,
      date,
      medias: [{
        typeName: isVideo ? "GraphVideo" : "GraphImage",
        url: mediaUrl,
        thumbnailUrl
      }]
    };
  } catch { return null; }
}

async function scrapeFromGQL(postId: string): Promise<InstaData | null> {
  try {
    const variables = JSON.stringify({
      shortcode: postId,
      fetch_comment_count: 2,
      has_threaded_comments: true,
    });

    const body = new URLSearchParams({
      av: "0",
      __d: "www",
      __user: "0",
      __a: "1",
      __req: "k",
      __hs: "19888.HYP:instagram_web_pkg.2.1..0.0",
      dpr: "2",
      __ccg: "UNKNOWN",
      __rev: "1014227545",
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: "PolarisPostActionLoadPostQueryQuery",
      server_timestamps: "true",
      doc_id: "25531498899829322",
      variables,
    }).toString();

    const res = await fetch("https://www.instagram.com/graphql/query/", {
      method: "POST",
      headers: GQL_HEADERS,
      body,
    });

    if (!res.ok) return null;

    const json = await res.json() as any;
    const item = json?.data?.shortcode_media ?? json?.data?.xdt_shortcode_media;
    return parseGqlItem(item, postId);
  } catch { return null; }
}

async function getInstaData(postId: string): Promise<InstaData | null> {
  const cached = instagramCache.get(postId) as InstaData | undefined;
  if (cached) return cached;

  let data = await scrapeFromGQL(postId);
  if (!data?.medias?.length) data = await scrapeFromEmbed(postId);

  if (data) {
    instagramCache.set(postId, data);
    return data;
  }
  return null;
}

export const instagramRouter = new Hono();

instagramRouter.get("/oembed", c => {
  const q = c.req.query();
  return c.json(buildOEmbed({
    type: (q.type as any) || "link",
    author_name: q.user,
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

  const data = await getInstaData(id);
  if (!data) return c.redirect(`https://www.instagram.com/p/${id}/`, 302);

  const n = parseInt(c.req.param("n")) - 1;
  const mediaUrl = data.medias[Math.max(0, n)]?.url;
  if (!mediaUrl) return c.redirect(`https://www.instagram.com/p/${id}/`, 302);

  try {
    const videoRes = await fetch(mediaUrl, {
      headers: {
        Referer: "https://www.instagram.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        Accept: "*/*",
        "sec-fetch-site": "cross-site",
      },
      redirect: "manual"
    });

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

  const originalUrl = `https://www.instagram.com/p/${postId}/`;
  const dParam = c.req.query("d") ?? c.req.query("dir") ?? c.req.query("direct");
  const isDirect = dParam !== undefined;

  if (!isBot(ua) && !isDirect) return c.redirect(originalUrl, 302);

  const data = await getInstaData(postId);
  if (!data?.medias?.length) return c.redirect(originalUrl, 302);

  const host = getOrigin(c);
  const imgIndexParam = manualMediaNum || c.req.param("mediaNum") || c.req.query("img_index") || c.req.query("index");
  const isGrid = data.medias.length > 1 && !imgIndexParam;
  const idx = Math.max(0, (parseInt(imgIndexParam || "1") - 1));
  const media = data.medias[Math.min(idx, data.medias.length - 1)];
  const isVideo = media.typeName.includes("Video");

  if (isDirect) {
    if (isVideo) return c.redirect(`${host}/ig/videos/${postId}/${idx + 1}/video.mp4`, 302);
    return c.redirect(`${host}/ig/images/${postId}/${idx + 1}`, 302);
  }

  const description = data.caption.slice(0, 280) + (data.caption.length > 280 ? "…" : "");
  const oembedUrl = `${host}/ig/oembed?user=${encodeURIComponent(`@${data.username}`)}&url=${encodeURIComponent(originalUrl)}&type=${isVideo ? "video" : "link"}`;

  if (isVideo) {
    return c.html(buildEmbedHtml({
      title: data.date ? `Published ${data.date}` : undefined,
      description,
      url: originalUrl,
      proxyUrl: c.req.url,
      videoUrl: `${host}/ig/videos/${postId}/${idx + 1}/video.mp4`,
      videoWidth: 1080,
      videoHeight: 1920,
      imageUrl: `${host}/ig/thumb/${postId}/${idx + 1}`,
      color: INSTA_COLOR,
      siteName: "Instagram",
      twitterCard: "player",
      oembedUrl
    }));
  }

  if (isGrid) {
    return c.html(buildEmbedHtml({
      title: data.date ? `Published ${data.date}` : undefined,
      description,
      url: originalUrl,
      proxyUrl: c.req.url,
      imageUrl: `${host}/ig/grid/${postId}`,
      color: INSTA_COLOR,
      siteName: "Instagram",
      largeImage: true,
      oembedUrl
    }));
  }

  return c.html(buildEmbedHtml({
    title: data.date ? `Published ${data.date}` : undefined,
    description,
    url: originalUrl,
    proxyUrl: c.req.url,
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
