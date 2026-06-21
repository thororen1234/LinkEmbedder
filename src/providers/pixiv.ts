import { spawn } from "child_process";
import fs from "fs/promises";
import { Context, Hono } from "hono";
import os from "os";
import path from "path";
import { extract } from "zip-lib";

import { isBot } from "../utils/bot.js";
import { pixivCache } from "../utils/cache.js";
import { buildEmbedHtml, buildOEmbed } from "../utils/html.js";

const PIXIV_COLOR = "#0096FA";

interface PixivArtwork { id: string; title: string; userName: string; description: string; urls: { regular: string; original: string }; tags: { tags: Array<{ tag: string; translation?: { en: string } }> }; pageCount: number; illustType: number; }
interface PixivData { body?: PixivArtwork; error?: boolean; message?: string; }
interface UgoiraMeta { body?: { src: string; originalSrc: string; mime_type: string; frames: Array<{ file: string; delay: number }> } }

async function fetchPixivData(id: string): Promise<PixivArtwork | null> {
  const cached = pixivCache.get(id) as PixivArtwork | undefined;
  if (cached) return cached;
  try {
    const res = await fetch(`https://www.pixiv.net/ajax/illust/${id}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept-Language": "en-US,en;q=0.5" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as PixivData;
    if (data.error || !data.body) return null;
    pixivCache.set(id, data.body);
    return data.body;
  } catch { return null; }
}

async function fetchUgoiraMeta(id: string): Promise<UgoiraMeta["body"] | null> {
  try {
    const res = await fetch(`https://www.pixiv.net/ajax/illust/${id}/ugoira_meta`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept-Language": "en-US,en;q=0.5" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as UgoiraMeta;
    return data.body || null;
  } catch { return null; }
}

async function proxyImage(url: string, c: Context): Promise<Response> {
  try {
    const res = await fetch(url, { headers: { Referer: "https://www.pixiv.net/" } });
    if (!res.ok) return c.redirect(url, 302);
    return new Response(res.body, { headers: { "Content-Type": res.headers.get("content-type") ?? "image/jpeg", "Cache-Control": "public, max-age=86400" } });
  } catch { return c.redirect(url, 302); }
}

async function buildUgoiraMp4(id: string, meta: UgoiraMeta["body"]): Promise<Buffer | null> {
  const cachedPath = path.join(os.tmpdir(), `pixiv_${id}.mp4`);
  try {
    const stat = await fs.stat(cachedPath);
    if (stat.isFile()) return await fs.readFile(cachedPath);
  } catch { }

  const zipRes = await fetch(meta!.originalSrc, { headers: { Referer: "https://www.pixiv.net/" } });
  if (!zipRes.ok) return null;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `ugoira_${id}_`));
  const zipPath = path.join(tempDir, "ugoira.zip");
  await fs.writeFile(zipPath, Buffer.from(await zipRes.arrayBuffer()));

  await extract(zipPath, tempDir);

  const concatTxtPath = path.join(tempDir, "concat.txt");
  let concatTxt = "";
  for (const frame of meta!.frames) {
    concatTxt += `file '${path.join(tempDir, frame.file).replace(/\\/g, "/")}'\n`;
    concatTxt += `duration ${frame.delay / 1000}\n`;
  }
  concatTxt += `file '${path.join(tempDir, meta!.frames[meta!.frames.length - 1].file).replace(/\\/g, "/")}'\n`;
  await fs.writeFile(concatTxtPath, concatTxt);

  return new Promise(resolve => {
    const ffmpegProcess = spawn("ffmpeg", [
      "-f", "concat",
      "-safe", "0",
      "-i", concatTxtPath,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-y",
      cachedPath
    ]);

    ffmpegProcess.on("close", async code => {
      if (code === 0) {
        try {
          const buf = await fs.readFile(cachedPath);
          resolve(buf);
        } catch {
          resolve(null);
        }
      } else {
        console.error(`ffmpeg exited with code ${code}`);
        resolve(null);
      }
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { });
    });

    ffmpegProcess.on("error", async err => {
      console.error("Ugoira ffmpeg spawn error:", err);
      resolve(null);
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { });
    });
  });
}

async function handleEmbed(c: Context): Promise<Response> {
  const id = c.req.param("id") as string;
  const { path } = c.req;
  const originalUrl = path.includes("/en/") ? `https://www.pixiv.net/en/artworks/${id}` : `https://www.pixiv.net/artworks/${id}`;
  const ua = c.req.header("user-agent");
  if (!isBot(ua)) return c.redirect(originalUrl, 302);

  const data = await fetchPixivData(id);
  if (!data) return c.redirect(originalUrl, 302);

  const authorName = `${data.userName}`;
  const rawDesc = data.description.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
  const tags = data.tags.tags.map(t => `#${t.translation?.en ?? t.tag}`).join(" ");
  const description = `${rawDesc}\n\n${tags}`;
  const host = new URL(c.req.url).origin;
  const oembedUrl = `${host}/pixiv/oembed?title=${encodeURIComponent(data.title)}&author=${encodeURIComponent(authorName)}&url=${encodeURIComponent(originalUrl)}`;

  if (data.illustType === 2) {
    const videoRoute = `${host}/pixiv/i/ugoira/${id}.mp4`;
    const imageRoute = `${host}/pixiv/i/${id}/1`;
    return c.html(buildEmbedHtml({ title: data.title, description, url: originalUrl, videoUrl: videoRoute, imageUrl: imageRoute, color: PIXIV_COLOR, siteName: "Pixiv", twitterCard: "player", oembedUrl }));
  }

  const imageRoute = `${host}/pixiv/i/${id}/1`;
  return c.html(buildEmbedHtml({ title: data.title, description, url: originalUrl, imageUrl: imageRoute, color: PIXIV_COLOR, siteName: "Pixiv", largeImage: true, oembedUrl }));
}

export const pixivRouter = new Hono();

pixivRouter.get("/oembed", c => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: "link", title: q.title, author_name: q.author, author_url: q.url, provider_name: "LinkEmbedder / Pixiv" }));
});

pixivRouter.get("/i/:id/:page", async c => {
  const id = c.req.param("id") as string;
  const page = parseInt(c.req.param("page"), 10) - 1;
  const data = await fetchPixivData(id);
  if (!data) return c.notFound();
  let url = data.urls.original;
  if (page > 0) {
    url = url.replace(/_p0/, `_p${page}`);
  }
  return proxyImage(url, c);
});

pixivRouter.get("/i/ugoira/:id.mp4", async c => {
  const id = c.req.param("id") as string;
  const data = await fetchPixivData(id);
  if (!data || data.illustType !== 2) return c.notFound();

  const meta = await fetchUgoiraMeta(id);
  if (!meta) return c.redirect(data.urls.original, 302);

  const mp4Buf = await buildUgoiraMp4(id, meta);
  if (!mp4Buf) return c.redirect(data.urls.original, 302);

  return new Response(mp4Buf as any, { headers: { "Content-Type": "video/mp4", "Cache-Control": "public, max-age=86400" } });
});

for (const pattern of ["/artworks/:id", "/en/artworks/:id", "/artworks/:id/:imageIndex", "/en/artworks/:id/:imageIndex"]) {
  pixivRouter.get(pattern, handleEmbed);
}
