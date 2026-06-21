const BOT_REGEX = /bot|facebook|embed|got|firefox\/92|firefox\/38|curl|wget|go-http|yahoo|generator|whatsapp|revoltchat|preview|link|proxy|vkshare|images|analyzer|index|crawl|spider|python|cfnetwork|node|mastodon|http\.rb|ruby|bun\/|fiddler|iframely|steamchaturllookup|discordbot|telegrambot|slackbot|twitterbot|applebot|googlebot|january|synapse/i;

export function isBot(userAgent: string | undefined | null): boolean {
  if (!userAgent) return false;
  return BOT_REGEX.test(userAgent);
}
