/** Guest Mode (Bot API 10.0, 2026-05-08).
 *
 * A user can @-mention the bot — or reply to one of its messages — in a chat the bot is NOT a
 * member of. Telegram then delivers `Update.guest_message` (a Message carrying `guest_query_id`)
 * and the bot answers once with `answerGuestQuery(guest_query_id, InlineQueryResult)`. The result
 * is posted into that chat, attributed to the bot, visible to everyone. No admin has to add us.
 *
 * Everything here is runtime-dependency-free (type-only grammY imports and plain object literals),
 * so `node --test` can exercise the pure parts without a Workers runtime. Keep it that way.
 */
import type { Bot, Context } from "grammy";
import type { InlineKeyboardButton, InlineQueryResultArticle } from "grammy/types";

/** Funnel step + `?start=` payload for a first touch that came from a guest reply. */
export const GUEST_SOURCE = "guest";
/** The fleet's /start payload shape. `guest` must match it, or an install that arrives
 * through a guest button could never attribute to `src_guest`. Asserted by a unit test. */
export const SOURCE_PAYLOAD_RE = /^[a-z]{2,12}$/;

/* ---- Write-time limits (F1). All pure, so they are unit-tested under plain node. ---- */

/** QA fixtures used by smoke.sh. A summon from this id range, or from this chat, is
 * answered normally but never stored and never counted. */
export const QA_USER_MIN = 900_000_000;
export const QA_USER_MAX = 900_999_999;
export const QA_CHAT_ID = -1001234567890;
/** Per user: at most one recorded query per minute, and at most 30 per UTC day. */
export const GUEST_GAP_S = 60;
export const GUEST_DAY_MAX = 30;
/** The rolling `guests` table never exceeds this many rows; totals live in counters. */
export const GUEST_ROW_CAP = 2000;
/** Flood guard: more than this many arrivals in one 10-minute window and every guest
 * write is skipped until the window rolls (the query is still answered, cheaply). */
export const GUEST_FLOOD_WINDOW_S = 600;
export const GUEST_FLOOD_MAX = 600;
const DAY_S = 86_400;

/** `ownerId` (0 when the OWNER_ID secret is unset) excludes the fleet owner's own real
 * Telegram id from Guest Mode / inline recording the same way the QA range is excluded —
 * the owner's manual testing must never inflate real user-facing counts. */
export const isQaGuest = (userId: number, chatId: number, ownerId = 0): boolean =>
  (userId >= QA_USER_MIN && userId <= QA_USER_MAX) || chatId === QA_CHAT_ID || (ownerId > 0 && userId === ownerId);

/** SQL predicate excluding both the QA fixture range and the fleet owner's own real id from
 * a user-facing count, in one place — every store (BaseStore and every per-bot db.ts) filters
 * through this rather than repeating a literal `BETWEEN` clause. `ownerId` is 0 when the
 * OWNER_ID secret is unset (tests, a fresh clone) so the owner clause is simply never true —
 * never hardcode the numeric id at a call site. Splices `ownerId` as a literal because it is
 * trusted config (a Worker secret), never user input, and every call site already has its own
 * positional (?1, ?2, ...) params this must not collide with. */
export function notTestUser(col: string, ownerId: number): string {
  const owner = Number.isInteger(ownerId) && ownerId > 0 ? ` OR ${col} = ${ownerId}` : "";
  return `NOT (${col} BETWEEN ${QA_USER_MIN} AND ${QA_USER_MAX}${owner})`;
}

export const guestDay = (ts: number): number => Math.floor(ts / DAY_S);
export const guestWindow = (ts: number): number => Math.floor(ts / GUEST_FLOOD_WINDOW_S);
export const guestFlooded = (windowCount: number): boolean => windowCount > GUEST_FLOOD_MAX;
export const guestOverflow = (rows: number, cap: number = GUEST_ROW_CAP): number => Math.max(0, rows - cap);

/** One row of the per-user guest rate ledger. */
export interface GuestRate { last_ts: number; day: number; n: number; }
/** What `recordGuest` reports back: whether the row was stored, and whether the fleet-wide
 * flood guard is tripped (in which case the caller answers with the cheapest pitch). */
export interface GuestRecordResult { recorded: boolean; flood: boolean; }

/** True when this user may have one more query recorded: never twice inside GUEST_GAP_S,
 * never more than GUEST_DAY_MAX in one UTC day. Excess queries are still answered. */
export function guestRateOk(prev: GuestRate | null, ts: number): boolean {
  if (!prev) return true;
  if (ts - prev.last_ts < GUEST_GAP_S) return false;
  return guestDay(ts) !== prev.day || prev.n < GUEST_DAY_MAX;
}

