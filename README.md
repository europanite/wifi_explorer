# wifi-gps-logger-structured-expo

Expo Go compatible Wi-Fi logger based on the earlier lightweight library setup.

This build keeps the Expo Go-compatible react-native-maps version for SDK 54 to avoid the RNMapsAirModule runtime error.

## What changed in this reverted version

- Removed `expo-dev-client`
- Removed `react-native-wifi-reborn`
- Restored plain `expo start` so the QR code opens in Expo Go again
- Kept the map view, GPS logging, local CSV writing, and CSV export
- Switched Wi-Fi collection back to the **currently connected Wi-Fi network** through `@react-native-community/netinfo`

## Important limitation

Expo Go cannot use custom native Wi-Fi scanning modules. Because of that, this reverted version **cannot scan nearby unconnected access points**.

What it can do:

- Track the signal of the **currently connected Wi-Fi network**
- Save latitude, longitude, accuracy, SSID, BSSID, strength, frequency, and link speed to a local CSV file
- Reflect the samples on a live map in real time
- Export the CSV file from the device

## Dependencies

- Expo SDK 54
- `expo-location`
- `expo-file-system`
- `expo-sharing`
- `@react-native-community/netinfo`
- `react-native-maps`

## Start with Docker

1. Use the included `.env` file
2. Confirm `REACT_NATIVE_PACKAGER_HOSTNAME=192.168.3.6` matches your PC's LAN IP address
3. Start the frontend container

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

### Expo Go does not open the QR code

- Check `REACT_NATIVE_PACKAGER_HOSTNAME` in `.env`
- Make sure the phone and PC are on the same LAN
- Check that ports `8081`, `19000`, `19001`, and `19002` are not blocked
- If LAN mode still fails, try:

```bash
cd frontend/app
npx expo start --tunnel
```

### Why nearby Wi-Fi scanning is gone

Expo Go can only use libraries included in Expo Go. Nearby access point scanning required `react-native-wifi-reborn`, which is a custom native module, so it had to be removed in the Expo Go version.


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

### Check build history

```bash
docker compose run --rm frontend sh -lc "npx eas-cli@latest build:list --platform android"
```
