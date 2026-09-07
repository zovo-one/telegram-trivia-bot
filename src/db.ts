import { BaseStore, FleetStats, now } from "./kit.ts";
import { dayIndex, hourOfDay, isSunday, monthIndex } from "./logic.ts";
import type { Streak } from "./logic.ts";
import type { Category } from "./questions.ts";

const QA_CHAT = -1001234567890;
const ADMIN_TTL = 300; // seconds

export interface GroupRow {
  chat_id: number; title: string; pro: number; created: number;
  tz_min: number; hour: number; active: number; category: string; last_sent: number;
}
export interface PollRow {
  id: string; chat_id: number; category: string; q_idx: number; correct_option_id: number;
  day: number; first_user_id: number | null; closes_at: number;
}
export interface LeaderRow { userId: number; name: string; points: number; streak: number; best: number; }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (chat_id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '', pro INTEGER NOT NULL DEFAULT 0,
  paid_charge TEXT, created INTEGER NOT NULL, tz_min INTEGER NOT NULL DEFAULT 0, hour INTEGER NOT NULL DEFAULT 18,
  active INTEGER NOT NULL DEFAULT 0, category TEXT NOT NULL DEFAULT 'general', last_sent INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS seen (chat_id INTEGER NOT NULL, category TEXT NOT NULL, idx INTEGER NOT NULL, PRIMARY KEY (chat_id, category, idx));
CREATE TABLE IF NOT EXISTS polls (id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, category TEXT NOT NULL, q_idx INTEGER NOT NULL,
  correct_option_id INTEGER NOT NULL, day INTEGER NOT NULL, first_user_id INTEGER, created INTEGER NOT NULL, closes_at INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS polls_chat_day ON polls(chat_id, day);
CREATE TABLE IF NOT EXISTS answers (poll_id TEXT NOT NULL, user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, day INTEGER NOT NULL,
  points INTEGER NOT NULL, correct INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (poll_id, user_id));
CREATE INDEX IF NOT EXISTS answers_chat_day ON answers(chat_id, day);
CREATE TABLE IF NOT EXISTS members (chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '',
  streak INTEGER NOT NULL DEFAULT 0, best INTEGER NOT NULL DEFAULT 0, last_day INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (chat_id, user_id));
CREATE TABLE IF NOT EXISTS daily_sent (chat_id INTEGER NOT NULL, day INTEGER NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY (chat_id, day));
CREATE TABLE IF NOT EXISTS weekly_reports (chat_id INTEGER NOT NULL, week INTEGER NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY (chat_id, week));
CREATE TABLE IF NOT EXISTS monthly_reports (chat_id INTEGER NOT NULL, month INTEGER NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY (chat_id, month));
CREATE TABLE IF NOT EXISTS admin_cache (chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, is_admin INTEGER NOT NULL, checked_at INTEGER NOT NULL, PRIMARY KEY (chat_id, user_id));
CREATE TABLE IF NOT EXISTS sources (user_id INTEGER PRIMARY KEY, src TEXT NOT NULL, ts INTEGER NOT NULL);`;

export class Store extends BaseStore {
  /** Extends BaseStore.forgetUser with this bot's own per-user tables: `sources`, `answers`
   * (the user's own quiz answers), `members` (per-user streak/score), `admin_cache`. `polls`
   * is left alone: `first_user_id` is just a cached "who answered first" on a shared quiz
   * question other users' `answers` rows still reference. */
  forgetUser(id: number): number {
    return super.forgetUser(id) + this.forgetTables(id, [
      ["sources", "user_id"], ["answers", "user_id"], ["members", "user_id"], ["admin_cache", "user_id"],
    ]);
  }

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) { super(ctx, env, SCHEMA); }

  async touchGroup(chatId: number, title: string): Promise<GroupRow> {
    this.run(`INSERT INTO groups (chat_id, title, created) VALUES (?1, ?2, ?3)
              ON CONFLICT(chat_id) DO UPDATE SET title = CASE WHEN ?2 = '' THEN title ELSE ?2 END`, chatId, title, now());
    return this.one<GroupRow>("SELECT * FROM groups WHERE chat_id = ?1", chatId)!;
  }
  async group(chatId: number): Promise<GroupRow | null> { return this.one<GroupRow>("SELECT * FROM groups WHERE chat_id = ?1", chatId); }
  async setGroupPro(chatId: number, charge: string): Promise<void> {
    this.run("INSERT INTO groups (chat_id, pro, paid_charge, created) VALUES (?1, 1, ?2, ?3) ON CONFLICT(chat_id) DO UPDATE SET pro = 1, paid_charge = ?2", chatId, charge, now());
  }
  async setSchedule(chatId: number, hour: number, active: boolean): Promise<void> {
    this.run("UPDATE groups SET hour = ?2, active = ?3 WHERE chat_id = ?1", chatId, hour, active ? 1 : 0);
  }
  async setActive(chatId: number, active: boolean): Promise<void> { this.run("UPDATE groups SET active = ?2 WHERE chat_id = ?1", chatId, active ? 1 : 0); }
  async setGroupTz(chatId: number, tzMin: number): Promise<void> { this.run("UPDATE groups SET tz_min = ?2 WHERE chat_id = ?1", chatId, tzMin); }
  async setGroupCategory(chatId: number, category: string): Promise<void> { this.run("UPDATE groups SET category = ?2 WHERE chat_id = ?1", chatId, category); }

  /** Rotation "seen" set of pool indices already used for this chat+category. */
  async getSeen(chatId: number, category: string): Promise<Set<number>> {
    return new Set(this.all<{ idx: number }>("SELECT idx FROM seen WHERE chat_id = ?1 AND category = ?2", chatId, category).map((r) => r.idx));
  }
  async markSeen(chatId: number, category: string, idx: number): Promise<void> {
    this.run("INSERT OR IGNORE INTO seen (chat_id, category, idx) VALUES (?1, ?2, ?3)", chatId, category, idx);
  }
  async resetSeen(chatId: number, category: string): Promise<void> { this.run("DELETE FROM seen WHERE chat_id = ?1 AND category = ?2", chatId, category); }

  async pollsToday(chatId: number, day: number): Promise<number> {
    return (this.one<{ n: number }>("SELECT COUNT(*) AS n FROM polls WHERE chat_id = ?1 AND day = ?2", chatId, day) ?? { n: 0 }).n;
  }
  /** Atomically claims the one cron-driven daily quiz slot for chat+day. Returns true only for the
   * first caller, so an at-least-once redelivery of the hourly cron trigger cannot double-post a
   * quiz to the same group in the same local day (S9c A9). Manual /trivia now is unaffected -- it
   * is gated by pollsToday()/dailyCap() instead, since Pro groups may run several a day by hand. */
  async claimDailyCronSlot(chatId: number, day: number): Promise<boolean> {
    return this.run("INSERT OR IGNORE INTO daily_sent (chat_id, day, sent_at) VALUES (?1, ?2, ?3)", chatId, day, now()) > 0;
  }
  async createPoll(id: string, chatId: number, category: Category, qIdx: number, correctOptionId: number, day: number, closesAt: number): Promise<void> {
    this.run("INSERT INTO polls (id, chat_id, category, q_idx, correct_option_id, day, created, closes_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      id, chatId, category, qIdx, correctOptionId, day, now(), closesAt);
  }
  async getPoll(id: string): Promise<PollRow | null> { return this.one<PollRow>("SELECT * FROM polls WHERE id = ?1", id); }
  /** Atomically claims "first correct answerer" for a poll. Returns true only for the caller that wins the race. */
  async claimFirstCorrect(pollId: string, userId: number): Promise<boolean> {
    return this.run("UPDATE polls SET first_user_id = ?2 WHERE id = ?1 AND first_user_id IS NULL", pollId, userId) > 0;
  }
  async hasAnswered(pollId: string, userId: number): Promise<boolean> {
    return this.one("SELECT 1 FROM answers WHERE poll_id = ?1 AND user_id = ?2", pollId, userId) !== null;
  }
  async recordAnswer(pollId: string, userId: number, chatId: number, day: number, points: number, correct: boolean): Promise<void> {
    this.run("INSERT OR IGNORE INTO answers (poll_id, user_id, chat_id, day, points, correct, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      pollId, userId, chatId, day, points, correct ? 1 : 0, now());
  }

  async touchMember(chatId: number, userId: number, name: string): Promise<void> {
    this.run(`INSERT INTO members (chat_id, user_id, name) VALUES (?1, ?2, ?3)
              ON CONFLICT(chat_id, user_id) DO UPDATE SET name = ?3`, chatId, userId, name);
  }
  async memberStreak(chatId: number, userId: number): Promise<Streak> {
    const r = this.one<{ streak: number; best: number; last_day: number }>(
      "SELECT streak, best, last_day FROM members WHERE chat_id = ?1 AND user_id = ?2", chatId, userId);
    return r ? { streak: r.streak, best: r.best, lastDay: r.last_day } : { streak: 0, best: 0, lastDay: 0 };
  }
  async saveMemberStreak(chatId: number, userId: number, s: Streak): Promise<void> {
    this.run("UPDATE members SET streak = ?3, best = ?4, last_day = ?5 WHERE chat_id = ?1 AND user_id = ?2", chatId, userId, s.streak, s.best, s.lastDay);
  }

  /** Points-ranked leaderboard for a day range, joined with each member's current streak. */
  async leaderboardRange(chatId: number, fromDay: number, toDay: number, limit = 10): Promise<LeaderRow[]> {
    const rows = this.all<{ user_id: number; name: string; points: number; streak: number; best: number }>(
      `SELECT a.user_id AS user_id, m.name AS name, SUM(a.points) AS points, m.streak AS streak, m.best AS best
       FROM answers a JOIN members m ON m.chat_id = a.chat_id AND m.user_id = a.user_id
       WHERE a.chat_id = ?1 AND a.day BETWEEN ?2 AND ?3 GROUP BY a.user_id ORDER BY points DESC, m.name ASC LIMIT ?4`,
      chatId, fromDay, toDay, limit);
    return rows.map((r) => ({ userId: r.user_id, name: r.name, points: r.points, streak: r.streak, best: r.best }));
  }

  /** All-time total points for one user, across every group (for the Mini App's "my score"). */
  async totalPoints(userId: number): Promise<number> {
    return (this.one<{ n: number | null }>("SELECT SUM(points) AS n FROM answers WHERE user_id = ?1", userId) ?? { n: 0 }).n ?? 0;
  }
  /** A user's most recent answered polls (any group), newest first, resolved to category + question index. */
  async recentAnswers(userId: number, limit = 7): Promise<{ category: string; qIdx: number; correct: number; points: number; day: number }[]> {
    return this.all(
      `SELECT p.category AS category, p.q_idx AS qIdx, a.correct AS correct, a.points AS points, a.day AS day
       FROM answers a JOIN polls p ON p.id = a.poll_id WHERE a.user_id = ?1 ORDER BY a.ts DESC LIMIT ?2`,
      userId, limit);
  }
  /** Groups a user has answered a quiz in at least once (for the Mini App's cross-group rank lookup). */
  async groupsOf(userId: number): Promise<GroupRow[]> {
    return this.all<GroupRow>(
      "SELECT g.* FROM groups g JOIN members m ON m.chat_id = g.chat_id WHERE m.user_id = ?1 LIMIT 20", userId);
  }

  /** Ordered oldest-last_sent-first so a hard cap on the number processed per cron pass (see
   * index.ts's dailyQuizzes/weeklyLeaderboards/monthlyChampions) rotates through the whole set
   * over time instead of always starving the same tail of chat ids (S9 addendum: cron rotation). */
  async activeGroups(): Promise<GroupRow[]> { return this.all<GroupRow>("SELECT * FROM groups WHERE active = 1 ORDER BY last_sent ASC, chat_id ASC LIMIT 5000"); }
  async proGroups(): Promise<GroupRow[]> { return this.all<GroupRow>("SELECT * FROM groups WHERE pro = 1 ORDER BY last_sent ASC, chat_id ASC LIMIT 5000"); }
  /** Bumps a group's rotation priority to the back of the queue after it actually receives a
   * cron-driven message (daily quiz, weekly leaderboard, or monthly champion post). */
  async touchLastSent(chatId: number): Promise<void> { this.run("UPDATE groups SET last_sent = ?2 WHERE chat_id = ?1", chatId, now()); }

  /** Active groups whose local hour matches their scheduled hour right now (called from the hourly cron). */
  async dueForDailyPoll(nowSec: number): Promise<GroupRow[]> {
    return (await this.activeGroups()).filter((g) => hourOfDay(nowSec, g.tz_min) === g.hour);
  }
  /** Active groups (not merely Pro) whose local day is Sunday and local hour matches, for the
   * weekly leaderboard post -- a Pro group that turned trivia off should not get an unsolicited post. */
  async dueForWeeklyReport(nowSec: number): Promise<GroupRow[]> {
    return (await this.activeGroups()).filter((g) => hourOfDay(nowSec, g.tz_min) === g.hour && isSunday(dayIndex(nowSec, g.tz_min)));
  }
  async weeklyReportDue(chatId: number, week: number): Promise<boolean> {
    return this.one("SELECT 1 FROM weekly_reports WHERE chat_id = ?1 AND week = ?2", chatId, week) === null;
  }
  async markWeeklyReportSent(chatId: number, week: number): Promise<void> {
    this.run("INSERT OR IGNORE INTO weekly_reports (chat_id, week, sent_at) VALUES (?1, ?2, ?3)", chatId, week, now());
  }

  /** Pro groups whose local hour matches and a new 28-day "month" bucket has just begun. */
  async dueForMonthlyChampion(nowSec: number): Promise<GroupRow[]> {
    return (await this.proGroups()).filter((g) => hourOfDay(nowSec, g.tz_min) === g.hour && dayIndex(nowSec, g.tz_min) % 28 === 0);
  }
  async monthlyReportDue(chatId: number, month: number): Promise<boolean> {
    return this.one("SELECT 1 FROM monthly_reports WHERE chat_id = ?1 AND month = ?2", chatId, month) === null;
  }
  async markMonthlyReportSent(chatId: number, month: number): Promise<void> {
    this.run("INSERT OR IGNORE INTO monthly_reports (chat_id, month, sent_at) VALUES (?1, ?2, ?3)", chatId, month, now());
  }

  async isAdminCached(chatId: number, userId: number, nowTs: number): Promise<boolean | null> {
    const r = this.one<{ is_admin: number; checked_at: number }>("SELECT is_admin, checked_at FROM admin_cache WHERE chat_id = ?1 AND user_id = ?2", chatId, userId);
    if (!r || nowTs - r.checked_at > ADMIN_TTL) return null;
    return r.is_admin === 1;
  }
  async setAdminCache(chatId: number, userId: number, isAdmin: boolean, nowTs: number): Promise<void> {
    this.run("INSERT INTO admin_cache (chat_id, user_id, is_admin, checked_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(chat_id, user_id) DO UPDATE SET is_admin = ?3, checked_at = ?4",
      chatId, userId, isAdmin ? 1 : 0, nowTs);
  }

  /** First-touch attribution for /start payloads like "site"/"share"/"x" (see logic.ts isSourcePayload). */
  async recordSource(userId: number, src: string): Promise<void> {
    this.run("INSERT OR IGNORE INTO sources (user_id, src, ts) VALUES (?1, ?2, ?3)", userId, src, now());
  }
  private sourceStats(): Record<string, number> {
    const rows = this.all<{ src: string; n: number }>(`SELECT src, COUNT(*) AS n FROM sources WHERE ${this.notTestUser("user_id")} GROUP BY src`);
    const out: Record<string, number> = {};
    for (const r of rows) out["src_" + r.src] = r.n;
    return out;
  }

  async stats(): Promise<FleetStats & { events: number; groups: number; answers: number }> {
    const u = this.userStats();
    const p = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM polls WHERE chat_id != ?1", QA_CHAT);
    const a = this.one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM answers WHERE chat_id != ?1 AND ${this.notTestUser("user_id")}`, QA_CHAT);
    const g = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM groups WHERE chat_id != ?1", QA_CHAT);
    return { ...u, events: p?.n ?? 0, groups: g?.n ?? 0, answers: a?.n ?? 0, ...this.sourceStats() };
  }
}
