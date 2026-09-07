/** Shared Mini App localization + in-app Stars checkout helpers (MINIAPP-SPEC.md).
 *
 * The Worker embeds one `APP_I18N` dictionary — every `app_*` key from src/i18n.ts in all
 * 11 locales — into the HTML it serves at GET /app, so translations live in exactly one
 * place (src/i18n.ts) and the client needs no extra request. The client picks a language
 * from `initDataUnsafe.user.language_code`, applies it through `data-i18n` attributes, and
 * sets `<html lang>` / `dir="rtl"`.
 *
 * This file is the source of truth in kit/; each bot carries a byte-identical copy at
 * src/webapp-i18n.ts (bots do not share a package). Keep the copies in sync. */

/** Languages that read right-to-left; mirrored in the client snippet below. */
export const RTL_LANGS = ["fa", "ar"];

/** Escapes a JSON literal so it cannot terminate the <script> element that carries it:
 * `</` (which ends any tag), `<!--` (which opens a legacy comment), and the two line
 * separators that are valid JSON but invalid JS source. */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** The client half of the localization contract. Defines `T(key, vars)`, applies every
 * `[data-i18n]` element's text, and sets `<html lang>` + direction. Depends only on the
 * `APP_I18N` global that `renderAppI18n` writes immediately above it. */
export const APP_I18N_JS = `var APP_RTL=${JSON.stringify(RTL_LANGS)};
function appLang(){try{var u=(window.Telegram.WebApp.initDataUnsafe||{}).user||{};var two=String(u.language_code||'').slice(0,2).toLowerCase();return APP_I18N[two]?two:'en'}catch(e){return 'en'}}
var LANG=appLang();
function T(k,v){var b=APP_I18N[LANG]||APP_I18N.en;var s=b[k];if(s===undefined)s=APP_I18N.en[k];if(s===undefined)return k;if(!v)return s;return s.replace(/\\{(\\w+)\\}/g,function(m,n){return n in v?String(v[n]):m})}
function applyI18n(){var e=document.querySelectorAll('[data-i18n]');for(var i=0;i<e.length&&i<200;i++)e[i].textContent=T(e[i].getAttribute('data-i18n'))}
function errText(d){var c=d&&d.code;if(c==='no_init')return T('app_errNoInit');if(c==='expired')return T('app_errExpired');if(c==='bad_sig')return T('app_errBadSig');return T('app_errBadSig')}
document.documentElement.lang=LANG;document.documentElement.dir=APP_RTL.indexOf(LANG)>=0?'rtl':'ltr';applyI18n();`;

/** The client half of the in-app Pro contract. Expects the page to define `tg`, an
 * `api(path, body)` helper and a `load()` refresh, plus `#pro` and `#note` containers.
 * Prices come from the API payload (`proStars` / `subStars`), never from the HTML. */
export const APP_PRO_JS = `function note(m){var el=document.getElementById('note');if(el)el.textContent=m}
function proBtn(plan,label){var b=document.createElement('button');b.textContent=label;b.style.marginTop='8px';b.onclick=function(){buyPro(plan,b)};return b}
function renderPro(s){var el=document.getElementById('pro');if(!el)return;el.innerHTML='';note('');
 if(!s||s.pro||typeof tg.openInvoice!=='function')return;
 var h=document.createElement('div');h.className='empty';h.style.margin='16px 0 4px';h.textContent=T('app_unlockPro');el.appendChild(h);
 if(s.proStars)el.appendChild(proBtn('onetime',T('app_proOneTime',{n:s.proStars})));
 if(s.subStars)el.appendChild(proBtn('monthly',T('app_proMonthly',{n:s.subStars})))}
async function buyPro(plan,b){b.disabled=true;
 try{var d=await api('/api/pro-link',{plan:plan});
  if(!d||!d.url){b.disabled=false;if(!d||!d.qa)note(T('app_payFailed'));return}
  tg.openInvoice(d.url,function(st){b.disabled=false;
   if(st==='paid'){note(T('app_payDone'));load()}else if(st==='cancelled'){note(T('app_payCancelled'))}else{note(T('app_payFailed'))}})}
 catch(e){b.disabled=false;note(T('app_payFailed'))}}`;

/** The whole embedded block: the dictionary, then the two client snippets. Drop this into
 * the served HTML once, before the app's own <script>. */
export function renderAppI18n(dict: Record<string, Record<string, string>>): string {
  return `<script>window.APP_I18N=${scriptSafeJson(dict)};\n${APP_I18N_JS}\n${APP_PRO_JS}</script>`;
}

export type ProPlan = "onetime" | "monthly";

/** QA fixture ids (the range smoke.sh and every stats() query already exclude). They must
 * never reach createInvoiceLink: the route still answers 200 so smoke can exercise it. */
export const QA_ID_MIN = 900_000_000;
export const QA_ID_MAX = 900_999_999;
export const isQaId = (id: number): boolean => id >= QA_ID_MIN && id <= QA_ID_MAX;

/** Normalizes the request's `plan` field. Anything unknown is a one-time purchase, and
 * "monthly" degrades to one-time for a bot that has no subscription. */
export function normalizePlan(plan: unknown, allowMonthly: boolean): ProPlan {
  return plan === "monthly" && allowMonthly ? "monthly" : "onetime";
}
