# LinkEmbedder

One server, fifteen embed fixers. Stop running a separate FxTwitter bot, FxReddit bot, and FxTikTok bot side by side - LinkEmbedder merges them into a single TypeScript/Hono service so links from Twitter/X, Instagram, Reddit, TikTok, Bluesky, Pixiv, Tumblr, DeviantArt, FurAffinity, Twitch, Bilibili, Facebook, Iwara, PTT, and Threads all render properly on Discord, Telegram, Slack, and friends.

Drop a LinkEmbedder URL in chat and:

- **Bots/crawlers** (Discord, Telegram, Slack, WhatsApp, Mastodon, etc.) get back an OpenGraph/Twitter Card response, so the embed actually shows the image, video, or post text.
- **Humans** get a 302 redirect straight to the original post.

Most platforms work with zero credentials. Tumblr needs a free API key, and Pixiv only needs a cookie if you want R-18 content.

## Quick Start

```bash
pnpm install
cp .env.example .env
pnpm dev
```

## Usage

Take any supported link and swap the domain for wherever you're hosting LinkEmbedder - the path stays the same. A couple of examples:

```
https://twitter.com/user/status/123 -> https://your-host/twitter/user/status/123
https://reddit.com/r/sub/comments/abc/xyz -> https://your-host/reddit/r/sub/comments/abc/xyz
https://vm.tiktok.com/ABC123 -> https://your-host/tiktok/ABC123
```

