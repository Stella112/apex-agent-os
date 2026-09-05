#!/usr/bin/env bash
# Start APEX and open it in a browser (macOS / Linux).
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org"
  exit 1
fi

( sleep 2
  if command -v xdg-open >/dev/null 2>&1; then xdg-open http://127.0.0.1:4173
  elif command -v open >/dev/null 2>&1; then open http://127.0.0.1:4173
  fi ) &

node server.mjs
