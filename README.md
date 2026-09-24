# SillyTavern 跨裝置設定同步

[繁體中文](README.md) · [简体中文](README.zh-CN.md) · [English](README.en.md)

讓同一個 SillyTavern 帳戶在手機、桌面及其他裝置之間，手動同步設定，並可選擇自動同步可攜式瀏覽器設定。

目前版本：**1.9.0**。IndexedDB 只納入手動同步中明確選取的項目，不會隨 localStorage 自動同步。要使用新版「只傳輸所選範圍」，請更新伺服器插件至 1.9.0 並重啟 SillyTavern；前端更新後重新整理瀏覽器即可。

## 功能

- 預設純手動模式：兩個自動開關皆關閉時，載入頁面不下載、不上傳、不輪詢。
- 自動上傳、自動下載分別開啟；15 分鐘模型請求閒置上傳，以及進入頁面時的下載檢查互不綁定。
- 「本機 → 伺服器：localStorage」把目前裝置視為來源，保存 SillyTavern 帳戶／擴充設定及選定範圍的 `localStorage`。
- 「伺服器 → 本機：localStorage」取得伺服器上對應範圍的資料，然後重新載入頁面以完整套用。
- 執行上傳或下載前會顯示確認視窗，避免誤觸造成設定被覆蓋。
- 每個 SillyTavern 登入帳戶使用獨立同步檔。
- 排除聊天快取、生成歷史、圖片／Blob、除錯資料及過大的值。
- 支援自訂 `localStorage` 排除規則。
- 介面支援繁體中文、簡體中文及英文。
- 五個帳戶共用備份插槽：每次確認上傳／下載後，先保存本機完整 `localStorage`。
- WizTree 風格的樹狀清單與容量方塊圖，支援搜尋、多選、容量排序及局部匯入／匯出／移除。
- 顯示完整用量估算、選取容量與清理建議；不自動刪除資料。
- localStorage 可選一般、全部或只同步選取的鍵／資料夾；明確選取的快取、歷史及大型值也會同步。
- 可選啟用 IndexedDB 同步，並在資料庫、物件儲存區及紀錄層級管理、匯入、匯出與移除。

第三方擴充存於 `localStorage` 的 OAuth token、登入憑證及 API 憑證會同步。瀏覽器 HttpOnly Cookie 與 SillyTavern 登入 Cookie 無法由擴充讀取，所以新裝置仍需先登入 SillyTavern 一次。

## 設定選單與完整 localStorage 同步

在擴充面板按「設定」，可調整自動上傳、自動下載、匯入／還原／移除前備份、額外排除鍵及 localStorage 同步範圍。範圍設定依網站、帳戶與裝置保存在本機，不會傳到其他裝置。

- **僅一般設定**（預設）：沿用既有快取、歷史、大型值、憑證及自訂排除規則。
- **只同步選取項目**：先開啟「管理 localStorage」，勾選鍵或資料夾並按「使用選取項目作為同步範圍」。選中的快取、歷史及大型值會納入；同步器內部鍵永遠排除。下載只影響該範圍。
- **同步全部 localStorage**：同步所有非內部鍵，包含快取、歷史、草稿、大型值及可能的憑證。

選取範圍與完整模式使用獨立帳戶同步檔，大小上限為 32 MiB JSON。手動與自動上傳／下載均沿用此範圍；不會在未選取時把完整 localStorage 靜默納入。

完整模式同時作用於手動和自動上傳／下載。它包含快取、歷史、草稿、大型值與可能的憑證；同步器內部鍵（包括裝置識別碼及排程）仍留在本機。完整模式與一般模式使用不同的帳戶私有伺服器同步檔，不會在切換時悄悄以其中一份覆蓋另一份；首次資料不同時，自動操作會詢問來源。完整同步檔上限 32 MiB JSON，超限拒絕且保留既有伺服器資料。真正套用前仍會先建立完整本機救援備份；下載會以完整快照取代本機非內部鍵，失敗時嘗試復原。

