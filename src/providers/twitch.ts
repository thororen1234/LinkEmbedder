import { Context, Hono } from "hono";

import { getOrigin, isBot } from "../utils/bot.js";
import { twitchCache } from "../utils/cache.js";
import { buildEmbedHtml, buildOEmbed } from "../utils/html.js";

const TWITCH_COLOR = "#9146FF";

function formatNumber(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toString();
}

interface TwitchClipInfo {
  title: string;
  streamer: string;
  views: number;
  video_url: string;
}

let twitchAccessToken = "";

async function fetchTwitchAccessToken(): Promise<string | null> {
  if (twitchAccessToken) return twitchAccessToken;
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`, { method: "POST" });
    if (!res.ok) return null;
    const data = await res.json() as { access_token: string; };
    twitchAccessToken = data.access_token;
    return twitchAccessToken;
  } catch { return null; }
}

async function fetchClipInfo(clipId: string): Promise<TwitchClipInfo | null> {
  const cached = twitchCache.get(clipId) as TwitchClipInfo | undefined;
  if (cached) return cached;

  const accessToken = await fetchTwitchAccessToken();
  if (!accessToken) {
    console.warn("[twitch] Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET");
    return null;
  }

  try {
    const res = await fetch("https://gql.twitch.tv/gql", {
      method: "POST",
      headers: {
        "Client-ID": "kimne78kx3ncx6brgo4mv6wki5h1ko",
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify([
        {
          operationName: "VideoPlayerStreamInfoOverlayClip",
          variables: { slug: clipId },
          extensions: { persistedQuery: { version: 1, sha256Hash: "fcefd8b2081e39d16cbdc94bc82142df01b143bb296f0043262c44c37dbd1f63" } }
        },
        {
          operationName: "VideoAccessToken_Clip",
          variables: { platform: "web", slug: clipId },
          extensions: { persistedQuery: { version: 1, sha256Hash: "6fd3af2b22989506269b9ac02dd87eb4a6688392d67d94e41a6886f1e9f5c00f" } }
        }
      ])
    });

    if (!res.ok) return null;
    const data = await res.json() as any;

    const clipData = data[0]?.data?.clip;
    const tokenData = data[1]?.data?.clip;
    if (!clipData || !tokenData) return null;

    const sourceUrl = tokenData.videoQualities?.[0]?.sourceURL;
    const { playbackAccessToken } = tokenData;
    if (!sourceUrl || !playbackAccessToken) return null;

    const videoUrl = `${sourceUrl}?sig=${playbackAccessToken.signature}&token=${encodeURIComponent(playbackAccessToken.value)}`;
    const info: TwitchClipInfo = {
      title: clipData.title,
      streamer: clipData.broadcaster?.displayName,
      views: clipData.viewCount,
      video_url: videoUrl
    };

    twitchCache.set(clipId, info);
    return info;
  } catch { return null; }
}

async function handleClip(c: Context, clipId: string): Promise<Response> {
  const originalUrl = `https://clips.twitch.tv/${clipId}`;

  const dParam = c.req.query("d") ?? c.req.query("dir") ?? c.req.query("direct");
  const isDirect = dParam !== undefined;

  const ua = c.req.header("user-agent");
  if (!isBot(ua) && !isDirect) return c.redirect(originalUrl, 302);

  const info = await fetchClipInfo(clipId);
  if (!info) return c.redirect(originalUrl, 302);

  if (isDirect) {
    return c.redirect(info.video_url, 302);
  }

  const host = getOrigin(c);
  const dateStr = ` • ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
  const customSiteName = `Twitch${dateStr}`;
  const oembedUrl = `${host}/twitch/oembed?title=${encodeURIComponent(info.title)}&author=${encodeURIComponent(info.streamer)}&url=${encodeURIComponent(originalUrl)}&provider=${encodeURIComponent(customSiteName)}`;

  const metricsArr = [];
  if (info.views > 0) metricsArr.push(`👁️ ${formatNumber(info.views)}`);

  let description = info.title;
  if (metricsArr.length > 0) description += `\n\n${metricsArr.join(" ")}`;

  return c.html(buildEmbedHtml({
    description,
    url: originalUrl,
    videoUrl: info.video_url,
    videoWidth: 1280,
    videoHeight: 720,
    color: TWITCH_COLOR,
    siteName: customSiteName,
    twitterCard: "player",
    oembedUrl
  }));
}

export const twitchRouter = new Hono();

twitchRouter.get("/oembed", c => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: "video", title: q.title, author_name: q.author, author_url: q.url, provider_name: q.provider ?? "LinkEmbedder / Twitch" }));
});

twitchRouter.get("/clip/:id", c => handleClip(c, c.req.param("id")));
twitchRouter.get("/:streamer/clip/:id", c => handleClip(c, c.req.param("id")));
twitchRouter.get("/:id", c => handleClip(c, c.req.param("id")));

function extractClipId(urlStr: string): string | null {
  try {
    const url = new URL(urlStr);
    if (url.hostname.includes("clips.twitch.tv")) {
      return url.pathname.replace(/^\//, "");
    } else if (url.hostname.includes("twitch.tv") && url.pathname.includes("/clip/")) {
      return url.pathname.split("/clip/")[1].split("?")[0].replace(/\/$/, "");
    }
  } catch {
    if (/^[A-Za-z0-9_-]+$/.test(urlStr)) return urlStr;
  }
  return null;
}

twitchRouter.get("/", c => {
  const url = c.req.query("url");
  if (url) {
    const clipId = extractClipId(url);
    if (clipId) return handleClip(c, clipId);
  }
  return new Response("Not found", { status: 404 });
});

twitchRouter.get("/*", c => {
  const { path } = c.req;
  const httpMatch = path.match(/(https?:\/\/[^\s]+)/);
  if (httpMatch) {
    const clipId = extractClipId(httpMatch[1]);
    if (clipId) return handleClip(c, clipId);
  }
  return new Response("Not found", { status: 404 });
});
