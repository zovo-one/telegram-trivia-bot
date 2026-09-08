import { Bot, Context, InlineKeyboard } from "grammy";
import { Env as KitEnv, PRO_STARS, ProSpec, Step, displayName, isPrivate, makeFetch, now, preparedShare, sendInvoice, wirePro } from "./kit.ts";
import { Store } from "./db.ts";
import type { GroupRow, LeaderRow } from "./db.ts";
import { GuestReply, queryText, wireGuest, wireInline } from "./guest.ts";
import {
  bumpStreak, buildGuestReply, dailyCap, dayIndex, encodeChatId, flame, isCategory, isPollOpen, isRealSender,
  isSourcePayload, leaderboard, monthIndex, parseHour, parseProStartPayload, parsePollAnswer, parseTz, rollIndex,
  scorePoints, weekRange,
} from "./logic.ts";
import type { PollAnswerUpdate } from "./logic.ts";
import { CATEGORIES, CATEGORY_LABEL, QUESTIONS } from "./questions.ts";
import type { Category } from "./questions.ts";
import { APP_HTML, buildShareText, handleAction, handleProLink, initDataFailure, initDataStartParam, isExcludedAppUser, validateInitData } from "./webapp.ts";
import type { ProLinkBody } from "./webapp.ts";
import type { ProPlan } from "./webapp-i18n.ts";
import { BOT, publicLink } from "./botname.ts";
import { resolveLang, t } from "./i18n.ts";
export { Store };

interface Env extends KitEnv { STORE: DurableObjectNamespace<Store>; }
const store = (env: Env) => env.STORE.get(env.STORE.idFromName("main"));

const PRO: ProSpec = {
  title: "TriviaBot Pro (this group)",
  description: "All 6 categories, 3 quizzes a day, a monthly champion post, and streak badges. One-time payment.",
  payload: "trivia-pro",
  thanks: "✅ Pro unlocked for the group.\n\n/more — more free tools",
};
const MORE_TEXT = "More free tools by the same maker:\n🔒 @WhisperLockBot — locked messages only one person can open\n⏰ @NudgeRemindBot — reminders that arrive on time\n📮 @AnonInboxProBot — anonymous inbox via your link\n🧾 @SplitTabsBot — split group expenses\n🔥 @HabitStreakProBot — habit streaks with daily check-ins";
const SHARE_PITCH = "A free daily trivia quiz for your group, with a real leaderboard.";
const shareUrl = (bot: string, pitch: string): string =>
  `https://t.me/share/url?url=${encodeURIComponent(`https://t.me/${bot}?start=share`)}&text=${encodeURIComponent(pitch)}`;

