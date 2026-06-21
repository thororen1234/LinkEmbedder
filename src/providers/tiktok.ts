import { Hono } from 'hono';
import type { Context } from 'hono';
import { isBot } from '../utils/bot.js';
import { buildEmbedHtml, buildOEmbed } from '../utils/html.js';
import { tiktokCache } from '../utils/cache.js';

const TIKTOK_COLOR = '#010101';

interface TikTokAuthor { nickname?: string; uniqueId?: string; avatarThumb?: string; }
interface TikTokVideo { width?: number; height?: number; duration?: number; cover?: string | { urlList?: string[] }; playAddr?: string | { urlList?: string[] }; }
interface TikTokStats { diggCount?: number; commentCount?: number; playCount?: number; }
interface TikTokItem {
  id?: string; desc?: string; author?: TikTokAuthor; video?: TikTokVideo;
  imagePost?: { images?: Array<{ imageURL?: { urlList?: string[] } }> };
  stats?: TikTokStats; isContentClassified?: boolean;
}

const TIKTOK_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const AWEME_LINK_PATTERN = /\/@([^/]+)\/(video|photo|live)\/(\d+)/;
const AWEME_ID_PATTERN = /^\d{15,20}$/;

async function resolveShortLink(videoId: string): Promise<URL | null> {
  try {
    const res = await fetch(`https://vm.tiktok.com/${videoId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0)' },
      redirect: 'manual',
    });
    const location = res.headers.get('location') ?? res.headers.get('Location');
    if (!location) return null;
    if (location.includes('/v/')) {
      const vPart = new URL(location).pathname.match(/\/v\/([^/]+)/);
      if (vPart) return new URL(`https://www.tiktok.com/@unknown/video/${vPart[1].split('.')[0]}`);
    }
    return new URL(location);
  } catch { return null; }
}

function extractJsonFromScript(html: string, scriptId: string): unknown {
  const startTag = `<script id="${scriptId}" type="application/json">`;
  const startIdx = html.indexOf(startTag);
  if (startIdx === -1) return null;
  const jsonStart = startIdx + startTag.length;
  const jsonEnd = html.indexOf('</script>', jsonStart);
  if (jsonEnd === -1) return null;
  try { return JSON.parse(html.substring(jsonStart, jsonEnd)); } catch { return null; }
}

