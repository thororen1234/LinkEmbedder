import { Hono } from 'hono';
import type { Context } from 'hono';
import { isBot } from '../utils/bot.js';
import { buildEmbedHtml, buildOEmbed } from '../utils/html.js';
import { twitterCache } from '../utils/cache.js';

const TWITTER_COLOR = '#1D9BF0';
const SYNDICATION_BASE = 'https://cdn.syndication.twimg.com/tweet-result';

interface SyndicationMedia {
  type: 'photo' | 'video' | 'animated_gif';
  media_url_https?: string;
  video_info?: {
    variants: Array<{ content_type: string; bitrate?: number; url: string }>;
    aspect_ratio?: [number, number];
  };
  sizes?: { large?: { w: number; h: number }; orig?: { w: number; h: number } };
}

interface SyndicationTweet {
  id_str: string;
  full_text?: string;
  text?: string;
  user?: { name: string; screen_name: string; profile_image_url_https?: string };
  extended_entities?: { media?: SyndicationMedia[] };
  entities?: { media?: SyndicationMedia[] };
  photos?: Array<{ url: string; width: number; height: number }>;
  video?: { url: string; poster?: string; aspectRatio?: [number, number] };
  mediaDetails?: SyndicationMedia[];
}

async function fetchTweet(id: string): Promise<SyndicationTweet | null> {
  const cached = twitterCache.get(id) as SyndicationTweet | undefined;
  if (cached) return cached;
  try {
    const res = await fetch(`${SYNDICATION_BASE}?id=${encodeURIComponent(id)}&lang=en&token=0`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0)', Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as SyndicationTweet;
    twitterCache.set(id, data);
    return data;
  } catch { return null; }
}

function getBestVideo(tweet: SyndicationTweet): { url: string; width?: number; height?: number; thumb?: string } | null {
  if (tweet.video) {
    const ar = tweet.video.aspectRatio;
    return { url: tweet.video.url, width: ar?.[0] ? ar[0] * 100 : undefined, height: ar?.[1] ? ar[1] * 100 : undefined, thumb: tweet.video.poster };
  }
  const medias = tweet.mediaDetails ?? tweet.extended_entities?.media ?? tweet.entities?.media ?? [];
  for (const m of medias) {
    if ((m.type === 'video' || m.type === 'animated_gif') && m.video_info) {
      const variants = m.video_info.variants
        .filter((v) => v.content_type === 'video/mp4' && v.bitrate !== undefined)
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      if (variants[0]) {
        const ar = m.video_info.aspect_ratio;
        return { url: variants[0].url, width: ar?.[0] ? ar[0] * 100 : undefined, height: ar?.[1] ? ar[1] * 100 : undefined, thumb: m.media_url_https };
      }
    }
  }
  return null;
}

function getPhotos(tweet: SyndicationTweet): Array<{ url: string; width?: number; height?: number }> {
  if (tweet.photos?.length) return tweet.photos.map((p) => ({ url: p.url, width: p.width, height: p.height }));
  const medias = tweet.mediaDetails ?? tweet.extended_entities?.media ?? tweet.entities?.media ?? [];
  return medias.filter((m) => m.type === 'photo').map((m) => {
    const large = m.sizes?.large ?? m.sizes?.orig;
    return { url: `${m.media_url_https ?? ''}?name=orig`, width: large?.w, height: large?.h };
  });
}

async function handleTweet(c: Context, tweetId: string, routeUser?: string, embedIndex = -1): Promise<Response> {
  const fallbackUrl = routeUser
    ? `https://x.com/${routeUser}/status/${tweetId}`
    : `https://x.com/i/status/${tweetId}`;

  const ua = c.req.header('user-agent');
  if (!isBot(ua)) return c.redirect(fallbackUrl, 302);

  const tweet = await fetchTweet(tweetId);
  if (!tweet) return c.redirect(fallbackUrl, 302);

  const text = tweet.full_text ?? tweet.text ?? '';
  const username = tweet.user?.screen_name ?? routeUser ?? 'unknown';
  const displayName = tweet.user?.name ?? username;
  const tweetUrl = `https://x.com/${username}/status/${tweetId}`;
  const authorName = `${displayName} (@${username})`;
  const host = new URL(c.req.url).origin;
  const oembedUrl = `${host}/twitter/oembed?desc=${encodeURIComponent(text)}&user=${encodeURIComponent(authorName)}&link=${encodeURIComponent(tweetUrl)}&ttype=link`;

  const video = getBestVideo(tweet);
  if (video) {
    return c.html(buildEmbedHtml({ description: text, url: tweetUrl, imageUrl: video.thumb, videoUrl: video.url, videoWidth: video.width ?? 1280, videoHeight: video.height ?? 720, color: TWITTER_COLOR, siteName: 'Twitter / X', twitterCard: 'player', oembedUrl }));
  }

  const photos = getPhotos(tweet);
  if (photos.length) {
    const desc = photos.length > 1 ? `${text}\n\n🖼️ ${photos.length} images` : text;
    if (embedIndex >= 0) {
      const idx = Math.min(embedIndex, photos.length - 1);
      const photo = photos[idx];
      return c.html(buildEmbedHtml({ description: desc, url: tweetUrl, imageUrl: photo.url, imageWidth: photo.width, imageHeight: photo.height, color: TWITTER_COLOR, siteName: 'Twitter / X', largeImage: true, oembedUrl }));
    } else {
      const imageUrls = photos.slice(0, 4).map(p => p.url);
      const first = photos[0];
      return c.html(buildEmbedHtml({ description: desc, url: tweetUrl, imageUrl: imageUrls, imageWidth: first.width, imageHeight: first.height, color: TWITTER_COLOR, siteName: 'Twitter / X', largeImage: true, oembedUrl }));
    }
  }

  return c.html(buildEmbedHtml({ description: text, url: tweetUrl, color: TWITTER_COLOR, siteName: 'Twitter / X', oembedUrl }));
}

export const twitterRouter = new Hono();

twitterRouter.get('/oembed', (c) => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: (q.ttype as 'link' | 'photo' | 'video') ?? 'link', author_name: q.user, author_url: q.link, provider_name: q.provider ?? 'LinkEmbedder / Twitter' }));
});

twitterRouter.get('/:user/status/:id', (c) =>
  handleTweet(c, c.req.param('id'), c.req.param('user'))
);
twitterRouter.get('/:user/status/:id/:index', (c) => {
  const idx = parseInt(c.req.param('index') ?? '1', 10);
  return handleTweet(c, c.req.param('id'), c.req.param('user'), isNaN(idx) ? 0 : idx - 1);
});
twitterRouter.get('/i/status/:id', (c) =>
  handleTweet(c, c.req.param('id'))
);