const helpText = (lang: string): string => t(lang, "help", { stars: PRO_STARS });
const startText = (lang: string): string => t(lang, "start", { stars: PRO_STARS });
const chatTitle = (ctx: Context): string => (ctx.chat && "title" in ctx.chat ? ctx.chat.title ?? "" : "");
const tzLabel = (tzMin: number): string => (tzMin === 0 ? "UTC" : `UTC${tzMin > 0 ? "+" : ""}${(tzMin / 60).toFixed(tzMin % 60 === 0 ? 0 : 1)}`);
const medal = (i: number): string => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`);

// publicLink(), not a literal `t.me/${BOT}`: BOT is still "PLACEHOLDER" until trivia is
// minted, and a guessed-looking t.me name is always somebody else's live bot (REVIEW-WEBAPP.md).
const proKb = (lang: string, chatId: number): InlineKeyboard =>
  new InlineKeyboard().url(t(lang, "btn_unlockPro", { stars: PRO_STARS }), publicLink(`pro_${encodeChatId(chatId)}`));

/** One Stars invoice link for the (only) plan, with exactly the title/description/payload the
 * chat flow uses. Shared by the chat /pro flow and the Mini App's POST /api/pro-link. trivia
 * sells no monthly plan, so `plan` is always "onetime" by the time this is called. */
function proLink(api: Bot["api"], _plan: ProPlan): Promise<string> {
  return api.createInvoiceLink(PRO.title, PRO.description, PRO.payload, "", "XTR", [{ label: PRO.title, amount: PRO_STARS }]);
}

async function isAdmin(ctx: Context, env: Env, chatId: number, userId: number): Promise<boolean> {
  const cached = await store(env).isAdminCached(chatId, userId, now());
  if (cached !== null) return cached;
  let ok = false;
  try {
    const m = await ctx.api.getChatMember(chatId, userId);
    ok = m.status === "administrator" || m.status === "creator";
  } catch { ok = false; }
  await store(env).setAdminCache(chatId, userId, ok, now());
  return ok;
}

/** Renders a leaderboard row list as plain text (names are user content, so no Markdown here). */
function leaderboardText(rows: LeaderRow[], pro: boolean): string {
  if (rows.length === 0) return "No answers yet this week. /trivia now to post a quiz.";
  return rows.map((r, i) => `${medal(i)} ${r.name} — ${r.points} pt${r.points === 1 ? "" : "s"}${pro ? ` ${flame(r.streak)}` : ""}`.trimEnd()).join("\n");
}

/** Quiz polls close after this many seconds (Telegram's max for `open_period`), so a scroll-back
 * answer days later cannot be voted at all, and the same window is stored as `closes_at` so
 * onPollAnswer can reject any answer that slips through after the poll should have closed. */
const POLL_OPEN_PERIOD_SEC = 600;

/** Rolls the next no-repeat question for chat+category, sends it as a quiz poll, and records the
 * poll row. Returns the sent question's index, or null if the poll API call failed. */
async function sendQuiz(env: Env, bot: Bot, chatId: number, category: Category, day: number): Promise<number | null> {
  const pool = QUESTIONS[category];
  const seen = await store(env).getSeen(chatId, category);
  const { idx, reset } = rollIndex(seen, pool.length);
  if (reset) await store(env).resetSeen(chatId, category);
  const question = pool[idx];
  try {
    const msg = await bot.api.sendPoll(chatId, question.q, question.options.map((text) => ({ text })), {
      type: "quiz", correct_option_ids: [question.correct], is_anonymous: false, explanation: question.explain.slice(0, 200),
      open_period: POLL_OPEN_PERIOD_SEC,
    });
    await store(env).markSeen(chatId, category, idx);
    await store(env).createPoll(String(msg.poll!.id), chatId, category, idx, question.correct, day, now() + POLL_OPEN_PERIOD_SEC);
    await store(env).touchLastSent(chatId);
    return idx;
  } catch (e) { console.log("sendQuiz failed", chatId, String(e).slice(0, 150)); return null; }
}

/** Acknowledging a tap is cosmetic; the action behind it is not. A stale, expired or
 * already-answered callback id makes answerCallbackQuery throw, and an unguarded throw
 * would abort the handler before it does the work the tap asked for. */
async function ack(ctx: Context): Promise<void> {
  try { await ctx.answerCallbackQuery(); } catch { /* stale or invalid query id */ }
}

/** The whole product, in one tap, in the DM the user is already in: rolls and posts a real
 * quiz poll to this chat (a DM chat_id doubles safely as a `groups` row key — sendQuiz and
 * poll_answer scoring don't care whether it's a group or a private chat). Counts as
 * `action`: the bot did the thing it exists for (ACTIVATION-SPEC.md §1a/§1e). */
async function previewQuiz(ctx: Context, env: Env): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const g = await store(env).touchGroup(from.id, "");
  const day = dayIndex(now(), g.tz_min);
  const bot = new Bot(env.BOT_TOKEN);
  const sent = await sendQuiz(env, bot, from.id, g.category as Category, day);
  if (sent === null) { await ctx.reply("Could not post the quiz — try again in a moment."); return; }
  await store(env).track(from.id, "action");
}

async function onTrivia(ctx: Context, env: Env): Promise<void> {
  const from = ctx.from;
  const lang = resolveLang(from?.language_code);
  if (isPrivate(ctx)) { await ctx.reply(helpText(lang), { parse_mode: "Markdown" }); return; }
  if (!from) return;
  const chat = ctx.chat!;
  const g = await store(env).touchGroup(chat.id, chatTitle(ctx));
  const parts = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? "").toLowerCase();

  if (sub === "") {
    const day = dayIndex(now(), g.tz_min);
    const sentToday = await store(env).pollsToday(chat.id, day);
    const cap = dailyCap(g.pro === 1);
    const status = g.active === 1 ? `ON — daily at ${String(g.hour).padStart(2, "0")}:00 (${tzLabel(g.tz_min)})` : "OFF";
    await ctx.reply(`🧠 Trivia: ${status}\nCategory: ${CATEGORY_LABEL[g.category as Category] ?? g.category}\nToday: ${sentToday}/${cap} quizzes sent\n\n/trivia on 18:00 · /trivia now · /trivia off · /leaderboard`);
    return;
  }
  if (!(await isAdmin(ctx, env, chat.id, from.id))) { await ctx.reply(t(lang, "adminOnly")); return; }

  if (sub === "on") {
    const hour = parts[1] ? parseHour(parts[1]) : g.hour;
    if (hour === null) { await ctx.reply("Usage: /trivia on 18:00"); return; }
    await store(env).setSchedule(chat.id, hour, true);
    await ctx.reply(t(lang, "scheduleOn", { hour: String(hour).padStart(2, "0"), tz: tzLabel(g.tz_min) }));
    return;
  }
  if (sub === "off") { await store(env).setActive(chat.id, false); await ctx.reply(t(lang, "scheduleOff")); return; }

  if (sub === "now") {
    await store(env).track(from.id, "action");
    const day = dayIndex(now(), g.tz_min);
    const cap = dailyCap(g.pro === 1);
    const sentToday = await store(env).pollsToday(chat.id, day);
    if (sentToday >= cap) {
      if (g.pro !== 1) await store(env).track(from.id, "pro_prompt");
      await ctx.reply(t(lang, "limitReached"), { reply_markup: g.pro === 1 ? undefined : proKb(lang, chat.id) });
      return;
    }
    const bot = new Bot(env.BOT_TOKEN);
    const sent = await sendQuiz(env, bot, chat.id, g.category as Category, day);
    if (sent === null) await ctx.reply("Could not post the quiz — try again in a moment.");
    return;
  }
  if (sub === "cat") {
    if (g.pro !== 1) {
      await store(env).track(from.id, "pro_prompt");
      await ctx.reply(t(lang, "proGroupInfo", { stars: PRO_STARS }), { reply_markup: proKb(lang, chat.id) });
      return;
    }
    const cat = (parts[1] ?? "").toLowerCase();
    if (!isCategory(cat)) { await ctx.reply(`Usage: /trivia cat <${CATEGORIES.join("|")}>`); return; }
    await store(env).setGroupCategory(chat.id, cat);
    await ctx.reply(`✅ Category set to ${CATEGORY_LABEL[cat]}.`);
    return;
  }
  await ctx.reply("Usage: /trivia [on HH:MM | off | now | cat <name>]");
}

async function onTtz(ctx: Context, env: Env): Promise<void> {
  const from = ctx.from;
  const lang = resolveLang(from?.language_code);
  if (isPrivate(ctx) || !from) { await ctx.reply(helpText(lang), { parse_mode: "Markdown" }); return; }
  const chat = ctx.chat!;
  await store(env).touchGroup(chat.id, chatTitle(ctx));
  if (!(await isAdmin(ctx, env, chat.id, from.id))) { await ctx.reply(t(lang, "adminOnly")); return; }
  const tz = parseTz(String(ctx.match ?? ""));
  if (tz === null) { await ctx.reply("Usage: /ttz +2  or  /ttz -5:30"); return; }
  await store(env).setGroupTz(chat.id, tz);
  await ctx.reply(`🕒 Group timezone set to ${tzLabel(tz)}.`);
}

async function onLeaderboard(ctx: Context, env: Env): Promise<void> {
  const lang = resolveLang(ctx.from?.language_code);
  if (isPrivate(ctx)) { await ctx.reply(helpText(lang), { parse_mode: "Markdown" }); return; }
  const chat = ctx.chat!;
  const g = await store(env).touchGroup(chat.id, chatTitle(ctx));
  const today = dayIndex(now(), g.tz_min);
  const [from, to] = weekRange(today);
  const rows = leaderboard(await store(env).leaderboardRange(chat.id, from, to, 10), 10);
  await ctx.reply(`📊 This week's leaderboard\n\n${leaderboardText(rows, g.pro === 1)}`);
}

