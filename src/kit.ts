import { DurableObject } from "cloudflare:workers";
import { Bot, Context, InlineKeyboard, webhookCallback } from "grammy";
export { FORGET_TABLES, GUEST_SOURCE, INLINE_CHAT_TYPE, SOURCE_PAYLOAD_RE, adminKeyOk, buildGuestResult, buildInlineResult, cheapPitch, guestAddUrl, guestButtons, guestOpenUrl, guestText, inlineResultId, isGuestGroup, notTestUser, plain, proCallbackMustRedirect, queryText, resolveBotUsername, wireGuest, wireInline } from "./guest.ts";
export type { GuestButton, GuestOpts, GuestRate, GuestRecord, GuestRecordResult, GuestReply, InlineOpts } from "./guest.ts";
import { FORGET_TABLES, GUEST_FLOOD_MAX, GUEST_ROW_CAP, adminKeyOk, guestDay, guestFlooded, guestOverflow, guestRateOk, guestWindow, isQaGuest, nextGuestRate, notTestUser, proCallbackMustRedirect } from "./guest.ts";
import type { GuestRate, GuestRecordResult } from "./guest.ts";

export const PRO_STARS = 150;
const DAY = 86_400;
export const now = (): number => Math.floor(Date.now() / 1000);

export interface UserRow { id: number; username: string | null; name: string; pro: number; tz_min: number; }
export interface FleetStats { users: number; pro: number; active_7d: number; events: number; [k: string]: number; }

const FUNNEL_SQL = `CREATE TABLE IF NOT EXISTS funnel (user_id INTEGER NOT NULL, step TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (user_id, step));`;
/** "guest" = summoned into a chat we are not a member of (Guest Mode); it is a first touch,
 * so it also doubles as a `?start=guest` source payload. */
export type Step = "start" | "action" | "pro_prompt" | "invoice" | "paid" | "guest" | "app_open";
export type ShareKind = "story" | "chat";
const SHARES_SQL = `CREATE TABLE IF NOT EXISTS shares (user_id INTEGER NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL);`;
/** Guest Mode storage is deliberately bounded (REVIEW-GUEST F1): `guests` is a rolling
 * window capped at GUEST_ROW_CAP rows, the totals live in `guest_counters`, `guest_rate`
 * is the per-user limiter, and `guest_flood` holds one row per 10-minute window. The two
 * INSERT OR IGNORE selects seed the counters once from any pre-existing rows. */
/** Table DDL is fixed, but the one-time seed inserts (they only ever fire once, from any
 * pre-existing rows) must exclude the owner the same as every later read, hence a function
 * of `ownerId` rather than a plain constant. */
const guestsSql = (ownerId: number): string => `CREATE TABLE IF NOT EXISTS guests (user_id INTEGER NOT NULL, chat_type TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS guest_counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS guest_rate (user_id INTEGER PRIMARY KEY, last_ts INTEGER NOT NULL, day INTEGER NOT NULL, n INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS guest_flood (win INTEGER PRIMARY KEY, n INTEGER NOT NULL);
INSERT OR IGNORE INTO guest_counters (k, n) SELECT 'queries', COUNT(*) FROM guests WHERE ${notTestUser("user_id", ownerId)};
INSERT OR IGNORE INTO guest_counters (k, n) SELECT 'ct_' || chat_type, COUNT(*) FROM guests WHERE ${notTestUser("user_id", ownerId)} GROUP BY chat_type;`;
const usersSql = (ownerId: number): string => FUNNEL_SQL + SHARES_SQL + guestsSql(ownerId) + `CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT, name TEXT NOT NULL DEFAULT '', pro INTEGER NOT NULL DEFAULT 0,
  paid_charge TEXT, tz_min INTEGER NOT NULL DEFAULT 0, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);`;

/** Median of a numeric array; 0 for an empty one. Pure so it's mirrored (and unit-tested
 * under plain node) in habit/src/logic.ts — this file imports cloudflare:workers and can't
 * run outside a Worker. Keep both copies in sync if the algorithm ever changes. */