完整模式只涵蓋 **localStorage**，不包含 IndexedDB、Cookie 或其他瀏覽器儲存區。不同裝置的 localStorage 配額可能不同，完整資料在來源裝置可用，也可能無法寫入容量較小的目標裝置。額外排除規則與一般同步的單鍵上限只適用於一般模式。

## IndexedDB 同步與管理（可選）

在「設定」啟用 IndexedDB 手動同步並選好範圍後，兩個方向按鈕會加上「＋已選 IndexedDB」，一併處理你選取的項目。IndexedDB 不會隨自動上傳或下載執行；設定只保存在目前網站／帳戶／裝置。

- 在「管理 IndexedDB」逐項選取資料庫、物件儲存區或個別紀錄，再按「使用選取項目作為同步範圍」；設定中不再提供全同源資料庫同步模式。伺服器先依此範圍篩選再分塊傳輸，未選取的遠端資料不會下載到裝置。管理視窗也提供單獨匯入、匯出和移除。
- 同步下載與伺服器上傳皆採合併：相同主鍵的紀錄以來源值更新，伺服器及本機的額外紀錄保留；同步本身不會刪除紀錄。刪除僅在本機管理視窗明確操作。
- IndexedDB 有獨立的五格帳戶救援備份。每份傳輸／備份 JSON 上限 128 MiB，使用 1 MiB 分塊及完整性雜湊；瀏覽器必須支援 `indexedDB.databases()` 才能安全列出既有資料庫。
- 會保留常見結構化資料型別、循環參照、Blob／File 與二進位值。無法安全序列化的值、資料庫結構衝突、鎖定或配額錯誤會明確停止，不會靜默略過。
- 同步前保存選取範圍的本機 IndexedDB 救援快照；伺服器資料版本競爭會中止並提示重試。不同資料庫／物件儲存區的 IndexedDB 交易無法形成單一跨庫原子交易；若發生部分失敗，請使用 IndexedDB 五格備份還原。

瀏覽器提供的 `navigator.storage.estimate()` 是整個來源的估算，並非 IndexedDB 專屬容量或保證上限。同步器不會嘗試清空或自行判定資料可刪除。

## 自動上傳與下載（可分別啟用）

在擴充面板分別勾選「啟用自動上傳」「啟用自動下載同步」，啟用時需確認。預設皆關閉，偏好依網站、登入帳戶及瀏覽器裝置保存，不跟隨一般同步傳到其他裝置。停用取消尚未送出的工作；已送出的請求可能完成。

- **僅上傳**：最後一個已觀測的模型請求成功、失敗或取消後，連續 15 分鐘沒有新活動才嘗試上傳，每輪最多成功一次。沒有可攜式資料變更就略過，不占備份槽。單純修改設定不啟動倒數。
- **僅下載**：開啟新頁面／手動重新整理時檢查；切回分頁不觸發下載。只有伺服器變更才自動套用，本機單獨變更會保留。真正套用後自動重新載入，以一次性標記避免循環。
- **兩者皆開**：各自運作，但共用跨分頁操作鎖。API 活動中或管理視窗開啟時延後執行。
- **衝突**：首次無基準且資料不同、雙方皆有變更，或上傳前遠端版本改變時，詢問「保留本機並上傳」「使用伺服器資料」「稍後處理」。前兩者只授權當次動作，不啟用另一開關；稍後處理會暫停自動寫入。

自動模式依設定處理一般或完整 localStorage，不再次保存整份酒館帳戶／擴充設定，不改變原生保存或手動同步行為。每次真正寫入前，強制保存完整 localStorage 救援備份（可能包含憑證），不受管理視窗的可選備份開關影響。備份失敗或核對失敗即停止；下載寫入失敗會嘗試復原。上傳即使未開下載，也必須讀取遠端版本，但不會因此套用遠端資料。

