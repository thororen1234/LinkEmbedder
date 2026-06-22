import { Context, Hono } from "hono";

import { getOrigin, isBot } from "../utils/bot.js";
import { twitterCache } from "../utils/cache.js";
import { buildEmbedHtml, buildOEmbed } from "../utils/html.js";
import { createMosaic } from "../utils/image.js";

const TWITTER_COLOR = "#1D9BF0";
const SYNDICATION_BASE = "https://cdn.syndication.twimg.com/tweet-result";
const BASE36_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

function baseConversion(x: number, base: number): string {
  let result = "";
  let i = Math.trunc(x);
  while (i > 0) {
    result = BASE36_DIGITS[i % base] + result;
    i = Math.floor(i / base);
  }
  if (Math.trunc(x) !== x) {
    result += ".";
    let frac = x - Math.trunc(x);
    let d = 0;
    while (frac !== Math.trunc(frac)) {
      result += BASE36_DIGITS[Math.trunc((frac * base) % base)];
      frac *= base;
      d += 1;
      if (d >= 8) break;
    }
  }
  return result;
}

function calcSyndicationToken(idStr: string): string {
  const id = (Number(idStr) / 1000000000000000) * Math.PI;
  const o = baseConversion(id, Math.pow(6, 2));
  const c = o.replace(/0/g, "").replace(".", "");
  return c === "" ? "0" : c;
}

interface SyndicationMedia {
  type: "photo" | "video" | "animated_gif";
  media_url_https?: string;
  video_info?: {
    variants: Array<{ content_type: string; bitrate?: number; url: string; }>;
    aspect_ratio?: [number, number];
  };
  sizes?: { large?: { w: number; h: number; }; orig?: { w: number; h: number; }; };
}

interface SyndicationTweet {
  id_str: string;
  full_text?: string;
  text?: string;
  user?: { name: string; screen_name: string; profile_image_url_https?: string; description?: string; followers_count?: number; friends_count?: number; statuses_count?: number; };
  extended_entities?: { media?: SyndicationMedia[]; };
  entities?: { media?: SyndicationMedia[]; };
  photos?: Array<{ url: string; width: number; height: number; }>;
  video?: { url: string; poster?: string; aspectRatio?: [number, number]; };
  mediaDetails?: SyndicationMedia[];
  quoted_tweet?: SyndicationTweet;
  card?: {
    name?: string;
    binding_values?: Record<string, { type: string; boolean_value?: boolean; string_value?: string; }>;
  };
}