export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export class BaseStore extends DurableObject {
  /** The fleet owner's real Telegram id, from the OWNER_ID secret; 0 (never matches a real
   * user id) when the secret is unset. Read once at construction, same as BOT_TOKEN. */
  protected readonly ownerId: number;
  constructor(ctx: DurableObjectState, env: Record<string, unknown>, schema: string) {
    super(ctx, env);
    this.ownerId = Number((env as { OWNER_ID?: string }).OWNER_ID) || 0;
    const ownerId = this.ownerId;
    ctx.blockConcurrencyWhile(async () => { ctx.storage.sql.exec(usersSql(ownerId) + schema); });
  }
  /** SQL fragment excluding QA fixtures and the owner from a count over `col`. Every
   * user-facing stat (base and per-bot) must filter through this, never a bare literal. */
  protected notTestUser(col: string): string { return notTestUser(col, this.ownerId); }
  protected all<T>(sql: string, ...a: unknown[]): T[] {
    return this.ctx.storage.sql.exec(sql, ...(a as SqlStorageValue[])).toArray() as T[];
  }
  protected one<T>(sql: string, ...a: unknown[]): T | null { return this.all<T>(sql, ...a)[0] ?? null; }
  protected run(sql: string, ...a: unknown[]): number {
    return this.ctx.storage.sql.exec(sql, ...(a as SqlStorageValue[])).rowsWritten;
  }
  protected lastId(): number { return (this.one<{ id: number }>("SELECT last_insert_rowid() AS id") ?? { id: 0 }).id; }

  async touchUser(id: number, username: string | undefined, name: string): Promise<UserRow> {
    this.run(`INSERT INTO users (id, username, name, first_seen, last_seen) VALUES (?1, ?2, ?3, ?4, ?4)
              ON CONFLICT(id) DO UPDATE SET username = ?2, name = ?3, last_seen = ?4`, id, username ?? null, name, now());
    const row = this.one<UserRow>("SELECT id, username, name, pro, tz_min FROM users WHERE id = ?1", id);
    if (!row) throw new Error("user upsert failed");
    return row;
  }
  async getUser(id: number): Promise<UserRow | null> {
    return this.one<UserRow>("SELECT id, username, name, pro, tz_min FROM users WHERE id = ?1", id);
  }
  /** Upsert: a payer may have no users row yet (deep-link invoice, restored chat). */
  async setPro(id: number, charge: string): Promise<void> {
    this.run(`INSERT INTO users (id, pro, paid_charge, first_seen, last_seen) VALUES (?1, 1, ?2, ?3, ?3)
              ON CONFLICT(id) DO UPDATE SET pro = 1, paid_charge = ?2`, id, charge, now());
  }
  /** First time a user reaches a funnel step; idempotent. */
  async track(userId: number, step: Step): Promise<void> {
    this.run("INSERT OR IGNORE INTO funnel (user_id, step, ts) VALUES (?1, ?2, ?3)", userId, step, now());
  }
  protected funnelStats(): Record<string, number> {
    const rows = this.all<{ step: string; n: number }>(`SELECT step, COUNT(*) AS n FROM funnel WHERE ${this.notTestUser("user_id")} GROUP BY step`);
    const f: Record<string, number> = { f_start: 0, f_action: 0, f_pro_prompt: 0, f_invoice: 0, f_paid: 0, f_guest: 0, f_app_open: 0 };
    for (const r of rows) f["f_" + r.step] = r.n;
    const oe = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM funnel WHERE user_id = ?1", this.ownerId);
    f.owner_events = oe?.n ?? 0;
    return f;
  }
  /** Median seconds from the "start" funnel step to the "action" step, over users who
   * reached both (QA ids and the owner excluded, bounded so a large table can't blow the query up). */
  protected ttvStats(): { ttv_median_s: number } {
    const rows = this.all<{ start_ts: number; action_ts: number }>(
      `SELECT s.ts AS start_ts, a.ts AS action_ts FROM funnel s JOIN funnel a ON a.user_id = s.user_id AND a.step = 'action'
       WHERE s.step = 'start' AND ${this.notTestUser("s.user_id")} LIMIT 5000`);
    const diffs = rows.map((r) => r.action_ts - r.start_ts).filter((d) => d >= 0);
    return { ttv_median_s: median(diffs) };
  }
  /** Records one "share to a chat" or "share to story" click. */
  async recordShare(userId: number, kind: ShareKind): Promise<void> {
    this.run("INSERT INTO shares (user_id, kind, ts) VALUES (?1, ?2, ?3)", userId, kind, now());
  }
  protected shareStats(): { shares_chat: number; shares_story: number } {
    const rows = this.all<{ kind: string; n: number }>(
      `SELECT kind, COUNT(*) AS n FROM shares WHERE ${this.notTestUser("user_id")} GROUP BY kind`);
    const s = { shares_chat: 0, shares_story: 0 };
    for (const r of rows) { if (r.kind === "chat") s.shares_chat = r.n; else if (r.kind === "story") s.shares_story = r.n; }
    return s;
  }
  /** Records one Guest Mode summon, bounded three ways: QA fixtures are never stored, a
   * user buys at most one row a minute and 30 a day, and a fleet-wide burst trips the
   * flood guard. An unrecorded query is still answered — `recorded` only drives the funnel
   * write, `flood` tells wireGuest to answer with the cheapest pitch. */
  async recordGuest(userId: number, chatType: string, chatId = 0): Promise<GuestRecordResult> {
    const ts = now();
    if (isQaGuest(userId, chatId, this.ownerId)) return { recorded: false, flood: false };
    if (guestFlooded(this.bumpGuestFlood(ts))) return { recorded: false, flood: true };
    const prev = this.one<GuestRate>("SELECT last_ts, day, n FROM guest_rate WHERE user_id = ?1", userId);
    if (!guestRateOk(prev, ts)) return { recorded: false, flood: false };
    this.writeGuest(userId, chatType, ts, nextGuestRate(prev, ts));
    return { recorded: true, flood: false };
  }
  /** Records one classic inline query. Same three guards as `recordGuest` (QA fixtures,
   * per-user rate, fleet-wide flood) and the same `guest_rate` ledger, but it writes only
   * the `inline_queries` counter: there is no chat to bucket by, no rolling detail table
   * worth keeping, and nothing here may touch `sources` (an inline user is not an installer). */
  async recordInline(userId: number): Promise<GuestRecordResult> {
    const ts = now();
    if (isQaGuest(userId, 0, this.ownerId)) return { recorded: false, flood: false };
    if (guestFlooded(this.bumpGuestFlood(ts))) return { recorded: false, flood: true };
    const prev = this.one<GuestRate>("SELECT last_ts, day, n FROM guest_rate WHERE user_id = ?1", userId);
    if (!guestRateOk(prev, ts)) return { recorded: false, flood: false };
    const rate = nextGuestRate(prev, ts);
    this.run(`INSERT INTO guest_rate (user_id, last_ts, day, n) VALUES (?1, ?2, ?3, ?4)
              ON CONFLICT(user_id) DO UPDATE SET last_ts = ?2, day = ?3, n = ?4`, userId, rate.last_ts, rate.day, rate.n);
    this.bumpGuestCounter("inline_queries");
    this.run("DELETE FROM guest_rate WHERE day < ?1", guestDay(ts) - 1);
    return { recorded: true, flood: false };
  }
  /** chosen_inline_result: one counter bump, nothing else. Kept cheap on purpose. */
  async recordInlineChosen(userId: number): Promise<void> {
    if (isQaGuest(userId, 0, this.ownerId)) return;
    this.bumpGuestCounter("inline_chosen");
  }
  /** One counter row per 10-minute window; every older window is dropped, so this table
   * holds at most two rows. Returns the arrival count for the current window. */
  private bumpGuestFlood(ts: number): number {
    const win = guestWindow(ts);
    this.run("INSERT INTO guest_flood (win, n) VALUES (?1, 1) ON CONFLICT(win) DO UPDATE SET n = n + 1", win);
    this.run("DELETE FROM guest_flood WHERE win < ?1", win - 1);
    const row = this.one<{ n: number }>("SELECT n FROM guest_flood WHERE win = ?1", win);
    return row?.n ?? GUEST_FLOOD_MAX + 1;
  }
  /** The whole recorded write: rolling row, per-user ledger, aggregate counters, trim.
   * No await between the statements, so the DO applies them as one transaction. */
  private writeGuest(userId: number, chatType: string, ts: number, rate: GuestRate): void {
    this.run("INSERT INTO guests (user_id, chat_type, ts) VALUES (?1, ?2, ?3)", userId, chatType, ts);
    this.run(`INSERT INTO guest_rate (user_id, last_ts, day, n) VALUES (?1, ?2, ?3, ?4)
              ON CONFLICT(user_id) DO UPDATE SET last_ts = ?2, day = ?3, n = ?4`, userId, rate.last_ts, rate.day, rate.n);
    this.bumpGuestCounter("queries");
    this.bumpGuestCounter("ct_" + chatType);
    this.trimGuests(ts);
  }
  private bumpGuestCounter(k: string): void {
    this.run("INSERT INTO guest_counters (k, n) VALUES (?1, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1", k);
  }
  /** Keeps `guests` at GUEST_ROW_CAP rows and drops rate rows older than yesterday, so
   * neither table can grow without bound however long the bot runs. */
  private trimGuests(ts: number): void {
    const c = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM guests");
    const over = guestOverflow(c?.n ?? 0, GUEST_ROW_CAP);
    if (over > 0) this.run("DELETE FROM guests WHERE rowid IN (SELECT rowid FROM guests ORDER BY ts, rowid LIMIT ?1)", over);
    this.run("DELETE FROM guest_rate WHERE day < ?1", guestDay(ts) - 1);
  }
  /** Totals come from the counters, not from the rolling table, so trimming never
   * rewrites history. QA ids are excluded at write time, so no filter is needed here. */
  protected guestStats(): Record<string, number> {
    const rows = this.all<{ k: string; n: number }>("SELECT k, n FROM guest_counters");
    const g: Record<string, number> = { guest_queries: 0, inline_queries: 0, inline_chosen: 0 };
    for (const r of rows) {
      if (r.k === "queries") g.guest_queries = r.n;
      else if (r.k === "inline_queries" || r.k === "inline_chosen") g[r.k] = r.n;
      else if (r.k.startsWith("ct_")) g["guest_" + r.k.slice(3)] = r.n;
    }
    return g;
  }
  async setTz(id: number, tzMin: number): Promise<void> { this.run("UPDATE users SET tz_min = ?2 WHERE id = ?1", id, tzMin); }
  /** `qa_pro` mirrors the synthetic-payment smoke test (a QA-range id flipped Pro); `owner_users`
   * / `owner_pro` mirror it for the fleet owner's own real id, so a real owner purchase still
   * flips Pro and still shows up — just filed as "yours" in the Registry, never under `users`/`pro`. */
  protected userStats(): { users: number; pro: number; active_7d: number; qa_pro: number; owner_users: number; owner_pro: number; [k: string]: number } {
    const u = this.one<{ n: number; p: number | null; a: number | null }>(
      `SELECT COUNT(*) AS n, SUM(pro) AS p, SUM(last_seen > ?1) AS a FROM users WHERE ${this.notTestUser("id")}`, now() - 7 * DAY);
    const q = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE pro = 1 AND id BETWEEN 900000000 AND 900999999");
    const o = this.one<{ n: number; p: number | null }>("SELECT COUNT(*) AS n, SUM(pro) AS p FROM users WHERE id = ?1", this.ownerId);
    return {
      users: u?.n ?? 0, pro: u?.p ?? 0, active_7d: u?.a ?? 0, qa_pro: q?.n ?? 0,
      owner_users: o?.n ?? 0, owner_pro: o?.p ?? 0,
      ...this.funnelStats(), ...this.ttvStats(), ...this.shareStats(), ...this.guestStats(),
    };
  }

  /** Deletes `id`'s rows from a fixed [table, column] list, one DELETE per table, each
   * wrapped in its own try/catch (an old schema may lack the expected column). Returns the
   * number of tables it successfully touched — the building block behind `forgetUser`, and
   * the thing every override calls for its own extra tables. Bounded: `tables` is always a
   * short, fixed, caller-supplied list, never derived from user input. */
  protected forgetTables(id: number, tables: Array<[string, string]>): number {
    let n = 0;
    for (const [t, c] of tables) { try { this.run(`DELETE FROM ${t} WHERE ${c} = ?1`, id); n++; } catch { /* table may lack the column */ } }
    return n;
  }

  /** Admin: erase every row a single user id owns (test rows, GDPR), scoped to the tables
   * BaseStore itself creates — users, funnel, shares, guests, guest_rate (see FORGET_TABLES
   * in guest.ts for why guest_counters/guest_flood are excluded). Wired to POST
   * /admin/forget by makeFetch below, so every bot gets the route for free.
   *
   * EXTENSION POINT: every bot defines its own `sources` table (not part of BaseStore), and
   * many define bot-specific per-user tables (habits, reminders, expenses, ...). A bot with
   * any such table MUST override this method, e.g.:
   *   forgetUser(id: number): number {
   *     return super.forgetUser(id) + this.forgetTables(id, [["sources", "user_id"], ["habits", "user_id"]]);
   *   }
   * A table that isn't keyed by a single user id (a shared group/event/poll row that merely
   * references a creator_id) should NOT be deleted wholesale — only the user's own row in a
   * per-user table (membership, RSVP, participant entry, ...) is in scope; deleting a shared
   * object would destroy other members' data too. A two-hop table (no direct user_id column,
   * only a foreign key to a per-user table, e.g. habit's `checkins(habit_id)`) needs its own
   * subquery DELETE run before the parent row is removed — `forgetTables` alone can't express
   * that join. */
  forgetUser(id: number): number {
    return this.forgetTables(id, FORGET_TABLES);
  }
}

