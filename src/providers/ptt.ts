import * as cheerio from "cheerio";
import { Context, Hono } from "hono";

import { getOrigin, isBot } from "../utils/bot.js";
import { pttCache } from "../utils/cache.js";
import { buildEmbedHtml, buildOEmbed } from "../utils/html.js";

const PTT_COLOR = "#000000";

interface PttPost {
  author: string;
  title: string;
  content: string;
  images: string[];
  date?: string;
}

async function fetchPttPost(board: string, id: string): Promise<PttPost | null> {
  const url = `https://www.ptt.cc/bbs/${board}/${id}.html`;
  const cached = pttCache.get(url) as PttPost | undefined;
  if (cached) return cached;

  try {
    const res = await fetch(url, {
      headers: { Cookie: "over18=1", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36" }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    const metaValues = $(".article-meta-value");
    const author = metaValues.eq(0).text().trim();
    const title = metaValues.eq(2).text().trim() || "No Title";

    const rawDate = metaValues.eq(3).text().trim();
    let dateStr = "";
    if (rawDate) {
      try {
        const d = new Date(rawDate);
        if (!isNaN(d.getTime())) dateStr = ` • ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
      } catch { }
    }

    const mainContent = $("#main-content");
    mainContent.find("div, span").remove();
    let content = mainContent.text().trim();

    if (content.endsWith("--")) {
      content = content.slice(0, -2).trim();
    }

    const imageRegex = /https?:\/\/[^\s]+\.(?:jpg|png|gif|webp|jpeg)/g;
    const images: string[] = [];
    for (const match of content.matchAll(imageRegex)) {
      images.push(match[0]);
    }

    content = content.replace(imageRegex, "").replace(/\n{2,}/g, "\n").trim();

    const post: PttPost = { author, title, content: content.slice(0, 500), images, date: dateStr };
    pttCache.set(url, post);
    return post;
  } catch { return null; }
}

async function handlePttEmbed(c: Context, board: string, id: string, embedIndex = -1): Promise<Response> {
  const dParam = c.req.query("d") ?? c.req.query("dir") ?? c.req.query("direct");
  const isDirect = dParam !== undefined;

  const imgIndexParam = c.req.query("img_index") ?? c.req.query("index");
  if (imgIndexParam !== undefined && embedIndex === -1) {
    embedIndex = parseInt(imgIndexParam, 10) - 1;
  }

  const originalUrl = `https://www.ptt.cc/bbs/${board}/${id}.html`;
  const ua = c.req.header("user-agent");
  if (!isBot(ua) && !isDirect) return c.redirect(originalUrl, 302);

  const post = await fetchPttPost(board, id);
  if (!post) return c.redirect(originalUrl, 302);

  const host = getOrigin(c);
  const customSiteName = `PTT${post.date || ""}`;
  const oembedUrl = `${host}/ptt/oembed?title=${encodeURIComponent(post.title)}&author=${encodeURIComponent(post.author)}&url=${encodeURIComponent(originalUrl)}&provider=${encodeURIComponent(customSiteName)}`;

  if (isDirect) {
    if (post.images.length > 0) {
      const idx = Math.max(0, Math.min(embedIndex >= 0 ? embedIndex : 0, post.images.length - 1));
      return c.redirect(post.images[idx], 302);
    }
    return c.redirect(originalUrl, 302);
  }

  if (post.images.length > 1 && embedIndex < 0) {
    const imageUrl = `${host}/ptt/grid/${board}/${id}`;
    return c.html(buildEmbedHtml({ title: `${post.title} - ${post.author}`, description: post.content, url: originalUrl, imageUrl, color: PTT_COLOR, siteName: customSiteName, largeImage: true, oembedUrl }));
  }

  const idx = Math.max(0, Math.min(embedIndex >= 0 ? embedIndex : 0, post.images.length - 1));
  const selectedImage = post.images[idx];

  return c.html(buildEmbedHtml({
    title: `${post.title} - ${post.author}`,
    description: post.content,
    url: originalUrl,
    imageUrl: selectedImage,
    color: PTT_COLOR,
    siteName: customSiteName,
    largeImage: !!selectedImage,
    oembedUrl
  }));
}

export const pttRouter = new Hono();

pttRouter.get("/oembed", c => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: "link", title: q.title, author_name: q.author, author_url: q.url, provider_name: q.provider ?? "LinkEmbedder / PTT" }));
});

pttRouter.get("/grid/:board/:id", async c => {
  const board = c.req.param("board");
  const id = c.req.param("id");
  const post = await fetchPttPost(board, id);
  if (!post || !post.images.length) return new Response("Not found", { status: 404 });

  const { createMosaic } = await import("../utils/image.js");
  const buffer = await createMosaic(post.images);
  if (!buffer) return c.redirect(post.images[0], 302);

  return new Response(buffer as any, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" } });
});

pttRouter.get("/bbs/:board/:id", c => {
  const id = c.req.param("id").replace(".html", "");
  return handlePttEmbed(c, c.req.param("board"), id);
});

function extractPttParams(urlStr: string): { board: string; id: string; } | null {
  try {
    const url = new URL(urlStr);
    if (url.hostname.includes("ptt.cc")) {
      const match = url.pathname.match(/\/bbs\/([^/]+)\/([^.]+)\.html?/);
      if (match) return { board: match[1], id: match[2] };
    }
  } catch {
    const match = urlStr.match(/\/bbs\/([^/]+)\/([^.]+)\.html?/);
    if (match) return { board: match[1], id: match[2] };
  }
  return null;
}

pttRouter.get("/", c => {
  const url = c.req.query("url");
  if (url) {
    const p = extractPttParams(url);
    if (p) return handlePttEmbed(c, p.board, p.id);
  }
  return new Response("Not found", { status: 404 });
});

pttRouter.get("/*", c => {
  const { path } = c.req;
  const httpMatch = path.match(/(https?:\/\/[^\s]+)/);
  if (httpMatch) {
    const p = extractPttParams(httpMatch[1]);
    if (p) return handlePttEmbed(c, p.board, p.id);
  }
  return new Response("Not found", { status: 404 });
});
