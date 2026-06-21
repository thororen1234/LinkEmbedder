import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { trimTrailingSlash } from "hono/trailing-slash";

import { bilibiliRouter } from "./providers/bilibili.js";
import { blueskyRouter } from "./providers/bluesky.js";
import { deviantartRouter } from "./providers/deviantart.js";
import { facebookRouter } from "./providers/facebook.js";
import { furaffinityRouter } from "./providers/furaffinity.js";
import { instagramRouter } from "./providers/instagram.js";
import { iwaraRouter } from "./providers/iwara.js";
import { pixivRouter } from "./providers/pixiv.js";
import { pttRouter } from "./providers/ptt.js";
import { redditRouter } from "./providers/reddit.js";
import { threadsRouter } from "./providers/threads.js";
import { tiktokRouter } from "./providers/tiktok.js";
import { tumblrRouter } from "./providers/tumblr.js";
import { twitchRouter } from "./providers/twitch.js";
import { twitterRouter } from "./providers/twitter.js";

try {
  const { readFileSync } = await import("fs");
  const envFile = readFileSync(".env", "utf8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = value;
  }
} catch { }

const app = new Hono();

app.use(trimTrailingSlash());

app.get("/", c =>
  c.json({
    twitter: [
      "/twitter/:user/status/:id",
      "/twitter/:user/status/:id/:mediaIndex",
      "/twitter/i/status/:id",
      "/x/:user/status/:id",
      "/x/:user/status/:id/:mediaIndex",
      "/x/i/status/:id",
      "/twitter?url=...",
      "/twitter/https://..."
    ],
    instagram: [
      "/ig/p/:id",
      "/ig/p/:id/:mediaNum",
      "/ig/reel/:id",
      "/ig/:username/p/:id",
      "/insta/p/:id",
      "/insta/p/:id/:mediaNum",
      "/insta/reel/:id",
      "/insta/:username/p/:id",
      "/instagram/p/:id",
      "/instagram/p/:id/:mediaNum",
      "/instagram/reel/:id",
      "/instagram/:username/p/:id",
      "/ig?url=...",
      "/ig/https://..."
    ],
    reddit: [
      "/reddit/r/:subreddit/comments/:id/:slug?",
      "/reddit/r/:sub/s/:shareId",
      "/reddit/gallery/:id",
      "/r/:subreddit/comments/:id",
      "/reddit?url=...",
      "/reddit/https://..."
    ],
    tiktok: [
      "/tiktok/:shortId",
      "/tiktok/@:user/video/:id",
      "/tiktok/@:user/photo/:id",
      "/tiktok/@:user/live",
      "/tk/:shortId",
      "/tk/@:user/video/:id",
      "/tk/@:user/photo/:id",
      "/tk/@:user/live",
      "/tiktok?url=...",
      "/tiktok/https://..."
    ],
    bluesky: [
      "/bsky/profile/:user/post/:id",
      "/bsky/profile/:user",
      "/bsky?url=...",
      "/bsky/https://...",
      "/bluesky/profile/:user/post/:id",
      "/bluesky/profile/:user",
      "/bluesky?url=...",
      "/bluesky/https://..."
    ],
    pixiv: [
      "/pixiv/artworks/:id",
      "/pixiv/artworks/:id/:imageIndex",
      "/pixiv/:lang/artworks/:id",
      "/pixiv/i/:id",
      "/pixiv/member_illust.php?illust_id=:id",
      "/pixiv/i/*",
      "/pixiv?url=...",
      "/pixiv/https://...",
      "/pix/artworks/:id",
      "/pix/artworks/:id/:imageIndex",
      "/pix/:lang/artworks/:id",
      "/pix/i/:id",
      "/pix/member_illust.php?illust_id=:id",
      "/pix/i/*",
      "/pix?url=...",
      "/pix/https://..."
    ],
    tumblr: [
      "/tumblr/:blog/:id",
      "/tumblr/:blog/:id/:slug",
      "/tumblr/:blog/post/:id",
      "/tumblr/:blog/post/:id/:slug",
      "/tumblr?url=...",
      "/tumblr/https://...",
      "/tmb/:blog/:id",
      "/tmb/:blog/:id/:slug",
      "/tmb/:blog/post/:id",
      "/tmb/:blog/post/:id/:slug",
      "/tmb?url=...",
      "/tmb/https://..."
    ],
    deviantart: [
      "/deviantart/*",
      "/da/*",
      "/deviantart?url=...",
      "/deviantart/https://..."
    ],
    furaffinity: [
      "/furaffinity/view/:id",
      "/furaffinity/view/:id/*",
      "/fa/view/:id",
      "/fa/view/:id/*",
      "/furaffinity?url=...",
      "/furaffinity/https://..."
    ],
    twitch: [
      "/twitch/clip/:id",
      "/twitch/:streamer/clip/:id",
      "/twitch?url=...",
      "/twitch/https://...",
      "/tw/clip/:id",
      "/tw/:streamer/clip/:id",
      "/tw?url=...",
      "/tw/https://..."
    ],
    bilibili: [
      "/bilibili/:bvid",
      "/bilibili?url=...",
      "/bilibili/https://...",
      "/bili/:bvid",
      "/bili?url=...",
      "/bili/https://..."
    ],
    facebook: [
      "/facebook/reel/:id",
      "/fb/reel/:id",
      "/facebook?url=...",
      "/facebook/https://..."
    ],
    iwara: [
      "/iwara/video/:id",
      "/iwara?url=...",
      "/iwara/https://...",
      "/iwa/video/:id",
      "/iwa?url=...",
      "/iwa/https://..."
    ],
    ptt: [
      "/ptt/bbs/:board/:id",
      "/ptt?url=...",
      "/ptt/https://...",
      "/pt/bbs/:board/:id",
      "/pt?url=...",
      "/pt/https://..."
    ],
    threads: [
      "/threads/@user/post/:id",
      "/thread/@user/post/:id",
      "/threads?url=...",
      "/threads/https://..."
    ]
  })
);

app.get("/health", c => c.json({ status: "ok", timestamp: new Date().toISOString() }));
app.route("/twitter", twitterRouter);
app.route("/x", twitterRouter);
app.route("/ig", instagramRouter);
app.route("/insta", instagramRouter);
app.route("/instagram", instagramRouter);
app.route("/reddit", redditRouter);
app.route("/r", redditRouter);
app.route("/tiktok", tiktokRouter);
app.route("/tk", tiktokRouter);
app.route("/bluesky", blueskyRouter);
app.route("/bsky", blueskyRouter);
app.route("/pixiv", pixivRouter);
app.route("/pix", pixivRouter);
app.route("/tumblr", tumblrRouter);
app.route("/tmb", tumblrRouter);
app.route("/twitch", twitchRouter);
app.route("/tw", twitchRouter);
app.route("/bilibili", bilibiliRouter);
app.route("/bili", bilibiliRouter);
app.route("/facebook", facebookRouter);
app.route("/fb", facebookRouter);
app.route("/furaffinity", furaffinityRouter);
app.route("/fa", furaffinityRouter);
app.route("/deviantart", deviantartRouter);
app.route("/da", deviantartRouter);
app.route("/iwara", iwaraRouter);
app.route("/iwa", iwaraRouter);
app.route("/ptt", pttRouter);
app.route("/pt", pttRouter);
app.route("/threads", threadsRouter);
app.route("/thread", threadsRouter);
app.all("*", c =>
  c.json({ error: "Not found. Check / for available routes." }, 404)
);

const port = parseInt(process.env.PORT ?? "3000", 10);

console.log(`started on http://localhost:${port}\n`);
serve({ fetch: app.fetch, port });
