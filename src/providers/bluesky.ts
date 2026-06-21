import { Context, Hono } from "hono";

import { isBot } from "../utils/bot.js";
import { blueskyCache } from "../utils/cache.js";
import { buildEmbedHtml, buildOEmbed } from "../utils/html.js";
import { createMosaic } from "../utils/image.js";

const BSKY_COLOR = "#0085FF";
const BSKY_API = "https://public.api.bsky.app/xrpc";

interface BskyImage { thumb: string; fullsize: string; aspectRatio?: { width: number; height: number }; alt?: string; }
interface BskyEmbed {
  $type: string;
  images?: BskyImage[];
  cid?: string; thumbnail?: string; aspectRatio?: { width: number; height: number };
  external?: { uri: string; title?: string; description?: string; thumb?: string };
  media?: BskyEmbed; record?: BskyEmbed;
}
interface BskyAuthor { did: string; handle: string; displayName?: string; avatar?: string; followersCount?: number; followsCount?: number; postsCount?: number; description?: string; }
interface BskyPost { uri: string; cid: string; author: BskyAuthor; record: { text?: string }; embed?: BskyEmbed; likeCount?: number; repostCount?: number; replyCount?: number; }
interface BskyThreadView { $type: string; post?: BskyPost; }

async function fetchPost(actor: string, rkey: string): Promise<BskyPost | null> {
  const cacheKey = `${actor}/${rkey}`;
  const cached = blueskyCache.get(cacheKey) as BskyPost | undefined;
  if (cached) return cached;
  try {
    const uri = `at://${actor}/app.bsky.feed.post/${rkey}`;
    const res = await fetch(`${BSKY_API}/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0`, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const json = await res.json() as { thread?: BskyThreadView };
    const post = json.thread?.post;
    if (!post) return null;
    blueskyCache.set(cacheKey, post);
    return post;
  } catch { return null; }
}

async function fetchProfile(actor: string): Promise<BskyAuthor | null> {
  const cached = blueskyCache.get(`profile:${actor}`) as BskyAuthor | undefined;
  if (cached) return cached;
  try {
    const res = await fetch(`${BSKY_API}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const profile = await res.json() as BskyAuthor;
    blueskyCache.set(`profile:${actor}`, profile);
    return profile;
  } catch { return null; }
}

function getImages(embed: BskyEmbed | undefined): BskyImage[] {
  if (!embed) return [];
  if (embed.$type === "app.bsky.embed.images#view" && embed.images) return embed.images;
  if (embed.$type === "app.bsky.embed.recordWithMedia#view" && embed.media) return getImages(embed.media);
  return [];
}

function getVideo(embed: BskyEmbed | undefined, did: string): { url: string; width?: number; height?: number; thumb?: string } | null {
  if (!embed) return null;
  const check = (e: BskyEmbed) => {
    if (e.$type === "app.bsky.embed.video#view" && e.cid) {
      const url = `https://bsky.social/xrpc/com.atproto.sync.getBlob?cid=${e.cid}&did=${did}`;
      return { url, width: e.aspectRatio?.width, height: e.aspectRatio?.height, thumb: e.thumbnail };
    }
    return null;
  };
  if (embed.$type === "app.bsky.embed.recordWithMedia#view" && embed.media) return check(embed.media);
  return check(embed);
}

async function handlePostEmbed(c: Context, user: string, postId: string, embedIndex = -1): Promise<Response> {
  const ua = c.req.header("user-agent");
  const originalUrl = `https://bsky.app/profile/${user}/post/${postId}`;
  if (!isBot(ua)) return c.redirect(originalUrl, 302);

  const post = await fetchPost(user, postId);
  if (!post) return c.redirect(originalUrl, 302);

  const displayName = post.author.displayName ?? post.author.handle;
  const authorName = `${displayName} (@${post.author.handle})`;
  const text = post.record?.text ?? "";
  const host = new URL(c.req.url).origin;
  const oembedUrl = `${host}/bsky/oembed?author=${encodeURIComponent(authorName)}&url=${encodeURIComponent(originalUrl)}`;
  const description = text;

  const video = getVideo(post.embed, post.author.did);
  if (video) return c.html(buildEmbedHtml({ description, url: originalUrl, videoUrl: video.url, videoWidth: video.width ?? 1080, videoHeight: video.height ?? 1080, imageUrl: video.thumb, color: BSKY_COLOR, siteName: "Bluesky", twitterCard: "player", oembedUrl }));

  const images = getImages(post.embed);
  if (images.length) {
    if (embedIndex >= 0) {
      const idx = Math.min(embedIndex, images.length - 1);
      const photo = images[idx];
      return c.html(buildEmbedHtml({ description, url: originalUrl, imageUrl: photo.fullsize, imageWidth: photo.aspectRatio?.width, imageHeight: photo.aspectRatio?.height, color: BSKY_COLOR, siteName: "Bluesky", largeImage: true, oembedUrl }));
    } else if (images.length > 1) {
      const imageUrl = `${host}/bsky/grid/${user}/${postId}`;
      return c.html(buildEmbedHtml({ description, url: originalUrl, imageUrl, color: BSKY_COLOR, siteName: "Bluesky", largeImage: true, oembedUrl }));
    } else {
      const first = images[0];
      return c.html(buildEmbedHtml({ description, url: originalUrl, imageUrl: first.fullsize, imageWidth: first.aspectRatio?.width, imageHeight: first.aspectRatio?.height, color: BSKY_COLOR, siteName: "Bluesky", largeImage: true, oembedUrl }));
    }
  }

  const ext = post.embed?.$type === "app.bsky.embed.external#view" ? post.embed.external : undefined;
  return c.html(buildEmbedHtml({ description: description || ext?.description, url: originalUrl, imageUrl: ext?.thumb ?? post.author.avatar, color: BSKY_COLOR, siteName: "Bluesky", oembedUrl }));
}

async function handleProfileEmbed(c: Context, user: string): Promise<Response> {
  const ua = c.req.header("user-agent");
  const originalUrl = `https://bsky.app/profile/${user}`;
  if (!isBot(ua)) return c.redirect(originalUrl, 302);
  const profile = await fetchProfile(user);
  if (!profile) return c.redirect(originalUrl, 302);
  const displayName = profile.displayName ?? profile.handle;
  return c.html(buildEmbedHtml({ title: `${displayName} (@${profile.handle})`, description: profile.description, url: originalUrl, imageUrl: profile.avatar, color: BSKY_COLOR, siteName: "Bluesky" }));
}

export const blueskyRouter = new Hono();

blueskyRouter.get("/oembed", c => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: "link", author_name: q.author, author_url: q.url, provider_name: "LinkEmbedder / Bluesky" }));
});

