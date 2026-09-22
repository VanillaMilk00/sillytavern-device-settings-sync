# 驗證方式 / Integration testing

## 純模組測試 / Unit and behavior tests

```bash
npm test
npm run check
```

保留原有 20 項測試，加入備份與資料操作案例。測試以暫存資料夾或記憶體 Storage 執行，不操作日常帳戶。CI 執行 Node.js 18、20、24。

1.5.0 共 59 項單元測試，包括保護規則優先、三色分類、型態與副檔名提示、容量區間／安全界線、暫存鍵碰撞、跨分頁修改及移除失敗。隔離瀏覽器有 30 項檢查，另有 4 項伺服器安全檢查。

Version 1.5.0 has 59 unit tests, 30 browser checks and 4 server-security checks. Added unit coverage includes protection-first classification, extension/type hints, quota bounds, temporary-key collisions, concurrent changes and cleanup failures.

The original 20 tests remain, with additional backup and storage-operation coverage. Unit tests use temporary directories and in-memory Storage, not everyday account data.

## 隔離整合環境 / Disposable host

**以下腳本會修改帳戶設定、localStorage、同步檔與備份，安全測試還會建立測試帳戶。僅對全新獨立安裝執行，不得使用正式環境。**

**These scripts mutate account settings, localStorage, sync data and backups. The security script also creates a test account. Use a fresh disposable installation, never production.**

1. 在獨立目錄取得官方 SillyTavern `1.14.0`，執行 `npm ci`。不要拿不完整工作區當正式主機。
2. 將本擴充複製或 clone 至該安裝的 `public/scripts/extensions/third-party/sillytavern-device-settings-sync`；勿連結到另一個沒有主機相依套件的工作區。
3. 在隔離主機執行擴充的 `install-server-plugin.mjs .`。設定 `enableServerPlugins: true`、`port: 18765`、`listen: false`、`browserLaunch.enabled: false`。僅測試副本可關閉擴充自動更新，以免 QA 過程取得其他版本。
4. 在測試主機安裝 Playwright：`npm install --no-save --package-lock=false playwright`。需有 Edge（預設），或設定其他 Chromium channel。
5. 啟動 `node server.js`。瀏覽器測試先保持 `enableUserAccounts: false`。

Clone the official SillyTavern 1.14.0 into a separate directory, run `npm ci`, copy/clone this extension into its global third-party extension directory, and run the installer from the host root. Enable server plugins, use loopback port 18765, disable automatic browser launch, and install Playwright in that disposable host. Do not use a symlink whose real path lacks the host dependencies. Start with user accounts disabled for the browser suite. Disable auto-update in the test copy only if needed to keep the tested revision stable.

在擴充根目錄執行，以下為 PowerShell 範例；路徑請替換為你的隔離安裝。

Run from the extension repository, replacing the example paths with your disposable installation:

```powershell
$env:DSS_QA_ALLOW_MUTATION = '1'
$env:DSS_QA_URL = 'http://127.0.0.1:18765'
$env:DSS_PLAYWRIGHT_MODULE = 'C:\path\to\qa\SillyTavern\node_modules\playwright\index.mjs'
$env:DSS_QA_OUTPUT = 'C:\path\to\qa\artifacts'
node tools/browser-smoke.mjs
```

預設使用已安裝的 Edge；可透過 `DSS_BROWSER_CHANNEL=chrome` 改用 Chrome。若擴充本身能解析 `playwright`，可省略 `DSS_PLAYWRIGHT_MODULE`。截圖寫入指定資料夾（預設為已被 Git 忽略的 `qa-artifacts/`）。

The default browser channel is Edge; set `DSS_BROWSER_CHANNEL=chrome` for Chrome. The Playwright module path is optional if `playwright` resolves from the extension itself. Screenshots are stored in `DSS_QA_OUTPUT`, or the ignored `qa-artifacts/` directory.

若已啟用測試帳戶，可設定 `DSS_QA_HANDLE=default-user` 讓瀏覽器測試先登入該無密碼帳戶。With accounts enabled, set `DSS_QA_HANDLE=default-user` to sign in to that passwordless test account before browser checks.

瀏覽器檢查包含頁面載入不傳輸、取消、備份失敗、快照內容、五格並行與重試、JSON 下載、預覽與範圍取代、跨分頁衝突、刪除確認與可選備份、最舊格還原、清理不刪除、樹／方塊圖搜尋多選、手機捲動、下載前備份與三語。

Browser checks cover idle loading, cancellation, backup failure, snapshot contents, five-slot concurrency/retries, downloads, import/replace previews, cross-tab conflicts, deletion and optional backups, oldest-slot restoration, non-destructive cleanup, search/shared selection, mobile scrolling, pre-download backup and all three languages.

1.5.0 加驗三色保護與副檔名、批次清理取消／備份失敗／過期預覽／成功後快照與釋放量，以及容量實測取消和完成後資料完全不變。**容量測試會刻意暫時填滿隔離瀏覽器的 localStorage；切勿在日常帳戶執行此測試腳本。**手機驗證使用瀏覽器視窗尺寸，並非實體 Android 或 iOS 測試。

Additional browser checks cover protected categories and suffixes, batch-cleanup cancellation/failure/stale preview/success and required backup contents, plus cancelled and completed quota probes with exact storage preservation. Capacity probing intentionally fills disposable browser storage temporarily. Mobile coverage uses viewport sizes, not physical Android/iOS devices.

## 登入與 CSRF / Authentication and CSRF

停止隔離主機，設定 `enableUserAccounts: true` 後重啟，保留全新安裝的無密碼 `default-user` 管理員。沿用上述環境變數執行：

Stop the disposable server, enable user accounts, restart, and keep its fresh passwordless `default-user` administrator. With the same environment variables:

```bash
node tools/server-smoke.mjs
```

此腳本會建立獨立 QA 帳戶，驗證未登入拒絕、不同帳戶無法讀取彼此備份、缺少／錯誤 CSRF token、無效及局部備份拒絕、32 MiB 超限拒絕且保留既有資料。完成後停止測試主機；測試帳戶只存在該隔離資料目錄。

This creates a separate QA account and verifies authentication, cross-account isolation, missing/invalid CSRF tokens, invalid/partial archives and the 32 MiB request limit without changing existing history on failure. Stop the disposable server afterward. Test accounts remain only in its isolated data directory.
