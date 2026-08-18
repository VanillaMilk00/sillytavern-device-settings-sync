# SillyTavern 跨裝置設定同步

讓同一個 SillyTavern 帳戶在手機、桌面及其他裝置之間，手動同步擴充設定與可攜式瀏覽器設定。

## 功能

- 純手動模式：載入頁面時不下載、不上傳、不輪詢。
- 「上傳本機設定」把目前裝置視為來源，保存 SillyTavern 帳戶／擴充設定及可攜式 `localStorage`。
- 「從伺服器同步」下載可攜式設定，然後重新載入頁面以完整套用。
- 每個 SillyTavern 登入帳戶使用獨立同步檔。
- 排除聊天快取、生成歷史、圖片／Blob、除錯資料及過大的值。
- 支援自訂 `localStorage` 排除規則。

第三方擴充存於 `localStorage` 的 OAuth token、登入憑證及 API 憑證會同步。瀏覽器 HttpOnly Cookie 與 SillyTavern 登入 Cookie 無法由擴充讀取，所以新裝置仍需先登入 SillyTavern 一次。

## 安全模型

- GitHub 倉庫只包含程式碼，不包含任何使用者設定或憑證。
- 同步資料只保存在你的 SillyTavern 伺服器，路徑為登入使用者的私有資料目錄。
- 同步檔權限固定為 `0600`，但內容並未額外加密；請保護伺服器、備份與管理員帳戶。
- 所有 API 都要求有效的 SillyTavern 登入工作階段及 CSRF 驗證。
- 診斷資料不包含設定值。

## 安裝

需要 SillyTavern 1.14.0 或更新版本、Node.js 18 或更新版本，以及已啟用的 Server Plugins。

已驗證版本：

- SillyTavern 1.14.0（Node.js 18 世代）
- SillyTavern 1.18.0（Node.js 20 世代）

1.12.13 至 1.13.x 的官方原始碼雖然已具備本擴充所需 API，但尚未完成實機驗證，因此目前不列入正式支援。1.12.12 或更早版本缺少完整的工作階段期限或 CSRF 介面，不支援。

### 1. 安裝前端擴充

在 SillyTavern 開啟「擴充功能 → 安裝擴充」，貼上：

```text
https://github.com/VanillaMilk00/sillytavern-device-settings-sync
```

安裝視窗可以選擇「為自己安裝」或「為所有使用者安裝」。兩者都受支援，但檔案位置不同；Docker 使用者請使用下方的自動偵測指令。

### 2. 連結伺服器插件

先在 `config.yaml` 設定：

```yaml
enableServerPlugins: true
```

一般 Linux／macOS，在 SillyTavern 根目錄執行：

```bash
node public/scripts/extensions/third-party/sillytavern-device-settings-sync/install-server-plugin.mjs .
```

Windows PowerShell，在 SillyTavern 根目錄執行：

```powershell
node .\public\scripts\extensions\third-party\sillytavern-device-settings-sync\install-server-plugin.mjs .
```

官方 Docker 容器名稱為 `sillytavern` 時，在宿主機執行以下自動偵測指令。它同時支援「為自己安裝」的 `data/<帳號>/extensions` 路徑，以及「為所有使用者安裝」的 `public/scripts/extensions/third-party` 路徑：

```bash
docker exec sillytavern sh -lc 'set -eu; for script in /home/node/app/public/scripts/extensions/third-party/sillytavern-device-settings-sync/install-server-plugin.mjs /home/node/app/data/*/extensions/sillytavern-device-settings-sync/install-server-plugin.mjs; do if [ -f "$script" ]; then exec node "$script" /home/node/app; fi; done; echo "找不到 sillytavern-device-settings-sync；請先在擴充功能頁完成安裝" >&2; exit 1'
```

若你明確選擇了「為所有使用者安裝」，也可以使用較短的原始指令：

```bash
docker exec sillytavern node /home/node/app/public/scripts/extensions/third-party/sillytavern-device-settings-sync/install-server-plugin.mjs /home/node/app
```

完成後重啟 SillyTavern。伺服器插件採用連結，因此透過擴充管理器更新 GitHub 倉庫時，前端與伺服器端會一起更新；伺服器端程式變更後仍需重啟 SillyTavern。

如果 `plugins/device-settings-sync` 已經是一般目錄，安裝器會拒絕覆寫。請先自行備份及移走舊目錄，再重新執行安裝器。

若按同步按鈕顯示 HTTP 404，代表前端擴充已載入，但 server plugin 尚未掛載。請檢查安裝指令是否輸出 `Linked server plugin` 或 `Server plugin link is already correct`，重啟容器後再試；不要忽略 `Cannot find module` 或「找不到擴充」錯誤。

## 使用

1. 在第一台裝置登入 SillyTavern，調整好設定後按「上傳本機設定」。
2. 在其他裝置登入同一帳戶，按「從伺服器同步」。
3. 頁面會重新載入一次，完成套用。

上傳是完整的手動來源切換：遠端存在、但來源裝置已刪除的可攜式設定也會被刪除。請先確認目前裝置的設定正確，再按上傳。

## 開發與測試

```bash
npm test
npm run check
```

## 授權

[MIT](LICENSE)
