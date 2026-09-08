/** Single source of truth for this bot's Telegram username. `wire-api.sh` / `wire-s4.sh` /
 * `wire-day2.sh` rewrite the exact line `const BOT = "...";` below when a real token is
 * minted -- keep its shape. Until then, or whenever this string contains "PLACEHOLDER", BOT is
 * NOT a real, owned username: every user-facing link must use HUB_FALLBACK instead of guessing
 * one -- a guessed-looking t.me name is always somebody else's live bot (see REVIEW-WEBAPP.md).
 * Imported by both index.ts (chat share, error copy) and webapp.ts (Mini App links) so the two
 * can never disagree about which bot they belong to. */
export const BOT = "TriviaDailyProBot";

/** intel/hub-apps.json direct_link for this bot's key -- the only safe public link when BOT
 * above is not live. Falls back to the hub root if this bot has no hub-apps.json entry yet. */
export const HUB_FALLBACK = "https://t.me/TinyTelegramToolsBot/trivia";

/** True when BOT is a real, owned username safe to link to directly. */
export const BOT_LIVE = BOT.length > 0 && !BOT.includes("PLACEHOLDER");

/** Product title shown in the Mini App header and share-widget label (intel/hub-apps.json). */
export const TITLE = "Trivia";

/** The public https://t.me link for this bot: its own username (optionally with a
 * ?start=startParam deep-link param) when live, else the hub Direct-Link fallback. Never
 * returns a tg:// URL (rejected by WebApp.openTelegramLink) and never guesses a username. */
export function publicLink(startParam?: string): string {
  if (!BOT_LIVE) return HUB_FALLBACK;
  return startParam ? `https://t.me/${BOT}?start=${startParam}` : `https://t.me/${BOT}`;
}
