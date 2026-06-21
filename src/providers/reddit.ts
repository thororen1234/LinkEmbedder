import { Hono } from 'hono';
import type { Context } from 'hono';
import { isBot } from '../utils/bot.js';
import { buildEmbedHtml, buildOEmbed } from '../utils/html.js';
import { redditCache } from '../utils/cache.js';

const REDDIT_COLOR = '#FF4500';

interface RedditPost {
  subreddit: string; title: string; author: string; permalink: string;
  selftext?: string; post_hint?: string; url?: string; domain?: string;
  is_reddit_media_domain?: boolean;
  media?: { reddit_video?: { fallback_url: string; width: number; height: number } };
  secure_media?: { reddit_video?: { fallback_url: string; width: number; height: number } };
  preview?: { images?: Array<{ source?: { url: string; width: number; height: number } }> };
  gallery_data?: { items: Array<{ media_id: string; caption?: string }> };
  media_metadata?: Record<string, { s?: { u: string; x: number; y: number } }>;
  crosspost_parent_list?: RedditPost[];
  thumbnail?: string; thumbnail_width?: number; thumbnail_height?: number;
}

async function fetchRedditPost(permalink: string): Promise<RedditPost | null> {
  const cached = redditCache.get(permalink) as RedditPost | undefined;
  if (cached) return cached;
  try {
    const res = await fetch(`https://www.reddit.com${permalink}.json?limit=1&raw_json=1`, {
      headers: { 'User-Agent': 'LinkEmbedder/1.0', Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = await res.json() as unknown[];
    const post = (json[0] as { data: { children: Array<{ data: RedditPost }> } })?.data?.children?.[0]?.data;
    if (!post) return null;
    redditCache.set(permalink, post);
    return post;
  } catch { return null; }
}

async function resolveShareLink(sub: string, shareId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://www.reddit.com/r/${sub}/s/${shareId}`, { redirect: 'manual', headers: { 'User-Agent': 'LinkEmbedder/1.0' } });
    return res.headers.get('location');
  } catch { return null; }
}

function decodeUrl(url: string) { return url.replace(/&amp;/g, '&'); }

function getPreviewImage(post: RedditPost) {
  const src = post.preview?.images?.[0]?.source;
  if (src) return { url: decodeUrl(src.url), width: src.width, height: src.height };
  if (post.thumbnail && post.thumbnail !== 'self' && post.thumbnail !== 'default' && post.thumbnail.startsWith('http')) {
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
  const ua = c.req.header('user-agent');
  if (!isBot(ua)) return c.redirect(originalUrl, 302);

  const post = await fetchRedditPost(permalink);
  if (!post) return c.redirect(originalUrl, 302);

  const effective = post.crosspost_parent_list?.[0] ?? post;
  const authorLabel = `u/${post.author} on r/${post.subreddit}`;
  const host = new URL(c.req.url).origin;
  const oembedUrl = `${host}/reddit/oembed?title=${encodeURIComponent(post.title)}&url=${encodeURIComponent(originalUrl)}`;
  const desc = post.selftext?.trim() || post.title;

  const vid = effective.media?.reddit_video ?? effective.secure_media?.reddit_video;
  if (vid || effective.post_hint === 'hosted:video') {
    const videoUrl = vid?.fallback_url?.replace('?source=fallback', '') ?? effective.url ?? '';
    const thumb = getPreviewImage(effective);
    return c.html(buildEmbedHtml({ title: authorLabel, description: post.title + '\n\n' + desc, url: originalUrl, videoUrl, videoWidth: vid?.width ?? 1280, videoHeight: vid?.height ?? 720, imageUrl: thumb?.url, color: REDDIT_COLOR, siteName: 'Reddit', twitterCard: 'player', oembedUrl }));
  }

  const gallery = getGalleryImages(effective);
  if (gallery.length > 1) {
    const first = gallery[0];
    return c.html(buildEmbedHtml({ title: authorLabel, description: `${post.title}\n\n🖼️ Gallery: ${gallery.length} images`, url: originalUrl, imageUrl: first.url, imageWidth: first.width, imageHeight: first.height, color: REDDIT_COLOR, siteName: 'Reddit', largeImage: true, oembedUrl }));
  }

  if (effective.post_hint === 'image' || effective.is_reddit_media_domain) {
    const preview = getPreviewImage(effective);
    return c.html(buildEmbedHtml({ title: authorLabel, description: post.title, url: originalUrl, imageUrl: effective.url ?? preview?.url, imageWidth: preview?.width, imageHeight: preview?.height, color: REDDIT_COLOR, siteName: 'Reddit', largeImage: true, oembedUrl }));
  }

  const preview = getPreviewImage(effective);
  if (preview) {
    return c.html(buildEmbedHtml({ title: authorLabel, description: post.title, url: originalUrl, imageUrl: preview.url, imageWidth: preview.width, imageHeight: preview.height, color: REDDIT_COLOR, siteName: 'Reddit', oembedUrl }));
  }

  return c.html(buildEmbedHtml({ title: authorLabel, description: post.title + (desc !== post.title ? '\n\n' + desc : ''), url: originalUrl, color: REDDIT_COLOR, siteName: 'Reddit', oembedUrl }));
}

export const redditRouter = new Hono();

redditRouter.get('/oembed', (c) => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: 'link', author_name: q.title, author_url: q.url, provider_name: 'LinkEmbedder / Reddit' }));
});

redditRouter.get('/r/:sub/comments/:id{[^/]+}', (c) => handlePost(`/r/${c.req.param('sub')}/comments/${c.req.param('id')}`, c));
redditRouter.get('/r/:sub/comments/:id/:slug', (c) => handlePost(`/r/${c.req.param('sub')}/comments/${c.req.param('id')}/${c.req.param('slug').split('/')[0]}`, c));
redditRouter.get('/r/:sub/comments/:id/:slug/:comment', (c) => handlePost(`/r/${c.req.param('sub')}/comments/${c.req.param('id')}/${c.req.param('slug').split('/')[0]}`, c));

redditRouter.get('/user/:name/comments/:id/:slug', (c) => handlePost(`/user/${c.req.param('name')}/comments/${c.req.param('id')}`, c));
redditRouter.get('/u/:name/comments/:id/:slug', (c) => handlePost(`/u/${c.req.param('name')}/comments/${c.req.param('id')}`, c));

redditRouter.get('/r/:sub/s/:shareId', async (c) => {
  const { sub, shareId } = c.req.param();
  const resolved = await resolveShareLink(sub, shareId);
  if (!resolved) return c.redirect(`https://www.reddit.com/r/${sub}/s/${shareId}`, 302);
  return handlePost(new URL(resolved).pathname, c);
});

redditRouter.get('/comments/:id', (c) => handlePost(`/comments/${c.req.param('id')}`, c));
redditRouter.get('/comments/:id/:slug', (c) => handlePost(`/comments/${c.req.param('id')}`, c));
redditRouter.get('/gallery/:id', (c) => handlePost(`/gallery/${c.req.param('id')}`, c));
redditRouter.get('/:id', (c) => {
  const id = c.req.param('id');
  if (id.includes('.')) return c.redirect(`https://www.reddit.com/${id}`, 302);
  return handlePost(`/${id}`, c);
});
