#!/usr/bin/env bash
set -euo pipefail

sudo apt update
sudo apt install -y git curl ffmpeg python3 python3-pip python3-venv nginx

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi

npm install
npx playwright install --with-deps chromium

python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install faster-whisper

if ! command -v pm2 >/dev/null 2>&1; then
  sudo npm install -g pm2
fi

echo "Setup complete. Copy .env.example to .env and fill APP_PASSWORD, KIMI_API_KEY."
