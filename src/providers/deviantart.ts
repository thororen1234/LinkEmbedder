import { Hono } from 'hono';
import type { Context } from 'hono';
import { isBot } from '../utils/bot.js';
import { buildEmbedHtml, buildOEmbed } from '../utils/html.js';
import { deviantartCache } from '../utils/cache.js';

const DA_COLOR = '#05cc47';

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
        headers['Cookie'] = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
      } catch {}
    }

    const res = await fetch(`https://backend.deviantart.com/oembed?url=${encodeURIComponent(url)}`, { headers });
    if (!res.ok) return null;
    const data = await res.json() as DAoEmbed;
    deviantartCache.set(url, data);
    return data;
  } catch { return null; }
}

async function handleDAEmbed(c: Context, path: string): Promise<Response> {
  const originalUrl = `https://www.deviantart.com${path}`;
  const ua = c.req.header('user-agent');
  if (!isBot(ua)) return c.redirect(originalUrl, 302);

  const info = await fetchDAInfo(originalUrl);
  if (!info) return c.redirect(originalUrl, 302);

  const host = new URL(c.req.url).origin;
  const oembedUrl = `${host}/deviantart/oembed?title=${encodeURIComponent(info.title)}&author=${encodeURIComponent(info.author_name)}&url=${encodeURIComponent(originalUrl)}`;

  return c.html(buildEmbedHtml({
    title: `${info.title} by ${info.author_name}`,
    description: '',
    url: originalUrl,
    imageUrl: info.fullsize_url ?? info.url ?? info.thumbnail_url,
    color: DA_COLOR,
    siteName: 'DeviantArt',
    largeImage: true,
    oembedUrl
  }));
}

export const deviantartRouter = new Hono();

deviantartRouter.get('/oembed', (c) => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: 'photo', title: q.title, author_name: q.author, author_url: q.url, provider_name: 'LinkEmbedder / DeviantArt' }));
});

deviantartRouter.get('/*', (c) => handleDAEmbed(c, c.req.path.replace('/deviantart', '')));