/** Scores one poll_answer update: first correct answer on a poll scores 3, later correct answers
 * score 1, wrong answers score 0. Idempotent per (poll, user) via the answers table's primary key. */
async function onPollAnswer(ctx: Context, env: Env): Promise<void> {
  const parsed = parsePollAnswer(ctx.pollAnswer as PollAnswerUpdate);
  if (!parsed) return;
  const poll = await store(env).getPoll(parsed.pollId);
  if (!poll) return;
  if (!isPollOpen(now(), poll.closes_at)) return; // poll closed (open_period elapsed); ignore scroll-back answers
  if (await store(env).hasAnswered(parsed.pollId, parsed.userId)) return;
  const correct = parsed.optionId === poll.correct_option_id;
  const isFirst = correct ? await store(env).claimFirstCorrect(parsed.pollId, parsed.userId) : false;
  const points = scorePoints(correct, isFirst);
  await store(env).recordAnswer(parsed.pollId, parsed.userId, poll.chat_id, poll.day, points, correct);
  const u = ctx.pollAnswer!.user!;
  const name = displayName({ first_name: u.first_name, username: u.username });
  await store(env).touchMember(poll.chat_id, parsed.userId, name);
  await store(env).touchUser(parsed.userId, u.username, name);
  if (correct) {
    const s = await store(env).memberStreak(poll.chat_id, parsed.userId);
    await store(env).saveMemberStreak(poll.chat_id, parsed.userId, bumpStreak(s, poll.day));
  }
  await store(env).track(parsed.userId, "action");
}

