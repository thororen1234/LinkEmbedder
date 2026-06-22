import crypto from "crypto";
import { Context, Hono } from "hono";

import { getOrigin, isBot } from "../utils/bot.js";
import { bilibiliCache } from "../utils/cache.js";
import { buildEmbedHtml, buildOEmbed } from "../utils/html.js";

const BILIBILI_COLOR = "#00A1D6";

function formatNumber(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toString();
}

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  "Referer": "https://www.bilibili.com",
  "Origin": "https://www.bilibili.com",
};

const WBI_MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

let cachedWbiKey: string | null = null;
let wbiKeyFetchedAt = 0;

async function fetchWbiKey(): Promise<string | null> {
  if (cachedWbiKey && Date.now() - wbiKeyFetchedAt < 3600000) {
    return cachedWbiKey;
  }
  try {
    const res = await fetch("https://api.bilibili.com/x/web-interface/nav", { headers: DEFAULT_HEADERS });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const wbi = data?.data?.wbi_img;
    if (!wbi) return null;

    const imgKey = wbi.img_url.substring(wbi.img_url.lastIndexOf("/") + 1).split(".")[0];
    const subKey = wbi.sub_url.substring(wbi.sub_url.lastIndexOf("/") + 1).split(".")[0];
    const raw = imgKey + subKey;

    let mixinKey = "";
    for (const idx of WBI_MIXIN_TABLE) {
      mixinKey += raw[idx];
    }
    cachedWbiKey = mixinKey.substring(0, 32);
    wbiKeyFetchedAt = Date.now();
    return cachedWbiKey;
  } catch { return null; }
}

function signWbiParams(params: Record<string, string | number>, mixinKey: string): Record<string, string> {
  const signed: Record<string, string> = {};
  const forbidden = /['()*!]/g;
  for (const [k, v] of Object.entries(params)) {
    signed[k] = String(v).replace(forbidden, "");
  }
  signed.wts = String(Math.floor(Date.now() / 1000));

  const query = Object.keys(signed).sort().map(k => `${k}=${encodeURIComponent(signed[k])}`).join("&");
  const wRid = crypto.createHash("md5").update(query + mixinKey).digest("hex");
  signed.w_rid = wRid;
  return signed;
}

interface BilibiliVideoInfo {
  bvid: string; cid: number; title: string; desc: string; pic: string; pubdate: number;
  owner: { name: string; }; stat: { view: number; like: number; coin: number; favorite: number; };
  dimension?: { width: number; height: number; };
}

async function fetchVideoInfo(bvid: string): Promise<BilibiliVideoInfo | null> {
  const cached = bilibiliCache.get(bvid) as BilibiliVideoInfo | undefined;
  if (cached) return cached;
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: DEFAULT_HEADERS });
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (data.code !== 0) return null;
    bilibiliCache.set(bvid, data.data);
    return data.data;
  } catch { return null; }
}

async function getPlayUrl(bvid: string, cid: number): Promise<string | null> {
  const params = { bvid, cid, qn: 64, fnval: 1, fnver: 0, fourk: 1, platform: "html5", high_quality: 1 };
  const mixinKey = await fetchWbiKey();

  if (mixinKey) {
    const signed = signWbiParams(params, mixinKey);
    const query = new URLSearchParams(signed as any).toString();
    try {
      const res = await fetch(`https://api.bilibili.com/x/player/wbi/playurl?${query}`, { headers: DEFAULT_HEADERS });
      if (res.ok) {
        const data = await res.json() as any;
        const durl = data.data?.durl || data.result?.durl;
        if (durl?.[0]?.url) return durl[0].url;
      }
    } catch { }
  }

  try {
    const query = new URLSearchParams(params as any).toString();
    const res = await fetch(`https://api.bilibili.com/x/player/playurl?${query}`, { headers: DEFAULT_HEADERS });
    if (res.ok) {
      const data = await res.json() as any;
      const durl = data.data?.durl || data.result?.durl;
      if (durl?.[0]?.url) return durl[0].url;
    }
  } catch { }
  return null;
}

