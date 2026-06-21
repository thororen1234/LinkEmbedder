import { Hono } from 'hono';
import type { Context } from 'hono';
import { isBot } from '../utils/bot.js';
import { buildEmbedHtml, buildOEmbed } from '../utils/html.js';
import { facebookCache } from '../utils/cache.js';

const FACEBOOK_COLOR = '#395898';
const API_KEY = 'vkrdownloader';

interface FacebookVideoInfo {
  title: string;
  description: string;
  source: string;
  downloads: Array<{ url: string; ext: string; format_id: string }>;
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
  const ua = c.req.header('user-agent');
  if (!isBot(ua)) return c.redirect(url, 302);

  const post = await fetchFacebookInfo(url);
  if (!post || !post.downloads) return c.redirect(url, 302);

  const download = post.downloads.find(d => d.ext === 'mp4' && d.format_id.includes('hd')) || post.downloads.find(d => d.ext === 'mp4');
  if (!download) return c.redirect(url, 302);

  const description = post.description || 'Facebook Video';
  const host = new URL(c.req.url).origin;
  const oembedUrl = `${host}/facebook/oembed?title=${encodeURIComponent('Facebook Reels')}&url=${encodeURIComponent(post.source || url)}`;

  return c.html(buildEmbedHtml({
    title: description,
    description: '',
    url: post.source || url,
    videoUrl: download.url,
    videoWidth: 720,
    videoHeight: 1280,
    color: FACEBOOK_COLOR,
    siteName: 'Facebook',
    twitterCard: 'player',
    oembedUrl
  }));
}

export const facebookRouter = new Hono();

facebookRouter.get('/oembed', (c) => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: 'video', author_name: q.title, author_url: q.url, provider_name: 'LinkEmbedder / Facebook' }));
});

facebookRouter.get('/share/r/:id', (c) => handleFacebookEmbed(c, `https://www.facebook.com/share/r/${c.req.param('id')}`));
facebookRouter.get('/reel/:id', (c) => handleFacebookEmbed(c, `https://www.facebook.com/reel/${c.req.param('id')}`));
facebookRouter.get('/share/v/:id', (c) => handleFacebookEmbed(c, `https://www.facebook.com/share/v/${c.req.param('id')}`));
facebookRouter.get('/watch', (c) => handleFacebookEmbed(c, `https://www.facebook.com/watch/?${new URLSearchParams(c.req.query()).toString()}`));
