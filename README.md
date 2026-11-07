# thermal-news-printer

**Your daily news, printed on a cheap Bluetooth thermal "cat printer" and kept in an app.**

Every morning the app collects stories from your RSS feeds, has a small AI model write a short,
concrete TL;DR for each one, and prints them as a little newspaper receipt, "The Thermal Times".
The full articles stay in the app, so you can read anything that caught your eye later.

<p align="center"><img src="docs/sample_receipt.png" width="300" alt="Sample receipt: The Thermal Times"></p>

Everything runs **on your Android phone**. You don't need a server.

> **Status:** active development. The phone-only version (Phase 6) is being built: on-device
> fetching, summaries, rendering and Bluetooth printing. The Python implementation in `backend/` works
> end to end today and is the reference the app is ported from. See [Status](#status).

---

## How it works

```
 RSS feeds ──► fetch & dedupe ──► full text ──► AI TL;DR ──► pick today's stories ──► render 384px ──► Bluetooth ──► 🧾
 (per category)  (SQLite)        (if teaser)   (OpenRouter)  (limits, never repeat)   1-bit receipt    cat printer
```

### 1. Collecting the news
- You manage **categories** (e.g. `#products`, `#engineering`) and the **RSS feeds** in each one from the app.
  Defaults: Hacker News Launches and TechCrunch Startups (products), The Pragmatic Engineer (engineering),
  Freakonomics (psychology), Big Think (learning).
- Feeds are fetched with conditional requests (ETag / Last-Modified), so unchanged feeds cost almost nothing.
- Every article gets a **fingerprint**, a hash of its normalised URL with tracking parameters, fragments and
  trailing slashes stripped. The same story arriving through two feeds is stored once.
- Some feeds only ship a one-line teaser. TechCrunch's RSS averages about 170 characters. For those, the app
  downloads the article page and extracts the main text (Readability), which typically means about 3,000+ characters.
  The AI then has the real story to work with, and you get the full article in the app.

### 2. Summarising with AI
- Summaries use [OpenRouter](https://openrouter.ai) through the OpenAI-compatible API.
  The default model is `google/gemma-3-12b-it`, with an automatic fallback to `deepseek/deepseek-v4.1-flash`.
  You can switch either model, or type any OpenRouter model id, in Settings.
- Each new article costs **one call**. That call writes the TL;DR and also decides whether the story is political.
- **Strictly non-political.** A keyword pre-filter catches obvious cases cheaply and the AI decides the rest.
  Political stories are never printed and are hidden from the feed.
- The prompt asks for 2–3 sentences of about 45–70 words that **name the concrete subject** (the headline
  isn't printed), give the key specifics (numbers, names, how it works) and say why it matters. Filler like
  "explores", "discusses" and "sheds light" is banned, and a weak answer is retried once.

### 3. Choosing what to print
- The **per-category limits** you set apply (e.g. max 3 `#products`, max 1 `#psychology`), plus an overall cap.
  Categories are interleaved so the print stays varied, and the newest stories come first.
- **It never prints the same news twice.** Anything that appeared in a successful (or in-progress) print is
  excluded. Headlines that are near-duplicates (word overlap ≥ 80%) of the last print, or of each other, are
  skipped too. If a print *fails*, those stories become eligible again, because they never reached paper.

### 4. Rendering the receipt
- A canvas exactly **384 px wide** (48 mm at 203 dpi), as long as the content needs, **1-bit black and white**.
- Newspaper typography with serif fonts: a *Playfair Display* masthead and *Source Serif 4* body text (both SIL OFL).
  Text is thresholded, not dithered, so it prints crisp.
- **Text only:** a plain `#tag` and the TL;DR, with no headlines, pills, boxes or illustrations.
  Every pixel of paper goes to news.
- The app's **Print Preview** shows the exact image that will be printed, so you can tune lengths without wasting paper.

### 5. Printing over Bluetooth

The printer side builds on **[rbaron/catprinter](https://github.com/rbaron/catprinter)** (MIT), which
reverse-engineered the BLE protocol these cheap printers (GB01, GB02, GT01, MX05… and our SC03h) use.
This project re-implements it, in Python (`backend/tnp/print/catprinter/`) and in TypeScript for the app
(`mobile/src/printer/`), and tests it byte for byte against the reference encoding.

How the protocol works:

- The printer exposes a BLE GATT service (`0xAE30`). The app **writes** commands to characteristic `0xAE01`
  and **listens** for notifications on `0xAE02`.
- Every command is a small packet:

  ```
  51 78 | cmd | 00 | len (2 bytes, little-endian) | payload | CRC-8 (poly 0x07) of payload | FF
  ```

- A print job is a sequence of commands: get device state → set quality → set energy (darkness) →
  *lattice start* → **one command per row of pixels** → feed paper → *lattice end* → get device state.
- Each row is 384 pixels = **48 bytes**, packed least-significant-bit first, 1 = burn (black).
  A row is sent either raw (`0xA2`) or run-length encoded (`0xBF`), whichever is shorter. Text-heavy
  receipts compress well.
- The job is streamed in small chunks with a short pause between them, so the printer's buffer never overflows.

Quirks of the **SC03h** that the reference doesn't cover (found on real hardware):

- **Dual-mode device:** it advertises classic Bluetooth serial as well as BLE. On Linux, BlueZ picks the
  classic connection and fails with `ProfileUnavailable`. The Python driver therefore opens a raw
  BLE ATT socket (`att.py`). Android's BLE stack connects over LE directly.
- It accepts a 247-byte MTU, but 244-byte writes stall the link. Chunks are capped at **100 bytes with 20 ms pacing**.
- It never sends the reference "ready" notification. It only answers *get device state* (`0xA3`). Since a job
  starts and ends with that command, the **second `0xA3` reply** marks the job as finished.

### 6. Scheduling
You set one or more print times in the app (e.g. 08:00 "Morning edition"). At each time, the phone fetches,
summarises, picks the stories, renders and prints. The phone must be within Bluetooth range of the printer
(about 10 m). Android's exact alarms and a battery-optimisation exemption keep scheduled prints reliable.

---

## The app

React Native (Expo, TypeScript) with **Material You** theming that takes its colours from your wallpaper (Android 12+).

| Tab | What it does |
|---|---|
| **Feed** | Cards with image, title and category tag; pull to refresh; tap for the full article and its TL;DR |
| **Preview** | The exact 384px receipt that would print right now |
| **History** | Every past print and its stories, so nothing is lost if you didn't read the paper |
| **Sources** | Add, edit and remove feeds and categories, and set per-category print limits |
| **Settings** | Print times, models, OpenRouter key, printer pairing and test print, Print now, data source |

**Data source** (Settings): *On-device* (default, no server), *Remote backend* (point the app at the Python
backend, e.g. on a Raspberry Pi), or *Demo* (sample data).

---

## Getting started

### Requirements
- An Android phone (Android 12+ for wallpaper colours) and a BLE cat printer (tested with **SC03h**).
- An [OpenRouter API key](https://openrouter.ai/keys). Summaries cost a fraction of a cent per day with the default model.
- To build: Node.js, JDK 17 and the Android SDK.

### Build and install the app
```bash
cd mobile
npm install
npx expo prebuild --platform android
cd android && ./gradlew assembleDebug        # first build takes ~10 minutes
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
For development with live reload, run `npx expo start --dev-client` in `mobile/` and `adb reverse tcp:8081 tcp:8081`.
Expo Go won't work, because Material You colours and Bluetooth need native modules.

### First run
1. **Settings → OpenRouter API key:** paste your key. It is stored in the phone's secure storage, never in the database or logs.
2. **Settings → Printer → Scan:** pick your printer, then **Print test page**.
3. Pull to refresh on **Feed**. Summaries appear within a minute.
4. Check **Preview**, then **Print now**, or wait for your scheduled time.

### Optional: the Python backend
The original implementation still works on any Linux machine with Bluetooth (including a Raspberry Pi):
```bash
cd backend
uv sync
uv run python -m tnp.ingest                 # fetch feeds
OPENROUTER_API_KEY=... uv run python -m tnp.pipeline process   # summarise
uv run python -m tnp.print preview --out receipt.png            # render
uv run python -m tnp.print probe            # check the printer handshake (no paper)
uv run python -m tnp.print test             # print a test strip
uv run python -m tnp.api                    # REST API + scheduler on :8000
OPENROUTER_API_KEY=... uv run python -m tnp.ai.eval --n 8       # inspect TL;DR quality
```
Set `TNP_PRINTER=dry` to run everything without a printer. Run `uv run pytest -q` for the test suite.

---

## Repository layout
```
mobile/                 React Native app (Expo)
  src/core/             on-device pipeline: SQLite, RSS, full text, OpenRouter, digest
  src/render/           384px receipt renderer (Skia)
  src/printer/          cat-printer BLE protocol + driver
  src/api/              data layer (on-device, remote backend, demo)
  src/app/              screens (expo-router)
backend/                Python reference implementation (FastAPI, Pillow, BLE)
docs/
  ARCHITECTURE.md       data model, dedup rules, REST API
  MOBILE_ARCHITECTURE.md  phone-only module contracts
  sample_receipt.png
```

## Status
- ✅ Python backend: ingest, enrichment, AI summaries with fallback, dedup, 384px renderer, BLE printing
  (connects and streams to the SC03h), REST API, scheduler, 359 tests.
- ✅ App screens, Material You theming, demo and remote-backend modes; runs on device.
- 🚧 Phase 6, phone-only: Bluetooth printing from the phone, on-device content pipeline, on-device rendering, exact-alarm schedules.

## Credits
- **[rbaron/catprinter](https://github.com/rbaron/catprinter)** by rbaron (MIT): the reverse-engineered BLE
  protocol this project's printer driver is based on.
- Fonts: [Playfair Display](https://github.com/google/fonts/tree/main/ofl/playfairdisplay) and
  [Source Serif 4](https://github.com/google/fonts/tree/main/ofl/sourceserif4) (SIL Open Font License).
- Summaries via [OpenRouter](https://openrouter.ai).

## License
MIT. See [LICENSE](LICENSE).
