import { Context, Hono } from "hono";

import { getOrigin, isBot } from "../utils/bot.js";
import { facebookCache } from "../utils/cache.js";
import { buildEmbedHtml, buildOEmbed } from "../utils/html.js";

const FACEBOOK_COLOR = "#395898";
const API_KEY = "vkrdownloader";

interface FacebookVideoInfo {
  title: string;
  description: string;
  source: string;
  downloads: Array<{ url: string; ext: string; format_id: string; }>;
}

async function fetchFacebookInfo(url: string): Promise<FacebookVideoInfo | null> {
  const cached = facebookCache.get(url) as FacebookVideoInfo | undefined;
  if (cached) return cached;

  try {
    const res = await fetch(`https://vkrdownloader.xyz/server/?api_key=${API_KEY}&vkr=${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (data.error || !data.data) return null;
    facebookCache.set(url, data.data);
    return data.data;
  } catch { return null; }
}

async function handleFacebookEmbed(c: Context, url: string): Promise<Response> {
  const dParam = c.req.query("d") ?? c.req.query("dir") ?? c.req.query("direct");
  const isDirect = dParam !== undefined;

  const ua = c.req.header("user-agent");
  if (!isBot(ua) && !isDirect) return c.redirect(url, 302);

  const post = await fetchFacebookInfo(url);
  if (!post || !post.downloads) return c.redirect(url, 302);

  const download = post.downloads.find(d => d.ext === "mp4" && d.format_id.includes("hd")) || post.downloads.find(d => d.ext === "mp4");
  if (!download) return c.redirect(url, 302);

  if (isDirect) {
    return c.redirect(download.url, 302);
  }

  const description = post.description || "Facebook Video";
  const host = getOrigin(c);
  const oembedUrl = `${host}/facebook/oembed?title=${encodeURIComponent("Facebook Reels")}&url=${encodeURIComponent(post.source || url)}`;

  return c.html(buildEmbedHtml({
    title: description,
    description: "",
    url: post.source || url,
    videoUrl: download.url,
    videoWidth: 720,
    videoHeight: 1280,
    color: FACEBOOK_COLOR,
    siteName: "Facebook",
    twitterCard: "player",
    oembedUrl
  }));
}

export const facebookRouter = new Hono();

facebookRouter.get("/oembed", c => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: "video", author_name: q.title, author_url: q.url, provider_name: "LinkEmbedder / Facebook" }));
});

facebookRouter.get("/share/r/:id", c => handleFacebookEmbed(c, `https://www.facebook.com/share/r/${c.req.param("id")}`));
facebookRouter.get("/reel/:id", c => handleFacebookEmbed(c, `https://www.facebook.com/reel/${c.req.param("id")}`));
facebookRouter.get("/share/v/:id", c => handleFacebookEmbed(c, `https://www.facebook.com/share/v/${c.req.param("id")}`));
facebookRouter.get("/watch", c => handleFacebookEmbed(c, `https://www.facebook.com/watch/?${new URLSearchParams(c.req.query()).toString()}`));

function extractFacebookUrl(urlStr: string): string | null {
  try {
    const url = new URL(urlStr);
    if (url.hostname.includes("facebook.com") || url.hostname.includes("fb.watch") || url.hostname.includes("fb.gg")) {
      return urlStr;
    }
  } catch {
    const match = urlStr.match(/(https?:\/\/(?:www\.)?(?:facebook\.com|fb\.watch|fb\.gg)\/[^\s]+)/);
    if (match) return match[1];
  }
  return null;
}

facebookRouter.get("/", c => {
  const url = c.req.query("url");
  if (url) {
    const p = extractFacebookUrl(url);
    if (p) return handleFacebookEmbed(c, p);
  }
  return new Response("Not found", { status: 404 });
});

facebookRouter.get("/*", c => {
  const { path } = c.req;
  const httpMatch = path.match(/(https?:\/\/[^\s]+)/);
  if (httpMatch) {
    const p = extractFacebookUrl(httpMatch[1]);
    if (p) return handleFacebookEmbed(c, p);
  }
  return new Response("Not found", { status: 404 });
});