/** Static copy for a guest chat, with the Markdown the i18n table carries stripped: guest
 * results are posted as plain text (the query is user-supplied and may contain _ or *). */
const plain = (s: string): string => s.replaceAll("*", "").replaceAll("`", "");

/** Guest Mode: someone @-mentioned us in a chat we were never added to. The question pick
 * (parses -> value card) lives in the pure, unit-tested `buildGuestReply` in logic.ts; this
 * just gathers the query text and the caller's language. */
async function onGuest(ctx: Context, env: Env): Promise<GuestReply> {
  const lang = resolveLang(ctx.from?.language_code);
  const q = queryText(ctx, BOT);
  const pitch: GuestReply = { title: "🧠 TriviaBot — a daily quiz for your group", description: "Try: @" + BOT + " science", text: plain(startText(lang)) };
  return buildGuestReply(q, pitch);
}

const addGroupKb = (lang: string): InlineKeyboard =>
  new InlineKeyboard().url(t(lang, "btn_addToGroup"), `https://t.me/${BOT}?startgroup=true`);

function buildBot(env: Env): Bot {
  const bot = new Bot(env.BOT_TOKEN);
  // Register group-safe /pro on the raw bot before wirePro/the filtered composer, so a group tap
  // never reaches wirePro's unconditional replyWithInvoice (Stars invoices are private-chat only).
  // A private /pro never sells the group product either: Pro is a per-group upgrade, so a DM
  // invoice here would take payment and unlock nothing a group ever reads (S9c A1). The only path
  // to a private-chat invoice is the pro_<chatId> deep link handled in bot.command("start") below.
  bot.command("pro", async (ctx) => {
    const lang = resolveLang(ctx.from?.language_code);
    if (!ctx.from) return;
    if (isPrivate(ctx)) { await ctx.reply(t(lang, "proRunInGroup"), { reply_markup: addGroupKb(lang) }); return; }
    const chat = ctx.chat!;
    await store(env).touchGroup(chat.id, chatTitle(ctx));
    await store(env).track(ctx.from.id, "pro_prompt");
    await ctx.reply(t(lang, "proGroupInfo", { stars: PRO_STARS }), { reply_markup: proKb(lang, chat.id) });
  });
  wirePro(bot, PRO, async (_ctx, payload, charge) => {
    // Every reachable invoice carries "trivia-pro:<chatId>" (see above and the start handler
    // below); there is no user-level Pro anything reads, so a payload that fails to match is
    // simply not fulfilled rather than silently upgrading a user record nothing checks.
    const match = payload.match(/^trivia-pro:(-?\d+)$/);
    if (match) await store(env).setGroupPro(Number(match[1]), charge);
  }, (uid, s) => store(env).track(uid, s), true);

  // Filters out anonymous-admin/channel-linked pseudo senders and via_bot messages before any
  // command or the help fallback below can run.
  const m = bot.on("message").filter((ctx) => isRealSender(ctx.from.id, ctx.message.via_bot));
  m.command("start", async (ctx) => {
    if (!ctx.from) return;
    await store(env).touchUser(ctx.from.id, ctx.from.username, displayName(ctx.from));
    await store(env).track(ctx.from.id, "start");
    const payload = String(ctx.match ?? "");
    if (isPrivate(ctx)) {
      const chatId = parseProStartPayload(payload);
      const uid = ctx.from.id;
      if (chatId !== null) { await sendInvoice(ctx, PRO, "trivia-pro:" + chatId, (s: Step) => store(env).track(uid, s)); return; }
    }
    if (isSourcePayload(payload)) await store(env).recordSource(ctx.from.id, payload);
    const lang = resolveLang(ctx.from.language_code);
    // The primary button posts a real quiz right here; the app button is private-only
    // because Telegram 400s a web_app button in a group (ACTIVATION-SPEC.md §1a/§1d).
    const kb = new InlineKeyboard();
    if (isPrivate(ctx)) kb.text(t(lang, "btn_playQuiz"), "start:quiz").row();
    kb.url(t(lang, "btn_addToGroup"), `https://t.me/${BOT}?startgroup=true`);
    if (isPrivate(ctx)) kb.row().url(t(lang, "btn_shareBot"), shareUrl(BOT, SHARE_PITCH));
    await ctx.reply(startText(lang), { parse_mode: "Markdown", reply_markup: kb });
  });
  m.command("help", (ctx) => ctx.reply(helpText(resolveLang(ctx.from.language_code)), { parse_mode: "Markdown" }));
  m.command("more", (ctx) => ctx.reply(MORE_TEXT));
  m.command("trivia", (ctx) => onTrivia(ctx, env));
  m.command("ttz", (ctx) => onTtz(ctx, env));
  m.command("leaderboard", (ctx) => onLeaderboard(ctx, env));
  // First-screen primary action: posts a real quiz poll into this DM instead of only
  // pitching the group flow (ACTIVATION-SPEC.md §1a).
  bot.callbackQuery("start:quiz", async (ctx) => { await ack(ctx); await previewQuiz(ctx, env); });
  // Help fallback: private text only, after payment/command handlers. via_bot messages are already
  // excluded by the isRealSender filter on `m` above.
  m.on("message:text", (ctx) => { if (isPrivate(ctx)) return ctx.reply(helpText(resolveLang(ctx.from.language_code)), { parse_mode: "Markdown" }); });
  // Greets the group when the bot itself is the one being added (not some other new member), so an
  // admin immediately learns the activation command instead of the bot sitting silently until
  // someone stumbles on /help.
  bot.on("message:new_chat_members", async (ctx) => {
    if (!ctx.message.new_chat_members.some((mem) => mem.id === ctx.me.id)) return;
    const lang = resolveLang(ctx.from?.language_code);
    await ctx.reply(t(lang, "groupJoinGreeting"), { parse_mode: "Markdown" });
  });

  bot.on("poll_answer", (ctx) => onPollAnswer(ctx, env));
  wireGuest(bot, {
    botUsername: BOT,
    reply: (ctx) => onGuest(ctx, env),
    // `guest` is NOT written to `sources` here (REVIEW-GUEST F3): a summoner is not an
    // installer. src_guest is earned later, through the ?start=guest deep link in the
    // buttons below. recordGuest self-limits; `flood` downgrades us to the cheap pitch.
    record: async (uid, chatType, chatId) => {
      const r = await store(env).recordGuest(uid, chatType, chatId);
      if (r.recorded) await store(env).track(uid, "guest");
      return !r.flood;
    },
  });
  // Classic inline mode: the SAME reply builder, answered as an inline result. A user types
  // "@Bot query" in any chat on any client and posts the card with `via @Bot` attribution —
  // no admin, no membership, no Guest Chat Mode toggle. The destination chat is unknown, so
  // the card carries private-style buttons only. Counted under `inline_queries`; `sources` is
  // never written here (an inline user is not an installer, same rule as the guest path).
  wireInline(bot, {
    botUsername: BOT,
    reply: (ctx) => onGuest(ctx, env),
    record: async (uid) => !(await store(env).recordInline(uid)).flood,
    chosen: (uid) => store(env).recordInlineChosen(uid),
  });
  return bot;
}

