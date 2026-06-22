import { Context } from "hono";

const BOT_REGEX = /bot|facebook|embed|got|firefox\/\d+|curl|wget|go-http|yahoo|generator|whatsapp|revoltchat|preview|link|proxy|vkshare|images|analyzer|index|crawl|spider|python|cfnetwork|node|mastodon|http\.rb|ruby|bun\/|fiddler|iframely|steamchaturllookup|discordbot|telegrambot|slackbot|twitterbot|applebot|googlebot|january|synapse/i;

export function isBot(userAgent: string | undefined | null): boolean {
  if (!userAgent) return false;
  return BOT_REGEX.test(userAgent);
}

export function getOrigin(c: Context): string {
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() ?? "https";
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? new URL(c.req.url).host;
  return `${proto}://${host}`;
}
