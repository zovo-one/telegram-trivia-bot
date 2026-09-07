import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GUEST_DAY_MAX, GUEST_FLOOD_MAX, GUEST_FLOOD_WINDOW_S, GUEST_GAP_S, GUEST_ROW_CAP, GUEST_SOURCE,
  QA_CHAT_ID, QA_USER_MAX, QA_USER_MIN, SOURCE_PAYLOAD_RE, buildGuestResult, cheapPitch, guestAddUrl,
  guestButtons, guestDay, guestFlooded, guestOpenUrl, guestOverflow, guestRateOk, guestText,
  guestWindow, isGuestGroup, isQaGuest, nextGuestRate, notTestUser, resolveBotUsername,
  INLINE_CHAT_TYPE, buildInlineResult, inlineResultId, queryText, proCallbackMustRedirect,
} from "../src/guest.ts";
import type { Context } from "grammy";

const BOT = "WhenIsItBot";

test("guestText strips the bot mention and normalizes whitespace", () => {
  assert.equal(guestText("@WhenIsItBot 3pm tomorrow", BOT), "3pm tomorrow");
  assert.equal(guestText("hey @WhenIsItBot   3pm", BOT), "hey 3pm");
  assert.equal(guestText("@whenisitbot 3pm", BOT), "3pm", "mentions are case-insensitive");
  assert.equal(guestText("@WhenIsItBot 3pm @WhenIsItBot", BOT), "3pm", "a second stray mention goes too");
  assert.equal(guestText("@WhenIsItBot", BOT), "", "a bare summon leaves an empty query");
});

test("guestText keeps other mentions and underscored user text intact", () => {
  assert.equal(guestText("@WhenIsItBot ask @alice about my_file_name", BOT), "ask @alice about my_file_name");
  assert.equal(guestText("@WhenIsItBotHelper 3pm", BOT), "@WhenIsItBotHelper 3pm", "word boundary: no prefix match");
  assert.equal(guestText("3pm", BOT), "3pm", "no mention at all is a no-op");
});

test("guestText tolerates a leading @ in the configured username", () => {
  assert.equal(guestText("@WhenIsItBot 3pm", "@WhenIsItBot"), "3pm");
});

test("default buttons: open always, add-to-group only in a group", () => {
  const r = { title: "t", text: "x" };
  const priv = guestButtons(r, BOT, "private");
  assert.equal(priv.length, 1);
  assert.deepEqual(priv[0], [{ text: "Open @WhenIsItBot", url: guestOpenUrl(BOT) }]);
  for (const type of ["group", "supergroup"]) {
    const rows = guestButtons(r, BOT, type);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[1], [{ text: "Add to this group", url: guestAddUrl(BOT) }]);
  }
  assert.equal(guestButtons(r, BOT, "channel").length, 1);
});

test("deep links carry the guest source payload", () => {
  assert.equal(guestOpenUrl(BOT), `https://t.me/${BOT}?start=guest`);
  assert.equal(guestAddUrl(BOT), `https://t.me/${BOT}?startgroup=guest`);
  assert.equal(GUEST_SOURCE, "guest");
  assert.equal(isGuestGroup("supergroup"), true);
  assert.equal(isGuestGroup("private"), false);
});

test("bot buttons come first and are capped at three", () => {
  const buttons = [1, 2, 3, 4, 5].map((n) => ({ label: "b" + n, url: "https://example.com/" + n }));
  const rows = guestButtons({ title: "t", text: "x", buttons }, BOT, "supergroup");
  assert.equal(rows.length, 5, "3 own + open + add");
  assert.deepEqual(rows[0], [{ text: "b1", url: "https://example.com/1" }]);
  assert.equal(rows[2][0].text, "b3");
  assert.equal(rows[3][0].text, `Open @${BOT}`);
});

test("a button with `data` becomes a callback button", () => {
  const rows = guestButtons({ title: "t", text: "x", buttons: [{ label: "🔓 Reveal", data: "r:abc" }] }, BOT, "supergroup");
  assert.deepEqual(rows[0], [{ text: "🔓 Reveal", callback_data: "r:abc" }]);
  assert.equal(rows.length, 3);
});

