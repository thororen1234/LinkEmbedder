import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { trimTrailingSlash } from 'hono/trailing-slash';

import { twitterRouter } from './providers/twitter.js';
import { instagramRouter } from './providers/instagram.js';
import { redditRouter } from './providers/reddit.js';
import { tiktokRouter } from './providers/tiktok.js';
import { blueskyRouter } from './providers/bluesky.js';
import { pixivRouter } from './providers/pixiv.js';
import { tumblrRouter } from './providers/tumblr.js';
import { twitchRouter } from './providers/twitch.js';
import { bilibiliRouter } from './providers/bilibili.js';
import { facebookRouter } from './providers/facebook.js';
import { furaffinityRouter } from './providers/furaffinity.js';
import { deviantartRouter } from './providers/deviantart.js';
import { iwaraRouter } from './providers/iwara.js';
import { pttRouter } from './providers/ptt.js';
import { threadsRouter } from './providers/threads.js';

try {
  const { readFileSync } = await import('fs');
  const envFile = readFileSync('.env', 'utf8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = value;
  }
} catch { }

const app = new Hono();

app.use(trimTrailingSlash());

app.get('/', (c) =>
  c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>LinkEmbedder</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:680px;margin:2rem auto;padding:0 1rem;color:#eee;background:#111;}
  h1{color:#7c6af7;}
  table{width:100%;border-collapse:collapse;margin-top:1rem;}
  th,td{padding:.4rem .7rem;border:1px solid #333;text-align:left;}
  th{background:#1a1a2e;}
  code{background:#222;padding:.1rem .3rem;border-radius:4px;font-size:.9em;}
  a{color:#7c6af7;}
</style>
</head>
<body>
<h1>🔗 LinkEmbedder</h1>
<p>Unified social media embed-fix server. Send a bot request to any of these prefixes:</p>
<table>
  <thead><tr><th>Prefix</th><th>Platform</th><th>Example</th></tr></thead>
  <tbody>
    <tr><td><code>/twitter/</code> or <code>/x/</code></td><td>Twitter / X</td><td><code>/twitter/:user/status/:id</code></td></tr>
    <tr><td><code>/ig/</code></td><td>Instagram</td><td><code>/ig/p/:id</code></td></tr>
    <tr><td><code>/reddit/</code> or <code>/r/</code></td><td>Reddit</td><td><code>/reddit/r/:sub/comments/:id</code></td></tr>
    <tr><td><code>/tiktok/</code></td><td>TikTok</td><td><code>/tiktok/@user/video/:id</code></td></tr>
    <tr><td><code>/bsky/</code></td><td>Bluesky</td><td><code>/bsky/profile/:user/post/:id</code></td></tr>
    <tr><td><code>/pixiv/</code></td><td>Pixiv</td><td><code>/pixiv/artworks/:id</code></td></tr>
    <tr><td><code>/tumblr/</code></td><td>Tumblr</td><td><code>/tumblr/:blog/:id</code></td></tr>
    <tr><td><code>/twitch/</code></td><td>Twitch</td><td><code>/twitch/clip/:id</code></td></tr>
    <tr><td><code>/bilibili/</code></td><td>Bilibili</td><td><code>/bilibili/:bvid</code></td></tr>
    <tr><td><code>/facebook/</code></td><td>Facebook</td><td><code>/facebook/reel/:id</code></td></tr>
    <tr><td><code>/furaffinity/</code></td><td>FurAffinity</td><td><code>/furaffinity/view/:id</code></td></tr>
    <tr><td><code>/deviantart/</code></td><td>DeviantArt</td><td><code>/deviantart/art/:id</code></td></tr>
    <tr><td><code>/iwara/</code></td><td>Iwara</td><td><code>/iwara/video/:id</code></td></tr>
    <tr><td><code>/ptt/</code></td><td>PTT</td><td><code>/ptt/bbs/:board/:id</code></td></tr>
    <tr><td><code>/threads/</code></td><td>Threads</td><td><code>/threads/@user/post/:id</code></td></tr>
  </tbody>
</table>
<p style="margin-top:2rem;color:#888;font-size:.85em;">
  Non-bot requests are redirected to the original platform. 
  Bot detection is based on User-Agent matching.
</p>
</body>
</html>`)
);

app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.route('/twitter', twitterRouter);
app.route('/x', twitterRouter);
app.route('/ig', instagramRouter);
app.route('/insta', instagramRouter);
app.route('/instagram', instagramRouter);
app.route('/reddit', redditRouter);
app.route('/r', redditRouter);
app.route('/tiktok', tiktokRouter);
app.route('/tk', tiktokRouter);
app.route('/bsky', blueskyRouter);
app.route('/pixiv', pixivRouter);
app.route('/tumblr', tumblrRouter);
app.route('/twitch', twitchRouter);
app.route('/bilibili', bilibiliRouter);
app.route('/facebook', facebookRouter);
app.route('/furaffinity', furaffinityRouter);
app.route('/deviantart', deviantartRouter);
app.route('/iwara', iwaraRouter);
app.route('/ptt', pttRouter);
app.route('/threads', threadsRouter);
app.all('*', (c) =>
  c.json({ error: 'Not found. Check / for available routes.' }, 404)
);

const port = parseInt(process.env.PORT ?? '3000', 10);

console.log(`started on http://localhost:${port}\n`);
serve({ fetch: app.fetch, port });