已知模型端點的 fetch／XHR、原生生成事件及可存取的同源 iframe 會參與活動計數，涵蓋生成、Responses、Embedding／Rerank。串流等待傳輸完成，不以回應標頭當結束，不複製或消耗回應串流。不檢視提示詞、回應內容、憑證或查詢參數；只保留必要的請求生命週期中繼資料。無法確認結束的請求會阻擋自動上傳，不逕自當作閒置。

跨來源 iframe、Worker、未知傳輸或未在觀測啟用後發出的請求無法完整觀測；擴充可透過主頁的生命週期橋接介面回報（不傳提示詞或回應）：

```js
const activity = globalThis.DeviceSettingsSync.beginModelActivity();
try {
    await yourModelRequest(); // 必須等到串流結束／取消，而不是只等標頭
} finally {
    globalThis.DeviceSettingsSync.endModelActivity(activity);
}
```

自動功能需要 HTTPS／localhost、安全內容、Web Locks、Web Crypto 與 Resource Timing；缺少可靠協調能力時不可啟用，手動功能仍可使用。關閉瀏覽器不保證準時上傳，也不在離開頁面時強行傳輸；返回後核對待辦與時間。關閉的分頁留下未結束活動時，保守重新等待 15 分鐘；仍存活但休眠的分頁會繼續阻擋。暫時網路失敗最多在 1、5、15 分鐘後重試，永久錯誤／衝突暫停，面板提供暫停及重試。

偏好、基準、提交收據索引與排程為內部資料：一般同步排除，完整備份包含，還原預設跳過。管理操作仍只直接修改本機；若有待辦自動上傳，之後的活動輪次可能將這些變更上傳。

## 介面語言

擴充會跟隨 SillyTavern 目前選擇的介面語言，完整支援：

- 繁體中文（`zh-TW`）
- 簡體中文（`zh-CN`）
- English（英文及其他未提供翻譯的語系會使用英文作為預設回退）

切換 SillyTavern 的介面語言並重新載入頁面後，設定面板、確認視窗、同步狀態、通知及主要錯誤訊息會一併切換。

## 安全模型

- GitHub 倉庫只包含程式碼，不包含任何使用者設定或憑證。
- 同步資料只保存在你的 SillyTavern 伺服器，路徑為登入使用者的私有資料目錄。
- 同步檔及備份檔設定 `0600` 權限（Windows 仍依檔案 ACL），但內容並未額外加密；請保護伺服器、下載檔與管理員帳戶。
- 所有 API 都要求有效的 SillyTavern 登入工作階段及 CSRF 驗證。
- 診斷資料不包含設定值。

## 安裝

需要 SillyTavern 1.14.0 或更新版本、Node.js 18 或更新版本，以及已啟用的 Server Plugins。

1.6.0 已在獨立的 SillyTavern 1.14.0 安裝、Node.js 22 與 Edge Chromium 驗證前後端整合、桌面／手機尺寸及三語介面；模型傳輸使用本機測試伺服器，未呼叫付費模型。既有同步功能曾驗證 SillyTavern 1.18.0；本次不宣稱所有模型擴充、酒館版本或實體手機均已驗證。CI 保留 Node.js 18、20、24 測試矩陣。

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

#### Android（Termux）

如果 SillyTavern 是在 Android 手機的 **Termux** 內執行，請在 Termux 終端機輸入以下指令，**不要使用 Docker 或 PowerShell 指令，也不是在瀏覽器主控台執行**。先確認 `config.yaml` 已設定 `enableServerPlugins: true`；若酒館正在同一個終端機執行，可先按 `Ctrl+C` 停止。

以下假設酒館位於 `~/SillyTavern`；若你使用啟動器或其他安裝路徑，請改成實際的 SillyTavern 根目錄（內有 `config.yaml`、`start.sh` 與 `src/users.js`）。依前端擴充的安裝方式，**選一組**執行：

「為所有使用者安裝」：

```bash
cd ~/SillyTavern && node public/scripts/extensions/third-party/sillytavern-device-settings-sync/install-server-plugin.mjs .
```

