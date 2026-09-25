# 驗證方式 / Integration testing

## 純模組測試 / Unit and behavior tests

```bash
npm test
npm run check
```

v1.11.0 has **127 passing Node unit/behavior tests** and a passing syntax and release-manifest check. An isolated SillyTavern 1.14.0 host with Node.js 22 and Edge Chromium passed **30 management, 14 automatic-mode, 2 runtime-update browser and 9 server-security checks**. Runtime tests cover dependency replacement, incomplete/tampered/broken candidates, duplicate reloads, request draining/timeouts and snapshot retention. Firefox, WebKit, physical mobile devices and the full CI platform matrix were not tested locally; mobile coverage uses a browser viewport.

v1.11.0 目前有 **127 項 Node.js 單元／行為測試全數通過**、語法及發布清單檢查通過，並已在 SillyTavern 1.14.0、Node.js 22 的隔離環境完成 Edge Chromium 驗收：管理介面 **30 項**、自動模式 **14 項**、熱更新 **2 項**及伺服器安全 **9 項**。熱更新測試涵蓋相依程式替換、殘缺／竄改／損壞候選版本、重複更新、請求排空／逾時及程式副本保留。Firefox、WebKit、實體手機及完整 CI 平台矩陣尚未於本機驗證。

保留原有 20 項測試，加入備份與資料操作案例。測試以暫存資料夾或記憶體 Storage 執行，不操作日常帳戶。CI 執行 Node.js 18、20、24。

1.6.0 保留既有 60 項測試，共 89 項單元／行為測試。涵蓋四種開關組合、閒置倒數、無變更略過、衝突、備份失敗、版本競爭、提交回應遺失、有限重試、舊後端、關閉／休眠分頁、首次多分頁識別、重新啟用、防刷新循環、延後重新載入與配額復原。既有管理介面有 30 項瀏覽器檢查，另加 12 項自動模式及 7 項伺服器安全檢查。

Version 1.6.0 retains the existing 60 tests, totaling 89 unit/behavior tests, 30 management browser checks, 12 automatic-mode checks and 7 server-security checks. Added cases cover independent switches, idle cycles, no-op work, conflict/backup failures, CAS races, lost-response recovery, bounded retries, old servers, closed/frozen/pristine tabs, re-enabling, reload guards, deferred reload and quota rollback.

1.7.0 共 96 項單元／行為測試，另外驗證完整 localStorage 模式的大型值與特殊鍵、32 MiB 原子提交、重試去重、模式獨立性、完整範圍取代與內部鍵保護。隔離瀏覽器測試加入設定選單與完整模式手動同步；自動完整模式以行為測試涵蓋。安全測試加入完整 API 的登入、CSRF、帳戶隔離及版本競爭。

Version 1.7.0 has 96 unit/behavior tests, including full-mode automatic upload/download. Isolated browser checks cover the Settings menu and full-mode manual sync; security checks cover full-state authentication, CSRF, account isolation and compare-and-swap conflicts.

The original 20 tests remain, with additional backup and storage-operation coverage. Unit tests use temporary directories and in-memory Storage, not everyday account data.

## 隔離整合環境 / Disposable host

**以下腳本會修改帳戶設定、localStorage、同步檔與備份，安全測試還會建立測試帳戶。僅對全新獨立安裝執行，不得使用正式環境。**

**These scripts mutate account settings, localStorage, sync data and backups. The security script also creates a test account. Use a fresh disposable installation, never production.**

1. 在獨立目錄取得官方 SillyTavern `1.14.0`，執行 `npm ci`。不要拿不完整工作區當正式主機。
2. 將本擴充複製或 clone 至該安裝的 `public/scripts/extensions/third-party/sillytavern-device-settings-sync`；勿連結到另一個沒有主機相依套件的工作區。
3. 在隔離主機執行擴充的 `install-server-plugin.mjs .`。設定 `enableServerPlugins: true`、`port: 18765`、`listen: false`、`browserLaunch.enabled: false`。僅測試副本可關閉擴充自動更新，以免 QA 過程取得其他版本。
4. 在測試主機安裝 Playwright：`npm install --no-save --package-lock=false playwright`。需有 Edge（預設），或設定其他 Chromium channel。
5. 啟動 `node server.js`。建議使用 `enableUserAccounts: true`，並設定 `DSS_QA_HANDLE=default-user`；測試只使用隔離的無密碼 QA 管理員。

Clone the official SillyTavern 1.14.0 into a separate directory, run `npm ci`, copy/clone this extension into its global third-party extension directory, and run the installer from the host root. Enable server plugins and user accounts, use loopback port 18765, disable automatic browser launch, and install Playwright in that disposable host. Set `DSS_QA_HANDLE=default-user` for the passwordless QA administrator. Do not use a symlink whose real path lacks the host dependencies. Disable auto-update in the test copy only if needed to keep the tested revision stable.

在擴充根目錄執行，以下為 PowerShell 範例；路徑請替換為你的隔離安裝。

Run from the extension repository, replacing the example paths with your disposable installation:

