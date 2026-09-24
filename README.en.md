# SillyTavern Device Settings Sync

[繁體中文](README.md) · [简体中文](README.zh-CN.md) · [English](README.en.md)

Manually synchronize settings between devices using the same SillyTavern account, with optional automatic synchronization of portable browser settings.

Version **1.8.3**. The IndexedDB manager opens quickly and marks unscanned sizes clearly; you can optionally estimate JSON sizes for all databases. This is a frontend-only update, so refresh the browser. Restart SillyTavern after first installing or updating the server plugin as described below.

## Features

- Manual upload/download with confirmation. With both automatic switches off (the default), loading a page does not synchronize, poll or create backups.
- Independently enable idle automatic upload and entry-time automatic download.
- Five full localStorage backup slots shared by the logged-in account, newest first.
- A WizTree-style storage tree and proportional treemap with search, multi-selection, sorting, folder/key export and removal.
- JSON import with selectable preview, merge or bounded replacement, stale-preview detection and rollback on write failure.
- Total and selected size estimates, local cleanup suggestions, desktop/mobile layouts, and English, Traditional Chinese and Simplified Chinese UI.
- Choose portable, all, or selected localStorage keys/folders; explicitly selected cache, history and large values are included.
- Optional IndexedDB synchronization and database/store/record management, import, export and removal.

## Settings menu and complete localStorage sync

Open **Settings** in the extension panel to adjust automatic upload/download, backups before changes, additional exclusions and the localStorage sync range. Range preferences are stored locally per site, account and device; they are not copied to other devices.

- **Portable settings** (default): existing cache, history, large-value, credential and custom-exclusion rules apply.
- **Selected keys/folders only:** in Manage localStorage, select entries or a folder and choose **Use selection as sync range**. Explicitly selected cache, history and large values are included; internal sync keys always remain excluded. Downloads affect only that range.
- **All localStorage:** synchronize every non-internal key, including caches, history, drafts, large values and possibly credentials.

Selected-range and full modes use the separate full-storage server file, limited to 32 MiB JSON. Manual and automatic synchronization honor the selected scope; an empty selection never silently expands to all storage.

Full mode applies to both manual and automatic upload/download. It includes caches, history, drafts, large values and possibly credentials. The extension's internal device and scheduling keys remain local. Full and regular modes use separate account-private server files; switching does not silently overwrite one with the other. Initial unequal data prompts for a source during automatic sync. The full JSON sync file is limited to 32 MiB; oversized writes leave existing server data untouched. A complete local rescue backup is required before applying changes. Downloads replace all non-internal keys from the full snapshot and attempt rollback on write failure.

Full mode covers **localStorage only**, not IndexedDB, cookies or other browser storage. Browser quotas vary: data fitting on one device may fail to fit on another. Additional exclusions and the ordinary per-key limit apply only to portable mode.

## Optional IndexedDB sync and manager

After explicitly enabling IndexedDB in Settings, the existing manual upload/download and corresponding automatic switches also process IndexedDB. It is off by default and the preference is local to this site/account/device.

- Choose selected databases/items or all same-origin databases. In Manage IndexedDB, select databases, object stores or individual records and choose **Use selection as sync range**. Import, export and removal are also available per selection.
- Upload and download are merge-only: incoming values replace matching primary keys, while extra server and local records remain. Sync never deletes records; removal is an explicit local manager action.
- IndexedDB uses its own five account-private rescue slots. Each archive is capped at 128 MiB and transferred in 1 MiB chunks with integrity checks. The browser must support `indexedDB.databases()`.
- Common structured values, cycles, Blob/File and binary data are retained. Unsupported values, schema conflicts, blocked databases and quota errors stop the operation instead of silently skipping data.
- A complete local IndexedDB rescue snapshot is saved before sync. IndexedDB cannot provide one atomic transaction across different databases/object stores; recover partial failures from its separate backup slots.

`navigator.storage.estimate()` reports a whole-origin estimate, not an IndexedDB-only quota or guaranteed maximum. The extension never clears data or guesses which records are safe to remove.

## Independent automatic upload and download

Both switches default **off** and require confirmation when enabled. Preferences belong to this website, account and browser device, and are excluded from ordinary sync. Disabling cancels unsent work; an already-sent request may finish.

- **Upload only:** after the last observed model request succeeds, fails or is cancelled, wait 15 uninterrupted idle minutes. Each activity cycle uploads at most once; unchanged portable data uses no backup slot. Editing settings alone does not start a countdown.
- **Download only:** check on a new page or manual reload, not when switching tabs. Apply remote-only changes; retain local-only changes. Successful changes reload once with a one-shot loop guard.
- **Both:** operate independently, sharing account-scoped Web Locks across tabs. Active requests and open storage management defer work.
- **Conflicts:** initial unequal data without a baseline, two-sided changes or changed remote versions before upload require a choice: keep local and upload once, use server data, or decide later. The first two authorize only that action, without enabling the other switch. Later pauses automatic writes.

