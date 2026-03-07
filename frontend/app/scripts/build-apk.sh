#!/bin/sh
set -eu

cd /app

if ! command -v git >/dev/null 2>&1; then
  echo "git is not installed in the container." >&2
  exit 1
fi

if [ ! -d .git ]; then
  git init
fi

GIT_USER_NAME="${GIT_USER_NAME:-europanite}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-europanite@example.com}"

git config --global --add safe.directory /app
git config --global user.name "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"

if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
  git add -A
  git commit -m "Initial commit for EAS build" || true
fi

if [ -n "${EXPO_TOKEN:-}" ]; then
  exec npx eas-cli@latest build --platform android --profile preview --non-interactive
else
  exec npx eas-cli@latest build --platform android --profile preview
fi
