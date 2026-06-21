import { Context, Hono } from "hono";

import { getOrigin, isBot } from "../utils/bot.js";
import { tumblrCache } from "../utils/cache.js";
import { buildEmbedHtml, buildOEmbed } from "../utils/html.js";
import { createMosaic } from "../utils/image.js";

const TUMBLR_COLOR = "#35465C";

interface TumblrMedia { url?: string; type?: string; width?: number; height?: number; }
interface TumblrFormatting { start: number; end: number; type: string; url?: string; }
interface TumblrBlock { type: string; text?: string; formatting?: TumblrFormatting[]; media?: TumblrMedia[]; url?: string; poster?: TumblrMedia[]; }
interface TumblrPost { id_string: string; blog_name: string; summary?: string; content?: TumblrBlock[]; trail?: Array<{ content?: TumblrBlock[] }>; shortUrl?: string; }

async function fetchPost(blog: string, postId: string): Promise<TumblrPost | null> {
  const apiKey = process.env.TUMBLR_API_KEY;
  if (!apiKey) { console.warn("[tumblr] TUMBLR_API_KEY not set"); return null; }
  const cacheKey = `${blog}:${postId}`;
  const cached = tumblrCache.get(cacheKey) as TumblrPost | undefined;
  if (cached) return cached;
  try {
    const res = await fetch(`https://api.tumblr.com/v2/blog/${blog}/posts/${postId}?npf=true&api_key=${encodeURIComponent(apiKey)}`, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const json = await res.json() as { meta: { status: number }; response?: { posts?: TumblrPost[] } };
    const post = json.response?.posts?.[0];
    if (!post) return null;
    tumblrCache.set(cacheKey, post);
    return post;
  } catch { return null; }
}

function getAllBlocks(post: TumblrPost): TumblrBlock[] {
  return [...(post.content ?? []), ...(post.trail ?? []).flatMap(t => t.content ?? [])];
}

function getImages(blocks: TumblrBlock[]): Array<{ url: string; width?: number; height?: number }> {
  const imgs: Array<{ url: string; width?: number; height?: number }> = [];
  for (const b of blocks) {
    if (b.type === "image" && b.media?.length) {
      const best = b.media.reduce((a, c) => ((c.width ?? 0) > (a.width ?? 0) ? c : a));
      if (best.url) imgs.push({ url: best.url, width: best.width, height: best.height });
    }
  }
  return imgs;
}

function getFirstVideo(blocks: TumblrBlock[]): { url: string; width?: number; height?: number; poster?: string } | null {
  for (const b of blocks) {
    if (b.type === "video" && b.media) {
      for (const m of b.media) {
        if (m.url && m.type?.startsWith("video")) return { url: m.url, width: m.width, height: m.height, poster: b.poster?.[0]?.url };
      }
    }
  }
  return null;
}

function parseTextBlocks(blocks: TumblrBlock[]): string {
  let res = "";
  for (const b of blocks) {
    if (b.type === "text" && b.text) {
      res += b.text + "\n";
    }
  }
  return res.trim().slice(0, 500);
}

async function handleEmbed(c: Context, blog: string, postId: string): Promise<Response> {
  const ua = c.req.header("user-agent");
  const originalUrl = `https://www.tumblr.com/${blog}/${postId}`;
  if (!isBot(ua)) return c.redirect(originalUrl, 302);

  const post = await fetchPost(blog, postId);
  if (!post) return c.redirect(originalUrl, 302);

  const host = getOrigin(c);
  const postUrl = post.shortUrl ?? originalUrl;
  const title = `${post.blog_name} on Tumblr`;
  const blocks = getAllBlocks(post);
  const video = getFirstVideo(blocks);
  const oembedUrl = `${host}/tumblr/oembed?blog=${encodeURIComponent(post.blog_name)}&url=${encodeURIComponent(postUrl)}&type=${video ? "video" : "link"}`;

  const textContent = parseTextBlocks(blocks);
  const description = post.summary && post.summary !== textContent ? `${post.summary}\n\n${textContent}` : textContent;

  if (video) return c.html(buildEmbedHtml({ title, description, url: postUrl, proxyUrl: c.req.url, videoUrl: video.url, videoWidth: video.width ?? 1280, videoHeight: video.height ?? 720, imageUrl: video.poster, color: TUMBLR_COLOR, siteName: "Tumblr", twitterCard: "player", oembedUrl }));

  const images = getImages(blocks);
  if (images.length > 1) {
    const imageUrl = `${host}/tumblr/grid/${blog}/${postId}`;
    return c.html(buildEmbedHtml({ title, description, url: postUrl, proxyUrl: c.req.url, imageUrl, color: TUMBLR_COLOR, siteName: "Tumblr", largeImage: true, oembedUrl }));
  } else if (images.length === 1) {
    const image = images[0];
    return c.html(buildEmbedHtml({ title, description, url: postUrl, proxyUrl: c.req.url, imageUrl: image.url, imageWidth: image.width, imageHeight: image.height, color: TUMBLR_COLOR, siteName: "Tumblr", largeImage: true, oembedUrl }));
  }

  return c.html(buildEmbedHtml({ title, description, url: postUrl, proxyUrl: c.req.url, color: TUMBLR_COLOR, siteName: "Tumblr", oembedUrl }));
}

export const tumblrRouter = new Hono();

tumblrRouter.get("/oembed", c => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: (q.type as any) || "link", author_name: q.blog, author_url: q.url, provider_name: "LinkEmbedder / Tumblr" }));
});

tumblrRouter.get("/grid/:blog/:id", async c => {
  const blog = c.req.param("blog");
  const postId = c.req.param("id");
  const post = await fetchPost(blog, postId);
  if (!post) return new Response("Not found", { status: 404 });
  const blocks = getAllBlocks(post);
  const imgs = getImages(blocks).map(i => i.url);
  if (!imgs.length) return new Response("Not found", { status: 404 });
  const buffer = await createMosaic(imgs);
  if (!buffer) return c.redirect(imgs[0], 302);
  return new Response(buffer as any, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" } });
});

tumblrRouter.get("/:blog/:id", c => handleEmbed(c, c.req.param("blog"), c.req.param("id")));
tumblrRouter.get("/:blog/:id/:slug", c => handleEmbed(c, c.req.param("blog"), c.req.param("id")));
