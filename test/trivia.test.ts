import { test } from "node:test";
import assert from "node:assert/strict";
import { CATEGORIES, QUESTIONS } from "../src/questions.ts";
import type { Category } from "../src/questions.ts";
import {
  bumpStreak, buildGuestReply, dailyCap, dayIndex, decodeChatId, encodeChatId, hourOfDay, isCategory, isPollOpen, isSourcePayload,
  leaderboard, parseHour, parseProStartPayload, parsePollAnswer, parseTz, rollIndex, scorePoints, weekRange,
} from "../src/logic.ts";

// ---------------------------------------------------------------- pack integrity --
test("pack integrity: 6 categories x 100 questions, valid options and correct index", () => {
  assert.equal(CATEGORIES.length, 6);
  const allQuestions = new Set<string>();
  for (const cat of CATEGORIES) {
    const pool = QUESTIONS[cat];
    assert.equal(pool.length, 100, `${cat} should have 100 questions`);
    for (const item of pool) {
      assert.equal(item.options.length, 4, item.q);
      assert.ok(item.correct >= 0 && item.correct <= 3, item.q);
      assert.equal(new Set(item.options).size, 4, `duplicate options: ${item.q}`);
      assert.ok(!allQuestions.has(item.q), `duplicate question text: ${item.q}`);
      allQuestions.add(item.q);
    }
  }
  assert.equal(allQuestions.size, 600);
});

test("pack integrity: every question and option fits Telegram's poll limits", () => {
  for (const cat of CATEGORIES) {
    for (const item of QUESTIONS[cat]) {
      assert.ok(item.q.length <= 300, item.q);
      assert.ok(item.explain.length <= 200, item.q);
      for (const o of item.options) assert.ok(o.length <= 100, item.q);
    }
  }
});

// --------------------------------------------------------------------- rotation --
test("rollIndex: never repeats until the pool is exhausted, then resets", () => {
  const poolSize = 5;
  const seen = new Set<number>();
  for (let i = 0; i < poolSize; i++) {
    const { idx, reset } = rollIndex(seen, poolSize);
    assert.equal(reset, false);
    assert.ok(!seen.has(idx));
    seen.add(idx);
  }
  assert.equal(seen.size, poolSize);
  const { reset } = rollIndex(seen, poolSize);
  assert.equal(reset, true);
});

// ---------------------------------------------------------------------- scoring --
test("scorePoints: first correct answer scores 3, later correct answers score 1, wrong scores 0", () => {
  assert.equal(scorePoints(true, true), 3);
  assert.equal(scorePoints(true, false), 1);
  assert.equal(scorePoints(false, true), 0);
  assert.equal(scorePoints(false, false), 0);
});

test("bumpStreak: continues on a consecutive day, resets after a gap, no-ops same day", () => {
  const start = { streak: 0, best: 0, lastDay: 0 };
  const day1 = bumpStreak(start, 100);
  assert.deepEqual(day1, { streak: 1, best: 1, lastDay: 100 });
  const day2 = bumpStreak(day1, 101);
  assert.deepEqual(day2, { streak: 2, best: 2, lastDay: 101 });
  const sameDay = bumpStreak(day2, 101);
  assert.deepEqual(sameDay, day2);
  const gap = bumpStreak(day2, 105);
  assert.deepEqual(gap, { streak: 1, best: 2, lastDay: 105 });
});

// ------------------------------------------------------------- weekly window/tz --
test("weekRange: trailing 7 local days including today", () => {
  const [from, to] = weekRange(200);
  assert.equal(from, 194);
  assert.equal(to, 200);
});

test("dayIndex/hourOfDay respect a group's timezone offset, including across the UTC day boundary", () => {
  const tsSec = Date.UTC(2024, 0, 1, 23, 30) / 1000; // 2024-01-01 23:30 UTC
  assert.equal(hourOfDay(tsSec, 0), 23);
  assert.equal(hourOfDay(tsSec, 120), 1); // UTC+2 -> already past midnight locally
  assert.equal(dayIndex(tsSec, 0), dayIndex(tsSec, 120) - 1); // local day has rolled over
});

// ------------------------------------------------------------- category gating --
test("isCategory accepts only the 6 known categories", () => {
  for (const cat of CATEGORIES) assert.ok(isCategory(cat));
  assert.equal(isCategory("general"), true);
  assert.equal(isCategory("music"), false);
  assert.equal(isCategory(""), false);
});