export interface ProSpec { title: string; description: string; payload: string; thanks: string; }

export async function sendInvoice(ctx: Context, spec: ProSpec, payload = spec.payload, track?: (s: Step) => Promise<void>): Promise<void> {
  if (track) await track("invoice");
  await ctx.replyWithInvoice(spec.title, spec.description, payload, "XTR", [{ label: spec.title, amount: PRO_STARS }]);
}

export const proButton = (text = "Unlock Pro"): InlineKeyboard => new InlineKeyboard().text(text, "pro");

/** /pro, "pro" callback, pre_checkout, successful_payment. `groupScoped` (P1-5) must be set
 * true by any bot whose Pro is sold per-chat (its own `onPaid` matches a `<payload>:<chatId>`
 * suffix and falls back to a user-level setPro on a miss): the generic callback carries no
 * chatId, so it must never mint that bare-payload invoice — it would misattribute a group's
 * purchase to whichever member happened to tap it. Such bots already shadow `/pro` with their
 * own chat-aware command; this only closes the "pro" callback_data as a second, unshadowed
 * entry point. */
export function wirePro(bot: Bot, spec: ProSpec, onPaid: (ctx: Context, payload: string, charge: string) => Promise<void>, track?: (uid: number, s: Step) => Promise<void>, groupScoped?: boolean): void {
  const t = (ctx: Context) => (s: Step) => (track ? track(ctx.from!.id, s) : Promise.resolve());
  bot.command("pro", (ctx) => sendInvoice(ctx, spec, spec.payload, t(ctx)));
  bot.callbackQuery("pro", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (proCallbackMustRedirect(groupScoped)) { await ctx.reply("Run /pro in this chat to unlock Pro here."); return; }
    await sendInvoice(ctx, spec, spec.payload, t(ctx));
  });
  bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true));
  bot.on("message:successful_payment", async (ctx) => {
    const sp = ctx.message.successful_payment;
    await onPaid(ctx, sp.invoice_payload, sp.telegram_payment_charge_id);
    if (track) await track(ctx.from!.id, "paid");
    await ctx.reply(spec.thanks);
  });
}

