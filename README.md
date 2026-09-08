# TriviaDailyProBot — daily trivia quiz for Telegram

**Try it:** [@TriviaDailyProBot](https://t.me/TriviaDailyProBot?start=github) · [tg.zovo.one/bots/trivia/](https://tg.zovo.one/bots/trivia/)

## What it does

TriviaDailyProBot posts a daily trivia quiz poll in a Telegram group, scores answers, and keeps a weekly leaderboard and per-member streaks. `/trivia on 18:00` turns on the daily quiz at that local hour; `/trivia now` posts one immediately (against the daily cap); `/ttz` sets the group's timezone offset. The first correct answer on a poll earns 3 points, any other correct answer earns 1, and `/leaderboard` shows the week's top scorers. Free tier: 1 quiz/day, general knowledge only. Pro (150 ⭐, one-time, per group) adds up to 3 quizzes/day, all 6 categories (science, geography, history, movies, sports, general), streak badges (🔥), and an automatic monthly champion post.

## Use it without adding the bot

Type `@TriviaDailyProBot` in **any** Telegram chat, even one the bot has never been added to. It posts a real trivia question from the question pack (the answer stays hidden behind the Open button; scoring needs group membership).

Both **Inline Mode** and **Guest Chat Mode** need to be turned on for the bot in [@BotFather](https://t.me/BotFather) (Bot Settings → Mode Settings) — turn Inline Mode on first, then Guest Chat Mode. Without both, only the classic `@Bot query` inline surface works.

## Self-host

```bash
pnpm i
wrangler secret put BOT_TOKEN
wrangler secret put WEBHOOK_SECRET
wrangler secret put OWNER_ID # optional
wrangler deploy
curl -G "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  --data-urlencode "url=https://<your-worker>.workers.dev/webhook" \
  --data-urlencode "secret_token=$WEBHOOK_SECRET" \
  --data-urlencode 'allowed_updates=["message","callback_query","guest_message","inline_query","chosen_inline_result"]'
```

## Stack

[grammY](https://grammy.dev/) on Cloudflare Workers, state in a Durable Object backed by SQLite, an hourly Cron Trigger for daily quizzes, weekly leaderboards, and monthly champion posts, a Telegram Mini App, Pro upgrades billed with Telegram Stars.

---
Part of Tiny Telegram Tools — https://tg.zovo.one/