「為自己安裝」，使用預設帳戶 `default-user`：

```bash
cd ~/SillyTavern && node data/default-user/extensions/sillytavern-device-settings-sync/install-server-plugin.mjs .
```

其他帳戶請把 `default-user` 換成實際帳戶資料夾名稱；若修改過 `dataRoot`，也要調整 `data/` 路徑。若提示找不到安裝腳本，先核對擴充是全域安裝還是帳戶專屬安裝，不要重新刪除安裝。

看到 `Linked server plugin` 或 `Server plugin link is already correct` 後，在酒館根目錄重新啟動：

```bash
bash start.sh
```

Termux 的酒館目錄與啟動方式可參考 [SillyTavern 官方 Android 說明](https://docs.sillytavern.app/installation/android-%28termux%29/)。如果手機只是用瀏覽器連到電腦／雲端酒館，**手機不需要執行安裝指令**；請在實際執行 SillyTavern 的伺服器安裝插件並重啟。

#### Docker

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

若按同步按鈕顯示 HTTP 404，代表前端擴充已載入，但 server plugin 尚未掛載。請檢查安裝指令是否輸出 `Linked server plugin` 或 `Server plugin link is already correct`，然後重新啟動 SillyTavern 伺服器；不要忽略 `Cannot find module` 或「找不到擴充」錯誤。

若出現 `Directory already exists at public/scripts/extensions/third-party/sillytavern-device-settings-sync`，代表已安裝前端擴充，請在擴充管理器選擇**更新**，不要重複安裝或直接刪除既有目錄。更新至 1.9.0 後重新啟動伺服器插件。

## 使用

1. 在第一台裝置登入 SillyTavern，調整好設定後按「本機 → 伺服器：localStorage」。
2. 在其他裝置登入同一帳戶，按「伺服器 → 本機：localStorage」。
3. 頁面會重新載入一次，完成套用。

上傳是完整的手動來源切換：遠端存在、但來源裝置已刪除的可攜式設定也會被刪除。請先確認目前裝置的設定正確，再按上傳。

## 五格完整備份

- 上傳與下載都在確認後、資料變更前保存完整本機快照。取消不備份；備份失敗會中止同步；後續同步失敗仍保留救援快照。
- 同一登入帳戶共用五格，最新為第 1 格。第六份寫入成功才淘汰最舊一份，並以帳戶內序列化與原子替換避免多裝置競爭破壞紀錄。網路重試沿用操作識別碼；即使原備份已淘汰，也不重複占格。
- 在「管理 localStorage → localStorage 備份」才載入列表。每格顯示時間、裝置、原因、鍵數、估算容量與 JSON 大小，提供瀏覽、匯出與還原。
- 「匯入、還原或移除本機資料前也自動備份」預設開啟，這些操作必須先成功備份才能執行。保留已儲存的開關選擇；舊版已儲存為關閉者，請在管理視窗手動勾選。
- 檔案位於登入帳戶私有資料目錄的 `device-settings-sync-backups/`，與 `device-settings-sync.json` 一般同步檔分開。
- 索引保留不含設定值的操作識別碼、備份 ID 與摘要雜湊，用於跨重啟及淘汰後的重試去重；快照內容仍只保留五份。

**localStorage 備份只涵蓋 localStorage**，不是整個 SillyTavern 備份：不含帳戶設定檔、伺服器聊天檔、角色、Cookie、sessionStorage 或 IndexedDB。完整快照不套用一般同步排除規則，因此會包含 localStorage 內的快取、歷史、大型值與憑證。IndexedDB 使用另一套獨立五格備份；一般 localStorage 跨裝置同步仍沿用原本排除規則。

## 管理、匯入與匯出

1. 開啟「管理 localStorage」。樹狀清單和容量方塊圖共用選取狀態；桌面並排、手機上下排列並可捲動。
2. 鍵名按 `:`、`/`、`.` 分層；沒有這些分隔符才使用第一個 `_` 前綴分組。連字號保留。資料夾只是原始前綴的虛擬分組，一個完整鍵就是一個檔案，不拆解值中的 JSON。
3. 可完整匯出，或選取資料夾、單鍵、多個項目後匯出／移除。單鍵永遠使用完整原鍵，不會改名。清理建議可定位至樹狀項目。
4. 「匯入檔案」會先顯示可勾選的樹與新增／覆蓋／刪除預覽。若主清單有選取，匯入限於該範圍；沒有選取則使用檔案宣告範圍。還原使用相同預覽流程。
5. 預設「合併」保留其他鍵。「取代指定範圍」只刪除範圍內、檔案未包含的鍵。取消勾選的傳入鍵保持原狀；選取單鍵不會獲得整個資料夾的刪除權限。局部檔案不能清空其他範圍。
6. 同步器內部鍵可見且納入匯出／備份，修改時預設略過。只有明確勾選「包含同步器內部鍵」才會複製或移除裝置識別資料。

匯入、還原、移除共用操作鎖，套用前核對 localStorage 是否與預覽一致；其他分頁改動時要求重新掃描。寫入失敗會嘗試復原此次已修改的鍵，並區分復原成功／失敗。完成後可按「重新載入以套用」；一般伺服器下載仍自動重新載入。這些管理操作只改本機，要變更一般伺服器同步資料仍需手動上傳。

### 檔案格式與限制

備份、匯入、匯出採相同 JSON 格式，保留原始字串而非解析值內容：

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

`scope` 可為 `{"kind":"full"}`、`{"kind":"prefix","prefix":"extension:"}` 或 `{"kind":"keys","keys":["extension:theme"]}`。也接受全部值為字串的普通 JSON 物件，例如 `{"extension:theme":"dark"}`；這類檔案只授權該組完整鍵，不視為完整快照。

JSON 檔案／備份請求上限為 **32 MiB**，超限拒絕且不修改既有資料。完整快照不受一般同步單鍵大小限制，但匯入仍可能遇到瀏覽器自身儲存空間不足。請只匯入可信檔案，並保護可能含有憑證的下載檔。

### 容量與清理建議

用量估算為所有 `(鍵.length + 值.length) × 2`，包含同步排除項目；JSON 匯出位元組大小另計。此估算依據 [MDN 的 UTF-16 儲存格式說明](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage)，不是瀏覽器配額，也不以網站總配額推測 localStorage 上限。

清理分析完全在本機進行，列出最大的十項與鍵名疑似快取／暫存／除錯／記錄的候選項目。歷史、草稿、聊天、憑證及同步器內部資料需人工判斷；被同步排除不代表可以安全刪除。不推測最後使用時間，也不自動清理。

### 一鍵分析、容量上限與副檔名（1.5.0）

- 「localStorage 清理 → 立即分析」會掃描全部鍵，依容量排序並標示最大的十項。綠色是疑似快取／暫存／除錯／記錄，黃色需人工判斷，紅色為批次清理保護項目。分類只依鍵名，不是 AI，也不能證明資料已無用途。
- 保護規則優先：憑證、歷史、草稿、聊天、設定與同步器內部鍵，不會因名稱同時含有 `cache` 而成為推薦項目。`tt:` 命名空間需人工判斷。紅色項目不能在批次清理選取；確定需要處理時，請使用「localStorage 資料」的一般移除功能。
- 預設不勾選任何項目。「選取推薦項目」只選綠色，黃色可自行勾選；按「備份並清理」後，確認清單、鍵數及容量，**強制先建立完整伺服器備份**，即使一般操作的自動備份開關關閉也一樣。取消、備份失敗或預覽過期均不刪除；寫入失敗沿用復原機制。完成後顯示清理前後用量與釋放量，且只修改本機。
- 容量區顯示 **5 MiB 參考上限**，並非目前裝置的實測值；不同環境的限制及計量可能不同。瀏覽器未提供直接查詢 localStorage 上限的標準 API，網站整體配額也不能替代。[MDN 儲存配額說明](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- 可自行確認執行「實測容量」：只新增一個暫存鍵，逐步測試並在結束時移除，顯示 UTF-16 計量的估算範圍及測試時間。測試值最多 16 MiB；到達安全界線仍未滿時，只顯示下限，不宣稱已測得最大值。**測試可能短暫卡住頁面或使其他分頁寫入失敗，請先匯出重要資料並暫停其他操作。**不會自動測試、清空儲存空間或覆寫既有鍵；偵測到其他資料變更即中止，暫存鍵無法安全移除時會明確提示。結果只供當次參考。
- 樹狀清單新增「副檔名／值類型」欄：已知副檔名取自原鍵；沒有時依內容顯示推測的 `.json` 或 `.txt`，並標示推測。可辨識 JSON 物件／陣列、一般文字、Data URI 與 Blob URL；超過 1 Mi 字元的值不解析 JSON。這只是顯示提示，**不改鍵名**，所有匯出仍是原始字串鍵值的 JSON 封裝檔。

### 備份 API

前綴：`/api/plugins/device-settings-sync`，沿用 SillyTavern 登入工作階段及 CSRF 防護。

- `GET /backups`：最多五份摘要，不含設定值。
- `POST /backups`：`{ operationId, reason, archive }`；`reason` 為 `upload`、`download`、`import`、`restore` 或 `delete`。
- `GET /backups/:id`：僅讀取目前帳戶保留中的指定快照。
- `GET /health`：能力標記包含 `backups-v1`、`atomic-sync-v1`、`full-storage-v1`、`indexeddb-sync-v1`、`indexeddb-chunks-v1`、`indexeddb-scoped-download-v1`；舊後端缺少所需能力時停止相關功能並提示更新／重啟。
- `POST /commit`：`{ operationId, expectedRevision, deviceId, mutations }`，全部驗證後原子提交；版本競爭或識別碼內容不一致回傳 HTTP 409，同識別碼重試不重複套用。
- `GET /commits/:id`：讀取本帳戶提交收據，用於恢復遺失回應。收據與資料一同寫入，計入既有 5 MiB 同步檔上限；單值限制與手動 API 相容性不變。
- `GET /full-state`、`POST /full-commit`、`GET /full-commits/:id`：完整模式的獨立快照、原子版本提交及重試收據；最多 32 MiB JSON，與一般同步及五格救援備份分開。
- `POST /indexeddb/transfers/start`、`PUT /indexeddb/transfers/:id/chunks/:index`、`POST /indexeddb/transfers/:id/finish`：分塊上傳及原子合併提交，最多 128 MiB，帳戶內版本控制並以操作識別碼去重。
- `POST /indexeddb/state/scoped`、`GET /indexeddb/state/scoped/:id/chunks/:index`、`DELETE /indexeddb/state/scoped/:id`：依明確選取範圍建立暫存快照並分塊下載，傳輸後刪除暫存；未選取的伺服器資料不傳至裝置。
- `GET /indexeddb/state` 與 `/indexeddb/state/chunks/:index`：讀取帳戶伺服器快照及分塊。
- `GET /indexeddb/backups`、`GET /indexeddb/backups/:id`、`GET /indexeddb/backups/:id/chunks/:index`：讀取 IndexedDB 專用五格救援備份摘要與封存內容；與 localStorage 備份槽分開。

## 開發與測試

```bash
npm test
npm run check
```

單元／行為測試涵蓋五格輪替、並行與重試、帳戶隔離、寫入失敗、最舊插槽還原、Unicode、大型值、取代邊界、配額復原、過期預覽、樹狀容量與三語完整性。

隔離環境的瀏覽器與登入／CSRF 整合測試方法見 [TESTING.md](TESTING.md)。測試腳本會修改測試帳戶與 localStorage，**不得指向日常使用的安裝**。不完整的專案工作區只能跑純模組測試，不能宣稱已驗證實際 SillyTavern 整合。

## 授權

[MIT](LICENSE)
