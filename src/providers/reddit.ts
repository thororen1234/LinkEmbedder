import { Context, Hono } from "hono";

import { getOrigin, isBot } from "../utils/bot.js";
import { redditCache } from "../utils/cache.js";
import { streamMux } from "../utils/ffmpeg.js";
import { buildEmbedHtml, buildOEmbed } from "../utils/html.js";

const REDDIT_COLOR = "#FF4500";

function formatNumber(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toString();
}

interface RedditPost {
  subreddit: string; title: string; author: string; permalink: string;
  selftext?: string; post_hint?: string; url?: string; domain?: string;
  is_reddit_media_domain?: boolean;
  ups?: number; num_comments?: number; created_utc?: number;
  media?: { reddit_video?: { fallback_url: string; width: number; height: number; has_audio?: boolean; }; };
  secure_media?: { reddit_video?: { fallback_url: string; width: number; height: number; has_audio?: boolean; }; };
  preview?: { images?: Array<{ source?: { url: string; width: number; height: number; }; }>; };
  gallery_data?: { items: Array<{ media_id: string; caption?: string; }>; };
  media_metadata?: Record<string, { s?: { u: string; x: number; y: number; }; }>;
  crosspost_parent_list?: RedditPost[];
  thumbnail?: string; thumbnail_width?: number; thumbnail_height?: number;
}