/** The ledger row to store after an allowed query; the daily count resets on a day roll. */
export function nextGuestRate(prev: GuestRate | null, ts: number): GuestRate {
  const day = guestDay(ts);
  const n = prev && prev.day === day ? prev.n + 1 : 1;
  return { last_ts: ts, day, n };
}

/** Telegram allows at most this many buttons on a guest result; we keep one row per button. */
const MAX_BUTTONS = 5;
const MAX_TITLE = 60;
const MAX_DESC = 90;
const MAX_TEXT = 4000;

/** A url button (the normal case) or, with `data` instead, a callback button — inline results
 * accept callback_data, and the resulting callback query arrives with `inline_message_id`
 * instead of `message`, which is why whisper-style reveal flows work from a guest reply. */
export interface GuestButton { label: string; url?: string; data?: string; }

/** What a bot wants said in the chat it was summoned into. `text` is sent as PLAIN TEXT —
 * never set parse_mode on it, because it can carry user-supplied words with _ * ` [ in them. */
export interface GuestReply {
  title: string;
  text: string;
  description?: string;
  thumb?: string;
  buttons?: GuestButton[];
}

export type GuestRecord = (userId: number, chatType: string, chatId: number) => Promise<boolean | void>;

export interface GuestOpts {
  /** Bare username, no leading "@". */
  botUsername: string;
  reply: (ctx: Context) => Promise<GuestReply>;
  /** Optional funnel hook for the summoning user. Returns `false` when the fleet-wide
   * flood guard is tripped, which makes wireGuest answer with the cheapest static pitch
   * instead of running the bot's own (possibly storage-backed) reply builder. */
  record?: GuestRecord;
}

export const guestOpenUrl = (botUsername: string): string => `https://t.me/${botUsername}?start=${GUEST_SOURCE}`;
export const guestAddUrl = (botUsername: string): string => `https://t.me/${botUsername}?startgroup=${GUEST_SOURCE}`;

/** True for the chat types where "Add to this group" makes sense. */
export const isGuestGroup = (chatType: string): boolean => chatType === "group" || chatType === "supergroup";

const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1) + "…");
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Strips the bot's @mention out of a guest message's text so a per-bot parser sees the bare query.
 *
 * Telegram marks the summon with a `mention` entity pointing at the bot, but the entity offsets are
 * redundant here: a `@username` mention is literally the username, case-insensitively, on a word
 * boundary. Matching the literal keeps this function pure and testable, and it also strips a second
 * stray mention of the same bot ("@Bot 3pm @Bot") that entity slicing would leave behind.
 */
export function guestText(mention: string, botUsername: string): string {
  const at = escapeRe(botUsername.replace(/^@/, ""));
  if (at.length === 0) return mention.trim();
  return mention.replace(new RegExp(`@${at}\\b`, "gi"), " ").replace(/\s+/g, " ").trim();
}

/**
 * Buttons for a guest result: the bot's own (at most 3), then always "Open @bot" and — in a
 * group or supergroup — "Add to this group". Both defaults carry `guest` so the funnel can
 * attribute the install to this surface.
 */
export function guestButtons(reply: GuestReply, botUsername: string, chatType: string): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  const own = (reply.buttons ?? []).slice(0, MAX_BUTTONS - 2);
  for (const b of own) {
    const text = clip(b.label, MAX_TITLE);
    if (b.url) rows.push([{ text, url: b.url }]);
    else if (b.data) rows.push([{ text, callback_data: b.data }]);
  }
  rows.push([{ text: `Open @${botUsername}`, url: guestOpenUrl(botUsername) }]);
  if (isGuestGroup(chatType)) rows.push([{ text: "Add to this group", url: guestAddUrl(botUsername) }]);
  return rows;
}

/**
 * The InlineQueryResultArticle posted into the guest chat. Pure, so the shape is unit-tested.
 * `input_message_content` never sets parse_mode: guest text echoes user words.
 */
export function buildGuestResult(reply: GuestReply, botUsername: string, chatType: string): InlineQueryResultArticle {
  const r: InlineQueryResultArticle = {
    type: "article",
    id: "g",
    title: clip(reply.title, MAX_TITLE),
    input_message_content: { message_text: clip(reply.text, MAX_TEXT) },
    reply_markup: { inline_keyboard: guestButtons(reply, botUsername, chatType) },
  };
  if (reply.description) r.description = clip(reply.description, MAX_DESC);
  if (reply.thumb) r.thumbnail_url = reply.thumb;
  return r;
}

/** The handle the buttons must point at. grammY fills `ctx.me` from getMe, so it is the
 * live handle BotFather registered; the compiled-in constant is only a fallback for a bot
 * whose botInfo is missing (F4: several bots still carry placeholder constants). */
export function resolveBotUsername(me: { username?: string } | undefined, fallback: string): string {
  const u = me?.username;
  return typeof u === "string" && u.length > 0 ? u : fallback;
}