test("a button with neither url nor data is dropped, not emitted broken", () => {
  const rows = guestButtons({ title: "t", text: "x", buttons: [{ label: "nope" }] }, BOT, "private");
  assert.equal(rows.length, 1);
});

test("buildGuestResult sends plain text with no parse_mode", () => {
  const res = buildGuestResult({ title: "Converted", text: "3pm in Europe/New_York" }, BOT, "supergroup");
  assert.equal(res.type, "article");
  assert.equal(res.id, "g");
  assert.equal(res.title, "Converted");
  assert.deepEqual(res.input_message_content, { message_text: "3pm in Europe/New_York" });
  assert.equal("parse_mode" in res.input_message_content, false, "user text may contain _ * ` — never parse it");
  assert.equal(res.description, undefined);
  assert.equal(res.thumbnail_url, undefined);
  assert.equal(res.reply_markup?.inline_keyboard.length, 2);
});

test("buildGuestResult passes through description and thumbnail", () => {
  const res = buildGuestResult({ title: "t", text: "x", description: "d", thumb: "https://x/y.png" }, BOT, "private");
  assert.equal(res.description, "d");
  assert.equal(res.thumbnail_url, "https://x/y.png");
});

test("buildGuestResult clips over-long fields instead of letting Telegram 400", () => {
  const res = buildGuestResult({ title: "T".repeat(200), text: "X".repeat(5000), description: "D".repeat(300) }, BOT, "group");
  assert.equal(res.title.length, 60);
  assert.equal(res.description?.length, 90);
  assert.equal(res.input_message_content.message_text.length, 4000);
  assert.ok(res.title.endsWith("…"));
});

/* ---- Bounded-write logic (REVIEW-GUEST F1) ---- */

test("QA fixtures are excluded at write time, by id range and by chat", () => {
  assert.equal(isQaGuest(900000001, -1), true, "smoke.sh's QA user id");
  assert.equal(isQaGuest(1, QA_CHAT_ID), true, "smoke.sh's QA supergroup");
  assert.equal(isQaGuest(QA_USER_MIN, 1), true);
  assert.equal(isQaGuest(QA_USER_MAX, 1), true);
  assert.equal(isQaGuest(QA_USER_MIN - 1, 1), false);
  assert.equal(isQaGuest(QA_USER_MAX + 1, 1), false);
  assert.equal(isQaGuest(4242, -100200300), false, "a real summon is recordable");
});

test("isQaGuest also excludes the fleet owner's own real id, only when OWNER_ID is set", () => {
  const OWNER = 424242424;
  assert.equal(isQaGuest(OWNER, 1, OWNER), true, "owner id is excluded once OWNER_ID is known");
  assert.equal(isQaGuest(OWNER, 1), false, "with no ownerId argument (secret unset), the owner is a normal user");
  assert.equal(isQaGuest(OWNER, 1, 0), false, "ownerId 0 (secret absent) never matches a real id");
  assert.equal(isQaGuest(4242, 1, OWNER), false, "a different real user is unaffected");
});

test("notTestUser excludes the QA range and, only when set, the owner id", () => {
  assert.equal(notTestUser("id", 0), "NOT (id BETWEEN 900000000 AND 900999999)", "owner clause dropped when unset");
  assert.equal(notTestUser("id", 424242424), "NOT (id BETWEEN 900000000 AND 900999999 OR id = 424242424)");
  assert.equal(notTestUser("s.user_id", 42), "NOT (s.user_id BETWEEN 900000000 AND 900999999 OR s.user_id = 42)", "column may be qualified");
  assert.equal(notTestUser("id", -1), "NOT (id BETWEEN 900000000 AND 900999999)", "a non-positive ownerId is treated as absent");
  assert.equal(notTestUser("id", 1.5), "NOT (id BETWEEN 900000000 AND 900999999)", "a non-integer ownerId is treated as absent");
});

test("per-user rate limit: one recorded query a minute", () => {
  const t0 = 1_800_000_000;
  assert.equal(guestRateOk(null, t0), true, "a first-ever summon always records");
  const r1 = nextGuestRate(null, t0);
  assert.deepEqual(r1, { last_ts: t0, day: guestDay(t0), n: 1 });
  assert.equal(guestRateOk(r1, t0), false, "same second");
  assert.equal(guestRateOk(r1, t0 + GUEST_GAP_S - 1), false, "one second short of the gap");
  assert.equal(guestRateOk(r1, t0 + GUEST_GAP_S), true, "exactly the gap is enough");
});

