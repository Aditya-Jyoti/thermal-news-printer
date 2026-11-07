# Phone-only architecture (Phase 6)

Everything runs inside the React Native app. The Python `backend/` is the **reference implementation**:
port its behaviour (schema, dedup rules, prompts, digest selection, layout, BLE protocol) to TypeScript.
`docs/ARCHITECTURE.md` remains the source for data shapes, dedup rules and defaults.

## Modules

| Path | Owner stream | Ports from |
|---|---|---|
| `mobile/src/device/contracts.ts` | Orchestrator | — shared interfaces (`ReceiptBitmap`, `RenderReceipt`, `PrinterDriver`, `registerDevice`) |
| `mobile/src/printer/` | P | `backend/tnp/print/catprinter/protocol.py`, `ble.py` |
| `mobile/src/render/` | R | `backend/tnp/print/render.py` (+ fonts in `backend/tnp/print/fonts/`) |
| `mobile/src/core/` | C | `backend/tnp/{db,seed,ingest,ai,digest,pipeline}.py` |
| `mobile/src/api/local.ts` | C | implements the existing `Api` interface (`src/api/types.ts`) on-device |

`core/` never imports `render/` or `printer/`; it calls `getDevice()` from `contracts.ts`.
`src/app/_layout.tsx` calls `registerDevice({ render, printer })` at startup (Stream C wires this after merge if R/P are not yet merged — use stubs that throw "not available yet").

## Data source modes (app setting)

`on-device` (default) → `createLocalApi()` · `remote` → existing `createHttpApi(baseUrl)` (for a Pi/desktop backend) · `demo` → `createMockApi()`.

## Storage

- SQLite via `expo-sqlite`, schema identical to `docs/ARCHITECTURE.md` (same tables/columns), plus a `schema_version` pragma for migrations.
- OpenRouter API key: `expo-secure-store` key `openrouter_api_key`; never logged, never in SQLite.
- Saved printer: settings key `printer_address` (BLE id) — already in `Settings`.
- Receipt PNGs of past prints: `FileSystem.documentDirectory + 'prints/<id>.png'`.

## Print flow (manual and scheduled)

`build digest` → `create_print (pending)` → `render` → save PNG → `printer.print(bitmap)` → status `printed` | `failed`.
Only `printed`/`pending` prints block their articles (failed prints release them) — same as backend.

## Scheduling

Scheduled prints run on the phone with the app closed, including in Doze.

Flow: `rearm(db)` (JS) computes the soonest next run across enabled schedules (`src/scheduler/cron.ts`, same
semantics as `backend/tnp/cron.py`, local time zone) → native `setNextAlarm(epochMs, id)` arms ONE
`AlarmManager.setExactAndAllowWhileIdle` alarm (RTC_WAKEUP) → at fire time `AlarmReceiver` starts
`PrintForegroundService` (foreground service type `connectedDevice`, required for BLE on Android 14+; ongoing
"Printing your morning edition…" notification) → the service is a React Native `HeadlessJsTaskService` that runs the
JS task `TnpScheduledPrint` (4 min timeout, `src/scheduler/task.ts`) → `getDb()`, register the real renderer and BLE
driver (headless runs skip `_layout`), `runCycle(db, 'schedule')` (ingest → summarize → digest → render → BLE print →
record status) → the notification shows the outcome ("Printed 6 stories" / "Printer not found — will try next time" /
"Nothing new to print") → the service stops itself. The task re-arms the next alarm both before running (so a crash can
never kill the schedule) and after.