const safeMe = (ctx: Context): { username?: string } | undefined => {
  try { return ctx.me; } catch { return undefined; }
};

/** i18n copy carries Markdown, but a guest body is posted with no parse_mode, so the
 * markers have to go — `_` and `[` included (REVIEW-GUEST V1: a stray `_` reached a
 * public group as a literal underscore). Route every guest body through this. */
export const plain = (s: string): string =>
  s.replaceAll("*", "").replaceAll("`", "").replaceAll("_", "").replaceAll("[", "").replaceAll("]", "");

/** The cheapest possible answer: no i18n, no parse, no storage read. Used when the flood
 * guard is tripped, so a burst costs one static object per query. */
export function cheapPitch(botUsername: string): GuestReply {
  return { title: `Open @${botUsername}`, text: `@${botUsername} — open the bot to use it.` };
}

/**
 * Wires `guest_message` on a bot. grammY 1.46 knows the filter query and ships
 * `ctx.api.answerGuestQuery(guest_query_id, result)`, so no raw call is needed.
 *
 * The handler NEVER throws: a guest query we fail to answer must not turn into a webhook error
 * (Telegram would retry the same dead query), and a broken store must not cost us the reply.
 */
export function wireGuest(bot: Bot, opts: GuestOpts): void {
  bot.on("guest_message", async (ctx) => {
    const gm = ctx.update.guest_message;
    const qid = gm?.guest_query_id;
    if (!gm || !qid) return;
    const chatType = gm.chat?.type ?? "unknown";
    const uname = resolveBotUsername(safeMe(ctx), opts.botUsername);
    const ok = await runGuestRecord(opts, ctx.from?.id, chatType, gm.chat?.id ?? 0);
    try {
      const reply = ok ? await opts.reply(ctx) : cheapPitch(uname);
      await ctx.api.answerGuestQuery(qid, buildGuestResult(reply, uname, chatType));
    } catch (e) {
      console.log("guest answer", String(e).slice(0, 200));
    }
  });
}

/** Runs the funnel hook. Never throws, and a broken store still gets a full answer;
 * only an explicit `false` (the flood guard) downgrades the reply. */
async function runGuestRecord(opts: { record?: GuestRecord }, uid: number | undefined, chatType: string, chatId: number): Promise<boolean> {
  if (!opts.record || !uid) return true;
  try {
    return (await opts.record(uid, chatType, chatId)) !== false;
  } catch (e) {
    console.log("guest record", String(e).slice(0, 120));
    return true;
  }
}


/* ---- Classic inline mode (Bot API since 2016). Same builders, different transport. ----
 *
 * Guest Mode needs the BotFather "Guest Chat Mode" toggle and a chat that summons us. Inline
 * mode needs only the "Inline Mode" toggle, and it then works in EVERY chat on EVERY client:
 * a user types `@Bot query`, picks our card, and Telegram posts it with `via @Bot` attribution.
 * That attribution line is the oldest distribution primitive on the platform, so the same
 * `GuestReply` a bot builds for a guest summon is answered here verbatim.
 *
 * Differences from the guest path, all handled here so a bot's `reply()` never changes:
 *  - the query is `ctx.inlineQuery.query`, already bare (no @mention to strip) — `queryText`
 *    reads whichever of the two updates is present.
 *  - the destination chat is unknown, so only private-style buttons are safe: "Open @bot".
 *    An "Add to this group" button in a chat that is not a group would be a dead link.
 *  - result ids must differ per answer or Telegram may cache/collapse them, so the id is a
 *    short hash of query+timestamp instead of the guest path's constant "g".
 */

/** The chat type reported to `record` for an inline query: the real one is unknowable. */
export const INLINE_CHAT_TYPE = "inline";
/** Result ids are capped by Telegram at 64 bytes. */
const MAX_ID = 64;

/**
 * A short, collision-resistant-enough id for one inline answer: FNV-1a over query+ts, base36.
 * Bounded loop (at most MAX_ID_INPUT chars) so a 256-char query cannot make this unbounded work.
 */