async function fetchTweet(id: string): Promise<SyndicationTweet | null> {
  const cached = twitterCache.get(id) as SyndicationTweet | undefined;
  if (cached) return cached;
  try {
    const token = calcSyndicationToken(id);
    const res = await fetch(`${SYNDICATION_BASE}?id=${encodeURIComponent(id)}&lang=en&token=${token}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Discordbot/2.0)", Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as SyndicationTweet;
    twitterCache.set(id, data);
    return data;
  } catch { return null; }
}

function getCardVideo(tweet: SyndicationTweet): { url: string; width?: number; height?: number; thumb?: string; } | null {
  const { card } = tweet;
  if (!card?.binding_values) return null;

  const bv = card.binding_values;
  const candidateKeys = [
    "player_stream_url",
    "amplify_content_url",
    "video_url",
    "player_url",
  ];

  for (const key of candidateKeys) {
    const val = bv[key]?.string_value;
    if (val && /^https?:\/\//.test(val)) {
      const widthStr = bv.player_width?.string_value;
      const heightStr = bv.player_height?.string_value;
      const thumb = bv.thumbnail_image_large?.string_value
        ?? bv.thumbnail_image_original?.string_value
        ?? bv.thumbnail_image?.string_value;
      return {
        url: val,
        width: widthStr ? parseInt(widthStr, 10) : undefined,
        height: heightStr ? parseInt(heightStr, 10) : undefined,
        thumb,
      };
    }
  }

  if (card.name && /player|amplify/i.test(card.name)) {
    console.log(`[twitter] card.name="${card.name}" has no recognized video URL key. Available binding_values keys: ${Object.keys(bv).join(", ")}`);
  }

  return null;
}

function getBestVideo(tweet: SyndicationTweet): { url: string; width?: number; height?: number; thumb?: string; } | null {
  if (tweet.video?.url) {
    const ar = tweet.video.aspectRatio;
    return { url: tweet.video.url, width: ar?.[0] ? ar[0] * 100 : undefined, height: ar?.[1] ? ar[1] * 100 : undefined, thumb: tweet.video.poster };
  }
  const medias = tweet.mediaDetails ?? tweet.extended_entities?.media ?? tweet.entities?.media ?? [];
  for (const m of medias) {
    if ((m.type === "video" || m.type === "animated_gif") && m.video_info) {
      const variants = m.video_info.variants
        .filter(v => v.content_type === "video/mp4" && v.bitrate !== undefined)
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      if (variants[0]) {
        const ar = m.video_info.aspect_ratio;
        return { url: variants[0].url, width: ar?.[0] ? ar[0] * 100 : undefined, height: ar?.[1] ? ar[1] * 100 : undefined, thumb: m.media_url_https };
      }
    }
  }
  return getCardVideo(tweet);
}

function getPhotos(tweet: SyndicationTweet): Array<{ url: string; width?: number; height?: number; }> {
  if (tweet.photos?.length) return tweet.photos.map(p => ({ url: p.url, width: p.width, height: p.height }));
  const medias = tweet.mediaDetails ?? tweet.extended_entities?.media ?? tweet.entities?.media ?? [];
  return medias.filter(m => m.type === "photo").map(m => {
    const large = m.sizes?.large ?? m.sizes?.orig;
    return { url: `${m.media_url_https ?? ""}?name=orig`, width: large?.w, height: large?.h };
  });
}

async function handleTweet(c: Context, tweetId: string, routeUser?: string, embedIndex = -1): Promise<Response> {
  const fallbackUrl = routeUser
    ? `https://x.com/${routeUser}/status/${tweetId}`
    : `https://x.com/i/status/${tweetId}`;

  const imgIndexParam = c.req.query("img_index") ?? c.req.query("index");
  if (imgIndexParam !== undefined && embedIndex === -1) {
    embedIndex = parseInt(imgIndexParam, 10) - 1;
  }

  const dParam = c.req.query("d") ?? c.req.query("dir") ?? c.req.query("direct");
  const isDirect = dParam !== undefined;

  const ua = c.req.header("user-agent");
  if (!isBot(ua) && !isDirect) return c.redirect(fallbackUrl, 302);

  const tweet = await fetchTweet(tweetId);
  if (!tweet) return c.redirect(fallbackUrl, 302);

  let text = tweet.full_text ?? tweet.text ?? "";
  text = text.replace(/(?:\s*https:\/\/t\.co\/\w+)+$/g, "");

  const username = tweet.user?.screen_name ?? routeUser ?? "unknown";
  const displayName = tweet.user?.name ?? username;
  const tweetUrl = `https://x.com/${username}/status/${tweetId}`;
  const authorName = `${displayName} (@${username})`;
  const host = getOrigin(c);
  const rawVideo = getBestVideo(tweet);
  const video = rawVideo?.url ? rawVideo : null;

  if (video && video.url && video.url.includes("video.twimg.com") && video.url.includes(".mp4")) {
    try {
      const urlObj = new URL(video.url);
      const cleanPath = urlObj.pathname.replace(".mp4", "");
      video.url = `${host}/tvid${cleanPath}`;
    } catch { }
  }

  if (isDirect) {
    if (video) return c.redirect(video.url, 302);
    const photos = getPhotos(tweet);
    if (photos.length) return c.redirect(photos[Math.max(0, embedIndex >= 0 ? Math.min(embedIndex, photos.length - 1) : 0)].url, 302);
  }

  const oembedUrl = `${host}/twitter/oembed?desc=${encodeURIComponent(text)}&user=${encodeURIComponent(authorName)}&link=${encodeURIComponent(tweetUrl)}&ttype=${video ? "video" : "link"}`;

  if (video) {
    return c.html(buildEmbedHtml({ description: text, url: tweetUrl, imageUrl: video.thumb, videoUrl: video.url, videoWidth: video.width ?? 1280, videoHeight: video.height ?? 720, color: TWITTER_COLOR, siteName: "Twitter / X", twitterCard: "player", oembedUrl }));
  }

  const photos = getPhotos(tweet);
  if (photos.length) {
    const desc = text;
    if (embedIndex >= 0) {
      const idx = Math.min(embedIndex, photos.length - 1);
      const photo = photos[idx];
      return c.html(buildEmbedHtml({ description: desc, url: tweetUrl, imageUrl: photo.url, imageWidth: photo.width, imageHeight: photo.height, color: TWITTER_COLOR, siteName: "Twitter / X", largeImage: true, oembedUrl }));
    } else if (photos.length > 1) {
      const imageUrls = photos.slice(0, 4).map(p => p.url);
      const first = photos[0];
      return c.html(buildEmbedHtml({ description: desc, url: tweetUrl, imageUrl: imageUrls, imageWidth: first.width, imageHeight: first.height, color: TWITTER_COLOR, siteName: "Twitter / X", largeImage: true, oembedUrl }));
    } else {
      const first = photos[0];
      return c.html(buildEmbedHtml({ description: desc, url: tweetUrl, imageUrl: first.url, imageWidth: first.width, imageHeight: first.height, color: TWITTER_COLOR, siteName: "Twitter / X", largeImage: true, oembedUrl }));
    }
  }

  return c.html(buildEmbedHtml({ description: text, url: tweetUrl, color: TWITTER_COLOR, siteName: "Twitter / X", oembedUrl }));
}

export const twitterRouter = new Hono();

twitterRouter.get("/oembed", c => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: (q.ttype as "link" | "photo" | "video") ?? "link", author_name: q.user, author_url: q.link, provider_name: q.provider ?? "LinkEmbedder / Twitter" }));
});

