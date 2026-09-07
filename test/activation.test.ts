/** The activation contract, enforced (ACTIVATION-SPEC.md §3).
 *
 * Two halves:
 *  1. Fixtures — proves the checker actually catches a start-screen button that answers with
 *     a usage string, and does not cry wolf on one that performs the action. These run
 *     everywhere, including in kit/ where there is no ../src.
 *  2. This bot — when ../src/index.ts exists, the same checker runs against the real source
 *     and must return zero violations.
 *
 * Copy this file to <bot>/test/activation.test.ts and change ONE line: the import path
 * ("../src/activation.ts" -> "../src/activation.ts"). Nothing else in it is bot-specific.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { callbackSource, keyboardCallbacks, matchParen, screenSource, screenViolations, stringLiterals, usageKeysFromSource } from "../src/activation.ts";

const ROOT = dirname(import.meta.dirname);
const SRC = existsSync(join(ROOT, "src", "index.ts")) ? join(ROOT, "src") : join(ROOT);
const read = (f: string): string => readFileSync(join(SRC, f), "utf8");
const HAS_BOT = existsSync(join(SRC, "index.ts")) && existsSync(join(SRC, "i18n.ts"));

const BAD = `
  m.command("start", async (ctx) => {
    const kb = new InlineKeyboard().text(t(lang, "startButton"), "start:add");
    await ctx.reply(t(lang, "start"), { reply_markup: kb });
  });
  bot.callbackQuery("start:add", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(t(langOf(ctx.from?.language_code), "usageAdd"));
  });
`;
const GOOD = `
  m.command("start", async (ctx) => {
    const kb = new InlineKeyboard().text(t(lang, "startButton"), "start:add");
    if (isPrivate(ctx)) kb.webApp(t(lang, "btn_openApp"), appUrl(env));
    await ctx.reply(t(lang, "start"), { reply_markup: kb });
  });
  bot.callbackQuery("start:add", async (ctx) => { await ack(ctx); await askHabitName(ctx, env); });
`;
const USAGE = [{ key: "usageAdd", value: "Usage: /add Read 20 pages" }];

test("the checker catches a start-screen button that answers with a usage i18n key", () => {
  const v = screenViolations({ index: BAD, usage: USAGE, commands: ["start"] });
  assert.equal(v.length, 1, v.join("; "));
  assert.match(v[0], /start:add/);
  assert.match(v[0], /usageAdd/);
});

test("the checker catches a literal usage string and a bare \"Usage: …\" reply", () => {
  const byValue = BAD.replace('t(langOf(ctx.from?.language_code), "usageAdd")', '"Usage: /add Read 20 pages"');
  assert.equal(screenViolations({ index: byValue, usage: USAGE, commands: ["start"] }).length, 1);
  const bare = BAD.replace('t(langOf(ctx.from?.language_code), "usageAdd")', '"Usage: /event in 2h Team sync"');
  assert.equal(screenViolations({ index: bare, usage: [], commands: ["start"] }).length, 1);
});

test("the checker catches a dead button and an ungated web_app button", () => {
  const dead = BAD.slice(0, BAD.indexOf("bot.callbackQuery"));
  assert.match(screenViolations({ index: dead, usage: USAGE, commands: ["start"] })[0], /no literal callbackQuery handler/);
  const ungated = GOOD.replace("if (isPrivate(ctx)) kb.webApp", "kb.webApp");
  assert.match(screenViolations({ index: ungated, usage: USAGE, commands: ["start"] })[0], /isPrivate/);
});

test("a button that performs the action passes", () => {
  assert.deepEqual(screenViolations({ index: GOOD, usage: USAGE, commands: ["start"] }), []);
});

test("screenSource follows a one-line delegation to a named function", () => {
  const src = `m.command("start", (ctx) => onStart(ctx, env));\nasync function onStart(ctx, env) { const kb = new InlineKeyboard().text("x", "go:1"); }\n`;
  assert.deepEqual(keyboardCallbacks(screenSource(src, "start")), ["go:1"]);
});

test("the source scanners are quote-safe and bounded", () => {
  assert.equal(matchParen('f("a)b")x', 1), 8);
  assert.equal(matchParen("f(", 1), -1);
  assert.deepEqual(stringLiterals('a("x", \'y\')'), ["x", "y"]);
  assert.deepEqual(usageKeysFromSource("  usageAdd: {\n  itzUsage: {\n  helpText: {"), ["usageAdd", "itzUsage"]);
  assert.equal(callbackSource("bot.callbackQuery(/^done:(\\d+)$/, x)", "done:1"), "");
});

test("this bot's /start and /help screens carry no usage-string button", { skip: !HAS_BOT }, async () => {
  const index = read("index.ts");
  const { t } = (await import(join(SRC, "i18n.ts"))) as { t: (l: string, k: string, v?: Record<string, string | number>) => string };
  const usage = usageKeysFromSource(read("i18n.ts")).map((key) => ({ key, value: t("en", key) }));
  const v = screenViolations({ index, usage });
  assert.deepEqual(v, [], v.join("\n"));
});
