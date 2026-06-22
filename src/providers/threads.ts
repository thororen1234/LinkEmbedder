import { Context, Hono } from "hono";

import { getOrigin, isBot } from "../utils/bot.js";
import { threadsCache } from "../utils/cache.js";
import { buildEmbedHtml, buildOEmbed } from "../utils/html.js";

const THREADS_COLOR = "#000000";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function formatNumber(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toString();
}

interface ThreadsInfo {
  username: string;
  description: string;
  images: string[];
  video?: string;
  oembedStat: string;
  likes?: number;
}

function getPostId(shortcode: string): string {
  const clean = shortcode.split("?")[0].replace(/[\s/]/g, "");
  let id = 0n;
  for (const char of clean) {
    id = id * 64n + BigInt(ALPHABET.indexOf(char));
  }
  return id.toString();
}

async function fetchThreadsInfo(shortcode: string): Promise<ThreadsInfo | null> {
  const cached = threadsCache.get(shortcode) as ThreadsInfo | undefined;
  if (cached) return cached;

  try {
    const postId = getPostId(shortcode);
    const variables = JSON.stringify({
      check_for_unavailable_replies: true,
      first: 10,
      postID: postId,
      __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: true,
      __relay_internal__pv__BarcelonaIsThreadContextHeaderEnabledrelayprovider: false,
      __relay_internal__pv__BarcelonaIsThreadContextHeaderFollowButtonEnabledrelayprovider: false,
      __relay_internal__pv__BarcelonaUseCometVideoPlaybackEnginerelayprovider: false,
      __relay_internal__pv__BarcelonaOptionalCookiesEnabledrelayprovider: false,
      __relay_internal__pv__BarcelonaIsViewCountEnabledrelayprovider: false,
      __relay_internal__pv__BarcelonaShouldShowFediverseM075Featuresrelayprovider: false
    });

    const body = new URLSearchParams({
      variables,
      doc_id: "7448594591874178",
      lsd: "hgmSkqDnLNFckqa7t1vJdn"
    });

    const res = await fetch("https://www.threads.com/api/graphql", {
      method: "POST",
      headers: {
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "X-Fb-Lsd": "hgmSkqDnLNFckqa7t1vJdn",
        "X-Ig-App-Id": "238260118697367",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });

    if (!res.ok) return null;
    const json = await res.json() as any;
    if (json.errors || !json.data) return null;

    const threadItems = json.data.data.edges[0].node.thread_items;
    const postObj = threadItems.find((i: any) => i.post.code === shortcode);
    if (!postObj) return null;

    const { post } = postObj;
    const { username } = post.user;

    const description = post.caption?.text || "";
    const likes = post.like_count ?? 0;
    const oembedStat = "Threads";

    const images: string[] = [];
    let video: string | undefined;

    if (post.carousel_media?.length) {
      post.carousel_media.forEach((m: any) => {
        if (m.video_versions?.length) video = video || m.video_versions[0].url;
        else if (m.image_versions2?.candidates?.length) images.push(m.image_versions2.candidates[0].url);
      });
    } else if (post.video_versions?.length) {
      video = post.video_versions[0].url;
    } else if (post.image_versions2?.candidates?.length) {
      images.push(post.image_versions2.candidates[0].url);
    }

    const info: ThreadsInfo = { username, description: description.slice(0, 500), images, video, oembedStat, likes };
    threadsCache.set(shortcode, info);
    return info;
  } catch { return null; }
}

async function handleThreadsEmbed(c: Context, user: string, shortcode: string, embedIndex = -1): Promise<Response> {
  const dParam = c.req.query("d") ?? c.req.query("dir") ?? c.req.query("direct");
  const isDirect = dParam !== undefined;

  const imgIndexParam = c.req.query("img_index") ?? c.req.query("index");
  if (imgIndexParam !== undefined && embedIndex === -1) {
    embedIndex = parseInt(imgIndexParam, 10) - 1;
  }

  const originalUrl = `https://www.threads.net/@${user}/post/${shortcode}`;
  const ua = c.req.header("user-agent");
  if (!isBot(ua) && !isDirect) return c.redirect(originalUrl, 302);

  const info = await fetchThreadsInfo(shortcode);
  if (!info) return c.redirect(originalUrl, 302);

  const host = getOrigin(c);

  if (isDirect) {
    if (info.video) return c.redirect(info.video, 302);
    if (info.images.length > 0) {
      const idx = Math.max(0, Math.min(embedIndex >= 0 ? embedIndex : 0, info.images.length - 1));
      return c.redirect(info.images[idx], 302);
    }
    return c.redirect(originalUrl, 302);
  }

  const dateStr = ` • ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
  const customSiteName = `Threads${dateStr}`;
  const oembedUrl = `${host}/threads/oembed?title=${encodeURIComponent(info.oembedStat)}&author=${encodeURIComponent("@" + info.username)}&url=${encodeURIComponent(originalUrl)}&provider=${encodeURIComponent(customSiteName)}`;

  const metricsArr = [];
  if (info.likes && info.likes > 0) metricsArr.push(`❤️ ${formatNumber(info.likes)}`);

  let { description } = info;
  if (metricsArr.length > 0) description = description ? `${description}\n\n${metricsArr.join(" ")}` : metricsArr.join(" ");

  if (info.images.length > 1 && embedIndex < 0) {
    const imageUrl = `${host}/threads/grid/${shortcode}`;
    return c.html(buildEmbedHtml({ title: `@${info.username} on Threads`, description, url: originalUrl, imageUrl, color: THREADS_COLOR, siteName: customSiteName, largeImage: true, oembedUrl }));
  }

  const idx = Math.max(0, Math.min(embedIndex >= 0 ? embedIndex : 0, info.images.length - 1));
  const selectedImage = info.images[idx];

  return c.html(buildEmbedHtml({
    title: `@${info.username} on Threads`,
    description,
    url: originalUrl,
    imageUrl: selectedImage,
    videoUrl: info.video,
    videoWidth: info.video ? 720 : undefined,
    videoHeight: info.video ? 1280 : undefined,
    color: THREADS_COLOR,
    siteName: customSiteName,
    twitterCard: info.video ? "player" : "summary_large_image",
    largeImage: !!selectedImage,
    oembedUrl
  }));
}

export const threadsRouter = new Hono();

threadsRouter.get("/oembed", c => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: "link", title: q.title, author_name: q.author, author_url: q.url, provider_name: q.provider ?? "LinkEmbedder / Threads" }));
});

threadsRouter.get("/grid/:shortcode", async c => {
  const shortcode = c.req.param("shortcode");
  const info = await fetchThreadsInfo(shortcode);
  if (!info || info.images.length < 2) return new Response("Not found", { status: 404 });

  const { createMosaic } = await import("../utils/image.js");
  const buffer = await createMosaic(info.images);
  if (!buffer) return c.redirect(info.images[0] as string, 302);

  return new Response(buffer as any, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" } });
});

threadsRouter.get("/@:user/post/:shortcode", c => handleThreadsEmbed(c, c.req.param("user") as string, c.req.param("shortcode") as string));

function extractThreadsParams(urlStr: string): { user: string; shortcode: string; } | null {
  try {
    const url = new URL(urlStr);
    if (url.hostname.includes("threads.net")) {
      const match = url.pathname.match(/\/@([^/]+)\/post\/([^/?]+)/);
      if (match) return { user: match[1], shortcode: match[2] };
    }
  } catch {
    const match = urlStr.match(/\/@([^/]+)\/post\/([^/?]+)/);
    if (match) return { user: match[1], shortcode: match[2] };
  }
  return null;
}

threadsRouter.get("/", c => {
  const url = c.req.query("url");
  if (url) {
    const p = extractThreadsParams(url);
    if (p) return handleThreadsEmbed(c, p.user, p.shortcode);
  }
  return new Response("Not found", { status: 404 });
});

threadsRouter.get("/*", c => {
  const { path } = c.req;
  const httpMatch = path.match(/(https?:\/\/[^\s]+)/);
  if (httpMatch) {
    const p = extractThreadsParams(httpMatch[1]);
    if (p) return handleThreadsEmbed(c, p.user, p.shortcode);
  }
  return new Response("Not found", { status: 404 });
});
