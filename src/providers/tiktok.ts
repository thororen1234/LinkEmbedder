import { Context, Hono } from "hono";

import { getOrigin, isBot } from "../utils/bot.js";
import { tiktokCache } from "../utils/cache.js";
import { buildEmbedHtml, buildOEmbed } from "../utils/html.js";
import { createMosaic } from "../utils/image.js";

const TIKTOK_COLOR = "#010101";

interface TikTokAuthor { nickname?: string; uniqueId?: string; avatarThumb?: string; }
interface TikTokBitrateInfo { PlayAddr?: { UrlList?: string[]; DataSize?: string }; CodecType?: string; }
interface TikTokVideo {
  width?: number;
  height?: number;
  duration?: number;
  cover?: string | { urlList?: string[] };
  playAddr?: string | { urlList?: string[] };
  playAddrStruct?: { urlList?: string[] };
  PlayAddrStruct?: { UrlList?: string[] };
  bitrateInfo?: TikTokBitrateInfo[];
}
interface TikTokStats { diggCount?: number; commentCount?: number; playCount?: number; }
interface TikTokItem {
  id?: string; desc?: string; author?: TikTokAuthor; video?: TikTokVideo;
  imagePost?: { images?: Array<{ imageURL?: { urlList?: string[] } }> };
  stats?: TikTokStats; isContentClassified?: boolean;
}

const TIKTOK_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.tiktok.com/",
  "sec-fetch-site": "same-site",
  "sec-fetch-mode": "cors",
};

const VIDEO_USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
];

async function resolveShortLink(videoId: string): Promise<URL | null> {
  try {
    const res = await fetch(`https://vm.tiktok.com/${videoId}`, {
      headers: { "User-Agent": VIDEO_USER_AGENTS[0] },
      redirect: "manual",
    });
    const location = res.headers.get("location") ?? res.headers.get("Location");
    if (!location) return null;
    return new URL(location);
  } catch { return null; }
}

function extractJsonFromScript(html: string, scriptId: string): unknown {
  const startTag = `<script id="${scriptId}" type="application/json">`;
  const startIdx = html.indexOf(startTag);
  if (startIdx === -1) return null;
  const jsonStart = startIdx + startTag.length;
  const jsonEnd = html.indexOf("</script>", jsonStart);
  if (jsonEnd === -1) return null;
  try { return JSON.parse(html.substring(jsonStart, jsonEnd)); } catch { return null; }
}

async function fetchVideoData(awemeId: string): Promise<TikTokItem | null> {
  const cached = tiktokCache.get(awemeId) as TikTokItem | undefined;
  if (cached) return cached;

  try {
    const res = await fetch(`https://www.tiktok.com/@i/video/${awemeId}`, {
      headers: TIKTOK_HEADERS
    });
    if (!res.ok) return null;

    const html = await res.text();
    const json = extractJsonFromScript(html, "__UNIVERSAL_DATA_FOR_REHYDRATION__") as any;
    if (!json?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct) return null;

    const item = json.__DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct;
    tiktokCache.set(awemeId, item);
    return item;
  } catch { return null; }
}

async function proxyImage(url: string, c: Context): Promise<Response> {
  try {
    const res = await fetch(url, { headers: { Referer: "https://www.tiktok.com/" } });
    if (!res.ok) return c.redirect(url, 302);
    return new Response(res.body, {
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "image/jpeg",
        "Cache-Control": "public, max-age=86400"
      }
    });
  } catch { return c.redirect(url, 302); }
}