const MAX_ID_INPUT = 256;
export function inlineResultId(query: string, ts: number): string {
  const s = query + "|" + ts;
  let h = 2166136261;
  const n = Math.min(s.length, MAX_ID_INPUT);
  for (let i = 0; i < n; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ("i" + (h >>> 0).toString(36) + ts.toString(36)).slice(0, MAX_ID);
}

/**
 * The InlineQueryResultArticle for classic inline mode. Identical to the guest article except
 * for the unique id and the private-style button set (no "Add to this group"). Pure; unit-tested.
 */
export function buildInlineResult(reply: GuestReply, botUsername: string, id: string): InlineQueryResultArticle {
  const r = buildGuestResult(reply, botUsername, "private");
  r.id = id.slice(0, MAX_ID) || "i";
  return r;
}

/**
 * The bare query for a per-bot reply builder, whichever surface delivered it. Guest summons
 * arrive as `guest_message.text` and still carry the @mention; inline queries arrive as
 * `inlineQuery.query` and never do. `guestText` is idempotent on an already-bare string.
 */
export function queryText(ctx: Context, botUsername: string): string {
  const iq = ctx.inlineQuery?.query;
  const raw = typeof iq === "string" ? iq : (ctx.update.guest_message?.text ?? "");
  return guestText(raw, botUsername);
}

export interface InlineOpts {
  /** Bare username, no leading "@". FALLBACK only; ctx.me.username wins. */
  botUsername: string;
  reply: (ctx: Context) => Promise<GuestReply>;
  /** Same shape and the same limits as the guest hook. `false` (flood) downgrades the
   * answer to cheapPitch(). Count under `inline_queries`, never under `src_*`. */
  record?: GuestRecord;
  /** Cheap-only hook for chosen_inline_result: bump a counter, nothing else. */
  chosen?: (userId: number) => Promise<void>;
}

/**
 * Wires `inline_query` (and, when `chosen` is given, `chosen_inline_result`).
 *
 * NEVER throws and returns fast: an unanswered inline query is a spinner in someone's chat,
 * and a thrown handler is a non-200 webhook reply. Telegram also requires `inline_query` and
 * `chosen_inline_result` in the webhook's allowed_updates or neither update ever arrives.
 */
export function wireInline(bot: Bot, opts: InlineOpts): void {
  bot.on("inline_query", async (ctx) => {
    const iq = ctx.inlineQuery;
    if (!iq) return;
    const uname = resolveBotUsername(safeMe(ctx), opts.botUsername);
    const ok = await runGuestRecord(opts, ctx.from?.id, INLINE_CHAT_TYPE, 0);
    try {
      const reply = ok ? await opts.reply(ctx) : cheapPitch(uname);
      const result = buildInlineResult(reply, uname, inlineResultId(iq.query ?? "", Date.now()));
      await ctx.answerInlineQuery([result], { cache_time: 0, is_personal: true });
    } catch (e) {
      console.log("inline answer", String(e).slice(0, 200));
    }
  });
  const chosen = opts.chosen;
  if (!chosen) return;
  bot.on("chosen_inline_result", async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    try { await chosen(uid); } catch (e) { console.log("inline chosen", String(e).slice(0, 120)); }
  });
}

/** Pro-callback guard (P1-5): a group-scoped Pro bot's generic `bot.callbackQuery("pro")`
 * carries no chatId in its payload (`spec.payload` alone, e.g. `"pulse-pro"`), so a payment
 * made through it can never match the `<payload>:<chatId>` parser its `onPaid` expects and
 * silently falls through to a user-level `setPro(user)` — the wrong sink, since Pro there is
 * sold per group, not per person. True means the callback must refuse to mint an invoice at
 * all and point the tapper at the chat's own `/pro` instead. Pure so it is unit-tested
 * without a Bot instance. */
export function proCallbackMustRedirect(groupScoped?: boolean): boolean {
  return groupScoped === true;
}

/** [table, column] pairs for the rows BaseStore itself creates (kit.ts's `usersSql` +
 * `guestsSql` + `FUNNEL_SQL` + `SHARES_SQL`) that are keyed by a single user id, i.e. the
 * base scope of `BaseStore.forgetUser`. Deliberately excludes `guest_counters` and
 * `guest_flood`: both are aggregate tables (keyed by a counter name / time window, not by
 * user) and hold no per-user row to erase. `sources` is NOT here even though every bot
 * defines it — it lives in each bot's own SCHEMA, not BaseStore's, so it's an "extra" table
 * from BaseStore's point of view and belongs in every per-bot forgetUser override instead.
 * Kept in guest.ts (no cloudflare:workers import) so it's usable from kit.ts (a Worker-only
 * module) and directly unit-testable under plain node. */
export const FORGET_TABLES: Array<[string, string]> = [
  ["users", "id"], ["funnel", "user_id"], ["shares", "user_id"], ["guests", "user_id"], ["guest_rate", "user_id"],
];

/** Constant-time-ish equality for the `/admin/forget` gate: a length mismatch short-circuits
 * (unavoidable without padding to a fixed size, and no worse than the length leak in any
 * string compare), but once lengths match every character is compared regardless of an
 * early mismatch, so a byte-by-byte timing attack against WEBHOOK_SECRET gets no signal past
 * "how long is it". An unset secret or a missing header always fails closed. Pure, so it's
 * unit-tested without a Request. */
export function adminKeyOk(provided: string | null | undefined, expected: string): boolean {
  if (!expected || !provided || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