async function handleEmbed(c: Context, bvid: string): Promise<Response> {
  const dParam = c.req.query("d") ?? c.req.query("dir") ?? c.req.query("direct");
  const isDirect = dParam !== undefined;

  const originalUrl = `https://www.bilibili.com/video/${bvid}`;
  const ua = c.req.header("user-agent");
  if (!isBot(ua) && !isDirect) return c.redirect(originalUrl, 302);

  const info = await fetchVideoInfo(bvid);
  if (!info) return c.redirect(originalUrl, 302);

  const host = getOrigin(c);
  const videoUrl = `${host}/bilibili/play/${info.bvid}/${info.cid}/video.mp4`;

  if (isDirect) return c.redirect(videoUrl, 302);

  const metricsArr = [];
  if (info.stat.view > 0) metricsArr.push(`👁️ ${formatNumber(info.stat.view)}`);
  if (info.stat.like > 0) metricsArr.push(`❤️ ${formatNumber(info.stat.like)}`);
  if (info.stat.coin > 0) metricsArr.push(`🪙 ${formatNumber(info.stat.coin)}`);
  if (info.stat.favorite > 0) metricsArr.push(`⭐ ${formatNumber(info.stat.favorite)}`);

  let description = (info.desc ?? "").slice(0, 500);
  if (metricsArr.length > 0) description = description ? `${description}\n\n${metricsArr.join(" ")}` : metricsArr.join(" ");

  let dateStr = "";
  if (info.pubdate) {
    try {
      const d = new Date(info.pubdate * 1000);
      dateStr = ` • ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    } catch { }
  }
  const customSiteName = `Bilibili${dateStr}`;

  const oembedUrl = `${host}/bilibili/oembed?title=${encodeURIComponent(info.title)}&author=${encodeURIComponent(info.owner.name)}&url=${encodeURIComponent(originalUrl)}&provider=${encodeURIComponent(customSiteName)}`;

  return c.html(buildEmbedHtml({
    title: `${info.owner.name} - ${info.title}`,
    description,
    url: originalUrl,
    videoUrl,
    videoWidth: info.dimension?.width ?? 1920,
    videoHeight: info.dimension?.height ?? 1080,
    imageUrl: info.pic,
    color: BILIBILI_COLOR,
    siteName: customSiteName,
    twitterCard: "player",
    oembedUrl
  }));
}

export const bilibiliRouter = new Hono();

bilibiliRouter.get("/oembed", c => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: "video", title: q.title, author_name: q.author, author_url: q.url, provider_name: q.provider ?? "LinkEmbedder / Bilibili" }));
});
bilibiliRouter.get("/play/:bvid/:cid/video.mp4", async c => {
  const bvid = c.req.param("bvid");
  const cid = parseInt(c.req.param("cid"), 10);
  const url = await getPlayUrl(bvid, cid);
  if (!url) return new Response("Not found", { status: 404 });

  try {
    const res = await fetch(url, { headers: DEFAULT_HEADERS, redirect: "manual" });
    if (res.status === 301 || res.status === 302) return c.redirect(res.headers.get("Location") ?? url, 302);

    const proxyHeaders = new Headers();
    ["Content-Type", "Content-Length", "Accept-Ranges", "Content-Range"].forEach(h => {
      if (res.headers.has(h)) proxyHeaders.set(h, res.headers.get(h)!);
    });
    return new Response(res.body, { status: res.status, headers: proxyHeaders });
  } catch {
    return c.redirect(url, 302);
  }
});

bilibiliRouter.get("/video/:bvid", c => handleEmbed(c, c.req.param("bvid").split("?")[0]));
bilibiliRouter.get("/:bvid", c => handleEmbed(c, c.req.param("bvid").split("?")[0]));

function extractBilibiliParams(urlStr: string): string | null {
  try {
    const url = new URL(urlStr);
    if (url.hostname.includes("bilibili.com")) {
      const match = url.pathname.match(/\/video\/([^/]+)/);
      if (match) return match[1];
    }
  } catch {
    const match = urlStr.match(/\/video\/([^/]+)/);
    if (match) return match[1];
  }
  return null;
}

bilibiliRouter.get("/", c => {
  const url = c.req.query("url");
  if (url) {
    const p = extractBilibiliParams(url);
    if (p) return handleEmbed(c, p);
  }
  return new Response("Not found", { status: 404 });
});

bilibiliRouter.get("/*", c => {
  const { path } = c.req;
  const httpMatch = path.match(/(https?:\/\/[^\s]+)/);
  if (httpMatch) {
    const p = extractBilibiliParams(httpMatch[1]);
    if (p) return handleEmbed(c, p);
  }
  return new Response("Not found", { status: 404 });
});
