# upsc-telegram-bot

A small worker that runs a UPSC Telegram channel on its own:

- **07:00 IST daily:** a current-affairs digest of three stories, built at 05:30 from PIB, The Hindu and Indian Express feeds, with a source link on every item.
- **Pre-written calendar:** posts in `content/*.json`, each with an id, an IST time and the text. Tips, product posts, blog posts and data facts.

State (what has been sent) lives in MongoDB, so restarts never double-post.

## How a day works

1. 05:30 IST: the worker fetches the feeds, asks Groq to pick the three most exam-relevant stories, fetches each article's text and asks for a two-sentence note using only that text. Output that fails a check (fewer than three items, an em-dash) is discarded and logged as `failed`, and nothing is posted.
2. The three items are also saved to the `ca_daily` collection. The website can turn a week of them into a weekly roundup page.
3. 07:00 IST: the digest is posted.
4. Calendar posts go out at their own times. A post more than six hours late is skipped, not sent.

## Run it

```bash
cp .env.example .env     # fill in the four values
npm install
npm run check -- --links # validates the calendar and that every link returns 200
npm run dry-ca           # prints today's digest without posting
DRY_RUN=1 npm start      # runs the worker, printing instead of posting
npm start                # runs it for real
```

## Deploy on a VPS (systemd)

```bash
sudo mkdir -p /opt/upsc-telegram-bot && sudo chown deploy: /opt/upsc-telegram-bot
git clone https://github.com/icancodefyi/upsc-telegram-bot /opt/upsc-telegram-bot
cd /opt/upsc-telegram-bot && cp .env.example .env && nano .env && npm ci
sudo cp deploy/upsc-telegram-bot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now upsc-telegram-bot
journalctl -u upsc-telegram-bot -f
```

Node 20 or newer. To add a week of posts, put a new `content/week-N.json` in the repo, run `npm run check -- --links`, then `git pull` on the server. No restart is needed, the worker re-reads the folder every minute.

## Notes

- The bot must be an admin of the channel with permission to post.
- Never commit `.env`. It is git-ignored.
- Current-affairs notes are machine-written from the source text. Read the first week before trusting it unattended.