test("per-user daily cap: 30 recorded queries, then nothing until the day rolls", () => {
  const t0 = 1_800_000_000;
  const day = guestDay(t0);
  const maxed = { last_ts: t0, day, n: GUEST_DAY_MAX };
  assert.equal(guestRateOk(maxed, t0 + 3600), false, "capped for the rest of the day");
  assert.equal(guestRateOk({ last_ts: t0, day, n: GUEST_DAY_MAX - 1 }, t0 + 3600), true);
  const tomorrow = t0 + 86_400;
  assert.equal(guestRateOk(maxed, tomorrow), true, "a new UTC day resets the cap");
  assert.equal(nextGuestRate(maxed, tomorrow).n, 1, "and the counter restarts at 1");
  assert.equal(nextGuestRate({ last_ts: t0, day, n: 4 }, t0 + 120).n, 5, "same day increments");
});

test("flood guard trips above 600 arrivals in one 10-minute window", () => {
  assert.equal(guestFlooded(GUEST_FLOOD_MAX), false, "600 is still served normally");
  assert.equal(guestFlooded(GUEST_FLOOD_MAX + 1), true);
  assert.equal(guestFlooded(0), false);
  const t0 = 1_800_000_000;
  assert.equal(guestWindow(t0), guestWindow(t0 + GUEST_FLOOD_WINDOW_S - 1), "same window");
  assert.equal(guestWindow(t0 + GUEST_FLOOD_WINDOW_S), guestWindow(t0) + 1, "next window");
});

test("rolling guests table is capped, and only the excess is deleted", () => {
  assert.equal(guestOverflow(0), 0);
  assert.equal(guestOverflow(GUEST_ROW_CAP), 0, "exactly at the cap deletes nothing");
  assert.equal(guestOverflow(GUEST_ROW_CAP + 1), 1);
  assert.equal(guestOverflow(GUEST_ROW_CAP + 500), 500);
  assert.equal(guestOverflow(5, 3), 2, "the cap is a parameter, so it is testable");
  assert.equal(GUEST_ROW_CAP, 2000);
});

test("the flood pitch is static: no user text, no i18n, both default buttons", () => {
  const p = cheapPitch(BOT);
  assert.ok(p.text.includes("@" + BOT));
  assert.equal(p.buttons, undefined, "nothing to build, nothing to clip");
  const rows = guestButtons(p, BOT, "supergroup");
  assert.equal(rows.length, 2, "Open + Add to this group survive the flood path");
});

test("button urls follow ctx.me, not the compiled-in constant (F4)", () => {
  assert.equal(resolveBotUsername({ username: "RealHandleBot" }, "PlaceholderBot"), "RealHandleBot");
  assert.equal(resolveBotUsername(undefined, "PlaceholderBot"), "PlaceholderBot", "no botInfo: fall back");
  assert.equal(resolveBotUsername({}, "PlaceholderBot"), "PlaceholderBot");
  assert.equal(resolveBotUsername({ username: "" }, "PlaceholderBot"), "PlaceholderBot");
  const rows = guestButtons({ title: "t", text: "x" }, resolveBotUsername({ username: "RealHandleBot" }, "PlaceholderBot"), "private");
  assert.deepEqual(rows[0], [{ text: "Open @RealHandleBot", url: "https://t.me/RealHandleBot?start=guest" }]);
});

test("`guest` is a valid /start source payload, so installs attribute to src_guest", () => {
  assert.equal(SOURCE_PAYLOAD_RE.test(GUEST_SOURCE), true);
  assert.equal(guestOpenUrl(BOT).endsWith("?start=" + GUEST_SOURCE), true);
});

/* ---- Classic inline mode. Same GuestReply, different transport. ---- */

