import { Context, Hono } from "hono";

import { getOrigin, isBot } from "../utils/bot.js";
import { iwaraCache } from "../utils/cache.js";
import { buildEmbedHtml, buildOEmbed } from "../utils/html.js";

const IWARA_COLOR = "#ed7042";
const X_VERSION = "00d377d9a3d18587749666e69858d607e396fb5a";

interface IwaraVideoInfo {
  title: string;
  body: string;
  numViews: number;
  numLikes: number;
  user: { name: string; };
  fileUrl: string;
  file: { id: string; };
}

async function fetchIwaraInfo(videoId: string): Promise<IwaraVideoInfo | null> {
  const cached = iwaraCache.get(videoId) as IwaraVideoInfo | undefined;
  if (cached) return cached;
  try {
    const res = await fetch(`https://api.iwara.tv/video/${videoId}`);
    if (!res.ok) return null;
    const data = await res.json() as IwaraVideoInfo;
    iwaraCache.set(videoId, data);
    return data;
  } catch { return null; }
}

async function handleIwaraEmbed(c: Context, videoId: string, videoName: string): Promise<Response> {
  const dParam = c.req.query("d") ?? c.req.query("dir") ?? c.req.query("direct");
  const isDirect = dParam !== undefined;

  const originalUrl = `https://iwara.tv/video/${videoId}/${videoName}`;
  const ua = c.req.header("user-agent");
  if (!isBot(ua) && !isDirect) return c.redirect(originalUrl, 302);

  const info = await fetchIwaraInfo(videoId);
  if (!info) return c.redirect(originalUrl, 302);

  const host = getOrigin(c);

  if (isDirect) {
    return c.redirect(`${host}/iwara/dl/${videoId}/Source/video.mp4`, 302);
  }

  const oembedUrl = `${host}/iwara/oembed?title=${encodeURIComponent(info.title)}&author=${encodeURIComponent(info.user.name)}&url=${encodeURIComponent(originalUrl)}`;

  const description = (info.body || "").slice(0, 500);

  return c.html(buildEmbedHtml({
    title: `${info.user.name} - ${info.title}`,
    description,
    url: originalUrl,
    videoUrl: `${host}/iwara/dl/${videoId}/Source/video.mp4`,
    videoWidth: 1920,
    videoHeight: 1080,
    imageUrl: `https://i.iwara.tv/image/thumbnail/${info.file.id}/thumbnail-00.jpg`,
    color: IWARA_COLOR,
    siteName: "Iwara",
    twitterCard: "player",
    oembedUrl
  }));
}

export const iwaraRouter = new Hono();

iwaraRouter.get("/oembed", c => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: "video", title: q.title, author_name: q.author, author_url: q.url, provider_name: "LinkEmbedder / Iwara" }));
});

iwaraRouter.get("/dl/:videoId/:quality/video.mp4", async c => {
  const videoId = c.req.param("videoId");
  const quality = c.req.param("quality");

  const info = await fetchIwaraInfo(videoId);
  if (!info || !info.fileUrl) return new Response("Not found", { status: 404 });

  try {
    const fileRes = await fetch(info.fileUrl, { headers: { "x-version": X_VERSION } });
    if (!fileRes.ok) return new Response("Not found", { status: 404 });
    const fileData = await fileRes.json() as Array<{ name: string; src: { download: string; }; }>;
    const qData = fileData.find(d => d.name === quality) || fileData[0];
    if (!qData) return new Response("Not found", { status: 404 });

    const videoUrl = `https:${qData.src.download}`;
    const vidRes = await fetch(videoUrl, { redirect: "manual" });
    if (vidRes.status === 301 || vidRes.status === 302) return c.redirect(vidRes.headers.get("Location") ?? videoUrl, 302);

    const proxyHeaders = new Headers();
    ["Content-Type", "Content-Length", "Accept-Ranges", "Content-Range"].forEach(h => {
      if (vidRes.headers.has(h)) proxyHeaders.set(h, vidRes.headers.get(h)!);
    });
    return new Response(vidRes.body, { status: vidRes.status, headers: proxyHeaders });
  } catch {
    return new Response("Not found", { status: 404 });
  }
});

iwaraRouter.get("/video/:videoId/:videoName", c => handleIwaraEmbed(c, c.req.param("videoId"), c.req.param("videoName")));
iwaraRouter.get("/video/:videoId", c => handleIwaraEmbed(c, c.req.param("videoId"), ""));

function extractIwaraParams(urlStr: string): { id: string; name: string; } | null {
  try {
    const url = new URL(urlStr);
    if (url.hostname.includes("iwara.tv")) {
      const match = url.pathname.match(/\/video\/([^/]+)(?:\/([^/]+))?/);
      if (match) return { id: match[1], name: match[2] || "" };
    }
  } catch {
    const match = urlStr.match(/\/video\/([^/]+)(?:\/([^/]+))?/);
    if (match) return { id: match[1], name: match[2] || "" };
  }
  return null;
}

iwaraRouter.get("/", c => {
  const url = c.req.query("url");
  if (url) {
    const p = extractIwaraParams(url);
    if (p) return handleIwaraEmbed(c, p.id, p.name);
  }
  return new Response("Not found", { status: 404 });
});

iwaraRouter.get("/*", c => {
  const { path } = c.req;
  const httpMatch = path.match(/(https?:\/\/[^\s]+)/);
  if (httpMatch) {
    const p = extractIwaraParams(httpMatch[1]);
    if (p) return handleIwaraEmbed(c, p.id, p.name);
  }
  return new Response("Not found", { status: 404 });
});