twitterRouter.get("/grid/:id", async c => {
  const id = c.req.param("id");
  const tweet = await fetchTweet(id);
  if (!tweet) return new Response("Not found", { status: 404 });
  const photos = getPhotos(tweet).map(p => p.url);
  if (!photos.length) return new Response("Not found", { status: 404 });
  const buffer = await createMosaic(photos);
  if (!buffer) return c.redirect(photos[0], 302);
  return new Response(buffer as any, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" } });
});

twitterRouter.get("/:user/status/:id/video.mp4", async c => {
  const tweet = await fetchTweet(c.req.param("id"));
  if (!tweet) return new Response("Not found", { status: 404 });
  const video = getBestVideo(tweet);
  if (video?.url) return c.redirect(video.url, 302);
  return new Response("No video found", { status: 404 });
});

twitterRouter.get("/:user/status/:id/image.png", async c => {
  const tweet = await fetchTweet(c.req.param("id"));
  if (!tweet) return new Response("Not found", { status: 404 });
  const photos = getPhotos(tweet);
  if (photos.length) return c.redirect(photos[0].url, 302);
  return new Response("No image found", { status: 404 });
});

twitterRouter.get("/:user/status/:id", c =>
  handleTweet(c, c.req.param("id"), c.req.param("user"))
);
twitterRouter.get("/:user/status/:id/:index", c => {
  const idx = parseInt(c.req.param("index") ?? "1", 10);
  return handleTweet(c, c.req.param("id"), c.req.param("user"), isNaN(idx) ? 0 : idx - 1);
});
twitterRouter.get("/i/status/:id", c =>
  handleTweet(c, c.req.param("id"))
);

function extractTwitterParams(urlStr: string): { user?: string; id: string; index?: number; } | null {
  try {
    const url = new URL(urlStr);
    if (url.hostname.includes("twitter.com") || url.hostname.includes("x.com")) {
      const match = url.pathname.match(/\/?([^/]+)\/status\/(\d+)(?:\/photo\/(\d+))?/);
      if (match) return { user: match[1] === "i" ? undefined : match[1], id: match[2], index: match[3] ? parseInt(match[3], 10) - 1 : undefined };
    }
  } catch {
    const match = urlStr.match(/\/?([^/]+)\/status\/(\d+)(?:\/photo\/(\d+))?/);
    if (match) return { user: match[1] === "i" ? undefined : match[1], id: match[2], index: match[3] ? parseInt(match[3], 10) - 1 : undefined };
  }
  return null;
}

twitterRouter.get("/", c => {
  const url = c.req.query("url");
  if (url) {
    const p = extractTwitterParams(url);
    if (p) return handleTweet(c, p.id, p.user, p.index ?? -1);
  }
  return new Response("Not found", { status: 404 });
});

twitterRouter.get("/*", c => {
  const { path } = c.req;
  const httpMatch = path.match(/(https?:\/\/[^\s]+)/);
  if (httpMatch) {
    const p = extractTwitterParams(httpMatch[1]);
    if (p) return handleTweet(c, p.id, p.user, p.index ?? -1);
  }
  return new Response("Not found", { status: 404 });
});
