# upsc-telegram-bot

A small worker that runs a UPSC Telegram channel on its own:

- **07:00 IST daily:** a current-affairs digest of three stories, built at 05:30 from PIB, The Hindu and Indian Express feeds, with a source link on every item.
- **Pre-written calendar:** posts in `content/*.json`, each with an id, an IST time and the text. Tips, product posts, blog posts and data facts.

State (what has been sent) lives in MongoDB, so restarts never double-post.

## Daily timetable (IST)

Everything below runs on its own. Nothing needs refilling.

| Time | What | Where it comes from |
|---|---|---|
| 05:30 | Builds the current-affairs digest (not posted) | PIB, The Hindu, Indian Express feeds + Groq |
| 07:00 | Current-affairs digest: 3 stories, GS tag, source link | as above |
| 10:00 | A quiz poll | `data/quiz.json`, 77 questions checked against UPSC's official key, then loops |
| 12:30 | A tip | `content/pools/tips.json`, 29 tips, then loops |
| 15:00 | Concept in 60 seconds | 14 hand-written, then ~98 topics written from Wikipedia summaries, number-checked |
| 17:30 | A product or blog post | `content/pools/promos.json`, 12 posts, then loops |
| 20:30 | A data fact | Computed from the toppers database, so it is always accurate |
| Sunday 18:00 | Weekly recap of the week's digests, by GS paper | the saved digests |

`QUIZ_TIMES` (comma-separated, default `10:00`; empty turns quizzes off) sets the quiz times. Each slot takes the next item of its pool, tracked in MongoDB, so it never repeats until the pool is used up. Calendar posts in `content/*.json` (an id, an IST time, the text) still work for one-off announcements.

## When something fails

Every job is retried (three attempts, ten minutes apart) and has a fallback, so the channel does not go quiet.

| What fails | What happens instead |
|---|---|
| The AI model is rate-limited or down | Four models are tried in turn, with waits for rate limits. If all fail, the digest becomes a headlines-only post |
| One or more news feeds are down | The other feeds are used (nine feeds across three sources) |
| Every feed is down | A "revise these" post from the last few digests |
| No digest at all by 08:30 | A tip is posted so the morning is never empty |
| A concept topic cannot be written cleanly (Wikipedia down, numbers not in the source) | Up to four topics are tried, then a tip is posted |
| The toppers database cannot be read for a data fact | A tip is posted |
| Telegram rejects the formatting | The post is resent as plain text |
| Telegram rejects an image | The caption is posted as text |
| Telegram rejects a quiz poll | The question is posted as text with the answer behind a spoiler |
| Telegram rate-limits or errors | Retried, honouring its `retry_after` |
| The process crashes or hangs | systemd restarts it. A watchdog exits the process if no tick has finished for ten minutes. Restarts never double-post |
| MongoDB is unreachable | The worker keeps retrying every minute and resumes without losing its place |

If `ADMIN_CHAT_ID` is set, the bot messages you when a job fails three times, when a fallback was used, and with a short report at 22:15 each day. To get your id, send any message to the bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `message.chat.id`.

Dry-run failure tests: `DRY_RUN=1 TEST_FAIL=llm` (AI down) or `TEST_FAIL=feeds` (no feeds), with `FORCE_CA=1` and `TEST_HM=07:05`.

## How a day works

1. 05:30 IST: the worker fetches the feeds, asks Groq to pick the three most exam-relevant stories, fetches each article's text and asks for a two-sentence note using only that text. Each note must be two short sentences, free of filler, and every number in it must appear in the source text. A digest that cannot reach three clean items is discarded and logged as `failed`, and nothing is posted. At most two items come from PIB, and stories posted in the last four days are skipped.
2. The three items are also saved to the `ca_daily` collection. The website can turn a week of them into a weekly roundup page.
3. 07:00 IST: the digest is posted.
4. A slot stays open for two hours, so a restart still catches it. After that it is skipped.

## Run it

```bash
cp .env.example .env     # fill in the four values
npm install
npm run check:links # validates the calendar and that every link returns 200
npm run dry-ca           # prints today's digest without posting
DRY_RUN=1 npm start      # runs the worker, printing instead of posting
npm start                # runs it for real
```

## Deploy on a VPS (systemd)

```bash
curl -fsSL https://raw.githubusercontent.com/icancodefyi/upsc-telegram-bot/main/deploy/install.sh | bash   # first run creates .env
nano /opt/upsc-telegram-bot/.env                                                                         # fill in the values
curl -fsSL https://raw.githubusercontent.com/icancodefyi/upsc-telegram-bot/main/deploy/install.sh | bash   # validates, installs the service, starts it
journalctl -u upsc-telegram-bot -f
```

Needs Node 20 or newer and `git`. To update: run the script again. To add a week of posts, put a new `content/week-N.json` in the repo, run `npm run check:links`, push, then run the script on the server. The worker re-reads the content folder every minute.

## Notes

- The bot must be an admin of the channel with permission to post.
- Never commit `.env`. It is git-ignored.
- Current-affairs notes are machine-written from the source text. Read the first week before trusting it unattended.