```powershell
$env:DSS_QA_ALLOW_MUTATION = '1'
$env:DSS_QA_URL = 'http://127.0.0.1:18765'
$env:DSS_PLAYWRIGHT_MODULE = 'C:\path\to\qa\SillyTavern\node_modules\playwright\index.mjs'
$env:DSS_QA_OUTPUT = 'C:\path\to\qa\artifacts'
node tools/browser-smoke.mjs
node tools/auto-browser-smoke.mjs
node tools/server-smoke.mjs
$env:DSS_QA_EXTENSION = 'C:\path\to\qa\SillyTavern\public\scripts\extensions\third-party\sillytavern-device-settings-sync'
node tools/runtime-browser-smoke.mjs
```

`runtime-browser-smoke.mjs` 僅修改 `DSS_QA_EXTENSION` 指向的隔離副本，模擬更新擴充後重新整理頁面、相依程式熱切換及備份收據重試，結束時還原測試檔案。執行前請確認該路徑不是日常安裝。

`runtime-browser-smoke.mjs` changes only the disposable `DSS_QA_EXTENSION` copy to simulate an update and refresh, verify a changed dependency, and replay a backup receipt. It restores the test files afterward. Verify that the path is never a daily-use installation.

預設使用已安裝的 Edge；可透過 `DSS_BROWSER_CHANNEL=chrome` 改用 Chrome。若擴充本身能解析 `playwright`，可省略 `DSS_PLAYWRIGHT_MODULE`。截圖寫入指定資料夾（預設為已被 Git 忽略的 `qa-artifacts/`）。

The default browser channel is Edge; set `DSS_BROWSER_CHANNEL=chrome` for Chrome. The Playwright module path is optional if `playwright` resolves from the extension itself. Screenshots are stored in `DSS_QA_OUTPUT`, or the ignored `qa-artifacts/` directory.

若已啟用測試帳戶，可設定 `DSS_QA_HANDLE=default-user` 讓瀏覽器測試先登入該無密碼帳戶。With accounts enabled, set `DSS_QA_HANDLE=default-user` to sign in to that passwordless test account before browser checks.

瀏覽器檢查包含頁面載入不傳輸、取消、備份失敗、快照內容、五格並行與重試、JSON 下載、預覽與範圍取代、跨分頁衝突、刪除確認與可選備份、最舊格還原、清理不刪除、樹／方塊圖搜尋多選、手機捲動、下載前備份與三語。

Browser checks cover idle loading, cancellation, backup failure, snapshot contents, five-slot concurrency/retries, downloads, import/replace previews, cross-tab conflicts, deletion and optional backups, oldest-slot restoration, non-destructive cleanup, search/shared selection, mobile scrolling, pre-download backup and all three languages.

1.5.0 加驗三色保護與副檔名、批次清理取消／備份失敗／過期預覽／成功後快照與釋放量，以及容量實測取消和完成後資料完全不變。**容量測試會刻意暫時填滿隔離瀏覽器的 localStorage；切勿在日常帳戶執行此測試腳本。**手機驗證使用瀏覽器視窗尺寸，並非實體 Android 或 iOS 測試。

Additional browser checks cover protected categories and suffixes, batch-cleanup cancellation/failure/stale preview/success and required backup contents, plus cancelled and completed quota probes with exact storage preservation. Capacity probing intentionally fills disposable browser storage temporarily. Mobile coverage uses viewport sizes, not physical Android/iOS devices.

自動模式瀏覽器腳本另啟動 loopback 模型測試端點，驗證串流標頭與結束的區別、XHR 失敗、同源 iframe、原生生成／取消事件、原生 localStorage 通知後的短延遲增量保存、跨分頁活動鎖、獨立下載及衝突選擇。使用假模型傳輸，不消耗付費 API，也不代表已驗證實際供應商或所有擴充。此腳本要求全新隔離的 SillyTavern 主機；若該主機不存在，不要改用正式站台。

The automatic browser script starts a loopback model fixture and checks stream headers versus completion, failed XHR, same-origin frames, native generation/cancellation events, short-delay incremental saves after native localStorage notifications, cross-tab request locks, independent download and conflict choices. It uses no paid model API and does not establish compatibility with every provider or extension. Run it only against a fresh disposable SillyTavern host; never substitute a production site.

## 登入與 CSRF / Authentication and CSRF

若上方尚未啟用帳戶，先停止隔離主機，設定 `enableUserAccounts: true` 後重啟，保留全新安裝的無密碼 `default-user` 管理員。沿用上述環境變數執行：

If user accounts were not enabled above, stop the disposable server, enable them, restart, and keep its fresh passwordless `default-user` administrator. With the same environment variables:

```bash
node tools/server-smoke.mjs
```

此腳本會建立獨立 QA 帳戶，驗證未登入拒絕、不同帳戶無法讀取彼此備份、缺少／錯誤 CSRF token、無效及局部備份拒絕、32 MiB 超限拒絕且保留既有資料。完成後停止測試主機；測試帳戶只存在該隔離資料目錄。

This creates a separate QA account and verifies authentication, cross-account isolation, missing/invalid CSRF tokens, invalid/partial archives and the 32 MiB request limit without changing existing history on failure. Stop the disposable server afterward. Test accounts remain only in its isolated data directory.

1.6.0 另驗證原子提交／收據的登入與 CSRF、並行版本競爭僅一方成功、同識別碼重試、收據帳戶隔離及後段無效變更不會部分套用。Atomic-route checks additionally verify authentication/CSRF, a single winner under concurrent CAS, idempotent receipts, receipt isolation and no partial changes from invalid later mutations.
