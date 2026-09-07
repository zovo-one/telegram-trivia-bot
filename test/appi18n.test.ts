/** MINIAPP-SPEC.md conformance: the embedded APP_I18N dictionary, the localized app body,
 * and the in-app Stars checkout route. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_HTML, handleProLink, initDataErrorCode } from "../src/webapp.ts";
import { RTL_LANGS, isQaId, normalizePlan, scriptSafeJson } from "../src/webapp-i18n.ts";
import { APP_LANGS, appDict, t } from "../src/i18n.ts";

const LANGS = ["en", "ru", "es", "pt", "id", "de", "tr", "uk", "fa", "ar", "hi"];
const APP_KEYS = ["app_title","app_loading","app_moreApps","app_shareChat","app_shareStory","app_storyText","app_shareFail","app_errNoInit","app_errExpired","app_errBadSig","app_unlockPro","app_proOneTime","app_proMonthly","app_payDone","app_payCancelled","app_payFailed","app_points","app_rank","app_playQuizBtn","app_quizSent","app_quizFail"];
/** app_* keys rendered as a button: Telegram truncates a long label on narrow screens. */
const BUTTON_KEYS = ["app_shareChat","app_shareStory","app_unlockPro","app_proOneTime","app_playQuizBtn"];
/** English that must never survive in the app body once localization is wired. */
const BANNED = ["Open this app from the bot", "Upgrade", "Loading", "More apps", "Share to a chat", "Share to story", "Unlock Pro"];
const DICT_HEAD = "window.APP_I18N=";
const DICT_TAIL = ";\nvar APP_RTL=";

function splitDict(): { json: string; outside: string } {
  const i = APP_HTML.indexOf(DICT_HEAD);
  const j = APP_HTML.indexOf(DICT_TAIL);
  assert.ok(i > 0 && j > i, "APP_HTML does not embed an APP_I18N dictionary");
  return { json: APP_HTML.slice(i + DICT_HEAD.length, j), outside: APP_HTML.slice(0, i) + APP_HTML.slice(j) };
}

test("every app_* key is translated in all 11 languages", () => {
  assert.equal(APP_LANGS.length, 11);
  const dict = appDict();
  for (const lang of LANGS) {
    for (const key of APP_KEYS) {
      const s = dict[lang][key];
      assert.ok(s && s.length > 0, `${lang}/${key} is empty`);
      assert.notEqual(s, key, `${lang}/${key} fell through to the raw key`);
      assert.equal(s, t(lang, key), `${lang}/${key} disagrees with t()`);
    }
    assert.equal(Object.keys(dict[lang]).length, APP_KEYS.length, `${lang} has an unexpected app_* key count`);
  }
});

test("no button label exceeds 24 characters in any language", () => {
  for (const lang of LANGS) {
    for (const key of BUTTON_KEYS) {
      const s = t(lang, key, { n: 150 });
      assert.ok(s.length <= 24, `${lang}/${key} is ${s.length} chars: "${s}"`);
    }
  }
});

test("the dictionary embeds as valid JSON and cannot close the <script> element", () => {
  const { json } = splitDict();
  assert.equal(json.includes("</"), false, "dictionary carries a raw </ sequence");
  const parsed = JSON.parse(json) as Record<string, Record<string, string>>;
  assert.deepEqual(Object.keys(parsed).sort(), [...LANGS].sort());
  assert.equal(parsed.ru.app_title, t("ru", "app_title"));
});

test("scriptSafeJson neutralizes a </script> payload and round-trips", () => {
  const evil = { en: { app_title: "</script><img src=x onerror=alert(1)>" } };
  const out = scriptSafeJson(evil);
  assert.equal(out.includes("</"), false);
  assert.equal(out.includes("<"), false);
  assert.deepEqual(JSON.parse(out), evil);
});

test("no banned English literal survives outside the dictionary", () => {
  const { outside } = splitDict();
  for (const s of BANNED) assert.equal(outside.includes(s), false, `banned literal in app body: "${s}"`);
});