async function fetchRedditPost(permalink: string): Promise<RedditPost | null> {
  const cached = redditCache.get(permalink) as RedditPost | undefined;
  if (cached) return cached;
  try {
    const res = await fetch(`https://www.reddit.com${permalink}.json?limit=1&raw_json=1`, {
      headers: { "User-Agent": "LinkEmbedder/1.0", Accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = await res.json() as unknown[];
    const post = (json[0] as { data: { children: Array<{ data: RedditPost; }>; }; })?.data?.children?.[0]?.data;
    if (!post) return null;
    redditCache.set(permalink, post);
    return post;
  } catch { return null; }
}

async function resolveShareLink(sub: string, shareId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://www.reddit.com/r/${sub}/s/${shareId}`, { redirect: "manual", headers: { "User-Agent": "LinkEmbedder/1.0" } });
    return res.headers.get("location");
  } catch { return null; }
}

function decodeUrl(url: string) { return url.replace(/&amp;/g, "&"); }

function getPreviewImage(post: RedditPost) {
  const src = post.preview?.images?.[0]?.source;
  if (src) return { url: decodeUrl(src.url), width: src.width, height: src.height };
  if (post.thumbnail && post.thumbnail !== "self" && post.thumbnail !== "default" && post.thumbnail.startsWith("http")) {
    return { url: post.thumbnail, width: post.thumbnail_width, height: post.thumbnail_height };
  }
  return null;
}

function getGalleryImages(post: RedditPost) {
  if (!post.media_metadata || !post.gallery_data?.items) return [];
  return post.gallery_data.items.map(({ media_id, caption }) => {
    const meta = post.media_metadata![media_id];
    if (!meta?.s) return null;
    return { url: decodeUrl(meta.s.u), width: meta.s.x, height: meta.s.y, caption };
  }).filter((x): x is NonNullable<typeof x> => x !== null);
}

async function handlePost(permalink: string, c: Context): Promise<Response> {
  const originalUrl = `https://www.reddit.com${permalink}`;
  const dParam = c.req.query("d") ?? c.req.query("dir") ?? c.req.query("direct");
  const isDirect = dParam !== undefined;

  const ua = c.req.header("user-agent");
  if (!isBot(ua) && !isDirect) return c.redirect(originalUrl, 302);

  const post = await fetchRedditPost(permalink);
  if (!post) return c.redirect(originalUrl, 302);

  const effective = post.crosspost_parent_list?.[0] ?? post;
  const authorLabel = `u/${post.author} on r/${post.subreddit}`;
  const host = getOrigin(c);

  const comments = effective.num_comments ?? 0;
  const ups = effective.ups ?? 0;
  const metricsArr = [];
  if (comments > 0) metricsArr.push(`💬 ${formatNumber(comments)}`);
  if (ups > 0) metricsArr.push(`❤️ ${formatNumber(ups)}`);

  const textBody = post.selftext?.trim() || "";
  let fullDesc = post.title + (textBody ? `\n\n${textBody}` : "");
  if (metricsArr.length > 0) fullDesc += `\n\n${metricsArr.join(" ")}`;

  let dateStr = "";
  if (effective.created_utc) {
    try {
      const d = new Date(effective.created_utc * 1000);
      dateStr = ` • ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    } catch { }
  }
  const customSiteName = `Reddit${dateStr}`;

  const vid = effective.media?.reddit_video ?? effective.secure_media?.reddit_video;
  const isVideo = vid || effective.post_hint === "hosted:video";
  const oembedUrl = `${host}/reddit/oembed?title=${encodeURIComponent(post.title)}&url=${encodeURIComponent(originalUrl)}&type=${isVideo ? "video" : "link"}&provider=${encodeURIComponent(customSiteName)}`;

  const imgIndexParam = c.req.query("img_index") ?? c.req.query("index");
  const embedIndex = imgIndexParam ? parseInt(imgIndexParam, 10) - 1 : -1;

  if (isDirect) {
    if (isVideo) return c.redirect(`${host}/reddit/video${permalink}`, 302);
    const gallery = getGalleryImages(effective);
    if (gallery.length > 0) return c.redirect(gallery[Math.max(0, Math.min(embedIndex >= 0 ? embedIndex : 0, gallery.length - 1))].url, 302);
    const preview = getPreviewImage(effective);
    if (preview) return c.redirect(preview.url, 302);
    return c.redirect(originalUrl, 302);
  }

  if (isVideo) {
    const thumb = getPreviewImage(effective);
    return c.html(buildEmbedHtml({ title: authorLabel, description: fullDesc, url: originalUrl, videoUrl: `${host}/reddit/video${permalink}`, videoWidth: vid?.width ?? 1280, videoHeight: vid?.height ?? 720, imageUrl: thumb?.url, color: REDDIT_COLOR, siteName: customSiteName, twitterCard: "player", oembedUrl }));
  }

  const gallery = getGalleryImages(effective);
  if (gallery.length > 1) {
    const first = gallery[Math.max(0, Math.min(embedIndex >= 0 ? embedIndex : 0, gallery.length - 1))];
    return c.html(buildEmbedHtml({ title: authorLabel, description: fullDesc, url: originalUrl, imageUrl: first.url, imageWidth: first.width, imageHeight: first.height, color: REDDIT_COLOR, siteName: customSiteName, largeImage: true, oembedUrl }));
  }

  const preview = getPreviewImage(effective);
  if (effective.post_hint === "image" || effective.is_reddit_media_domain) {
    return c.html(buildEmbedHtml({ title: authorLabel, description: fullDesc, url: originalUrl, imageUrl: effective.url ?? preview?.url, imageWidth: preview?.width, imageHeight: preview?.height, color: REDDIT_COLOR, siteName: customSiteName, largeImage: true, oembedUrl }));
  }

  if (preview) {
    return c.html(buildEmbedHtml({ title: authorLabel, description: fullDesc, url: originalUrl, imageUrl: preview.url, imageWidth: preview.width, imageHeight: preview.height, color: REDDIT_COLOR, siteName: customSiteName, oembedUrl }));
  }

  return c.html(buildEmbedHtml({ title: authorLabel, description: fullDesc, url: originalUrl, color: REDDIT_COLOR, siteName: customSiteName, oembedUrl }));
}

export const redditRouter = new Hono();

redditRouter.get("/oembed", c => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: (q.type as any) || "link", author_name: q.title, author_url: q.url, provider_name: q.provider ?? "LinkEmbedder / Reddit" }));
});

redditRouter.get("/video/*", async c => {
  const permalink = c.req.path.replace("/reddit/video", "");
  const post = await fetchRedditPost(permalink);
  if (!post) return new Response("Not found", { status: 404 });
  const effective = post.crosspost_parent_list?.[0] ?? post;
  const vid = effective.media?.reddit_video ?? effective.secure_media?.reddit_video;
  if (!vid) return new Response("No video", { status: 404 });

  const fallbackUrl = vid.fallback_url.replace("?source=fallback", "");
  if (!vid.has_audio) {
    return c.redirect(fallbackUrl, 302);
  }

  const audioUrl = fallbackUrl.substring(0, fallbackUrl.lastIndexOf("/")) + "/DASH_AUDIO_128.mp4";

  try {
    const audioRes = await fetch(audioUrl, { method: "HEAD" });
    if (!audioRes.ok) {
      return c.redirect(fallbackUrl, 302);
    }
  } catch {
    return c.redirect(fallbackUrl, 302);
  }

  const stream = streamMux(fallbackUrl, audioUrl);
  return new Response(stream as any, { headers: { "Content-Type": "video/mp4", "Cache-Control": "public, max-age=86400" } });
});

redditRouter.get("/r/:sub/comments/:id{[^/]+}", c => handlePost(`/r/${c.req.param("sub")}/comments/${c.req.param("id")}`, c));
redditRouter.get("/r/:sub/comments/:id/:slug", c => handlePost(`/r/${c.req.param("sub")}/comments/${c.req.param("id")}/${c.req.param("slug").split("/")[0]}`, c));
redditRouter.get("/r/:sub/comments/:id/:slug/:comment", c => handlePost(`/r/${c.req.param("sub")}/comments/${c.req.param("id")}/${c.req.param("slug").split("/")[0]}`, c));

redditRouter.get("/user/:name/comments/:id/:slug", c => handlePost(`/user/${c.req.param("name")}/comments/${c.req.param("id")}`, c));
redditRouter.get("/u/:name/comments/:id/:slug", c => handlePost(`/u/${c.req.param("name")}/comments/${c.req.param("id")}`, c));

redditRouter.get("/r/:sub/s/:shareId", async c => {
  const { sub, shareId } = c.req.param();
  const resolved = await resolveShareLink(sub, shareId);
  if (!resolved) return c.redirect(`https://www.reddit.com/r/${sub}/s/${shareId}`, 302);
  return handlePost(new URL(resolved).pathname, c);
});

redditRouter.get("/comments/:id", c => handlePost(`/comments/${c.req.param("id")}`, c));
redditRouter.get("/comments/:id/:slug", c => handlePost(`/comments/${c.req.param("id")}`, c));
redditRouter.get("/gallery/:id", c => handlePost(`/gallery/${c.req.param("id")}`, c));
redditRouter.get("/:id", c => {
  const id = c.req.param("id");
  if (id.includes(".")) return c.redirect(`https://www.reddit.com/${id}`, 302);
  return handlePost(`/${id}`, c);
});

function extractRedditParams(urlStr: string): string | null {
  try {
    const url = new URL(urlStr);
    if (url.hostname.includes("reddit.com") || url.hostname.includes("redd.it")) {
      return url.pathname;
    }
  } catch {
    if (urlStr.startsWith("/r/") || urlStr.startsWith("/user/") || urlStr.startsWith("/u/") || urlStr.startsWith("/comments/") || urlStr.startsWith("/gallery/")) return urlStr;
  }
  return null;
}

redditRouter.get("/", c => {
  const url = c.req.query("url");
  if (url) {
    const p = extractRedditParams(url);
    if (p) return handlePost(p, c);
  }
  return new Response("Not found", { status: 404 });
});

redditRouter.get("/*", c => {
  const { path } = c.req;
  const httpMatch = path.match(/(https?:\/\/[^\s]+)/);
  if (httpMatch) {
    const p = extractRedditParams(httpMatch[1]);
    if (p) return handlePost(p, c);
  }
  return new Response("Not found", { status: 404 });
});