async function fetchVideoData(awemeId: string): Promise<TikTokItem | null> {
  const cached = tiktokCache.get(awemeId) as TikTokItem | undefined;
  if (cached) return cached;
  try {
    const res = await fetch(`https://www.tiktok.com/@i/video/${awemeId}`, { headers: TIKTOK_HEADERS });
    if (!res.ok) return null;
    const html = await res.text();
    const json = extractJsonFromScript(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__') as Record<string, Record<string, unknown>> | null;
    if (!json) return null;
    const scope = json['__DEFAULT_SCOPE__'];
    if (!scope) return null;
    const videoDetail = scope['webapp.video-detail'] as { itemInfo?: { itemStruct?: TikTokItem }; statusCode?: number } | undefined;
    if (!videoDetail || videoDetail.statusCode === 10204) return null;
    const item = videoDetail.itemInfo?.itemStruct;
    if (!item) return null;
    tiktokCache.set(awemeId, item);
    return item;
  } catch { return null; }
}

async function handleVideoEmbed(c: Context, awemeId: string): Promise<Response> {
  const ua = c.req.header('user-agent');
  const tiktokUrl = `https://www.tiktok.com/@i/video/${awemeId}`;
  if (!isBot(ua)) return c.redirect(tiktokUrl, 302);

  const item = await fetchVideoData(awemeId);
  if (!item) return c.redirect(tiktokUrl, 302);

  if (item.isContentClassified) {
    return c.html(buildEmbedHtml({ title: 'Age-Restricted Content', description: 'View on TikTok.', url: tiktokUrl, color: TIKTOK_COLOR, siteName: 'TikTok' }));
  }

  const username = item.author?.uniqueId ?? 'unknown';
  const displayName = item.author?.nickname ?? username;
  const authorName = `${displayName} (@${username})`;
  const description = item.desc ?? '';
  const postUrl = `https://www.tiktok.com/@${username}/video/${awemeId}`;
  const host = new URL(c.req.url).origin;
  const oembedUrl = `${host}/tiktok/oembed?author=${encodeURIComponent(authorName)}&url=${encodeURIComponent(postUrl)}`;

  if (item.imagePost?.images?.length) {
    const images = item.imagePost.images;
    const imageUrls = images.slice(0, 4).map(i => i.imageURL?.urlList?.[0]).filter(Boolean) as string[];
    const count = images.length;
    return c.html(buildEmbedHtml({ description: description + (count > 1 ? `\n\n🖼️ ${count} photos` : ''), url: postUrl, imageUrl: imageUrls, color: TIKTOK_COLOR, siteName: 'TikTok', largeImage: true, oembedUrl }));
  }

  const stats = item.stats;
  const statsLine = stats ? `▶ ${(stats.playCount ?? 0).toLocaleString()} · ❤️ ${(stats.diggCount ?? 0).toLocaleString()} · 💬 ${(stats.commentCount ?? 0).toLocaleString()}` : '';
  const coverObj = item.video?.cover;
  const coverUrl = typeof coverObj === 'string' ? coverObj : coverObj?.urlList?.[0];

  const playAddrObj = item.video?.playAddr;
  const playAddrUrl = typeof playAddrObj === 'string' ? playAddrObj : playAddrObj?.urlList?.[0];
  const videoUrl = playAddrUrl ? `${host}/tiktok/play/${awemeId}` : postUrl;

  return c.html(buildEmbedHtml({ description: [description, statsLine].filter(Boolean).join('\n'), url: postUrl, videoUrl, videoWidth: item.video?.width ?? 1080, videoHeight: item.video?.height ?? 1920, imageUrl: coverUrl ?? item.author?.avatarThumb, color: TIKTOK_COLOR, siteName: 'TikTok', twitterCard: 'player', oembedUrl }));
}

export const tiktokRouter = new Hono();

tiktokRouter.get('/oembed', (c) => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: 'video', author_name: q.author, author_url: q.url, provider_name: 'LinkEmbedder / TikTok' }));
});

tiktokRouter.get('/play/:videoId', async (c) => {
  const awemeId = c.req.param('videoId');
  const item = await fetchVideoData(awemeId);
  const playAddrObj = item?.video?.playAddr;
  const playAddrUrl = typeof playAddrObj === 'string' ? playAddrObj : playAddrObj?.urlList?.[0];
  if (!playAddrUrl) return c.redirect(`https://www.tiktok.com/@i/video/${awemeId}`, 302);
  return c.redirect(playAddrUrl, 302);
});

tiktokRouter.get('/:videoId', async (c) => {
  const videoId = c.req.param('videoId');
  if (videoId.startsWith('@')) return c.redirect(`https://www.tiktok.com/${videoId}`, 302);
  const id = videoId.split('.')[0];
  if (AWEME_ID_PATTERN.test(id)) return handleVideoEmbed(c, id);
  const resolved = await resolveShortLink(id);
  if (!resolved) return c.redirect(`https://www.tiktok.com/${id}`, 302);
  const match = resolved.pathname.match(AWEME_LINK_PATTERN);
  if (match) return handleVideoEmbed(c, match[3]);
  return c.redirect(resolved.toString(), 302);
});

tiktokRouter.get('/@:user/video/:videoId', (c) => handleVideoEmbed(c, c.req.param('videoId').split('.')[0]));
tiktokRouter.get('/@:user/photo/:videoId', (c) => handleVideoEmbed(c, c.req.param('videoId').split('.')[0]));
tiktokRouter.get('/*/video/:videoId', (c) => handleVideoEmbed(c, c.req.param('videoId').split('.')[0]));

tiktokRouter.get('/@:user/live', async (c) => {
  const user = c.req.param('user');
  const liveUrl = `https://www.tiktok.com/@${user}/live`;
  if (!isBot(c.req.header('user-agent'))) return c.redirect(liveUrl, 302);
  return c.html(buildEmbedHtml({ title: `@${user} is live on TikTok`, description: 'Watch live on TikTok.', url: liveUrl, color: TIKTOK_COLOR, siteName: 'TikTok' }));
});