Automatic mode synchronizes regular or full localStorage according to the selected mode. It does not re-save native account/extension settings or change manual sync. Every real write first creates a full server rescue backup, potentially including credentials, even in download-only mode and regardless of the optional management-backup switch. Backup or validation failures abort writes; failed downloads attempt rollback. Upload still reads the remote version with download disabled, without applying remote settings.

Monitoring covers native generation events and known generation/Responses/Embedding/Rerank fetch/XHR endpoints, including accessible same-origin frames. Streaming waits for transfer completion, not headers; response bodies are not cloned or consumed. Prompts, responses, credentials and query parameters are not inspected. Requests with no confirmed completion block uploads. Cross-origin frames, workers, unknown transports and requests started before monitoring are observation limits. Extensions can report lifecycle through the main page without passing content:

```js
const activity = globalThis.DeviceSettingsSync.beginModelActivity();
try {
    await yourModelRequest(); // Wait until streaming finishes or is cancelled, not just headers.
} finally {
    globalThis.DeviceSettingsSync.endModelActivity(activity);
}
```

Automatic operation requires a secure HTTPS/localhost context, Web Locks, Web Crypto and Resource Timing. Unsupported environments retain manual controls. Browser closure/suspension cannot guarantee timely uploads; no forced unload transmission occurs. Returning reconciles pending work; abandoned requests from closed tabs restart a conservative 15-minute wait, while live frozen tabs remain blocking. Transient failures retry after 1, 5 and 15 minutes, then pause; permission/version/conflict errors do not repeatedly retry. Use the panel's pause/resume/retry controls.

Preferences, baselines and journals are internal keys: excluded from regular sync, included in full backups, skipped by default on restore. Management operations directly change only local data, but a pending/future automatic upload can subsequently upload those changes.

## Installation and upgrade

Requires SillyTavern 1.14.0+, Node.js 18+, and server plugins enabled. Version 1.6.0 was tested in a separate SillyTavern 1.14.0 installation with Node.js 22 and Edge Chromium, including mobile-sized viewports and all three languages. Model transports use a local test server, not paid models. Previous sync versions were also tested on SillyTavern 1.18.0; this does not verify every model extension, host version or physical mobile browser. CI covers Node.js 18, 20 and 24.

1. In Extensions → Install extension, enter:

   ```text
   https://github.com/VanillaMilk00/sillytavern-device-settings-sync
   ```

2. Set `enableServerPlugins: true` in SillyTavern's `config.yaml`.
3. From the SillyTavern root, link the server plugin:

   ```bash
   node public/scripts/extensions/third-party/sillytavern-device-settings-sync/install-server-plugin.mjs .
   ```

   This command also works in Windows PowerShell. For a per-user installation, use the install script under `data/<account>/extensions/` instead.

4. Restart SillyTavern. After future extension updates, restart it again to reload server-side code.

For the official Docker container named `sillytavern`, this host command detects both global and per-user extension installations:

```bash
docker exec sillytavern sh -lc 'set -eu; for script in /home/node/app/public/scripts/extensions/third-party/sillytavern-device-settings-sync/install-server-plugin.mjs /home/node/app/data/*/extensions/sillytavern-device-settings-sync/install-server-plugin.mjs; do if [ -f "$script" ]; then exec node "$script" /home/node/app; fi; done; echo "Extension not found; install it in SillyTavern first" >&2; exit 1'
```

If the installer finds an ordinary directory at `plugins/device-settings-sync`, it refuses to overwrite it. Back it up and move it yourself before linking again. An HTTP 404 means the server plugin is missing or outdated: verify the link and restart the server/container. If extension installation reports `Directory already exists`, use **Update** in the extension manager instead of reinstalling or deleting the existing directory.

### Android (Termux)

If SillyTavern runs **inside Termux on your Android phone**, run these commands in the Termux terminal, **not Docker, PowerShell or the browser console**. First set `enableServerPlugins: true` in `config.yaml`. If the server occupies that terminal, stop it with `Ctrl+C`.

These examples assume `~/SillyTavern`. If you use a launcher or another location, substitute the actual SillyTavern root containing `config.yaml`, `start.sh` and `src/users.js`. Choose **one** command according to how you installed the frontend extension.

Installed for all users:

```bash
cd ~/SillyTavern && node public/scripts/extensions/third-party/sillytavern-device-settings-sync/install-server-plugin.mjs .
```

Installed for yourself, using the default account `default-user`:

```bash
cd ~/SillyTavern && node data/default-user/extensions/sillytavern-device-settings-sync/install-server-plugin.mjs .
```

For another account, replace `default-user` with its account directory name. Adjust `data/` too if you changed `dataRoot`. A missing installer script usually means you chose the wrong global/per-user path; check the installation location instead of deleting and reinstalling.

After `Linked server plugin` or `Server plugin link is already correct`, restart from the SillyTavern root:

```bash
bash start.sh
```

See the [official Android guide](https://docs.sillytavern.app/installation/android-%28termux%29/) for the Termux working directory and startup command. If your phone only connects through a browser to a PC/cloud-hosted SillyTavern, **no installation command is needed on the phone**. Install the plugin and restart on the actual server instead.

## Sync and five backup slots

Use **Upload local settings** on the source device, then **Sync from server** on another device using the same account. Download automatically reloads the page. Upload mirrors removals of portable keys from the source device to the server.

Both actions create a full snapshot of the **current device's localStorage before changes**, after confirmation. Cancel creates nothing; backup failure aborts sync; a later sync failure keeps the rescue backup. The sixth successful backup evicts the oldest, using atomic publication and per-account serialization. A transport retry uses the same operation ID and does not consume another slot, even after eviction. The index retains operation IDs, backup IDs and digest receipts without setting values for deduplication across eviction and server restarts; only five snapshot contents are retained.

Open **Manage localStorage → Backups** to fetch the list. Slots show time, device, reason, key count, estimated size and JSON size, with browse/export/restore actions. Contents load only when selected. The option to also back up before importing, restoring or removing data is **on by default**. Saved preferences are preserved; if an older installation has it disabled, enable it manually in the manager.

**These localStorage backups contain localStorage only**—not account settings files, server chat files, characters, cookies, sessionStorage or IndexedDB. They include localStorage caches, history, large values and credentials without ordinary sync exclusions. IndexedDB uses separate five-slot backups; regular localStorage sync keeps its existing exclusions and size limits.

## Storage manager

Keys are grouped at `:`, `/` and `.`; only keys without those separators use the first `_` prefix. Hyphens remain intact. Folders are virtual original-key prefixes; each complete key is one file, and values remain raw strings without splitting their JSON fields.

- Export everything, a folder, an individual key or a multi-selection. Search and selection are shared by the tree and treemap; mobile stacks them vertically in a scrollable dialog.
- Import first displays selectable entries plus added/overwritten/deleted counts and a deletion list. A selection in the main tree restricts the destination; otherwise the file's scope applies. Restore uses the same preview.
- **Merge** is the default. **Replace within the chosen scope** removes only keys absent from the file and inside the permitted scope. Unchecked incoming keys stay unchanged. Selecting a single key does not grant replacement authority over its folder. Partial files cannot clear unrelated data.
- Internal synchronizer keys are visible and included in backups/exports, but skipped during import/restore/removal unless explicitly included. Leave them protected to avoid copying another device's identity.
- Removal requires confirmation with affected keys and size. Changes are local only; manually upload to change regular server sync data.

Mutations share an operation lock and compare current storage with the preview before writing. Changes in another tab invalidate the preview. On write failure, the manager attempts rollback and reports whether it succeeded. A reload button appears after successful changes; ordinary server downloads still reload automatically.

## JSON format and limits

Backups and exports use:

```json
{
  "format": "sillytavern-localstorage-backup",
  "version": 1,
  "createdAt": "2026-09-22T00:00:00.000Z",
  "source": { "origin": "https://your-tavern.example", "deviceId": "device_example" },
  "scope": { "kind": "prefix", "prefix": "extension:" },
  "entries": [{ "key": "extension:theme", "value": "dark" }]
}
```

Scope supports `{"kind":"full"}`, `{"kind":"prefix","prefix":"extension:"}`, or `{"kind":"keys","keys":["extension:theme"]}`. Plain JSON objects with string values are also accepted, e.g. `{"extension:theme":"dark"}`. They authorize only their exact keys, never a full replacement.

JSON files/backup requests are limited to **32 MiB**. Oversized input is rejected without modifying existing data. Full snapshots do not have the ordinary per-key sync limit, but browser storage quota may still prevent importing them. Import only trusted files.

## Capacity, cleanup and security

Estimated usage is the sum of `(key.length + value.length) × 2`, including excluded keys; JSON file bytes are calculated separately. This follows the [UTF-16 storage format documented by MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage), not the browser's actual quota or its total site-storage limit.

Local analysis lists the ten largest entries and name-based cache/temp/debug/log candidates, with sizes and reasons. History, drafts, chats, credentials and internal keys require manual review. Exclusion from sync does not imply safe deletion. No last-used time is invented and no cleanup runs automatically.

Backup files live in the account's private `device-settings-sync-backups/` directory, separate from `device-settings-sync.json`. Files request `0600` permissions (Windows still uses filesystem ACLs) but are **not additionally encrypted**. Protect your server and downloaded JSON files: full snapshots may contain OAuth tokens and other credentials. HttpOnly/login cookies are not readable by this extension; each device must still sign in to SillyTavern.

All APIs use SillyTavern session authentication and CSRF protection. Under `/api/plugins/device-settings-sync`:

- `GET /backups`: up to five summaries, without values.
- `POST /backups`: `{ operationId, reason, archive }`; reasons are `upload`, `download`, `import`, `restore`, `delete`.
- `GET /backups/:id`: a retained backup belonging to the current account.
- `GET /health`: advertises `backups-v1`, `atomic-sync-v1`, `full-storage-v1`, `indexeddb-sync-v1` and `indexeddb-chunks-v1`. Missing capabilities pause affected work with an update/restart message.
- `POST /commit`: `{ operationId, expectedRevision, deviceId, mutations }`, validated completely before an atomic write. Version or operation-ID conflicts return HTTP 409; identical retries are idempotent.
- `GET /commits/:id`: account-private receipt recovery for lost responses. Receipts and values are written together and count toward the existing 5 MiB state limit. Existing per-value limits and manual APIs remain compatible.
- `GET /full-state`, `POST /full-commit`, `GET /full-commits/:id`: separate full snapshot, atomic versioned commit and retry receipt, limited to 32 MiB JSON. These are separate from regular sync and the five rescue backups.
- `POST /indexeddb/transfers/start`, `PUT /indexeddb/transfers/:id/chunks/:index`, `POST /indexeddb/transfers/:id/finish`: chunked upload and atomic merge commit, capped at 128 MiB with account-scoped revision checks and idempotent operation IDs.
- `GET /indexeddb/state` and `/indexeddb/state/chunks/:index`: read the account's server snapshot in chunks.
- `GET /indexeddb/backups`, `GET /indexeddb/backups/:id`, `GET /indexeddb/backups/:id/chunks/:index`: list and retrieve the separate five-slot IndexedDB rescue archives.

### One-click analysis, capacity ceiling and extension hints (1.5.0)

- **Cleanup suggestions → Analyze now** scans all keys, sorts by size and marks the largest ten. Green means possible cache/temp/debug/log data, yellow means manual review, and red is protected from batch cleanup. This is a key-name heuristic, not AI or proof that data is unused.
- Protection takes precedence: credentials, history, drafts, chats, settings and internal keys are not recommended even when their names contain `cache`. The `tt:` namespace requires review. Red items cannot be selected for batch cleanup; deliberate removal remains available in Local data.
- Nothing is selected initially. Select recommended items selects green entries only; yellow entries can be checked manually. **Back up and clean** previews exact keys, count and size, then requires a successful full server backup even when optional pre-change backups are disabled. Cancellation, backup failure or stale data abort deletion. Write failures use rollback; success reports before/after usage and released space. Changes remain local.
- The panel shows a **5 MiB reference ceiling**, not a measurement of this device. Runtime limits and accounting can differ. There is no standard direct localStorage quota query, and total site quota is not a substitute. [MDN quota documentation](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- The explicitly confirmed capacity test grows one new temporary key and removes it afterward, reporting an estimated UTF-16 range and timestamp. The test value is capped at 16 MiB; reaching this safety bound reports only a lower bound. **It may briefly block the page or make writes in other tabs fail: export important data and pause other activity first.** It never runs automatically, clears storage or overwrites existing keys. Concurrent changes abort testing; unsafe temporary-key cleanup is reported. Results are not a permanent guarantee.
- The extension/value-type column displays recognized suffixes from original keys, otherwise inferred `.json` or `.txt` labels. It distinguishes JSON objects/arrays, text, Data URIs and Blob URLs, skipping JSON parsing above 1 Mi characters. Hints **never rename keys**; exports remain JSON archives containing the original string values.

## Development

Run `npm test` and `npm run check`. See [TESTING.md](TESTING.md) for reproducible browser and authentication/CSRF checks. Integration scripts mutate the test account and must run only against a disposable installation, never your everyday data. A partial workspace cannot substitute for an actual SillyTavern integration test.

## License

[MIT](LICENSE)