async function fetchVideoWithRetry(playAddrUrl: string, range?: string): Promise<Response | null> {
  for (let i = 0; i < VIDEO_USER_AGENTS.length; i++) {
    const headers: Record<string, string> = {
      "User-Agent": VIDEO_USER_AGENTS[i],
      Referer: "https://www.tiktok.com/",
      Accept: "*/*",
      "Accept-Encoding": "identity",
    };
    if (range) headers.Range = range;

    try {
      const videoRes = await fetch(playAddrUrl, {
        headers,
        redirect: "manual"
      });

      if (videoRes.status === 301 || videoRes.status === 302) {
        const location = videoRes.headers.get("location");
        if (location) return new Response(null, { status: 302, headers: { Location: location } });
      }

      if (videoRes.ok || videoRes.status === 206) {
        return videoRes;
      }
    } catch { }

    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

function findPlayUrl(video: TikTokVideo | undefined): string | undefined {
  if (!video) return undefined;

  const candidates: string[] = [];

  if (typeof video.playAddr === "string") {
    candidates.push(video.playAddr);
  } else if (video.playAddr?.urlList?.[0]) {
    candidates.push(video.playAddr.urlList[0]);
  }

  if (video.playAddrStruct?.urlList?.[0]) candidates.push(video.playAddrStruct.urlList[0]);
  if (video.PlayAddrStruct?.UrlList?.[0]) candidates.push(video.PlayAddrStruct.UrlList[0]);

  if (video.bitrateInfo) {
    for (const b of video.bitrateInfo) {
      if (b.PlayAddr?.UrlList?.[0]) candidates.push(b.PlayAddr.UrlList[0]);
    }
  }

  for (const url of candidates) {
    if (url.includes("/aweme/v1/play/")) return url;
  }

  return candidates[0];
}

export const tiktokRouter = new Hono();

tiktokRouter.get("/oembed", c => {
  const q = c.req.query();
  return c.json(buildOEmbed({
    type: (q.type as any) || "link",
    author_name: q.author,
    author_url: q.url,
    provider_name: "LinkEmbedder / TikTok"
  }));
});

tiktokRouter.get("/images/:videoId/:n", async c => {
  const awemeId = c.req.param("videoId");
  const n = parseInt(c.req.param("n"), 10) - 1;
  const item = await fetchVideoData(awemeId);
  const imgs = item?.imagePost?.images;
  if (!imgs?.length) return new Response("Not found", { status: 404 });

  const url = imgs[Math.max(0, Math.min(n, imgs.length - 1))]?.imageURL?.urlList?.[0];
  if (!url) return new Response("Not found", { status: 404 });
  return proxyImage(url, c);
});

tiktokRouter.get("/grid/:videoId", async c => {
  const awemeId = c.req.param("videoId");
  const item = await fetchVideoData(awemeId);
  const imgs = item?.imagePost?.images?.map(i => i.imageURL?.urlList?.[0]).filter(Boolean) as string[];
  if (!imgs?.length) return new Response("Not found", { status: 404 });

  const buffer = await createMosaic(imgs);
  if (!buffer) return c.redirect(imgs[0], 302);
  return new Response(buffer as any, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" }
  });
});

tiktokRouter.get("/cover/:videoId", async c => {
  const awemeId = c.req.param("videoId");
  const item = await fetchVideoData(awemeId);
  const coverObj = item?.video?.cover;
  const coverUrl = typeof coverObj === "string" ? coverObj : coverObj?.urlList?.[0];
  const url = coverUrl ?? item?.author?.avatarThumb;
  if (!url) return new Response("Not found", { status: 404 });
  return proxyImage(url, c);
});

tiktokRouter.get("/play/:videoId/video.mp4", async c => {
  const awemeId = c.req.param("videoId");
  tiktokCache.delete(awemeId);

  const item = await fetchVideoData(awemeId);
  const playAddrUrl = findPlayUrl(item?.video);

  if (!playAddrUrl) {
    return c.redirect(`https://www.tiktok.com/@i/video/${awemeId}`, 302);
  }

  const range = c.req.header("range");
  const upstreamRes = await fetchVideoWithRetry(playAddrUrl, range);

  if (!upstreamRes) {
    console.log(`All video proxy attempts failed for ${awemeId}`);
    return c.redirect(playAddrUrl, 302);
  }

  const proxyHeaders = new Headers();
  ["Content-Type", "Content-Length", "Accept-Ranges", "Content-Range"].forEach(h => {
    if (upstreamRes.headers.has(h)) proxyHeaders.set(h, upstreamRes.headers.get(h)!);
  });

  if (!proxyHeaders.has("Accept-Ranges")) proxyHeaders.set("Accept-Ranges", "bytes");

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: proxyHeaders
  });
});

tiktokRouter.get("/:videoId", async c => {
  const videoId = c.req.param("videoId");
  if (videoId.startsWith("@")) return c.redirect(`https://www.tiktok.com/${videoId}`, 302);

  const id = videoId.split(".")[0];
  if (/^\d{15,20}$/.test(id)) return handleVideoEmbed(c, id);

  const resolved = await resolveShortLink(id);
  if (!resolved) return c.redirect(`https://www.tiktok.com/${id}`, 302);

  const match = resolved.pathname.match(/\/@([^/]+)\/(video|photo|live)\/(\d+)/);
  if (match) return handleVideoEmbed(c, match[3]);

  return c.redirect(resolved.toString(), 302);
});