test("the app body drives its text from data-i18n and sets lang + direction", () => {
  assert.ok(APP_HTML.includes('data-i18n="app_title"'));
  assert.ok(APP_HTML.includes('data-i18n="app_loading"'));
  assert.ok(APP_HTML.includes("document.documentElement.dir="));
  assert.deepEqual(RTL_LANGS, ["fa", "ar"]);
});

test("the app can sell Pro: openInvoice against /api/pro-link, price from the server", () => {
  assert.ok(APP_HTML.includes("tg.openInvoice("), "no openInvoice call in the Mini App");
  assert.ok(APP_HTML.includes("/api/pro-link"));
  assert.equal(/\b150\b/.test(APP_HTML.slice(0, APP_HTML.indexOf(DICT_HEAD))), false, "a Stars price is hardcoded in the HTML");
});

const enc = new TextEncoder();
async function sign(token: string, fields: Record<string, string>): Promise<string> {
  const dcs = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const k1 = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", k1, enc.encode(token));
  const k2 = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const h = [...new Uint8Array(await crypto.subtle.sign("HMAC", k2, enc.encode(dcs)))].map((x) => x.toString(16).padStart(2, "0")).join("");
  return new URLSearchParams({ ...fields, hash: h }).toString();
}
const TOKEN = "123456:ABC-DEF";
const initDataFor = (id: number) => sign(TOKEN, { auth_date: String(Math.floor(Date.now() / 1000)), query_id: "q", user: JSON.stringify({ id, first_name: "QA" }) });
const OPTS = { tokens: [TOKEN], botLink: "https://t.me/Bot", allowMonthly: false };

test("pro-link: a QA fixture id gets 200 + qa:true and never mints an invoice", async () => {
  let minted = 0;
  const res = await handleProLink({ initData: await initDataFor(900_000_123), plan: "onetime" }, { ...OPTS, mint: async () => { minted += 1; return "x"; } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { url: null, qa: true });
  assert.equal(minted, 0);
  assert.equal(isQaId(900_000_123), true);
  assert.equal(isQaId(42), false);
});

test("pro-link: bad initData is 401 with a localizable code, and mints nothing", async () => {
  let minted = 0;
  const mint = async () => { minted += 1; return "x"; };
  const bad = await handleProLink({ initData: "user=%7B%7D&hash=deadbeef&auth_date=" + Math.floor(Date.now() / 1000) }, { ...OPTS, mint });
  assert.equal(bad.status, 401);
  assert.equal(((await bad.json()) as { code: string }).code, "bad_sig");
  const none = await handleProLink({}, { ...OPTS, mint });
  assert.equal(none.status, 401);
  assert.equal(((await none.json()) as { code: string }).code, "no_init");
  assert.equal(minted, 0);
});

test("pro-link: a real user gets the minted link for the plan they asked for", async () => {
  const initData = await initDataFor(4242);
  const seen: string[] = [];
  const mint = async (plan: string) => { seen.push(plan); return `https://t.me/$${plan}`; };
  const one = await handleProLink({ initData, plan: "onetime" }, { ...OPTS, mint });
  assert.equal(((await one.json()) as { url: string }).url, "https://t.me/$onetime");
  // trivia sells no monthly plan: "monthly" degrades to one-time rather than minting a subscription.
  const sub = await handleProLink({ initData, plan: "monthly" }, { ...OPTS, mint });
  assert.equal(((await sub.json()) as { url: string }).url, "https://t.me/$onetime");
  assert.deepEqual(seen, ["onetime", "onetime"]);
  assert.equal(normalizePlan("monthly", false), "onetime");
  assert.equal(normalizePlan("nonsense", true), "onetime");
});

test("pro-link: a Bot API failure is a 502, never an unhandled throw", async () => {
  const res = await handleProLink({ initData: await initDataFor(4242) }, { ...OPTS, mint: async () => { throw new Error("api down"); } });
  assert.equal(res.status, 502);
});

test("the three initData failure modes are told apart", () => {
  const fresh = String(Math.floor(Date.now() / 1000));
  assert.equal(initDataErrorCode(""), "no_init");
  assert.equal(initDataErrorCode(`hash=abc&auth_date=1000`), "expired");
  assert.equal(initDataErrorCode(`hash=abc&auth_date=${fresh}`), "bad_sig");
});