/** OWNER_ID: the fleet owner's real Telegram user id, as a Worker secret (a string, like
 * every wrangler secret) — optional so tests and a fresh clone still typecheck and run with
 * it unset (BaseStore then treats the owner clause as never-true). Never hardcode the id. */
export interface Env { BOT_TOKEN: string; WEBHOOK_SECRET: string; HUB_BOT_TOKEN?: string; OWNER_ID?: string; STORE: DurableObjectNamespace<any>; }

export function makeFetch<E extends Env>(build: (env: E) => Bot, stats: (env: E) => Promise<FleetStats>) {
  return async (req: Request, env: E): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/stats") return Response.json(await stats(env), { headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } });
    // S18->kit: admin-only, key-guarded user erasure (test rows, GDPR). Every bot gets this
    // for free via makeFetch — only ever call it with a QA id or on the owner's explicit
    // instruction (see ADMIN-ROUTES.md). The DO's own `forgetUser` (BaseStore, overridden
    // per-bot for extra tables) does the actual deleting; this route is just the HTTP gate.
    if (url.pathname === "/admin/forget" && req.method === "POST") {
      if (!adminKeyOk(req.headers.get("x-admin-key"), env.WEBHOOK_SECRET)) return new Response("unauthorized", { status: 401 });
      const body = (await req.json().catch(() => ({}))) as { id?: unknown };
      if (typeof body.id !== "number") return Response.json({ error: "id required" }, { status: 400 });
      const store = env.STORE as unknown as { idFromName(name: string): unknown; get(id: unknown): { forgetUser(id: number): Promise<number> } };
      const stub = store.get(store.idFromName("main"));
      const n = await stub.forgetUser(body.id);
      return Response.json({ ok: true, tables: n });
    }
    if (req.method !== "POST" || url.pathname !== "/webhook") return new Response("not found", { status: 404 });
    const handler = webhookCallback(build(env), "cloudflare-mod", { secretToken: env.WEBHOOK_SECRET, timeoutMilliseconds: 25_000 });
    try {
      return await handler(req);
    } catch (e) {
      console.log("handler error", String(e).slice(0, 200));
      return new Response("ok"); // never let Telegram retry a handler failure
    }
  };
}

