#!/usr/bin/env bash
# Installs or updates the bot on a Debian/Ubuntu VPS. Run as a user with sudo. Idempotent.
set -euo pipefail

APP=/opt/upsc-telegram-bot
REPO=https://github.com/icancodefyi/upsc-telegram-bot.git
RUN_USER=${RUN_USER:-$(whoami)}

command -v node >/dev/null || { echo "Node 20+ is required. Install it first (https://nodejs.org)."; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node 20+ is required."; exit 1; }

sudo mkdir -p "$APP" && sudo chown "$RUN_USER": "$APP"
if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only; else git clone "$REPO" "$APP"; fi
cd "$APP"
npm ci --omit=dev=false --silent

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created $APP/.env. Fill in the four values, then run this script again."
  exit 0
fi

npm run check --silent
sudo sed "s/^User=.*/User=$RUN_USER/" deploy/upsc-telegram-bot.service | sudo tee /etc/systemd/system/upsc-telegram-bot.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable upsc-telegram-bot >/dev/null
sudo systemctl restart upsc-telegram-bot
sleep 3
systemctl is-active upsc-telegram-bot && journalctl -u upsc-telegram-bot -n 5 --no-pager
