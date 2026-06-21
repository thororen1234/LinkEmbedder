import { Context, Hono } from "hono";

import { isBot } from "../utils/bot.js";
import { instagramCache } from "../utils/cache.js";
import { buildEmbedHtml, buildOEmbed } from "../utils/html.js";
import { createMosaic } from "../utils/image.js";

const INSTA_COLOR = "#E1306C";

interface InstaMedia { typeName: string; url: string; }
interface InstaData { postId: string; username: string; caption: string; medias: InstaMedia[]; }
interface InstaProfile { username: string; fullName: string; biography: string; profilePicUrl: string; followersCount: number; followingCount: number; postsCount: number; }

const GQL_HEADERS: Record<string, string> = {
  Accept: "*/*", "Accept-Language": "en-US,en;q=0.9",
  "Content-Type": "application/x-www-form-urlencoded",
  Origin: "https://www.instagram.com",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
  "X-Ig-App-Id": "936619743392459",
  "X-Fb-Friendly-Name": "PolarisPostActionLoadPostQueryQuery",
};

async function scrapeFromEmbed(postId: string): Promise<InstaData | null> {
  try {
    const res = await fetch(`https://www.instagram.com/p/${postId}/embed/captioned/`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Discordbot/2.0)", Accept: "text/html" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const userMatch = html.match(/class="UsernameText"[^>]*>([^<]+)</);
    const username = userMatch?.[1]?.trim() ?? "";
    const captionMatch = html.match(/class="Caption"[^>]*>([\s\S]*?)<\/div>/);
    let caption = (captionMatch?.[1] ?? "").replace(/<[^>]+>/g, "").trim();
    if (username && caption.startsWith(username)) {
      caption = caption.substring(username.length).trim();
    }
    caption = caption.replace(/View all \d+ comments$/i, "").trim();
    caption = caption.replace(/Add a comment\.\.\.$/i, "").trim();
    const isVideo = html.includes("EmbeddedMediaVideo");
    const mediaMatch = isVideo
      ? html.match(/class="EmbeddedMediaVideo"[^>]*src="([^"]+)"/)
      : html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/);
    if (!mediaMatch || !username) return null;
    return { postId, username, caption, medias: [{ typeName: isVideo ? "GraphVideo" : "GraphImage", url: mediaMatch[1].replace(/&amp;/g, "&") }] };
  } catch { return null; }
}

async function scrapeFromGQL(postId: string): Promise<InstaData | null> {
  try {
    const variables = JSON.stringify({ shortcode: postId, fetch_comment_count: 2, has_threaded_comments: true });
    const body = new URLSearchParams({
      av: "0", __d: "www", __user: "0", __a: "1", __req: "k",
      __hs: "19888.HYP:instagram_web_pkg.2.1..0.0", dpr: "2", __ccg: "UNKNOWN", __rev: "1014227545",
      fb_api_caller_class: "RelayModern", fb_api_req_friendly_name: "PolarisPostActionLoadPostQueryQuery",
      server_timestamps: "true", doc_id: "25531498899829322", variables,
    }).toString();
    const res = await fetch("https://www.instagram.com/graphql/query/", { method: "POST", headers: GQL_HEADERS, body });
    if (!res.ok) return null;
    const json = await res.json() as Record<string, unknown>;
    const data = json.data as Record<string, unknown> | undefined;
    if (!data) return null;
    const item = (data.shortcode_media ?? data.xdt_shortcode_media) as Record<string, unknown> | undefined;
    if (!item) return null;
    const username = (item.owner as Record<string, string> | undefined)?.username ?? "";
    const captionEdges = (item.edge_media_to_caption as { edges: Array<{ node: { text: string } }> } | undefined)?.edges ?? [];
    const caption = captionEdges[0]?.node?.text ?? "";
    const medias: InstaMedia[] = [];
    const sidecar = item.edge_sidecar_to_children as { edges: Array<{ node: Record<string, unknown> }> } | undefined;
    const nodes = sidecar?.edges?.map(e => e.node) ?? [item];
    for (const node of nodes) {
      const videoUrl = node.video_url as string | undefined;
      const displayUrl = node.display_url as string | undefined;
      const typeName = (node.__typename as string | undefined) ?? (videoUrl ? "GraphVideo" : "GraphImage");
      medias.push({ typeName, url: videoUrl ?? displayUrl ?? "" });
    }
    return { postId, username, caption, medias };
  } catch { return null; }
}

