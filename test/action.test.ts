/** ACTIVATION-SPEC.md §3: the Mini App can perform this bot's first value action.
 * The route is served, unsigned/expired/forged initData is refused with 401, and a QA
 * fixture id answers 200 + {qa:true} without ever reaching the write.
 *
 * Copy this file to <bot>/test/action.test.ts and change ONE line: ROUTE. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { handleAction } from "../src/webapp.ts";

/** This bot's first-value-action endpoint. */
const ROUTE = "/api/quiz";

const INDEX = readFileSync(join(dirname(import.meta.dirname), "src", "index.ts"), "utf8");
const TOKEN = "123456:ABC-DEF";
const enc = new TextEncoder();

async function sign(fields: Record<string, string>): Promise<string> {
  const dcs = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const k1 = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", k1, enc.encode(TOKEN));
  const k2 = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const h = [...new Uint8Array(await crypto.subtle.sign("HMAC", k2, enc.encode(dcs)))].map((x) => x.toString(16).padStart(2, "0")).join("");
  return new URLSearchParams({ ...fields, hash: h }).toString();
}
const initDataFor = (id: number) => sign({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: "q", user: JSON.stringify({ id, first_name: "QA" }) });

test("the first-action route is served, by POST", () => {
  assert.ok(INDEX.includes(`path === "${ROUTE}"`), `${ROUTE} is not routed in src/index.ts`);
  assert.match(INDEX, new RegExp(`path === "${ROUTE}" && req\\.method === "POST"`));
});

test("unsigned and forged initData are 401, and never reach the write", async () => {
  let ran = 0;
  const run = async () => { ran += 1; return { ok: true }; };
  const opts = { tokens: [TOKEN], botLink: "https://t.me/Bot", run };
  const none = await handleAction({}, opts);
  assert.equal(none.status, 401);
  assert.equal(((await none.json()) as { code: string }).code, "no_init");
  const bad = await handleAction({ initData: `user=%7B%7D&hash=deadbeef&auth_date=${Math.floor(Date.now() / 1000)}` }, opts);
  assert.equal(bad.status, 401);
  assert.equal(((await bad.json()) as { code: string }).code, "bad_sig");
  assert.equal(ran, 0);
});

test("a QA fixture id gets 200 + qa:true and writes nothing", async () => {
  let ran = 0;
  const res = await handleAction({ initData: await initDataFor(900_000_123) }, {
    tokens: [TOKEN], botLink: "https://t.me/Bot", run: async () => { ran += 1; return { ok: true }; },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, qa: true });
  assert.equal(ran, 0);
});

test("a real user's call runs the write and returns its result", async () => {
  const seen: number[] = [];
  const res = await handleAction({ initData: await initDataFor(4242) }, {
    tokens: [TOKEN], botLink: "https://t.me/Bot", run: async (u) => { seen.push(u.id); return { ok: true, limit: 0 }; },
  });
  assert.deepEqual(await res.json(), { ok: true, limit: 0 });
  assert.deepEqual(seen, [4242]);
});

test("a failing write is a 502, never an unhandled throw", async () => {
  const res = await handleAction({ initData: await initDataFor(4242) }, {
    tokens: [TOKEN], botLink: "https://t.me/Bot", run: async () => { throw new Error("store down"); },
  });
  assert.equal(res.status, 502);
});
