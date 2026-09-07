/** Activation contract (ACTIVATION-SPEC.md §1) as pure functions over source text.
 *
 * The check every bot must pass: no button on the /start (or /help) screen may answer with
 * a usage/instructions string. A route-existence check cannot see that — `start:add` HAD a
 * route, and the route printed "Usage: /add Read 20 pages" (REVIEW-ACTIVATION P0-1). So the
 * check reads the handler body instead.
 *
 * Everything here is a pure string function: no fs, no grammY, no cloudflare:workers. The
 * per-bot copy of test/activation.test.ts reads its own src/index.ts and src/i18n.ts from
 * disk and passes the text in, so the test runs under plain `node --test`.
 */

/** Longest source we will scan. A bot's index.ts is ~15 KB; this only bounds the loops. */
const MAX_SRC = 400_000;

/** Walks `src` from the "(" at `open`, returning the index just past its matching ")".
 * Quotes (', ", `) and their escapes are skipped, so a paren inside a string never counts.
 * Returns -1 if the parens never balance. Bounded by MAX_SRC iterations. */
export function matchParen(src: string, open: number): number {
  if (src[open] !== "(") return -1;
  let depth = 0;
  let quote = "";
  const end = Math.min(src.length, MAX_SRC);
  for (let i = open; i < end; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(") depth += 1;
    else if (c === ")") { depth -= 1; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** The source of the `<recv>.command("<name>", …)` registration, parens balanced. "" when
 * the bot does not register that command. */
export function commandSource(src: string, name: string): string {
  const re = new RegExp(`command\\(\\s*(?:\\[[^\\]]*["']${name}["'][^\\]]*\\]|["']${name}["'])`, "");
  const m = re.exec(src);
  if (!m) return "";
  const open = src.indexOf("(", m.index);
  const close = matchParen(src, open);
  return close < 0 ? "" : src.slice(m.index, close);
}

/** The source of `async function <name>(…) { … }`, braces balanced. "" when absent.
 * Used to follow a one-line command registration that delegates (`(ctx) => onStart(ctx, env)`). */
export function functionSource(src: string, name: string): string {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, "");
  const m = re.exec(src);
  if (!m) return "";
  const brace = src.indexOf("{", src.indexOf("(", m.index));
  if (brace < 0) return "";
  let depth = 0;
  const end = Math.min(src.length, MAX_SRC);
  for (let i = brace; i < end; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (depth === 0) return src.slice(m.index, i + 1); }
  }
  return "";
}

/** Everything that runs when a user sends /<name>: the registration plus, when it only
 * delegates, the body of the named function it delegates to (one level, which is the only
 * shape the fleet uses — `m.command("start", (ctx) => onStart(ctx, env))`). */
export function screenSource(src: string, name: string): string {
  const reg = commandSource(src, name);
  if (!reg) return "";
  const delegate = /=>\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(reg);
  const extra = delegate ? functionSource(src, delegate[1]) : "";
  return extra ? reg + "\n" + extra : reg;
}

/** Every callback_data literal attached to a keyboard in `handlerSrc`: `.text(label, "d")`
 * and `callback_data: "d"`. Deduplicated, in source order. */
export function keyboardCallbacks(handlerSrc: string): string[] {
  const out: string[] = [];
  const push = (d: string): void => { if (d && !out.includes(d)) out.push(d); };
  const dotText = /\.text\(\s*[^,()]*(?:\([^()]*\))?[^,]*,\s*["'`]([^"'`]+)["'`]\s*\)/g;
  const field = /callback_data\s*:\s*["'`]([^"'`]+)["'`]/g;
  for (const m of handlerSrc.matchAll(dotText)) push(m[1]);
  for (const m of handlerSrc.matchAll(field)) push(m[1]);
  return out;
}

/** The body of `bot.callbackQuery("<data>", …)`, parens balanced. "" when no literal handler
 * is registered for that data (a regex handler is not matched — a start-screen button must
 * be routed by an exact literal so this check can read it). */
export function callbackSource(src: string, data: string): string {
  const esc = data.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`callbackQuery\\(\\s*["'\`]${esc}["'\`]`, "");
  const m = re.exec(src);
  if (!m) return "";
  const open = src.indexOf("(", m.index);
  const close = matchParen(src, open);
  return close < 0 ? "" : src.slice(m.index, close);
}

/** Object keys in an i18n source that name a usage/instructions string (`usageAdd:`,
 * `icebreakerUsage:`, `itzUsage:`). One entry per key, deduplicated. */
export function usageKeysFromSource(i18nSrc: string): string[] {
  const out: string[] = [];
  const re = /^[\t ]*([A-Za-z_$][\w$]*)\s*:/gm;
  for (const m of i18nSrc.matchAll(re)) if (/usage/i.test(m[1]) && !out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Every string literal in `body`, unescaped only enough to compare. */
export function stringLiterals(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g)) {
    out.push((m[1] ?? m[2] ?? "").replace(/\\n/g, "\n"));
  }
  return out;
}

export interface UsageEntry { key: string; value: string }

export interface ScreenCheck {
  /** src/index.ts, verbatim. */
  index: string;
  /** Every usage-ish i18n key with its English value (`usageKeysFromSource` + `t("en", k)`). */
  usage: UsageEntry[];
  /** Commands whose reply is a first screen. Default: /start and /help. */
  commands?: string[];
}

/** True when `body` answers with one of the usage strings: by key (`t(lang, "usageAdd")`),
 * by an equal or containing literal, or by a bare "Usage: …" literal of its own. */
function usageReply(body: string, usage: UsageEntry[]): string {
  for (const u of usage) {
    if (new RegExp(`["'\`]${u.key}["'\`]`).test(body)) return u.key;
  }
  const lits = stringLiterals(body);
  for (const lit of lits) {
    if (/^\s*usage\b/i.test(lit)) return lit.slice(0, 40);
    for (const u of usage) {
      if (u.value.length > 8 && (lit === u.value || lit.includes(u.value))) return u.key;
    }
  }
  return "";
}

/** The activation contract, checked. An empty array is a pass; each string is one violation,
 * phrased so the failure message names the button and the reason.
 *
 * Rules (ACTIVATION-SPEC.md §1):
 *   a. every callback button on a first screen has a literal handler, and that handler never
 *      replies with a usage/instructions string;
 *   d. a web_app button on a first screen is gated on isPrivate (Telegram 400s one in a group).
 */
export function screenViolations(o: ScreenCheck): string[] {
  const out: string[] = [];
  const commands = o.commands ?? ["start", "help"];
  for (const cmd of commands.slice(0, 8)) {
    const screen = screenSource(o.index, cmd);
    if (!screen) continue;
    if (screen.includes(".webApp(") && !screen.includes("isPrivate")) {
      out.push(`/${cmd}: a web_app button is attached without an isPrivate guard (Telegram 400s it in a group)`);
    }
    for (const data of keyboardCallbacks(screen).slice(0, 16)) {
      const body = callbackSource(o.index, data);
      if (!body) { out.push(`/${cmd}: button "${data}" has no literal callbackQuery handler`); continue; }
      const hit = usageReply(body, o.usage);
      if (hit) out.push(`/${cmd}: button "${data}" replies with the usage string ${JSON.stringify(hit)}`);
    }
  }
  return out;
}