test("inlineResultId is unique per query and per timestamp, and fits Telegram's 64-byte cap", () => {
  const ts = 1_756_000_000_000;
  assert.notEqual(inlineResultId("science", ts), inlineResultId("history", ts), "different queries differ");
  assert.notEqual(inlineResultId("science", ts), inlineResultId("science", ts + 1), "different times differ");
  assert.equal(inlineResultId("science", ts), inlineResultId("science", ts), "same input is stable");
  const ids = new Set<string>();
  for (let i = 0; i < 500; i++) ids.add(inlineResultId("q" + i, ts));
  assert.equal(ids.size, 500, "500 distinct queries give 500 distinct ids");
  assert.ok(inlineResultId("x".repeat(4000), ts).length <= 64);
  assert.ok(inlineResultId("", ts).length > 0, "an empty query still yields an id");
});

test("buildInlineResult: unique id, no parse_mode, exactly one button", () => {
  const reply = { title: "Trivia", text: "Q: what?", description: "one question" };
  const id = inlineResultId("science", 1_756_000_000_000);
  const r = buildInlineResult(reply, BOT, id);
  assert.equal(r.type, "article");
  assert.equal(r.id, id);
  assert.notEqual(r.id, "g", "the guest path's constant id would collapse inline answers");
  assert.equal(r.title, "Trivia");
  assert.equal(r.description, "one question");
  assert.deepEqual(r.input_message_content, { message_text: "Q: what?" });
  assert.equal((r.input_message_content as Record<string, unknown>).parse_mode, undefined, "never parse user text");
  const rows = r.reply_markup!.inline_keyboard;
  assert.equal(rows.length, 1, "chat type is unknown inline, so no Add-to-group button");
  assert.deepEqual(rows[0], [{ text: "Open @" + BOT, url: guestOpenUrl(BOT) }]);
});

test("buildInlineResult keeps the bot's own buttons above Open, and clips a long id", () => {
  const reply = { title: "t", text: "x", buttons: [{ label: "Reveal", data: "r:1" }] };
  const rows = buildInlineResult(reply, BOT, "abc").reply_markup!.inline_keyboard;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], [{ text: "Reveal", callback_data: "r:1" }]);
  assert.equal(buildInlineResult(reply, BOT, "z".repeat(200)).id.length, 64);
  assert.equal(buildInlineResult(reply, BOT, "").id, "i", "an empty id is never sent");
});

test("buildInlineResult clips title, description and text like the guest article", () => {
  const long = { title: "T".repeat(120), text: "X".repeat(5000), description: "D".repeat(200) };
  const r = buildInlineResult(long, BOT, "i1");
  assert.equal(r.title.length, 60);
  assert.equal(r.description!.length, 90);
  assert.equal((r.input_message_content as { message_text: string }).message_text.length, 4000);
});

test("queryText reads whichever surface delivered the query", () => {
  const inline = { inlineQuery: { query: "3pm tomorrow" }, update: {} } as unknown as Context;
  assert.equal(queryText(inline, BOT), "3pm tomorrow", "an inline query is already bare");
  const mentioned = { inlineQuery: { query: "@" + BOT + " 3pm" }, update: {} } as unknown as Context;
  assert.equal(queryText(mentioned, BOT), "3pm", "a stray mention is stripped anyway");
  const guest = { inlineQuery: undefined, update: { guest_message: { text: "@" + BOT + " 3pm" } } } as unknown as Context;
  assert.equal(queryText(guest, BOT), "3pm");
  const empty = { inlineQuery: { query: "" }, update: {} } as unknown as Context;
  assert.equal(queryText(empty, BOT), "", "an empty inline query is not the guest fallback");
  assert.equal(queryText({ inlineQuery: undefined, update: {} } as unknown as Context, BOT), "");
});

test("INLINE_CHAT_TYPE is not a group, so the inline path can never emit an Add-to-group button", () => {
  assert.equal(isGuestGroup(INLINE_CHAT_TYPE), false);
});

test("proCallbackMustRedirect (P1-5): only an explicitly group-scoped Pro bot redirects", () => {
  assert.equal(proCallbackMustRedirect(true), true);
  assert.equal(proCallbackMustRedirect(false), false);
  assert.equal(proCallbackMustRedirect(undefined), false, "user-scoped bots (no flag passed) keep today's invoice behavior");
});