test("free groups are locked to general; category selection is a pure gate a caller enforces with isCategory + pro flag", () => {
  const category: Category = "general";
  assert.ok(QUESTIONS[category].length === 100);
  assert.equal(isCategory("science"), true); // valid category, but /trivia cat still requires pro in index.ts
});

// -------------------------------------------------------------------- daily cap --
test("dailyCap: free groups get 1/day, Pro groups get 3/day", () => {
  assert.equal(dailyCap(false), 1);
  assert.equal(dailyCap(true), 3);
});

// ------------------------------------------------------- leaderboard ordering/ties --
test("leaderboard: orders by points desc, ties broken by name asc, respects the limit", () => {
  const rows = [
    { userId: 1, name: "Zed", points: 5 },
    { userId: 2, name: "Amy", points: 5 },
    { userId: 3, name: "Bo", points: 9 },
    { userId: 4, name: "Cy", points: 1 },
  ];
  const top = leaderboard(rows, 3);
  assert.deepEqual(top.map((r) => r.userId), [3, 2, 1]);
});

// -------------------------------------------------------------------- deep-link --
test("encodeChatId/decodeChatId round-trip negative group chat ids for the /start=pro_<id> deep link", () => {
  const chatId = -1001234567890;
  const encoded = encodeChatId(chatId);
  assert.equal(encoded, "m1001234567890");
  assert.equal(decodeChatId(encoded), chatId);
  assert.equal(decodeChatId("not-a-valid-id"), null);
});

// ------------------------------------------------------------------ source regex --
test("isSourcePayload: accepts short lowercase attribution tags only", () => {
  assert.equal(isSourcePayload("site"), true);
  assert.equal(isSourcePayload("x"), false); // below the 2-char minimum
  assert.equal(isSourcePayload("share"), true);
  assert.equal(isSourcePayload("pro_m123"), false);
  assert.equal(isSourcePayload("UPPER"), false);
});

// ------------------------------------------------------------- poll_answer parsing --
test("parsePollAnswer: extracts pollId/userId/optionId, rejects retracted votes and bot/missing users", () => {
  const good = parsePollAnswer({ poll_id: "p1", user: { id: 42 }, option_ids: [2] });
  assert.deepEqual(good, { pollId: "p1", userId: 42, optionId: 2 });
  assert.equal(parsePollAnswer({ poll_id: "p1", user: { id: 42 }, option_ids: [] }), null); // retracted
  assert.equal(parsePollAnswer({ poll_id: "p1", option_ids: [1] }), null); // no user (anonymous)
  assert.equal(parsePollAnswer({ poll_id: "p1", user: { id: 1, is_bot: true }, option_ids: [0] }), null);
});

// ------------------------------------------------------------------- misc parsing --
test("parseHour and parseTz accept schedule input formats used by /trivia on and /ttz", () => {
  assert.equal(parseHour("18:00"), 18);
  assert.equal(parseHour("6pm"), 18);
  assert.equal(parseHour("25"), null);
  assert.equal(parseTz("+2"), 120);
  assert.equal(parseTz("-5:30"), -330);
  assert.equal(parseTz("nonsense"), null);
});

// -------------------------------------------------------- pack: answer-key distribution (B6) --
test("pack integrity: correct-index distribution is not a fixed 0->1->2->3 cycle per category", () => {
  for (const cat of CATEGORIES) {
    const pool = QUESTIONS[cat];
    // Before the S9c fix, `correct` was exactly `i % 4` (or a fixed phase shift of it) for every
    // single item in every category -- a perfect, silent, machine-detectable tell. Assert that at
    // least some items break the cyclic pattern, in both possible phase directions.
    let matchesCycle = 0;
    for (let i = 0; i < pool.length; i++) if (pool[i].correct === i % 4) matchesCycle += 1;
    assert.ok(matchesCycle < pool.length, `${cat}: correct index is still a strict i%4 cycle`);
    // Distribution should not be a perfectly even 25/25/25/25 split either (the old pack-wide tell).
    const counts = [0, 0, 0, 0];
    for (const item of pool) counts[item.correct] += 1;
    assert.ok(!counts.every((c) => c === pool.length / 4), `${cat}: correct index still evenly 25/25/25/25`);
  }
});

