import { Context, Hono } from "hono";

import { getOrigin, isBot } from "../utils/bot.js";
import { twitchCache } from "../utils/cache.js";
import { buildEmbedHtml, buildOEmbed } from "../utils/html.js";

const TWITCH_COLOR = "#9146FF";

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
    const data = await res.json() as { access_token: string };
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
  const ua = c.req.header("user-agent");
  if (!isBot(ua)) return c.redirect(originalUrl, 302);

  const info = await fetchClipInfo(clipId);
  if (!info) return c.redirect(originalUrl, 302);

  const host = getOrigin(c);
  const oembedUrl = `${host}/twitch/oembed?title=${encodeURIComponent(info.title)}&author=${encodeURIComponent(info.streamer)}&url=${encodeURIComponent(originalUrl)}`;

  const description = `👁️ ${info.views} views`;

  return c.html(buildEmbedHtml({
    description: `${info.title}\n\n${description}`,
    url: originalUrl,
    videoUrl: info.video_url,
    videoWidth: 1280,
    videoHeight: 720,
    color: TWITCH_COLOR,
    siteName: "Twitch",
    twitterCard: "player",
    oembedUrl
  }));
}

export const twitchRouter = new Hono();

twitchRouter.get("/oembed", c => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: "video", title: q.title, author_name: q.author, author_url: q.url, provider_name: "LinkEmbedder / Twitch" }));
});

twitchRouter.get("/clip/:id", c => handleClip(c, c.req.param("id")));
twitchRouter.get("/:streamer/clip/:id", c => handleClip(c, c.req.param("id")));
twitchRouter.get("/:id", c => handleClip(c, c.req.param("id")));