export const displayName = (u: { first_name: string; username?: string }): string => u.username ? "@" + u.username : u.first_name;
export const isPrivate = (ctx: Context): boolean => ctx.chat?.type === "private";

/** Pure: one-line pitch + an attributable deep link (?start=<startParam>), for both the
 * "Share to a chat" prepared message and any "Share to story" widget_link text. Kept short
 * enough (fleet convention: <=300 chars) to fit comfortably in a story/chat share sheet. */
export function buildShareText(pitch: string, botUsername: string, startParam: string): string {
  return `${pitch}\n\nhttps://t.me/${botUsername}?start=${startParam}`;
}

export interface PreparedShare { id: string; expires: number; }

/** Registers a one-time "prepared" inline message via the Bot API (savePreparedInlineMessage)
 * so a Mini App can hand its id to tg.shareMessage(id) and let the user forward `text` (with a
 * URL button to `url`) into any chat, group, or channel — no copy/paste needed. Uses this bot's
 * own token, so it must be called with an Env that carries it. */
export async function preparedShare(env: Env, userId: number, text: string, url: string): Promise<PreparedShare> {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/savePreparedInlineMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      result: {
        type: "article", id: "share", title: "Share",
        input_message_content: { message_text: text },
        reply_markup: { inline_keyboard: [[{ text: "Open", url }]] },
      },
      allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true,
    }),
  });
  const data = (await res.json()) as { ok: boolean; result?: { id: string; expiration_date: number } };
  if (!data.ok || !data.result) throw new Error("savePreparedInlineMessage failed");
  return { id: data.result.id, expires: data.result.expiration_date };
}
