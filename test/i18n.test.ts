import { test } from "node:test";
import assert from "node:assert/strict";
import { LANGS, resolveLang, t } from "../src/i18n.ts";
import type { Key } from "../src/i18n.ts";

const KEYS: Key[] = [
  "help", "start", "proGroupInfo", "proRunInGroup", "proThanks", "limitReached", "adminOnly", "scheduleOn", "scheduleOff",
  "btn_unlockPro", "btn_addToGroup", "btn_shareBot", "groupJoinGreeting",
];
const BTN_KEYS: Key[] = ["btn_unlockPro", "btn_addToGroup", "btn_shareBot"];

test("LANGS has all 11 supported locales", () => {
  assert.equal(LANGS.length, 11);
  assert.deepEqual([...LANGS].sort(), ["ar", "de", "en", "es", "fa", "hi", "id", "pt", "ru", "tr", "uk"]);
});

test("resolveLang falls back to en for missing, unknown, or region-tagged codes", () => {
  assert.equal(resolveLang(undefined), "en");
  assert.equal(resolveLang(""), "en");
  assert.equal(resolveLang("xx"), "en");
  assert.equal(resolveLang("de-AT"), "de");
  assert.equal(resolveLang("ID"), "id");
});

test("every key is translated (non-empty) for all 11 locales", () => {
  for (const lang of LANGS) {
    for (const key of KEYS) {
      const s = t(lang, key, { stars: 99, hour: "18", tz: "UTC" });
      assert.ok(s.length > 0, `${lang}/${key} is empty`);
    }
  }
});

// Button labels are rendered as inline-keyboard text, which Telegram clips hard — keep them short
// in every locale so a translation never gets truncated on a small screen.
test("no btn_* label exceeds 32 chars in any locale", () => {
  for (const lang of LANGS) {
    for (const key of BTN_KEYS) {
      const s = t(lang, key, { stars: 99 });
      assert.ok(s.length <= 32, `${lang}/${key} is ${s.length} chars: "${s}"`);
    }
  }
});

test("btn_unlockPro substitutes the {stars} placeholder in every locale", () => {
  for (const lang of LANGS) {
    const s = t(lang, "btn_unlockPro", { stars: 99 });
    assert.ok(s.includes("99"), `${lang}: missing stars count`);
    assert.ok(!s.includes("{stars}"), `${lang}: unsubstituted placeholder`);
  }
});

test("groupJoinGreeting mentions the activation command and stays short (<=4 lines) in every locale", () => {
  for (const lang of LANGS) {
    const s = t(lang, "groupJoinGreeting");
    assert.ok(s.includes("/trivia on 18:00"), `${lang}: missing activation command`);
    assert.ok(s.split("\n").length <= 4, `${lang}: more than 4 lines`);
  }
});

test("t falls back to English for an unsupported language", () => {
  assert.equal(t("xx", "btn_addToGroup"), t("en", "btn_addToGroup"));
});
