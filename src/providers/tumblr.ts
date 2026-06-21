import { Hono } from 'hono';
import type { Context } from 'hono';
import { isBot } from '../utils/bot.js';
import { buildEmbedHtml, buildOEmbed } from '../utils/html.js';
import { tumblrCache } from '../utils/cache.js';

const TUMBLR_COLOR = '#35465C';

interface TumblrMedia { url?: string; type?: string; width?: number; height?: number; }
interface TumblrBlock { type: string; text?: string; media?: TumblrMedia[]; url?: string; poster?: TumblrMedia[]; }
interface TumblrPost { id_string: string; blog_name: string; summary?: string; content?: TumblrBlock[]; trail?: Array<{ content?: TumblrBlock[] }>; shortUrl?: string; }

async function fetchPost(blog: string, postId: string): Promise<TumblrPost | null> {
  const apiKey = process.env.TUMBLR_API_KEY;
  if (!apiKey) { console.warn('[tumblr] TUMBLR_API_KEY not set'); return null; }
  const cacheKey = `${blog}:${postId}`;
  const cached = tumblrCache.get(cacheKey) as TumblrPost | undefined;
  if (cached) return cached;
  try {
    const res = await fetch(`https://api.tumblr.com/v2/blog/${blog}/posts/${postId}?npf=true&api_key=${encodeURIComponent(apiKey)}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const json = await res.json() as { meta: { status: number }; response?: { posts?: TumblrPost[] } };
    const post = json.response?.posts?.[0];
    if (!post) return null;
    tumblrCache.set(cacheKey, post);
    return post;
  } catch { return null; }
}

function getAllBlocks(post: TumblrPost): TumblrBlock[] {
  return [...(post.content ?? []), ...(post.trail ?? []).flatMap((t) => t.content ?? [])];
}

function getFirstImage(blocks: TumblrBlock[]): { url: string; width?: number; height?: number } | null {
  for (const b of blocks) {
    if (b.type === 'image' && b.media?.length) {
      const best = b.media.reduce((a, c) => ((c.width ?? 0) > (a.width ?? 0) ? c : a));
      if (best.url) return { url: best.url, width: best.width, height: best.height };
    }
  }
  return null;
}

function getFirstVideo(blocks: TumblrBlock[]): { url: string; width?: number; height?: number; poster?: string } | null {
  for (const b of blocks) {
    if (b.type === 'video' && b.media) {
      for (const m of b.media) {
        if (m.url && m.type?.startsWith('video')) return { url: m.url, width: m.width, height: m.height, poster: b.poster?.[0]?.url };
      }
    }
  }
  return null;
}

async function handleEmbed(c: Context, blog: string, postId: string): Promise<Response> {
  const ua = c.req.header('user-agent');
  const originalUrl = `https://www.tumblr.com/${blog}/${postId}`;
  if (!isBot(ua)) return c.redirect(originalUrl, 302);

  const post = await fetchPost(blog, postId);
  if (!post) return c.redirect(originalUrl, 302);

  const host = new URL(c.req.url).origin;
  const postUrl = post.shortUrl ?? originalUrl;
  const title = `${post.blog_name} on Tumblr`;
  const oembedUrl = `${host}/tumblr/oembed?blog=${encodeURIComponent(post.blog_name)}&url=${encodeURIComponent(postUrl)}`;
  const blocks = getAllBlocks(post);
  const description = post.summary ?? blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text!).join('\n').slice(0, 500);

  const video = getFirstVideo(blocks);
  if (video) return c.html(buildEmbedHtml({ title, description, url: postUrl, videoUrl: video.url, videoWidth: video.width ?? 1280, videoHeight: video.height ?? 720, imageUrl: video.poster, color: TUMBLR_COLOR, siteName: 'Tumblr', twitterCard: 'player', oembedUrl }));

  const image = getFirstImage(blocks);
  if (image) return c.html(buildEmbedHtml({ title, description, url: postUrl, imageUrl: image.url, imageWidth: image.width, imageHeight: image.height, color: TUMBLR_COLOR, siteName: 'Tumblr', largeImage: true, oembedUrl }));

  return c.html(buildEmbedHtml({ title, description, url: postUrl, color: TUMBLR_COLOR, siteName: 'Tumblr', oembedUrl }));
}

export const tumblrRouter = new Hono();

tumblrRouter.get('/oembed', (c) => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: 'link', author_name: q.blog, author_url: q.url, provider_name: 'LinkEmbeder / Tumblr' }));
});

tumblrRouter.get('/:blog/:id', (c) => handleEmbed(c, c.req.param('blog'), c.req.param('id')));
tumblrRouter.get('/:blog/:id/:slug', (c) => handleEmbed(c, c.req.param('blog'), c.req.param('id')));
