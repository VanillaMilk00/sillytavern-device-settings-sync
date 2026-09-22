# SillyTavern Device Settings Sync

[繁體中文](README.md) · [简体中文](README.zh-CN.md) · [English](README.en.md)

Manually synchronize portable browser settings and account/extension settings between devices using the same SillyTavern account.

Version **1.5.2**: **restart the SillyTavern server plugin after upgrading**. Refreshing the browser alone does not activate the new backup API.

## Features

- Manual upload/download with confirmation. Loading a page does not synchronize, poll or create backups.
- Five full localStorage backup slots shared by the logged-in account, newest first.
- A WizTree-style storage tree and proportional treemap with search, multi-selection, sorting, folder/key export and removal.
- JSON import with selectable preview, merge or bounded replacement, stale-preview detection and rollback on write failure.
- Total and selected size estimates, local cleanup suggestions, desktop/mobile layouts, and English, Traditional Chinese and Simplified Chinese UI.

## Installation and upgrade

Requires SillyTavern 1.14.0+, Node.js 18+, and server plugins enabled. The 1.5.0 integration was tested in a separate SillyTavern 1.14.0 installation with Node.js 22 and Edge Chromium, including mobile-sized viewports. Previous sync versions were also tested on SillyTavern 1.18.0; this is not a claim of testing every host version or physical mobile browser. CI covers Node.js 18, 20 and 24.

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

**These backups contain localStorage only**—not account settings files, server chat files, characters, cookies, sessionStorage or IndexedDB. They include localStorage caches, history, large values and credentials without ordinary sync exclusions. Regular cross-device sync continues to apply its existing exclusion rules and size limits.

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
