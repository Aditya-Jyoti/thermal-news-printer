# Thermal News (mobile)

React Native (Expo SDK 58, TypeScript, expo-router) companion app and control center for
termal-news-printer. Read full articles, browse print history, manage RSS sources/categories,
schedules and limits, and preview the 384px thermal print.

## Stack

- Material You theming: `react-native-paper` (MD3) + `@pchmn/expo-material3-theme` (dynamic wallpaper
  colors on Android 12+, static fallback seed color elsewhere). Follows system light/dark.
- Data: `@tanstack/react-query` over a typed fetch client (`src/api/client.ts`) that implements the REST
  contract in `docs/ARCHITECTURE.md`. Types in `src/api/types.ts` mirror `backend/tnp/models.py`.
- Demo mode: `src/api/mock.ts` is an in-memory mock of every endpoint.

## Run

Material You dynamic colors need a native module, so Expo Go is NOT enough. Use a development build:

```bash
cd mobile
npm install
npx expo run:android        # prebuilds android/, builds and installs on a device/emulator (JDK 17 + Android SDK)
npx expo start --dev-client # later runs: start Metro and open the installed dev build
```

Point the app at the backend: open **Settings > Connection**, set the Backend URL
(default `http://192.168.1.100:8000`, use your machine's LAN IP; Android emulator: `http://10.0.2.2:8000`),
then "Test connection". The backend must bind to `0.0.0.0` (`TNP_API_HOST`). Cleartext HTTP is enabled
for LAN use.

No backend yet? Turn on **Settings > Connection > Use demo data**.

## Checks

```bash
npx tsc --noEmit
npx expo lint
npx expo-doctor
npx expo export --platform android   # bundling sanity check
```

## Screens

| Tab | Purpose |
|---|---|
| Feed | Article cards with category filter chips; pull to refresh runs `POST /feeds/refresh` |
| Preview | `GET /print/preview.png` in a paper frame (384px wide); "Renderer not available yet" on 501; placeholder receipt in demo mode |
| History | Past prints, with a detail view listing `#tag` + TL;DR per item |
| Sources | Categories (create/rename/recolor/delete, print limit stepper) and feeds (add/edit/toggle/delete, last error) |
| Settings | Print now, schedules (time picker -> `M H * * *`, or raw cron), max items, summarization + fallback model pickers (from `GET /models`, or custom id), printer address, backend URL, demo toggle |

Article detail (`/article/[id]`) and print detail (`/print/[id]`) are stack screens.

## Layout

```
src/app/         expo-router routes ((tabs), article/[id], print/[id])
src/api/         types, http client, mock, react-query hooks, provider
src/components/  small UI pieces (cards, dialogs, receipt mock, ...)
src/theme/       Material You providers
src/state/       on-device settings (AsyncStorage)
src/lib/         cron + formatting helpers
```
