import { Context, Hono } from "hono";

import { getOrigin, isBot } from "../utils/bot.js";
import { deviantartCache } from "../utils/cache.js";
import { buildEmbedHtml, buildOEmbed } from "../utils/html.js";

const DA_COLOR = "#05cc47";

interface DAoEmbed {
  title: string;
  url: string;
  author_name: string;
  provider_name: string;
  fullsize_url?: string;
  thumbnail_url?: string;
}

async function fetchDAInfo(url: string): Promise<DAoEmbed | null> {
  const cached = deviantartCache.get(url) as DAoEmbed | undefined;
  if (cached) return cached;

  try {
    const daCookie = process.env.DA_COOKIE;
    const headers: Record<string, string> = {};
    if (daCookie) {
      try {
        const cookies = JSON.parse(daCookie);
        headers.Cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
      } catch { }
    }

    const res = await fetch(`https://backend.deviantart.com/oembed?url=${encodeURIComponent(url)}`, { headers });
    if (!res.ok) return null;
    const data = await res.json() as DAoEmbed;
    deviantartCache.set(url, data);
    return data;
  } catch { return null; }
}

async function handleDAEmbed(c: Context, originalUrl: string): Promise<Response> {
  const dParam = c.req.query("d") ?? c.req.query("dir") ?? c.req.query("direct");
  const isDirect = dParam !== undefined;

  const ua = c.req.header("user-agent");
  if (!isBot(ua) && !isDirect) return c.redirect(originalUrl, 302);

  const info = await fetchDAInfo(originalUrl);
  if (!info) return c.redirect(originalUrl, 302);

  const host = getOrigin(c);

  if (isDirect) {
    return c.redirect(info.fullsize_url ?? info.url ?? info.thumbnail_url ?? originalUrl, 302);
  }

  const customSiteName = "DeviantArt";
  const oembedUrl = `${host}/deviantart/oembed?title=${encodeURIComponent(info.title)}&author=${encodeURIComponent(info.author_name)}&url=${encodeURIComponent(originalUrl)}&provider=${encodeURIComponent(customSiteName)}`;

  return c.html(buildEmbedHtml({
    title: `${info.title} by ${info.author_name}`,
    description: "",
    url: originalUrl,
    imageUrl: info.fullsize_url ?? info.url ?? info.thumbnail_url,
    color: DA_COLOR,
    siteName: customSiteName,
    largeImage: true,
    oembedUrl
  }));
}

export const deviantartRouter = new Hono();

deviantartRouter.get("/oembed", c => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: "photo", title: q.title, author_name: q.author, author_url: q.url, provider_name: q.provider ?? "LinkEmbedder / DeviantArt" }));
});

function extractDAUrl(urlStr: string): string | null {
  try {
    const url = new URL(urlStr);
    if (url.hostname.includes("deviantart.com")) return urlStr;
  } catch {
    const match = urlStr.match(/(https?:\/\/(?:www\.)?deviantart\.com\/[^\s]+)/);
    if (match) return match[1];
    if (urlStr.startsWith("/")) return `https://www.deviantart.com${urlStr}`;
  }
  return null;
}

deviantartRouter.get("/", c => {
  const url = c.req.query("url");
  if (url) {
    const p = extractDAUrl(url);
    if (p) return handleDAEmbed(c, p);
  }
  return new Response("Not found", { status: 404 });
});

deviantartRouter.get("/*", c => {
  const path = c.req.path.replace("/deviantart", "").replace("/da", "");
  const httpMatch = path.match(/(https?:\/\/[^\s]+)/);
  if (httpMatch) {
    const p = extractDAUrl(httpMatch[1]);
    if (p) return handleDAEmbed(c, p);
  }
  if (path && path !== "/") {
    return handleDAEmbed(c, `https://www.deviantart.com${path}`);
  }
  return new Response("Not found", { status: 404 });
});