Native module: `mobile/modules/print-scheduler` (Expo Modules API, Kotlin, autolinked from `modules/`; manifest
entries come from the module's own `AndroidManifest.xml`, so the generated `android/` stays untouched). JS access is
behind the small `PrintSchedulerNative` interface in `src/scheduler/native.ts` (mocked in tests, null off Android).
`index.ts` is the app entry: it registers the headless task, then loads `expo-router/entry`.

Re-arming happens on app start, after every schedule create/update/delete/enable toggle (local Api), and at the end of
every run. The next epoch and schedule id are also stored in SharedPreferences, so `BootReceiver` re-sets the alarm after
reboot, app update, clock change or timezone change. After a reboot a run missed by under 2 h fires immediately; older
ones are dropped. A run whose alarm fires more than 2 h late (e.g. Doze/OEM delay) is skipped (no surprise prints), and
the next one is armed. After a timezone change the stored absolute time is kept until the next app open or run
recomputes it in the new zone.

Permissions (module manifest): `SCHEDULE_EXACT_ALARM`, `RECEIVE_BOOT_COMPLETED`, `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_CONNECTED_DEVICE`, `POST_NOTIFICATIONS`, `WAKE_LOCK`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
(plus the BLE permissions from react-native-ble-plx). Without "Alarms & reminders" access the module falls back to
`setAndAllowWhileIdle` (inexact: may be delayed by many minutes in Doze); the Settings card warns about it.

UI: Settings → Print schedule has a "Scheduled printing" card with the next run ("Next print: tomorrow 08:00"),
warnings with fix buttons (exact alarms, notifications, battery optimisation) and "Run schedule now (test)", which
starts the same foreground service + headless task immediately. `POST_NOTIFICATIONS` is requested when a schedule is
created or enabled (Android 13+).


## AI-curated edition (feed = preview = print)

`core/edition.ts`: `curateEdition` sends the recent unprinted non-political candidates (cap 60, `id | #category | title | ~220 chars`) in ONE OpenRouter call and gets `{"picks":[...],"political":[...]}`; code then applies per-category limits, `max_items_total`, printed exclusion and near-duplicate removal on the AI order (deterministic newest-first fallback without key/on failure). The result is persisted in `edition_items` (schema v2, setting `edition_built_at`); only those stories are enriched and summarized (concurrency 3). Feed, Preview and `runPrint` all read this table; a successful print clears it and builds the next edition. `buildEdition` is single-flight per database. Pipeline progress reaches the UI through `core/events.ts` (query invalidation, no polling). Cards open the original article via `expo-web-browser`.

## Archive, read state and diagnostics (schema v3)

- `articles.read_at` (NULL = unread). Opening the original or the per-card action sets it; `Api.setRead(id, read)`.
- `editions(id, created_at, archived_at, print_id)` + `edition_archive_items(edition_id, position, article_id, category_slug, tldr)` hold only **archived** editions; the live one stays in `edition_items`. I chose a separate archive (instead of an `archived_at` flag on `edition_items`) because the live table is replaced wholesale on every curation and is keyed by position, while history needs stable ids, a print link and nullable summaries. v3 back-fills every `printed` print as an archived edition (edition id = print id).
- `Api.fetchNews()` ("Fetch new news"): wait for a running build, archive the live edition (print_id NULL = "Not printed"), ingest, curate a fresh edition (summaries continue in the background). A successful print archives the printed items with `print_id`. Archived articles are excluded from curation like printed ones (`NOT_CONSUMED` in `db/articles.ts`). Pull to refresh = ingest + fill missing summaries only; it never replaces the edition.
- `Api.listHistory()`: one joined query over the newest N editions; the History tab groups by local day (`lib/history.ts`) into collapsible sections (latest day open).
- Curation window: `MAX_AGE_DAYS = 14`, `MAX_CANDIDATES = 80`; AI picks first, then top-up from remaining non-political candidates, per-category `print_limit` stays a hard maximum; `Edition.target` lets the Feed explain a short edition. Missing/unparseable `published_at` falls back to `fetched_at`.
- Failures: `core/diagnostics.ts` stores the last error per stage (ingest/curate/summarize/render/print) in setting `last_errors` (redacted, cleared on success); `EditionStatus.last_error` feeds the Feed/Preview banner; Settings > Diagnostics lists them with counts and a "Test OpenRouter key" button. AI failures are `console.warn`ed with model, HTTP status and a redacted body snippet.
- AI requests send `reasoning: { enabled: false }` and a `max_tokens` floor of 2048; a fallback equal to the main model is replaced by `google/gemma-3-12b-it`.
