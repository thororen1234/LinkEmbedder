import * as cheerio from "cheerio";
import { Context, Hono } from "hono";

import { isBot } from "../utils/bot.js";
import { furaffinityCache } from "../utils/cache.js";
import { buildEmbedHtml, buildOEmbed } from "../utils/html.js";

const FA_COLOR = "#2e3b44";

interface FAInfo {
  url: string;
  title: string;
  description: string;
  imageUrl?: string;
  artistName: string;
}

async function fetchFASubmission(id: string): Promise<FAInfo | null> {
  const cached = furaffinityCache.get(id) as FAInfo | undefined;
  if (cached) return cached;

  const cookieA = process.env.FA_COOKIE_A ?? "";
  const cookieB = process.env.FA_COOKIE_B ?? "";
  const cookieHeader = (cookieA && cookieB) ? `a=${cookieA}; b=${cookieB}` : "";

  try {
    const res = await fetch(`https://www.furaffinity.net/view/${id}/`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Cookie": cookieHeader
      }
    });

    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    const title = $('meta[property="og:title"]').attr("content") || "";
    const description = $('meta[property="og:description"]').attr("content") || "";
    const url = $('meta[property="og:url"]').attr("content") || `https://www.furaffinity.net/view/${id}/`;

    let artistName = $('.submission-description-artist .c-usernameBlockSimple a[href^="/user/"]').first().text().trim();
    if (!artistName) {
      artistName = $('.submission-id-sub-container a[href^="/user/"]').first().text().trim();
    }

    let downloadHref = $('#submission-options a[href^="//d.furaffinity.net"]').attr("href") || $("div.download a").attr("href");
    if (!downloadHref) {
      downloadHref = $("#submissionImg").attr("data-preview-src") || $('meta[property="og:image"]').attr("content");
    }
    const imageUrl = downloadHref ? (downloadHref.startsWith("//") ? `https:${downloadHref}` : downloadHref) : undefined;

    const info: FAInfo = { url, title, description, imageUrl, artistName: artistName || "Unknown Artist" };
    furaffinityCache.set(id, info);
    return info;
  } catch { return null; }
}

async function handleFA(c: Context, id: string): Promise<Response> {
  const originalUrl = `https://www.furaffinity.net/view/${id}/`;
  const ua = c.req.header("user-agent");
  if (!isBot(ua)) return c.redirect(originalUrl, 302);

  const info = await fetchFASubmission(id);
  if (!info) return c.redirect(originalUrl, 302);

  const host = new URL(c.req.url).origin;
  const oembedUrl = `${host}/furaffinity/oembed?title=${encodeURIComponent(info.title)}&author=${encodeURIComponent(info.artistName)}&url=${encodeURIComponent(originalUrl)}`;

  return c.html(buildEmbedHtml({
    title: info.title,
    description: info.description,
    url: originalUrl,
    imageUrl: info.imageUrl,
    color: FA_COLOR,
    siteName: "FurAffinity",
    largeImage: true,
    oembedUrl
  }));
}

export const furaffinityRouter = new Hono();

furaffinityRouter.get("/oembed", c => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: "photo", title: q.title, author_name: q.author, author_url: q.url, provider_name: "LinkEmbedder / FurAffinity" }));
});

furaffinityRouter.get("/view/:id", c => handleFA(c, c.req.param("id")));
furaffinityRouter.get("/view/:id/*", c => handleFA(c, c.req.param("id")));
