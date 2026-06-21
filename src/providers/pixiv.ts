import { Hono } from 'hono';
import type { Context } from 'hono';
import { isBot } from '../utils/bot.js';
import { buildEmbedHtml, buildOEmbed } from '../utils/html.js';
import { pixivCache } from '../utils/cache.js';

const PIXIV_COLOR = '#0096FA';
const MAX_IMAGES = parseInt(process.env.MAX_IMAGES ?? '3', 10);

interface PixivUrls { mini?: string; thumb?: string; small?: string; regular?: string; original?: string; }
interface PixivTag { tag: string; translation?: Record<string, string>; }
interface PixivAjaxBody {
  illustId: string; title: string; description: string; pageCount: number;
  bookmarkCount: number; likeCount: number; viewCount: number;
  userName: string; userId: string; urls: PixivUrls;
  tags: { tags: PixivTag[] }; illustType: number; ai_type: number;
  extraData: { meta: { canonical: string } };
}
interface PixivAjaxResponse { error: boolean; body: PixivAjaxBody; }

function getPixivCookie(): string | null {
  const raw = process.env.PIXIV_COOKIE;
  if (!raw) return null;
  const cookies = raw.split(',').map((c) => c.trim()).filter(Boolean);
  if (!cookies.length) return null;
  return cookies[Math.floor(Math.random() * cookies.length)];
}

async function fetchArtwork(illustId: string, lang = 'en'): Promise<PixivAjaxBody | null> {
  const cacheKey = `${lang}:${illustId}`;
  const cached = pixivCache.get(cacheKey) as PixivAjaxBody | undefined;
  if (cached) return cached;
  const cleanId = illustId.match(/^\d+/)?.[0] ?? illustId;
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    Referer: 'https://www.pixiv.net/',
  };
  const cookie = getPixivCookie();
  if (cookie) headers['Cookie'] = `PHPSESSID=${cookie}`;
  try {
    const res = await fetch(`https://www.pixiv.net/ajax/illust/${cleanId}?lang=${lang}`, { headers });
    if (!res.ok) return null;
    const json = await res.json() as PixivAjaxResponse;
    if (json.error) return null;
    pixivCache.set(cacheKey, json.body);
    return json.body;
  } catch { return null; }
}

function buildImageProxyUrls(host: string, body: PixivAjaxBody): string[] {
  const base = body.urls.regular ?? body.urls.original ?? '';
  if (!base) return [];
  try {
    const basePath = new URL(base).pathname;
    const count = Math.min(body.pageCount, MAX_IMAGES);
    return Array.from({ length: count }, (_, i) => {
      const pagePath = i === 0 ? basePath : basePath.replace(/_p0_/, `_p${i}_`);
      return `${host}/pixiv/i${pagePath}`;
    });
  } catch { return []; }
}

async function handleArtwork(c: Context, illustId: string, lang = 'en', imageIndex = 0): Promise<Response> {
  const cleanId = illustId.match(/^\d+/)?.[0] ?? illustId;
  const ua = c.req.header('user-agent');
  const originalUrl = `https://www.pixiv.net/${lang}/artworks/${cleanId}`;
  if (!isBot(ua)) return c.redirect(originalUrl, 302);

  const body = await fetchArtwork(cleanId, lang);
  if (!body) return c.redirect(originalUrl, 302);

  const host = new URL(c.req.url).origin;
  const imageUrls = buildImageProxyUrls(host, body);
  if (!imageUrls.length) return c.redirect(originalUrl, 302);

  const idx = Math.max(0, Math.min(imageIndex, imageUrls.length - 1));
  const oembedUrl = `${host}/pixiv/oembed?author=${encodeURIComponent(body.userName)}&url=${encodeURIComponent(`https://www.pixiv.net/${lang}/users/${body.userId}`)}`;
  const tags = body.tags.tags.map((t) => `#${t.translation?.[lang] ?? t.tag}`).join(', ');
  const aiLabel = body.ai_type === 2 ? '[AI Generated] ' : '';
  const rawDesc = body.description.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim().slice(0, 200);
  const stats = `❤️ ${body.likeCount.toLocaleString()} 🔖 ${body.bookmarkCount.toLocaleString()} 👁 ${body.viewCount.toLocaleString()}`;
  const description = [aiLabel + rawDesc, tags, stats, body.pageCount > 1 ? `🖼️ ${body.pageCount} pages` : ''].filter(Boolean).join('\n');

  return c.html(buildEmbedHtml({
    title: `${body.title} — ${body.userName}`,
    description,
    url: body.extraData.meta.canonical,
    imageUrl: imageUrls[idx],
    color: PIXIV_COLOR,
    siteName: 'Pixiv',
    largeImage: true,
    oembedUrl,
  }));
}

export const pixivRouter = new Hono();

pixivRouter.get('/oembed', (c) => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: 'photo', author_name: q.author, author_url: q.url, provider_name: 'LinkEmbedder / Pixiv' }));
});

pixivRouter.get('/i/*', async (c) => {
  const path = c.req.path.replace('/pixiv/i', '');
  const imgUrl = `https://i.pximg.net${path}`;
  try {
    const res = await fetch(imgUrl, { headers: { Referer: 'https://www.pixiv.net/' } });
    if (!res.ok) return c.redirect(imgUrl, 302);
    return new Response(res.body, { headers: { 'Content-Type': res.headers.get('content-type') ?? 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
  } catch { return c.redirect(imgUrl, 302); }
});

pixivRouter.get('/member_illust.php', (c) => {
  const illustId = c.req.query('illust_id');
  if (!illustId) return c.redirect('https://www.pixiv.net/', 302);
  return handleArtwork(c, illustId);
});

pixivRouter.get('/artworks/:id', (c) => handleArtwork(c, c.req.param('id')));
pixivRouter.get('/artworks/:id/:imageIndex', (c) => handleArtwork(c, c.req.param('id'), 'en', parseInt(c.req.param('imageIndex'), 10)));
pixivRouter.get('/:lang/artworks/:id', (c) => handleArtwork(c, c.req.param('id'), c.req.param('lang')));
pixivRouter.get('/:lang/artworks/:id/:imageIndex', (c) => handleArtwork(c, c.req.param('id'), c.req.param('lang'), parseInt(c.req.param('imageIndex'), 10)));
pixivRouter.get('/i/:id', (c) => handleArtwork(c, c.req.param('id')));
