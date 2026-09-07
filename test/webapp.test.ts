import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_HTML, buildShareText, initDataErrorMessage, validateInitData, initDataStartParam, isExcludedAppUser } from "../src/webapp.ts";
import { BOT as BOT_PLACEHOLDER } from "../src/botname.ts";
const LIVE_USERNAMES = ["WhisperLockBot", "NudgeRemindBot", "AnonInboxProBot", "SplitTabsBot", "HabitStreakProBot", "EventRSVPProBot", "AnonSayProBot", "IcebreakerDailyBot", "SantaDrawProBot"];
const enc = new TextEncoder();
async function sign(token: string, fields: Record<string, string>): Promise<string> {
  const dcs = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const k1 = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", k1, enc.encode(token));
  const k2 = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const h = [...new Uint8Array(await crypto.subtle.sign("HMAC", k2, enc.encode(dcs)))].map((x) => x.toString(16).padStart(2, "0")).join("");
  return new URLSearchParams({ ...fields, hash: h }).toString();
}
test("valid initData accepted, tampered rejected, stale rejected", async () => {
  const token = "123456:ABC-DEF";
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: "q1", user: JSON.stringify({ id: 42, first_name: "Ann", username: "ann" }) };
  const good = await sign(token, fields);
  assert.equal((await validateInitData(good, token))?.id, 42);
  assert.equal(await validateInitData(good.replace("Ann", "Bob"), token), null);
  assert.equal(await validateInitData(good, "other:token"), null);
  const stale = await sign(token, { ...fields, auth_date: "1000" });
  assert.equal(await validateInitData(stale, token), null);
});

test("dual-token: hub-signed initData accepted only when hub token is in the list", async () => {
  const tokenA = "123456:ABC-DEF";
  const tokenB = "999999:HUB-TOKEN";
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: "q2", user: JSON.stringify({ id: 7, first_name: "Hub", username: "hubuser" }) };
  const signedByB = await sign(tokenB, fields);
  assert.equal((await validateInitData(signedByB, [tokenA, tokenB]))?.id, 7);
  assert.equal(await validateInitData(signedByB, [tokenA]), null);
});

test("buildShareText: pitch + attributable deep link, under 300 chars", () => {
  const pitch = "Learn English vocabulary that actually sticks, right inside Telegram.";
  const botUsername = "VocabBot";
  const text = buildShareText(pitch, botUsername, "shared");
  assert.ok(text.length <= 300, `share text too long: ${text.length}`);
  assert.ok(text.includes(`https://t.me/${botUsername}?start=shared`));
  assert.ok(text.startsWith(pitch));
});

test("APP_HTML: no tg:// links, no stranger usernames (P0 fleet audit, REVIEW-WEBAPP.md)", () => {
  assert.ok(!APP_HTML.includes("tg://"), "APP_HTML must not contain a tg:// link");
  const usernames = APP_HTML.match(/https:\/\/t\.me\/([A-Za-z0-9_]+)/g) || [];
  const allowed = new Set([...LIVE_USERNAMES, "TinyTelegramToolsBot"]);
  for (const u of usernames) {
    const name = u.replace("https://t.me/", "");
    assert.ok(allowed.has(name), `unexpected t.me link in APP_HTML: ${u}`);
  }
  assert.ok(!APP_HTML.includes(BOT_PLACEHOLDER), `APP_HTML must not hardcode the placeholder bot name ${BOT_PLACEHOLDER}`);
});

test("initDataErrorMessage: no initData vs invalid/expired get distinct copy, both name a way back into the bot", () => {
  const missing = initDataErrorMessage("", "https://t.me/TinyTelegramToolsBot");
  const invalid = initDataErrorMessage("hash=deadbeef&auth_date=1", "https://t.me/TinyTelegramToolsBot");
  assert.notEqual(missing, invalid);
  assert.ok(missing.includes("https://t.me/TinyTelegramToolsBot"));
  assert.ok(/expired/i.test(invalid));
});

test("initDataStartParam: extracts the ?startapp= start_param from signed initData, \"\" when absent", async () => {
  const token = "123456:ABC-DEF";
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: "q3", start_param: "findmini",
    user: JSON.stringify({ id: 55, first_name: "Fin" }) };
  const withParam = await sign(token, fields);
  assert.equal(initDataStartParam(withParam), "findmini");
  const { start_param: _drop, ...noParamFields } = fields;
  const withoutParam = await sign(token, noParamFields);
  assert.equal(initDataStartParam(withoutParam), "");
  assert.equal(initDataStartParam(""), "");
});

test("isExcludedAppUser: true for a QA fixture id or the owner id, false for a real user", () => {
  assert.equal(isExcludedAppUser(900_000_001, 777), true);
  assert.equal(isExcludedAppUser(900_999_999, 777), true);
  assert.equal(isExcludedAppUser(777, 777), true);
  assert.equal(isExcludedAppUser(42, 777), false);
  assert.equal(isExcludedAppUser(42, 0), false);
});