blueskyRouter.get("/grid/:user/:post", async c => {
  const user = c.req.param("user");
  const postId = c.req.param("post");
  const post = await fetchPost(user, postId);
  if (!post) return new Response("Not found", { status: 404 });
  const images = getImages(post.embed).map(i => i.fullsize);
  if (!images.length) return new Response("Not found", { status: 404 });
  const buffer = await createMosaic(images);
  if (!buffer) return c.redirect(images[0], 302);
  return new Response(buffer as any, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" } });
});

blueskyRouter.get("/profile/:user/post/:post", c => handlePostEmbed(c, c.req.param("user"), c.req.param("post")));
blueskyRouter.get("/profile/:user/post/:post/:index", c => handlePostEmbed(c, c.req.param("user"), c.req.param("post"), parseInt(c.req.param("index") ?? "1", 10) - 1));
blueskyRouter.get("/https://bsky.app/profile/:user/post/:post", c => handlePostEmbed(c, c.req.param("user"), c.req.param("post")));
blueskyRouter.get("/https://bsky.app/profile/:user/post/:post/:index", c => handlePostEmbed(c, c.req.param("user"), c.req.param("post"), parseInt(c.req.param("index") ?? "1", 10) - 1));
blueskyRouter.get("/profile/:user", c => handleProfileEmbed(c, c.req.param("user")));
blueskyRouter.get("/https://bsky.app/profile/:user", c => handleProfileEmbed(c, c.req.param("user")));
