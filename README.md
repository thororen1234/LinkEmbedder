# LinkEmbedder

One server, seven embed fixers. Stop running a separate FxTwitter bot, FxReddit bot, and FxTikTok bot side by side - LinkEmbedder merges them into a single TypeScript/Hono service so links from Twitter/X, Instagram, Reddit, TikTok, Bluesky, Pixiv, and Tumblr all render properly on Discord, Telegram, Slack, and friends.

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

| Platform | Path prefix | Auth needed? | How it fetches data |
|---|---|---|---|
| Twitter / X | `/twitter/`, `/x/` | None | Public syndication API |
| Instagram | `/ig/` | None | Embed page + GQL scraping |
| Reddit | `/reddit/`, `/r/` | None | Public JSON API |
| TikTok | `/tiktok/` | None | Page scraping |
| Bluesky | `/bsky/` | None | Public AT Protocol API |
| Pixiv | `/pixiv/` | Cookie, R-18 only | Page scraping |
| Tumblr | `/tumblr/` | Free API key | Official API |

<details>
<summary>Accepted URL formats per platform</summary>

**Twitter / X**

```
/twitter/:user/status/:id
/twitter/:user/status/:id/:mediaIndex
/twitter/i/status/:id
/x/:user/status/:id
```

**Instagram**

```
/ig/p/:id
/ig/p/:id/:mediaNum
/ig/reel/:id
/ig/:username/p/:id
```

**Reddit**

```
/reddit/r/:subreddit/comments/:id/:slug?
/reddit/r/:sub/s/:shareId
/reddit/gallery/:id
/r/:subreddit/comments/:id
```

**TikTok**

```
/tiktok/:shortId
/tiktok/@:user/video/:id
/tiktok/@:user/photo/:id
/tiktok/@:user/live
```

**Bluesky**

```
/bsky/profile/:user/post/:id
/bsky/profile/:user
/bsky/https://bsky.app/profile/:user/post/:id
```

**Pixiv**

```
/pixiv/artworks/:id
/pixiv/artworks/:id/:imageIndex
/pixiv/:lang/artworks/:id
/pixiv/i/:id
/pixiv/member_illust.php?illust_id=:id
```

Image proxy (required for the Pixiv CDN): `/pixiv/i/*`

**Tumblr**

```
/tumblr/:blog/:id
/tumblr/:blog/:id/:slug
```

</details>

## Configuration

| Variable | Required? | Description |
|---|---|---|
| `PORT` | No | Port to listen on (default `3000`) |
| `TUMBLR_API_KEY` | For Tumblr | Free app key from [tumblr.com/oauth/apps](https://www.tumblr.com/oauth/apps) |
| `PIXIV_COOKIE` | For R-18 Pixiv | `PHPSESSID` from a logged-in Pixiv session. Comma-separated for rotation. |

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
- [embed-fixer](https://github.com/seriaati/embed-fixer)
- [fixthreads](https://github.com/milanmdev/fixthreads)
