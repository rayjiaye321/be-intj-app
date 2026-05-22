#!/usr/bin/env bash
set -euo pipefail

sudo apt update
sudo apt install -y git curl nginx

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi

npm install
npx playwright install --with-deps chromium

if ! command -v pm2 >/dev/null 2>&1; then
  sudo npm install -g pm2
fi

echo "Setup complete. Copy .env.example to .env and fill APP_PASSWORD, KIMI_API_KEY."