async function fetchProfile(username: string): Promise<InstaProfile | null> {
  const cacheKey = `profile:${username}`;
  const cached = instagramCache.get(cacheKey) as InstaProfile | undefined;
  if (cached) return cached;
  try {
    const res = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, {
      headers: { ...GQL_HEADERS, "X-Ig-App-Id": "936619743392459" }
    });
    if (!res.ok) return null;
    const json = await res.json() as any;
    const user = json?.data?.user;
    if (!user) return null;
    const profile = {
      username: user.username,
      fullName: user.full_name,
      biography: user.biography,
      profilePicUrl: user.profile_pic_url_hd ?? user.profile_pic_url,
      followersCount: user.edge_followed_by?.count ?? 0,
      followingCount: user.edge_follow?.count ?? 0,
      postsCount: user.edge_owner_to_timeline_media?.count ?? 0,
    };
    instagramCache.set(cacheKey, profile);
    return profile;
  } catch { return null; }
}

async function getInstaData(postId: string): Promise<InstaData | null> {
  const cached = instagramCache.get(postId) as InstaData | undefined;
  if (cached) return cached;
  let data = await scrapeFromEmbed(postId);
  if (!data || !data.medias.length) data = await scrapeFromGQL(postId);
  if (!data) return null;
  instagramCache.set(postId, data);
  return data;
}

export const instagramRouter = new Hono();

instagramRouter.get("/oembed", c => {
  const q = c.req.query();
  return c.json(buildOEmbed({ type: "link", author_name: q.user, author_url: q.url, provider_name: "LinkEmbedder / Instagram" }));
});

instagramRouter.get("/images/:id/:n", async c => {
  const { id, n } = c.req.param();
  const data = await getInstaData(id);
  if (!data) return c.redirect(`https://www.instagram.com/p/${id}/`, 302);
  const idx = Math.max(1, parseInt(n, 10)) - 1;
  const media = data.medias[idx];
  if (!media) return c.redirect(`https://www.instagram.com/p/${id}/`, 302);
  try {
    const imgRes = await fetch(media.url, { headers: { Referer: "https://www.instagram.com/" } });
    if (!imgRes.ok) return c.redirect(media.url, 302);
    return new Response(imgRes.body, { headers: { "Content-Type": imgRes.headers.get("content-type") ?? "image/jpeg", "Cache-Control": "public, max-age=86400" } });
  } catch { return c.redirect(media.url, 302); }
});

instagramRouter.get("/videos/:id/:n/video.mp4", async c => {
  const { id, n } = c.req.param();
  instagramCache.delete(id);
  const data = await getInstaData(id);
  if (!data) return c.redirect(`https://www.instagram.com/p/${id}/`, 302);
  const idx = Math.max(1, parseInt(n, 10)) - 1;
  const mediaUrl = data.medias[idx]?.url;
  if (!mediaUrl) return c.redirect(`https://www.instagram.com/p/${id}/`, 302);

  try {
    const videoRes = await fetch(mediaUrl, {
      headers: {
        Referer: "https://www.instagram.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
        Accept: "*/*"
      }
    });
    if (!videoRes.ok) return c.redirect(mediaUrl, 302);

    const proxyHeaders = new Headers();
    ["Content-Type", "Content-Length", "Accept-Ranges", "Content-Range"].forEach(h => {
      if (videoRes.headers.has(h)) proxyHeaders.set(h, videoRes.headers.get(h)!);
    });
    return new Response(videoRes.body, { status: videoRes.status, headers: proxyHeaders });
  } catch {
    return c.redirect(mediaUrl, 302);
  }
});

