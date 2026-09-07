/** Pure logic for TriviaBot: day/hour bucketing, rotation, scoring, leaderboard, streaks, parsing. */
import { CATEGORIES, CATEGORY_LABEL, QUESTIONS } from "./questions.ts";
import type { Category } from "./questions.ts";
import type { GuestReply } from "./guest.ts";

const DAY_SEC = 86_400;

/** Day index since epoch, shifted by a timezone offset in minutes (0 = UTC). */
export function dayIndex(tsSec: number, tzMin = 0): number {
  return Math.floor((tsSec + tzMin * 60) / DAY_SEC);
}

/** Hour of day (0-23) in the given timezone offset. */
export function hourOfDay(tsSec: number, tzMin = 0): number {
  const secInDay = ((tsSec + tzMin * 60) % DAY_SEC + DAY_SEC) % DAY_SEC;
  return Math.floor(secInDay / 3600);
}

/** Epoch day 0 (1970-01-01) was a Thursday, so a local day index lands on Sunday when it's 3 mod 7. */
export const isSunday = (dayIdx: number): boolean => ((dayIdx % 7) + 7) % 7 === 3;

/** True on the first local day of a calendar-ish 28-day month bucket used for the monthly champion
 * post: a new "month" starts every time dayIdx is a multiple of 28, counted from epoch. Deterministic
 * and cron-friendly (no calendar-month arithmetic needed), and dedup uses monthIndex() below. */
export const monthIndex = (dayIdx: number): number => Math.floor(dayIdx / 28);

export function parseHour(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2})(?::00)?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const ap = (m[2] ?? "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return h > 23 ? null : h;
}

export function parseTz(s: string): number | null {
  const m = s.trim().match(/^(?:utc)?\s*([+-])?(\d{1,2})(?::?(\d{2}))?$/i);
  if (!m) return null;
  const h = Number(m[2]), mi = Number(m[3] ?? "0");
  if (h > 14 || mi > 59) return null;
  return (m[1] === "-" ? -1 : 1) * (h * 60 + mi);
}

export function isCategory(s: string): s is Category {
  return (CATEGORIES as readonly string[]).includes(s);
}

/** Free groups get 1 quiz/day; Pro groups get 3/day. */
export function dailyCap(pro: boolean): number {
  return pro ? 3 : 1;
}

export interface RollResult { idx: number; reset: boolean; }

/** Pick a random unseen question index within [0, poolSize). Resets (treats all as unseen) once every
 * index in the category has been used, so a group eventually cycles through the whole pack. */
export function rollIndex(seen: ReadonlySet<number>, poolSize: number): RollResult {
  let unseen: number[] = [];
  for (let i = 0; i < poolSize; i++) if (!seen.has(i)) unseen.push(i);
  let reset = false;
  if (unseen.length === 0) {
    reset = true;
    unseen = Array.from({ length: poolSize }, (_, i) => i);
  }
  const idx = unseen[Math.floor(Math.random() * unseen.length)];
  return { idx, reset };
}

/** Points for one poll_answer: 0 for a wrong answer, 3 for the first correct answer on that poll,
 * 1 for every other correct answer. */
export function scorePoints(correct: boolean, isFirstCorrect: boolean): number {
  if (!correct) return 0;
  return isFirstCorrect ? 3 : 1;
}

export interface LeaderRow { userId: number; name: string; points: number; }

/** Top-N leaderboard: highest points first, ties broken by name (stable, deterministic). Generic
 * so callers can pass rows carrying extra fields (e.g. db.ts's LeaderRow, which also has streaks). */
export function leaderboard<T extends LeaderRow>(rows: T[], limit = 10): T[] {
  return [...rows].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name)).slice(0, Math.max(0, limit));
}

export interface Streak { streak: number; best: number; lastDay: number; }

/** Updates a user's daily-correct-answer streak. No-op (same object) if already counted today;
 * continues the streak on a consecutive day; resets to 1 after a gap. */
export function bumpStreak(s: Streak, today: number): Streak {
  if (s.lastDay === today) return s;
  const streak = today - s.lastDay === 1 ? s.streak + 1 : 1;
  return { streak, best: Math.max(s.best, streak), lastDay: today };
}

export const flame = (n: number): string => (n >= 14 ? "🔥🔥🔥" : n >= 7 ? "🔥🔥" : n >= 3 ? "🔥" : "");

