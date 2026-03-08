# [wifi_explorer](https://github.com/europanite/wifi_explorer "wifi_explorer")


[![CI](https://github.com/europanite/wifi_explorer/actions/workflows/ci.yml/badge.svg)](https://github.com/europanite/wifi_explorer/actions/workflows/ci.yml)
[![CodeQL](https://github.com/europanite/wifi_explorer/actions/workflows/codeql.yml/badge.svg)](https://github.com/europanite/wifi_explorer/actions/workflows/codeql.yml)
[![pages](https://github.com/europanite/wifi_explorer/actions/workflows/pages/pages-build-deployment/badge.svg)](https://github.com/europanite/wifi_explorer/actions/workflows/pages/pages-build-deployment)

Expo Go compatible Wi-Fi logger.


```bash
docker compose up --build
```

## Start without Docker

```bash
cd frontend/app
npm install
npx expo start --host lan
```

## Open on Android

- Install Expo Go on the phone
- Put the phone and PC on the same LAN
- Scan the QR code from the Metro output

## Troubleshooting

```bash
cd frontend/app
npx expo start --tunnel
```

## Build an installable APK with Docker Compose

This project can trigger an Android APK build on Expo's EAS Build service from inside the existing Docker Compose frontend container. The APK build runs in the cloud, so the local container does not need the Android SDK.

### One-time preparation

1. Set a unique Android package name in `frontend/app/app.json`
2. Keep `frontend/app/eas.json` with the `preview` profile set to internal distribution and APK output
3. Log in to Expo from the container, or provide `EXPO_TOKEN` in `.env`

### Interactive login from Docker Compose

```bash
docker compose run --rm -it frontend sh -lc "npm install && npx eas-cli@latest login && npx eas-cli@latest build --platform android --profile preview"
```

### Non-interactive build with EXPO_TOKEN

Add `EXPO_TOKEN=your_token_here` to `.env`, then run:

```bash
docker compose run --rm -e EXPO_TOKEN=$EXPO_TOKEN frontend sh -lc "npm install && npx eas-cli@latest build --platform android --profile preview --non-interactive"
```


### build an apk ###

```bash
docker compose run --rm \
  -e EXPO_TOKEN="$EXPO_TOKEN" \
  -e GIT_USER_NAME="" \
  -e GIT_USER_EMAIL="" \
  frontend \
  sh -lc 'npm install && npm run build:apk:docker'
```