tiktokRouter.get("/@:user/video/:videoId", c => handleVideoEmbed(c, c.req.param("videoId").split(".")[0]));
tiktokRouter.get("/@:user/video/:videoId/:index", c => handleVideoEmbed(c, c.req.param("videoId").split(".")[0], parseInt(c.req.param("index"), 10) - 1));
tiktokRouter.get("/@:user/photo/:videoId", c => handleVideoEmbed(c, c.req.param("videoId").split(".")[0]));
tiktokRouter.get("/@:user/photo/:videoId/:index", c => handleVideoEmbed(c, c.req.param("videoId").split(".")[0], parseInt(c.req.param("index"), 10) - 1));
tiktokRouter.get("/*/video/:videoId", c => handleVideoEmbed(c, c.req.param("videoId").split(".")[0]));

tiktokRouter.get("/@:user/live", async c => {
  const user = c.req.param("user");
  const liveUrl = `https://www.tiktok.com/@${user}/live`;
  if (!isBot(c.req.header("user-agent"))) return c.redirect(liveUrl, 302);
  return c.html(buildEmbedHtml({
    title: `@${user} is live on TikTok`,
    description: "Watch live on TikTok.",
    url: liveUrl,
    proxyUrl: c.req.url,
    color: TIKTOK_COLOR,
    siteName: "TikTok"
  }));
});

async function handleVideoEmbed(c: Context, awemeId: string, embedIndex = -1): Promise<Response> {
  const ua = c.req.header("user-agent");
  const tiktokUrl = `https://www.tiktok.com/@i/video/${awemeId}`;
  if (!isBot(ua)) return c.redirect(tiktokUrl, 302);

  const item = await fetchVideoData(awemeId);
  if (!item) return c.redirect(tiktokUrl, 302);

  if (item.isContentClassified) {
    return c.html(buildEmbedHtml({ title: "Age-Restricted Content", description: "View on TikTok.", url: tiktokUrl, proxyUrl: c.req.url, color: TIKTOK_COLOR, siteName: "TikTok" }));
  }

  const username = item.author?.uniqueId ?? "unknown";
  const displayName = item.author?.nickname ?? username;
  const authorName = `${displayName} (@${username})`;
  const description = item.desc ?? "";
  const postUrl = `https://www.tiktok.com/@${username}/video/${awemeId}`;
  const host = getOrigin(c);
  const isVideo = !item.imagePost?.images?.length;
  const oembedUrl = `${host}/tiktok/oembed?author=${encodeURIComponent(authorName)}&url=${encodeURIComponent(postUrl)}&type=${isVideo ? "video" : "link"}`;

  if (item.imagePost?.images?.length) {
    const { images } = item.imagePost;
    if (embedIndex >= 0) {
      const idx = Math.min(embedIndex, images.length - 1);
      return c.html(buildEmbedHtml({ description, url: postUrl, proxyUrl: c.req.url, imageUrl: `${host}/tiktok/images/${awemeId}/${idx + 1}`, color: TIKTOK_COLOR, siteName: "TikTok", largeImage: true, oembedUrl }));
    } else if (images.length > 1) {
      return c.html(buildEmbedHtml({ description, url: postUrl, proxyUrl: c.req.url, imageUrl: `${host}/tiktok/grid/${awemeId}`, color: TIKTOK_COLOR, siteName: "TikTok", largeImage: true, oembedUrl }));
    } else {
      return c.html(buildEmbedHtml({ description, url: postUrl, proxyUrl: c.req.url, imageUrl: `${host}/tiktok/images/${awemeId}/1`, color: TIKTOK_COLOR, siteName: "TikTok", largeImage: true, oembedUrl }));
    }
  }

  const hasCover = !!(item.video?.cover ?? item.author?.avatarThumb);
  const playUrl = findPlayUrl(item.video);
  const videoUrl = playUrl ? `${host}/tiktok/play/${awemeId}/video.mp4` : postUrl;

  return c.html(buildEmbedHtml({
    description,
    url: postUrl,
    proxyUrl: c.req.url,
    videoUrl,
    videoWidth: item.video?.width ?? 1080,
    videoHeight: item.video?.height ?? 1920,
    imageUrl: hasCover ? `${host}/tiktok/cover/${awemeId}` : undefined,
    color: TIKTOK_COLOR,
    siteName: "TikTok",
    twitterCard: "player",
    oembedUrl
  }));
}
