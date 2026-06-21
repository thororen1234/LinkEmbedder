import { Hono } from 'hono';
import type { Context } from 'hono';
import { isBot } from '../utils/bot.js';
import { buildEmbedHtml, buildOEmbed } from '../utils/html.js';
import { pttCache } from '../utils/cache.js';
import * as cheerio from 'cheerio';

const PTT_COLOR = '#000000';

interface PttPost {
  author: string;
  title: string;
  content: string;
  images: string[];
}

async function fetchPttPost(board: string, id: string): Promise<PttPost | null> {
  const url = `https://www.ptt.cc/bbs/${board}/${id}.html`;
  const cached = pttCache.get(url) as PttPost | undefined;
  if (cached) return cached;

  try {
    const res = await fetch(url, {
      headers: { Cookie: 'over18=1', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    const metaValues = $('.article-meta-value');
    const author = metaValues.eq(0).text().trim();
    const title = metaValues.eq(2).text().trim() || 'No Title';

    const mainContent = $('#main-content');
    mainContent.find('div, span').remove();
    let content = mainContent.text().trim();

    if (content.endsWith('--')) {
      content = content.slice(0, -2).trim();
    }

    const imageRegex = /https?:\/\/[^\s]+\.(?:jpg|png|gif|webp|jpeg)/g;
    const images: string[] = [];
    for (const match of content.matchAll(imageRegex)) {
      images.push(match[0]);
    }

    content = content.replace(imageRegex, '').replace(/\n{2,}/g, '\n').trim();

    const post: PttPost = { author, title, content: content.slice(0, 500), images };
    pttCache.set(url, post);
    return post;
  } catch { return null; }
}

async function handlePttEmbed(c: Context, board: string, id: string): Promise<Response> {
  const originalUrl = `https://www.ptt.cc/bbs/${board}/${id}.html`;
  const ua = c.req.header('user-agent');
  if (!isBot(ua)) return c.redirect(originalUrl, 302);

  const post = await fetchPttPost(board, id);
  if (!post) return c.redirect(originalUrl, 302);

  const host = new URL(c.req.url).origin;
  const oembedUrl = `${host}/ptt/oembed?title=${encodeURIComponent(post.title)}&author=${encodeURIComponent(post.author)}&url=${encodeURIComponent(originalUrl)}`;

  if (post.images.length > 1) {
    const imageUrl = `${host}/ptt/grid/${board}/${id}`;
    return c.html(buildEmbedHtml({ title: `${post.title} - ${post.author}`, description: post.content, url: originalUrl, imageUrl, color: PTT_COLOR, siteName: 'PTT', largeImage: true, oembedUrl }));
  }

  return c.html(buildEmbedHtml({
    title: `${post.title} - ${post.author}`,
    description: post.content,
    url: originalUrl,
    imageUrl: post.images[0],
    color: PTT_COLOR,
    siteName: 'PTT',
    largeImage: !!post.images[0],
    oembedUrl
  }));
}

export const pttRouter = new Hono();

pttRouter.get('/oembed', (c) => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: 'link', title: q.title, author_name: q.author, author_url: q.url, provider_name: 'LinkEmbedder / PTT' }));
});

pttRouter.get('/grid/:board/:id', async (c) => {
  const board = c.req.param('board');
  const id = c.req.param('id');
  const post = await fetchPttPost(board, id);
  if (!post || !post.images.length) return new Response('Not found', { status: 404 });
  
  const { createMosaic } = await import('../utils/image.js');
  const buffer = await createMosaic(post.images);
  if (!buffer) return c.redirect(post.images[0], 302);
  
  return new Response(buffer as any, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
});

pttRouter.get('/bbs/:board/:id', (c) => {
  const id = c.req.param('id').replace('.html', '');
  return handlePttEmbed(c, c.req.param('board'), id);
});
