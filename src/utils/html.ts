export interface EmbedOptions {
  title?: string;
  description?: string;
  url: string;
  proxyUrl?: string;
  imageUrl?: string | string[];
  imageWidth?: number;
  imageHeight?: number;
  videoUrl?: string;
  videoWidth?: number;
  videoHeight?: number;
  videoContentType?: string;
  posterUrl?: string;
  oembedUrl?: string;
  color?: string;
  siteName?: string;
  twitterCard?: "summary" | "summary_large_image" | "player";
  largeImage?: boolean;
  type?: string;
}

export interface OEmbedData {
  type: "link" | "photo" | "video" | "rich";
  version: "1.0";
  title?: string;
  author_name?: string;
  author_url?: string;
  provider_name?: string;
  provider_url?: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
  width?: number;
  height?: number;
  html?: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function meta(property: string, content: string): string {
  return `<meta property="${esc(property)}" content="${esc(content)}" />`;
}

function nameMeta(name: string, content: string): string {
  return `<meta name="${esc(name)}" content="${esc(content)}" />`;
}

function getVideoSizeMultiplier(width?: number, height?: number): number {
  if (!width || !height) return 1;
  if (width > 1920 || height > 1920) return 0.5;
  if (width < 400 && height < 400) return 2;
  return 1;
}

export function buildEmbedHtml(opts: EmbedOptions): string {
  const {
    title,
    description,
    url,
    proxyUrl,
    imageUrl,
    imageWidth,
    imageHeight,
    videoUrl,
    videoWidth,
    videoHeight,
    videoContentType = "video/mp4",
    posterUrl,
    oembedUrl,
    color = "#5865F2",
    siteName = "LinkEmbedder",
    twitterCard,
    largeImage = false,
    type,
  } = opts;

  const isVideo = Boolean(videoUrl);

  let card = twitterCard;
  if (card === "player" && !videoUrl) card = undefined;
  if (!card) {
    if (isVideo) card = "player";
    else if (imageUrl) card = largeImage ? "summary_large_image" : "summary";
    else card = "summary";
  }

  const metas: string[] = [
    meta("og:url", proxyUrl ?? url),
    meta("og:type", type ?? (isVideo ? "video.other" : "website")),
    meta("og:site_name", siteName),
    meta("theme-color", color),
    nameMeta("twitter:card", card),
    nameMeta("twitter:site", siteName),
  ];

  if (title) {
    metas.push(meta("og:title", title));
    metas.push(nameMeta("twitter:title", title));
  }

  if (description) {
    metas.push(meta("description", description));
    metas.push(meta("og:description", description));
    metas.push(nameMeta("twitter:description", description));
  }

  if (imageUrl && !isVideo) {
    const images = Array.isArray(imageUrl) ? imageUrl : [imageUrl];
    for (const img of images) {
      metas.push(meta("og:image", img));
      metas.push(nameMeta("twitter:image", img));
    }
    if (imageWidth) metas.push(meta("og:image:width", String(imageWidth)));
    if (imageHeight) metas.push(meta("og:image:height", String(imageHeight)));
  }

  if (isVideo && videoUrl) {
    const sizeMultiplier = getVideoSizeMultiplier(videoWidth, videoHeight);
    const scaledWidth = videoWidth ? Math.round(videoWidth * sizeMultiplier) : undefined;
    const scaledHeight = videoHeight ? Math.round(videoHeight * sizeMultiplier) : undefined;

    if (scaledWidth) metas.push(nameMeta("twitter:player:width", String(scaledWidth)));
    if (scaledHeight) metas.push(nameMeta("twitter:player:height", String(scaledHeight)));
    metas.push(nameMeta("twitter:player:stream", videoUrl));
    metas.push(nameMeta("twitter:player:stream:content_type", videoContentType));

    metas.push(meta("og:video", videoUrl));
    metas.push(meta("og:video:secure_url", videoUrl));
    metas.push(meta("og:video:type", videoContentType));
    if (scaledWidth) metas.push(meta("og:video:width", String(scaledWidth)));
    if (scaledHeight) metas.push(meta("og:video:height", String(scaledHeight)));

    const poster = posterUrl ?? (Array.isArray(imageUrl) ? imageUrl[0] : imageUrl);
    if (poster) {
      metas.push(meta("og:image", poster));
      metas.push(nameMeta("twitter:image", poster));
    }
  }

  if (oembedUrl) {
    metas.push(
      `<link rel="alternate" type="application/json+oembed" href="${esc(oembedUrl)}" title="${esc(title ?? "")}" />`
    );
  }

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        ${metas.join("\n")}
      </head>
      <body>
        <a href="${esc(url)}">Redirecting…</a>
      </body>
    </html>
  `;
}

export function buildOEmbed(data: Partial<OEmbedData>): OEmbedData {
  return {
    ...data,
    type: "rich",
    version: "1.0",
  };
}