instagramRouter.get("/grid/:id", async c => {
  const id = c.req.param("id");
  const data = await getInstaData(id);
  if (!data) return new Response("Not found", { status: 404 });
  const photos = data.medias.filter(m => !m.typeName.toLowerCase().includes("video")).map(m => m.url);
  if (!photos.length) return new Response("Not found", { status: 404 });
  const buffer = await createMosaic(photos);
  if (!buffer) return c.redirect(photos[0], 302);
  return new Response(buffer as any, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" } });
});

async function handleProfileEmbed(c: Context, username: string): Promise<Response> {
  const ua = c.req.header("user-agent");
  const originalUrl = `https://www.instagram.com/${username}/`;
  if (!isBot(ua)) return c.redirect(originalUrl, 302);
  const profile = await fetchProfile(username);
  if (!profile) return c.redirect(originalUrl, 302);
  return c.html(buildEmbedHtml({ title: `${profile.fullName || profile.username} (@${profile.username})`, description: profile.biography, url: originalUrl, proxyUrl: c.req.url, imageUrl: profile.profilePicUrl, color: INSTA_COLOR, siteName: "Instagram" }));
}

async function handleEmbed(c: Context): Promise<Response> {
  const { path } = c.req;
  const postIdFromRoute = c.req.param("id") as string | undefined;
  const postId = postIdFromRoute ?? path.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)?.[1];
  if (!postId) return c.redirect("https://www.instagram.com/", 302);

  const ua = c.req.header("user-agent");
  const mediaNumParam = parseInt((c.req.param("mediaNum") as string | undefined) ?? c.req.query("img_index") ?? "0", 10);
  const originalUrl = `https://www.instagram.com/p/${postId}/`;
  if (!isBot(ua)) return c.redirect(originalUrl, 302);

  const data = await getInstaData(postId);
  if (!data || !data.medias.length) return c.redirect(originalUrl, 302);

  const authorName = `@${data.username}`;
  const description = data.caption.slice(0, 300) + (data.caption.length > 300 ? "…" : "");
  const host = new URL(c.req.url).origin;
  const oembedUrl = `${host}/ig/oembed?user=${encodeURIComponent(authorName)}&url=${encodeURIComponent(originalUrl)}`;
  const idx = Math.max(0, (mediaNumParam || 1) - 1);
  const media = data.medias[Math.min(idx, data.medias.length - 1)];
  const isVideo = media.typeName.toLowerCase().includes("video");
  const n = idx + 1;

  if (isVideo) {
    return c.html(buildEmbedHtml({ description, url: originalUrl, proxyUrl: c.req.url, videoUrl: `${host}/ig/videos/${postId}/${n}/video.mp4`, videoWidth: 1080, videoHeight: 1080, color: INSTA_COLOR, siteName: "Instagram", twitterCard: "player", oembedUrl }));
  }
  const galleryDesc = description;
  if (mediaNumParam) {
    return c.html(buildEmbedHtml({ description: galleryDesc, url: originalUrl, proxyUrl: c.req.url, imageUrl: `${host}/ig/images/${postId}/${n}`, color: INSTA_COLOR, siteName: "Instagram", largeImage: true, oembedUrl }));
  } else if (data.medias.length > 1) {
    return c.html(buildEmbedHtml({ description: galleryDesc, url: originalUrl, proxyUrl: c.req.url, imageUrl: `${host}/ig/grid/${postId}`, color: INSTA_COLOR, siteName: "Instagram", largeImage: true, oembedUrl }));
  } else {
    return c.html(buildEmbedHtml({ description: galleryDesc, url: originalUrl, proxyUrl: c.req.url, imageUrl: `${host}/ig/images/${postId}/1`, color: INSTA_COLOR, siteName: "Instagram", largeImage: true, oembedUrl }));
  }
}

instagramRouter.get("/:username", c => {
  const username = c.req.param("username");
  if (["p", "reel", "reels", "tv", "stories", "images", "videos", "oembed", "grid"].includes(username)) {
    return c.notFound();
  }
  return handleProfileEmbed(c, username);
});

for (const pattern of ["/p/:id", "/p/:id/:mediaNum", "/reel/:id", "/reels/:id", "/tv/:id", "/stories/:username/:id", "/:username/p/:id", "/:username/p/:id/:mediaNum", "/:username/reel/:id"]) {
  instagramRouter.get(pattern, handleEmbed);
}