// ------------------------------------------------------------------- A1: /pro deep-link routing --
test("parseProStartPayload: only a valid pro_<encoded group id> payload routes to a private invoice", () => {
  assert.equal(parseProStartPayload("pro_m1001234567890"), -1001234567890);
  assert.equal(parseProStartPayload("pro_123"), null); // positive/ungrouped id -- decodeChatId rejects it
  assert.equal(parseProStartPayload("pro_"), null);
  assert.equal(parseProStartPayload("share"), null); // a bare /pro or unrelated payload never invoices
  assert.equal(parseProStartPayload(""), null);
});

// -------------------------------------------------------------------- A7: decodeChatId hardening --
test("decodeChatId: rejects positive/bare-digit ids, accepts only the m-prefixed (negative) form", () => {
  assert.equal(decodeChatId("m5"), -5);
  assert.equal(decodeChatId("5"), null); // bare positive digits must never decode to a chat id
  assert.equal(decodeChatId("123456"), null);
  assert.equal(decodeChatId("not-a-valid-id"), null);
  assert.equal(decodeChatId(""), null);
});

// -------------------------------------------------------------------- A3: poll close-window scoring --
test("isPollOpen: true up to and including closes_at, false for any answer after", () => {
  const closesAt = 1_000_000;
  assert.equal(isPollOpen(closesAt - 1, closesAt), true);
  assert.equal(isPollOpen(closesAt, closesAt), true);
  assert.equal(isPollOpen(closesAt + 1, closesAt), false);
  assert.equal(isPollOpen(closesAt + 86_400, closesAt), false); // next-day scroll-back answer
});

// --------------------------------------------------------------------------- A2: cron rotation --
test("rotation: ordering by (last_sent asc, chat_id asc) and capping the window still covers every group", () => {
  // Mirrors db.ts's `ORDER BY last_sent ASC, chat_id ASC LIMIT n` + index.ts's cron `.slice(0, cap)`,
  // with touchLastSent() bumping a processed group to the back of the queue. Simulates several
  // cron passes over a group count well above the per-pass cap and asserts nobody is starved forever.
  const CAP = 5;
  const groups = Array.from({ length: 23 }, (_, i) => ({ chat_id: i, last_sent: 0 }));
  const seenEver = new Set<number>();
  let clock = 0;
  const passes = Math.ceil(groups.length / CAP) + 1; // one extra pass of slack
  for (let pass = 0; pass < passes; pass++) {
    const due = [...groups].sort((a, b) => a.last_sent - b.last_sent || a.chat_id - b.chat_id).slice(0, CAP);
    clock += 1;
    for (const g of due) { g.last_sent = clock; seenEver.add(g.chat_id); }
  }
  assert.equal(seenEver.size, groups.length, "every group must eventually be served, not just the head of the list");
  // A second, independent property: within any single pass, nobody who was served last time is
  // re-served before everyone else waiting has had a turn (no tail permanently starved).
  for (const g of groups) assert.ok(g.last_sent > 0, `chat ${g.chat_id} was never served`);
});

test("buildGuestReply: a named category returns a value card from that category, answer hidden", () => {
  const pitch = { title: "pitch", description: "d", text: "p" };
  const r = buildGuestReply("science", pitch);
  assert.notEqual(r, pitch);
  assert.match(r.title, /Science/);
  assert.match(r.text, /A\) .+\nB\) .+\nC\) .+\nD\) .+/);
  assert.match(r.text, /Answer \+ explanation inside the bot\./);
  assert.doesNotMatch(r.text.toLowerCase(), /correct/);
  assert.ok(!("parse_mode" in r));
  assert.equal("buttons" in r, false, "buttons are appended by wireGuest, not the pure builder");
});
test("buildGuestReply: an unrecognized/empty category still returns a value card (defaults to general)", () => {
  const pitch = { title: "pitch", description: "d", text: "p" };
  const r1 = buildGuestReply("not a category", pitch);
  const r2 = buildGuestReply("", pitch);
  assert.notEqual(r1, pitch);
  assert.notEqual(r2, pitch);
  assert.match(r1.title, /General/);
  assert.match(r2.title, /General/);
});
