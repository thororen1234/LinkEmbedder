export interface EmbedOptions {
  title: string;
  description?: string;
  url: string;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  videoUrl?: string;
  videoWidth?: number;
  videoHeight?: number;
  oembedUrl?: string;
  color?: string;
  siteName?: string;
  twitterCard?: 'summary' | 'summary_large_image' | 'player';
  largeImage?: boolean;
}

export interface OEmbedData {
  type: 'link' | 'photo' | 'video' | 'rich';
  version: '1.0';
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
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function meta(property: string, content: string): string {
  return `<meta property="${esc(property)}" content="${esc(content)}" />`;
}

function nameMeta(name: string, content: string): string {
  return `<meta name="${esc(name)}" content="${esc(content)}" />`;
}

export function buildEmbedHtml(opts: EmbedOptions): string {
  const {
    title,
    description,
    url,
    imageUrl,
    imageWidth,
    imageHeight,
    videoUrl,
    videoWidth,
    videoHeight,
    oembedUrl,
    color = '#5865F2',
    siteName = 'LinkEmbeder',
    twitterCard,
    largeImage = false,
  } = opts;

  let card = twitterCard;
  if (!card) {
    if (videoUrl) card = 'player';
    else if (imageUrl) card = largeImage ? 'summary_large_image' : 'summary_large_image';
    else card = 'summary';
  }

  const metas: string[] = [
    `<meta http-equiv="refresh" content="0; url=${esc(url)}" />`,
    meta('og:url', url),
    meta('og:title', title),
    meta('og:site_name', siteName),
    meta('theme-color', color),
    nameMeta('twitter:card', card),
    nameMeta('twitter:title', title),
    nameMeta('twitter:site', siteName),
  ];

  if (description) {
    metas.push(meta('og:description', description));
    metas.push(nameMeta('twitter:description', description));
  }

  if (imageUrl) {
    metas.push(meta('og:image', imageUrl));
    metas.push(nameMeta('twitter:image', imageUrl));
    if (imageWidth) metas.push(meta('og:image:width', String(imageWidth)));
    if (imageHeight) metas.push(meta('og:image:height', String(imageHeight)));
    if (card === 'player') {
      metas.push(nameMeta('twitter:image', imageUrl));
    }
  }

  if (videoUrl) {
    metas.push(meta('og:video', videoUrl));
    metas.push(meta('og:video:url', videoUrl));
    metas.push(meta('og:video:type', 'video/mp4'));
    if (videoWidth) metas.push(meta('og:video:width', String(videoWidth)));
    if (videoHeight) metas.push(meta('og:video:height', String(videoHeight)));
    metas.push(nameMeta('twitter:player', videoUrl));
    if (videoWidth) metas.push(nameMeta('twitter:player:width', String(videoWidth)));
    if (videoHeight) metas.push(nameMeta('twitter:player:height', String(videoHeight)));
  }

  if (oembedUrl) {
    metas.push(
      `<link rel="alternate" type="application/json+oembed" href="${esc(oembedUrl)}" title="${esc(title)}" />`
    );
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
${metas.join('\n')}
</head>
<body>
<a href="${esc(url)}">Redirecting…</a>
</body>
</html>`;
}

export function buildOEmbed(data: Partial<OEmbedData>): OEmbedData {
  return {
    type: data.type ?? 'link',
    version: '1.0',
    ...data,
  };
}