async function apiMe(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { initData?: string };
  const user = await validateInitData(body.initData ?? "", [env.BOT_TOKEN, env.HUB_BOT_TOKEN].filter((t): t is string => !!t));
  if (!user) return Response.json(initDataFailure(body.initData ?? "", publicLink()), { status: 401 });
  if (!isExcludedAppUser(user.id, Number(env.OWNER_ID) || 0)) {
    await store(env).touchUser(user.id, user.username, displayName(user));
    await store(env).track(user.id, "app_open");
    const startParam = initDataStartParam(body.initData ?? "");
    if (isSourcePayload(startParam)) await store(env).recordSource(user.id, startParam);
  }
  const total = await store(env).totalPoints(user.id);
  let bestRank: number | null = null;
  for (const g of await store(env).groupsOf(user.id)) {
    const [from, to] = weekRange(dayIndex(now(), g.tz_min));
    const rows = leaderboard(await store(env).leaderboardRange(g.chat_id, from, to, 1000), 1000);
    const idx = rows.findIndex((r) => r.userId === user.id);
    if (idx >= 0 && (bestRank === null || idx + 1 < bestRank)) bestRank = idx + 1;
  }
  const recent = (await store(env).recentAnswers(user.id, 7)).map((a) => ({
    q: QUESTIONS[a.category as Category]?.[a.qIdx]?.q ?? "Question",
    correct: a.correct === 1, points: a.points,
  }));
  // No `proStars`: trivia Pro is per GROUP ("trivia-pro:<chatId>") and wirePro ignores any other
  // payload, so a purchase minted from the Mini App (no group context) would take Stars and unlock
  // nothing. Omitting the price keeps renderPro() empty; /api/pro-link stays live for smoke.
  return Response.json({ total, rank: bestRank, recent });
}