Every platform also has a documented set of accepted path formats (galleries, specific media indexes, share links, etc.) - see [Platform Reference](#platform-reference) below.

## Platform Reference

### Universal URL & Direct Media Redirects

All supported platforms now include universal routes. You can pass the original URL as a query parameter or append it directly to the path:

- **Query Parameter:** `https://your-host/twitter?url=https://twitter.com/user/status/123`
- **Path Prefix:** `https://your-host/twitter/https://twitter.com/user/status/123`

You can also use the `?d=1`, `?dir=1`, or `?direct=1` parameters to bypass the HTML embed completely and redirect straight to the raw media (image or video file) if available:

- `https://your-host/twitter?url=https://twitter.com/user/status/123&d=1`

### Image Index Selection

For posts containing multiple images (e.g. a Twitter thread with 4 photos, an Instagram carousel, a Bluesky post, or a Reddit gallery), you can pass `?img_index=X` or `?index=X` (1-based) to specify exactly which image you want:

- **In an embed:** Bypasses generating a grid layout and instead embeds only the specified image. `https://your-host/twitter/user/status/123?img_index=2`
- **With direct redirect (`?d=1`):** Redirects straight to the raw image file at the specified index. `https://your-host/ig/p/123?d=1&img_index=3`

- **TikTok only (`?hq=1`):** Redirects to the HQ H.265 video file.

| Platform | Path prefix | Auth needed? | How it fetches data |
|---|---|---|---|
| Twitter / X | `/twitter/`, `/x/` | None | Public syndication API |
| Instagram | `/ig/`, `/insta/`, `/instagram/` | None | Embed page + GQL scraping |
| Reddit | `/reddit/`, `/r/` | None | Public JSON API |
| TikTok | `/tiktok/`, `/tk/` | None | Page scraping |
| Bluesky | `/bluesky/`, `/bsky/` | None | Public AT Protocol API |
| Pixiv | `/pixiv/`, `/pix/` | Cookie, R-18 only | Page scraping |
| Tumblr | `/tumblr/`, `/tmb/` | Free API key | Official API |
| DeviantArt | `/deviantart/`, `/da/` | Cookie, R-18 only | Official oEmbed API |
| FurAffinity | `/furaffinity/`, `/fa/` | Cookie, R-18 only | Page scraping |
| Twitch | `/twitch/`, `/tw/` | Client ID / Secret | Public GQL API |
| Bilibili | `/bilibili/`, `/bili/` | None | Public JSON API |
| Facebook | `/facebook/`, `/fb/` | None | Third-party Downloader API |
| Iwara | `/iwara/`, `/iwa/` | None | Public JSON API |
| PTT | `/ptt/`, `/pt/` | None | Page scraping |
| Threads | `/threads/`, `/thread/` | None | Internal GQL API |

<details>
<summary>Accepted URL formats per platform</summary>

```json
{
  "twitter": [
    "/twitter/:user/status/:id",
    "/twitter/:user/status/:id/:mediaIndex",
    "/twitter/i/status/:id",
    "/x/:user/status/:id",
    "/x/:user/status/:id/:mediaIndex",
    "/x/i/status/:id"
  ],
  "instagram": [
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
    "/instagram/:username/p/:id"
  ],
  "reddit": [
    "/reddit/r/:subreddit/comments/:id/:slug?",
    "/reddit/r/:sub/s/:shareId",
    "/reddit/gallery/:id",
    "/r/:subreddit/comments/:id"
  ],
  "tiktok": [
    "/tiktok/:shortId",
    "/tiktok/@:user/video/:id",
    "/tiktok/@:user/photo/:id",
    "/tiktok/@:user/live",
    "/tk/:shortId",
    "/tk/@:user/video/:id",
    "/tk/@:user/photo/:id",
    "/tk/@:user/live"
  ],
  "bluesky": [
    "/bsky/profile/:user/post/:id",
    "/bsky/profile/:user",
    "/bsky/https://bsky.app/profile/:user/post/:id"
  ],
  "pixiv": [
    "/pixiv/artworks/:id",
    "/pixiv/artworks/:id/:imageIndex",
    "/pixiv/:lang/artworks/:id",
    "/pixiv/i/:id",
    "/pixiv/member_illust.php?illust_id=:id",
    "/pixiv/i/*"
  ],
  "tumblr": [
    "/tumblr/:blog/:id",
    "/tumblr/:blog/:id/:slug",
    "/tumblr/:blog/post/:id",
    "/tumblr/:blog/post/:id/:slug"
  ],
  "deviantart": [
    "/deviantart/*",
    "/da/*"
  ],
  "furaffinity": [
    "/furaffinity/view/:id",
    "/furaffinity/view/:id/*",
    "/fa/view/:id",
    "/fa/view/:id/*"
  ],
  "twitch": [
    "/twitch/clip/:id",
    "/twitch/:streamer/clip/:id",
    "/twitch?url=https://twitch.tv/:streamer/clip/:id",
    "/twitch/https://twitch.tv/:streamer/clip/:id"
  ],
  "bilibili": [
    "/bilibili/:bvid"
  ],
  "facebook": [
    "/facebook/reel/:id",
    "/fb/reel/:id"
  ],
  "iwara": [
    "/iwara/video/:id"
  ],
  "ptt": [
    "/ptt/bbs/:board/:id"
  ],
  "threads": [
    "/threads/@user/post/:id",
    "/thread/@user/post/:id"
  ]
}
```

</details>

## Configuration

| Variable | Required? | Description |
|---|---|---|
| `PORT` | No | Port to listen on (default `3000`) |
| `TUMBLR_API_KEY` | For Tumblr | [tumblr.com](https://www.tumblr.com/oauth/apps) |
| `TWITCH_CLIENT_ID` | For Twitch | [dev.twitch.tv](https://dev.twitch.tv/docs/authentication/register-app) |
| `TWITCH_CLIENT_SECRET` | For Twitch | [dev.twitch.tv](https://dev.twitch.tv/docs/authentication/register-app) |
| `PIXIV_COOKIE` | For R-18 Pixiv | `PHPSESSID` from a logged-in Pixiv session. Comma-separated for rotation. |
| `DA_COOKIE` | For R-18 DeviantArt | JSON string of cookies (e.g. `{"auth":"...","userinfo":"..."}`). |
| `FA_COOKIE_A` | For R-18 FurAffinity | The `a` cookie from a logged-in session. |
| `FA_COOKIE_B` | For R-18 FurAffinity | The `b` cookie from a logged-in session. |

## Caching

Each provider keeps its own in-memory LRU cache (TTL 15 min - 1 hr). No Redis or external store needed.

## Build & Deploy

```bash
pnpm build
pnpm start
```

## Credit

LinkEmbedder wouldn't exist without the platform-specific fixers it's built on:

- [VixBluesky](https://github.com/Lexedia/VixBluesky)
- [InstaFix](https://github.com/Wikidepia/InstaFix)
- [phixiv](https://github.com/thelaao/phixiv)
- [fxreddit](https://github.com/MinnDevelopment/fxreddit)
- [fxtumblr](https://github.com/knuxify/fxtumblr)
- [BetterTwitFix](https://github.com/dylanpdx/BetterTwitFix)
- [fxTikTok](https://github.com/okdargy/fxTikTok)
- [fxtwitch](https://github.com/seriaati/fxtwitch)
- [fxBilibili](https://github.com/seriaati/fxBilibili)
- [fxfacebook](https://github.com/seriaati/fxfacebook)
- [xFurAffinity](https://github.com/FirraWoof/xfuraffinity)
- [fixdeviantart](https://github.com/Tschrock/fixdeviantart)
- [fxiwara](https://github.com/seriaati/fxiwara)
- [fxptt](https://github.com/seriaati/fxptt)
- [fixthreads](https://github.com/milanmdev/fixthreads)
- [embed-fixer](https://github.com/seriaati/embed-fixer)
