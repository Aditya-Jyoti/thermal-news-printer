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

## Scheduling (step 4, later)

Exact Android alarms fire at the schedule times; a short headless task runs fetch → summarize → digest → render → print. Requires exact-alarm permission and battery-optimisation exemption.