/** POST /api/quiz: the Mini App's own first-value action (ACTIVATION-SPEC.md §1b) — same
 * DM quiz post as the `start:quiz` chat button, targeting the caller's own chat with the
 * bot. A QA fixture id gets 200 + {qa:true} and never reaches `run` (handleAction). */
async function apiQuiz(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { initData?: string };
  return handleAction(body, {
    tokens: [env.BOT_TOKEN, env.HUB_BOT_TOKEN].filter((x): x is string => !!x),
    botLink: publicLink(),
    run: async (user) => {
      const g = await store(env).touchGroup(user.id, "");
      const day = dayIndex(now(), g.tz_min);
      const sent = await sendQuiz(env, new Bot(env.BOT_TOKEN), user.id, g.category as Category, day);
      if (sent !== null) await store(env).track(user.id, "action");
      return { ok: sent !== null };
    },
  });
}

/** POST /api/pro-link: the Mini App's own Stars checkout (tg.openInvoice). Same invoice
 * as the chat flow, so successful_payment handling is unchanged. */
async function apiProLink(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as ProLinkBody;
  return handleProLink(body, {
    tokens: [env.BOT_TOKEN, env.HUB_BOT_TOKEN].filter((t): t is string => !!t),
    botLink: publicLink(),
    allowMonthly: false,
    mint: (plan) => proLink(new Bot(env.BOT_TOKEN).api, plan),
    track: (userId) => store(env).track(userId, "invoice"),
  });
}

/** POST /api/share: registers a Bot API "prepared" inline message so the Mini App can hand its
 * id to tg.shareMessage(id) for a native chat/group/channel share. */
async function apiShare(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { initData?: string };
  const user = await validateInitData(body.initData ?? "", [env.BOT_TOKEN, env.HUB_BOT_TOKEN].filter((t): t is string => !!t));
  if (!user) return Response.json(initDataFailure(body.initData ?? "", publicLink()), { status: 401 });
  try {
    const share = await preparedShare(env, user.id, buildShareText(SHARE_PITCH, BOT, "shared"), `https://t.me/${BOT}`);
    await store(env).recordShare(user.id, "chat");
    return Response.json(share);
  } catch { return Response.json({ error: "Share unavailable." }, { status: 502 }); }
}

/** POST /api/share-story: records a "share to story" click. Telegram gives no server
 * callback for tg.shareToStory, so the client fires this right before calling it. */
async function apiShareStory(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { initData?: string };
  const user = await validateInitData(body.initData ?? "", [env.BOT_TOKEN, env.HUB_BOT_TOKEN].filter((t): t is string => !!t));
  if (!user) return Response.json(initDataFailure(body.initData ?? "", publicLink()), { status: 401 });
  await store(env).recordShare(user.id, "story");
  return Response.json({ ok: true });
}