/** [fromDay, toDay] inclusive window for the trailing 7 local days ending at (and including) today. */
export function weekRange(today: number): [number, number] {
  return [today - 6, today];
}

/** t.me/<bot>?start=pro_<id> deep-link payload: chat ids are negative, and '-' inside a run of
 * digits is visually confusable there, so the sign is carried as a leading 'm' instead. */
export function encodeChatId(chatId: number): string {
  return String(chatId).replace("-", "m");
}
/** Group and supergroup chat ids are always negative, so a valid encoded id always carries the
 * 'm' (minus) prefix; a bare digit string (a positive id) is rejected rather than decoded. */
export function decodeChatId(encoded: string): number | null {
  if (!/^m\d+$/.test(encoded)) return null;
  const n = Number("-" + encoded.slice(1));
  return Number.isSafeInteger(n) && n < 0 ? n : null;
}

/** True for a first-touch attribution payload on /start (e.g. "site", "share", "x"), never the
 * reserved "pro_<id>" per-group payload. */
export const SOURCE_PAYLOAD_RE = /^[a-z]{2,12}$/;
export function isSourcePayload(s: string): boolean { return SOURCE_PAYLOAD_RE.test(s); }

/** Parses a /start payload of the form "pro_<encodedChatId>" into the target group's chat id, or
 * null for anything else (including a payload that decodes to a non-negative id). This is the
 * ONLY path that may queue a private-chat Pro invoice -- a bare private /pro must never sell the
 * group product (S9c A1); see index.ts's bot.command("pro") and bot.command("start"). */
export function parseProStartPayload(payload: string): number | null {
  const m = payload.match(/^pro_(m?\d+)$/);
  return m ? decodeChatId(m[1]) : null;
}

/** True while a quiz poll is still within its `open_period` window, so onPollAnswer can ignore a
 * scroll-back answer arriving after the poll should have closed (S9c A3). */
export function isPollOpen(nowSec: number, closesAt: number): boolean {
  return nowSec <= closesAt;
}

export interface PollAnswerUpdate { poll_id: string; user?: { id: number; is_bot?: boolean }; option_ids: number[]; }
export interface ParsedAnswer { pollId: string; userId: number; optionId: number; }

/** Parses a raw poll_answer update into {pollId, userId, optionId}. Returns null when the vote was
 * retracted (empty option_ids, which Telegram sends for anonymous polls being un-answered) or the
 * update carries no real user (should not happen for a non-anonymous poll, but guarded anyway). */
export function parsePollAnswer(pa: PollAnswerUpdate): ParsedAnswer | null {
  if (!pa.user || pa.user.is_bot) return null;
  if (!pa.option_ids || pa.option_ids.length === 0) return null;
  return { pollId: pa.poll_id, userId: pa.user.id, optionId: pa.option_ids[0] };
}

/** Telegram's pseudo-user id for "sent by a group's anonymous admin", plus the linked-channel
 * pseudo-poster and Telegram's own service account -- never real people to track or score. */
export const PSEUDO_IDS: ReadonlySet<number> = new Set([1087968824, 136817688, 777000]);
export function isRealSender(fromId: number | undefined, viaBot: unknown): boolean {
  return fromId !== undefined && !PSEUDO_IDS.has(fromId) && !viaBot;
}

/** Pure Guest Mode reply builder: posts one question from the named (or default "general")
 * category, answer hidden — scoring and the correct-option reveal both need real membership
 * (an interactive poll and a per-user answers table), so the guest card lists the options
 * plain and points at the bot to actually play. Never touches the store: `seen` is always
 * empty here, so a guest summon can repeat a question a chat has already had. */
export function buildGuestReply(q: string, pitch: GuestReply): GuestReply {
  const query = q.trim().toLowerCase();
  const cat: Category = isCategory(query) ? query : "general";
  const pool = QUESTIONS[cat];
  if (pool.length === 0) return pitch;
  const { idx } = rollIndex(new Set(), pool.length);
  const question = pool[idx];
  const letters = ["A", "B", "C", "D"];
  const optionLines = question.options.map((o, i) => `${letters[i]}) ${o}`).join("\n");
  return {
    title: `${CATEGORY_LABEL[cat]} — quiz`,
    description: question.q.slice(0, 90),
    text: `${CATEGORY_LABEL[cat]}\n${question.q}\n\n${optionLines}\n\nAnswer + explanation inside the bot.`,
  };
}