async function dailyQuizzes(env: Env): Promise<number> {
  const bot = new Bot(env.BOT_TOKEN);
  let sent = 0;
  for (const g of (await store(env).dueForDailyPoll(now())).slice(0, 500)) {
    const day = dayIndex(now(), g.tz_min);
    const cap = dailyCap(g.pro === 1);
    if ((await store(env).pollsToday(g.chat_id, day)) >= cap) continue;
    if (!(await store(env).claimDailyCronSlot(g.chat_id, day))) continue; // dedupe an at-least-once cron redelivery
    if ((await sendQuiz(env, bot, g.chat_id, g.category as Category, day)) !== null) sent += 1;
  }
  return sent;
}

async function weeklyLeaderboards(env: Env): Promise<number> {
  const bot = new Bot(env.BOT_TOKEN);
  let sent = 0;
  for (const g of (await store(env).dueForWeeklyReport(now())).slice(0, 500)) {
    const today = dayIndex(now(), g.tz_min);
    const week = Math.floor(today / 7);
    if (!(await store(env).weeklyReportDue(g.chat_id, week))) continue;
    const [from, to] = weekRange(today);
    const rows = leaderboard(await store(env).leaderboardRange(g.chat_id, from, to, 10), 10);
    const text = `📊 Weekly leaderboard\n\n${leaderboardText(rows, g.pro === 1)}`;
    try { await bot.api.sendMessage(g.chat_id, text); sent += 1; } catch (e) { console.log("weekly report failed", g.chat_id, String(e).slice(0, 100)); }
    await store(env).markWeeklyReportSent(g.chat_id, week); // mark even on failure to avoid retry storms
    await store(env).touchLastSent(g.chat_id);
  }
  return sent;
}

async function monthlyChampions(env: Env): Promise<number> {
  const bot = new Bot(env.BOT_TOKEN);
  let sent = 0;
  for (const g of (await store(env).dueForMonthlyChampion(now())).slice(0, 500)) {
    const today = dayIndex(now(), g.tz_min);
    const month = monthIndex(today);
    if (!(await store(env).monthlyReportDue(g.chat_id, month))) continue;
    // The month just ended is the 28 local days [today-28, today-1] -- dayIndex % 28 === 0 means
    // *today* is already the first day of the new bucket (see monthIndex/dueForMonthlyChampion).
    const rows = await store(env).leaderboardRange(g.chat_id, today - 28, today - 1, 1);
    if (rows.length > 0) {
      const champ = rows[0];
      // Plain text, like leaderboardText() -- champ.name is user content, and legacy Markdown only
      // escapes a subset of the characters escapeMd() covers (e.g. not a literal "]"), so a name
      // like "a]b" rendered as parse_mode: "Markdown" could print the stray backslash literally.
      const text = `🏆 This month's trivia champion: ${champ.name} with ${champ.points} points! ${flame(champ.streak)}`.trimEnd();
      try { await bot.api.sendMessage(g.chat_id, text); sent += 1; } catch (e) { console.log("monthly champion failed", g.chat_id, String(e).slice(0, 100)); }
    }
    await store(env).markMonthlyReportSent(g.chat_id, month);
    await store(env).touchLastSent(g.chat_id);
  }
  return sent;
}

const botFetch = makeFetch<Env>(buildBot, (env) => store(env).stats());

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/app") return new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (path === "/api/me" && req.method === "POST") return apiMe(req, env);
    if (path === "/api/quiz" && req.method === "POST") return apiQuiz(req, env);
    if (path === "/api/share" && req.method === "POST") return apiShare(req, env);
    if (path === "/api/share-story" && req.method === "POST") return apiShareStory(req, env);
    if (path === "/api/pro-link" && req.method === "POST") return apiProLink(req, env);
    return botFetch(req, env);
  },
  async scheduled(_ev: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      // Each pass is independently boxed: a store hiccup during one (e.g. dailyQuizzes) must not
      // cancel the others for this hour's cron run.
      try { await dailyQuizzes(env); } catch (e) { console.log("dailyQuizzes failed", String(e).slice(0, 200)); }
      try { await weeklyLeaderboards(env); } catch (e) { console.log("weeklyLeaderboards failed", String(e).slice(0, 200)); }
      try { await monthlyChampions(env); } catch (e) { console.log("monthlyChampions failed", String(e).slice(0, 200)); }
    })());
  },
};
