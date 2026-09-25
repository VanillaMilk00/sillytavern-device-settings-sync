# Changelog

## 1.10.0 - 2026-09-25

### 繁體中文

- 自動上傳改為由 localStorage 原生變更通知觸發；同鍵連續變更合併，只讀取及傳送有變更的鍵，不再依賴模型請求後 15 分鐘倒數或定時掃描。
- 新增瀏覽器私有 IndexedDB 佇列、原子增量提交、大型值差分與關頁後盡力續傳；只有伺服器確認才顯示保存完成。背景同步不保證所有瀏覽器都能完成，必要時會在原瀏覽器下次開啟後續傳。
- 新增伺服器端最多五份 localStorage 版本；相同裝置與範圍 30 分鐘內合併，管理視窗可瀏覽、匯出及還原。
- 新增增量同步能力。請更新伺服器插件至 1.10.0 並重啟 SillyTavern；舊版自動上傳會關閉，需重新確認才能啟用新行為。

### 简体中文

- 自动上传改由 localStorage 原生变更通知触发；同一键的连续变化会合并，只读取和发送有变化的键，不再依赖模型请求后 15 分钟倒计时或定时扫描。
- 新增浏览器私有 IndexedDB 队列、原子增量提交、大型值差分和关页后尽力续传；只有服务器确认后才显示保存完成。后台同步不保证所有浏览器都能完成，必要时会在原浏览器下次打开后续传。
- 新增服务器端最多五份 localStorage 版本；同一设备和范围在 30 分钟内合并，管理窗口可浏览、导出和还原。
- 新增增量同步能力。请将服务器插件更新至 1.10.0 并重启 SillyTavern；旧版自动上传会关闭，需重新确认才能启用新行为。

### English

- Automatic uploads now react to native localStorage change notifications. Repeated edits to a key are coalesced, and only changed keys are read and sent; the former 15-minute model-idle timer and periodic scans are removed.
- Add a private browser IndexedDB queue, atomic incremental commits, large-value deltas and best-effort continuation after closing a page. A save is reported only after server confirmation. Background Sync is not guaranteed in every browser; the original browser may need to be reopened to resume.
- Add up to five server-side localStorage versions, grouped for 30 minutes by device and scope, with browse, export and restore controls.
- Add the incremental-sync server capability. Update the server plugin to 1.10.0 and restart SillyTavern. Existing automatic-upload consent is disarmed and must be confirmed again for the new behavior.

## 1.9.0 - 2026-09-25

### 繁體中文

- IndexedDB 只會在手動上傳／下載時處理明確選取的資料庫、儲存區或紀錄；localStorage 自動同步不再讀取或上傳 IndexedDB。
- 移除全同源資料庫同步模式。舊版若啟用了該模式，升級後會自動關閉並要求重新選取範圍。
- 同步前只掃描及備份選取範圍；選取單筆紀錄時直接讀取該鍵，避免載入同庫其他紀錄。
- 新增伺服器端所選範圍分塊下載；未選取的 IndexedDB 遠端資料不再傳至裝置。伺服器插件版本升至 1.9.0，需更新並重啟才能使用 IndexedDB 同步。

### 简体中文

- IndexedDB 只在手动上传／下载时处理明确选中的数据库、存储区或记录；localStorage 自动同步不再读取或上传 IndexedDB。
- 移除全同源数据库同步模式。旧版若启用了该模式，升级后会自动关闭并要求重新选择范围。
- 同步前只扫描并备份选中范围；选择单条记录时直接读取该键，避免加载同一数据库中的其他记录。
- 新增服务器端所选范围分块下载；未选中的 IndexedDB 远端数据不会传到设备。服务器插件升至 1.9.0，需更新并重启后才能使用 IndexedDB 同步。

### English

- IndexedDB now runs only during manual upload/download for explicitly selected databases, stores or records. Automatic localStorage sync no longer reads or uploads IndexedDB.
- Remove the all-same-origin sync mode. Upgrades disable that legacy setting and ask the user to select a new scope.
- Snapshot and rescue only the selected scope before sync. Selecting an individual record reads that key instead of loading other records from its database.
- Add server-side scoped chunk downloads so unselected remote IndexedDB data is not sent to the device. The server plugin is now 1.9.0 and must be updated and restarted for IndexedDB sync.

## 1.8.3 - 2026-09-25

### 繁體中文

- 未讀取的 IndexedDB 容量不再顯示為 0 B，改為明確標示尚未估算。
- 新增按需掃描全部儲存區的 JSON 容量與紀錄數；維持管理器開啟時的快速延遲載入。純前端更新，無須重啟伺服器插件。

### 简体中文

- 未读取的 IndexedDB 容量不再显示为 0 B，改为明确标示尚未估算。
- 新增按需扫描全部存储区的 JSON 容量和记录数；管理器仍快速延迟加载。本次仅更新前端，无需重启服务器插件。

### English

- Unread IndexedDB sizes are now labeled as not estimated instead of 0 B.
- Add an on-demand scan for estimated JSON sizes and record counts across all stores while keeping the manager fast to open. Frontend-only update; no server-plugin restart is needed.

## 1.8.2 - 2026-09-24

### 繁體中文

- IndexedDB 管理器改為先讀取資料庫／儲存區目錄，展開時才分頁載入紀錄；每頁最多 100 筆，避免每次開啟都讀取所有資料。
- 改以清楚的「資料庫 → 物件儲存區 → 紀錄檔案」樹狀介面瀏覽。此版本只更新前端，既有伺服器插件無須重啟。

### 简体中文

- IndexedDB 管理器改为先读取数据库／存储区目录，展开后才分页加载记录；每页最多 100 条，避免每次打开都读取全部数据。
- 改为清晰的“数据库 → 对象存储区 → 记录文件”树状界面。本版本仅更新前端，现有服务器插件无需重启。

### English

- Make the IndexedDB manager read only database/store metadata initially, then load records on expansion in pages of 100 instead of scanning every database on each open.
- Show a clear database → object store → record-file tree. This release changes only the frontend; an already-current server plugin does not need a restart.

## 1.8.1 - 2026-09-24

### 繁體中文

- 修正大型 IndexedDB 資料庫在檔案管理器因整份 JSON 字串超出瀏覽器限制而顯示 `Invalid string length`；容量改為逐項估算，超過 128 MiB 的傳輸會提早顯示容量錯誤。
- 更新版本資訊。伺服器端出現 HTTP 404 時，仍須安裝／更新伺服器插件並重啟 SillyTavern。

### 简体中文

- 修复大型 IndexedDB 数据库在文件管理器中因整份 JSON 字符串超出浏览器限制而显示 `Invalid string length`；容量改为逐项估算，超过 128 MiB 的传输会提前显示容量错误。
- 更新版本信息。服务器端出现 HTTP 404 时，仍需安装／更新服务器插件并重启 SillyTavern。

### English

- Fix `Invalid string length` in the IndexedDB file manager for large databases by estimating JSON size without constructing one combined string; transfers over 128 MiB are rejected early with a clear size error.
- Update version metadata. HTTP 404 still requires installing/updating the server plugin and restarting SillyTavern.

## 1.8.0 - 2026-09-24

### 繁體中文

- localStorage 同步範圍新增「一般／全部／只同步選取項目」；選取模式的快取、歷史及大型值會同步，擴充內部鍵仍受保護。
- 新增 IndexedDB 樹狀管理、範圍選取、匯入／匯出／移除，以及手動與既有自動上傳／下載整合；下載採合併並保留本機額外紀錄。
- IndexedDB 檔案匯入可勾選資料庫、物件儲存區或單筆紀錄，顯示新增／覆蓋預覽並檢查預覽後的本機變更；範圍外結構不會被套用。
- IndexedDB 使用獨立帳戶五格救援備份與 128 MiB、1 MiB 分塊傳輸；加入結構衝突、版本競爭與完整性保護。
- 更新繁中、簡中、英文 README 及伺服器插件能力標記。升級後必須重啟 SillyTavern 伺服器插件。

### 简体中文

- localStorage 同步范围新增“普通／全部／仅同步选中项”；选中模式会同步明确选择的缓存、历史和大型值，扩展内部键仍受保护。
- 新增 IndexedDB 树状管理、范围选择、导入／导出／移除，并接入手动及现有自动上传／下载；下载采用合并并保留本地额外记录。
- IndexedDB 文件导入可勾选数据库、对象存储区或单条记录，显示新增／覆盖预览并检查预览后的本地变化；范围外结构不会被应用。
- IndexedDB 使用独立账户五槽救援备份和 128 MiB、1 MiB 分块传输，并提供结构冲突、版本竞争与完整性保护。
- 更新三语 README 和服务器能力标记。升级后必须重启 SillyTavern 服务器插件。

### English

- Add portable/all/selected localStorage sync scopes. Selected mode includes explicitly chosen cache, history and large values while protecting extension-internal keys.
- Add a tree-based IndexedDB manager, scoped selection, import/export/removal, and integration with manual and existing automatic upload/download. Downloads merge and preserve local-only records.
- IndexedDB file import can select databases, stores or individual records, previews additions/overwrites, detects stale previews, and leaves out-of-scope schemas untouched.
- Add independent account-scoped five-slot IndexedDB rescue backups and 128 MiB transfers in 1 MiB chunks, with schema, revision and integrity checks.
- Update all three READMEs and server capability markers. Restart the SillyTavern server plugin after upgrading.

## 1.7.0 - 2026-09-24

### 繁體中文

- 面板加入「設定」選單，集中自動上傳／下載、變更前備份、額外排除鍵與完整 localStorage 同步開關。
- 完整模式預設關閉，手動及自動同步均可使用。快取、歷史與大型值納入獨立的 32 MiB 帳戶私有同步檔，內部裝置與排程鍵仍留在本機。
- 完整同步採原子版本提交、重試收據及變更前救援備份；下載缺失鍵時執行有復原能力的範圍取代。
- 三語介面與 README 更新；備份及同步仍不涵蓋 IndexedDB。升級後必須重啟伺服器插件。

### 简体中文

- 新增「设置」菜单，集中自动上传／下载、变更前备份、额外排除键和完整 localStorage 同步开关。
- 默认关闭的完整模式适用于手动与自动同步；缓存、历史和大型值写入独立的 32 MiB 账户文件，内部设备及调度键保留在本机。
- 原子版本提交、重试收据、救援备份，以及下载时可回滚的完整范围替换。更新三语文档；IndexedDB 暂不包含。升级后重启服务器插件。

### English

- Add a Settings menu for automatic upload/download, pre-change backups, exclusions and optional full localStorage sync.
- Full mode is off by default and works with manual and automatic sync. Caches, history and large values use a separate account-private 32 MiB file; device and scheduler keys stay local.
- Add atomic versioned full commits, retry receipts, rescue backups and rollback-capable replacement downloads. Update all three languages. IndexedDB remains outside backup and sync. Restart the server plugin after upgrading.

## 1.6.0 - 2026-09-23

### 繁體中文

- 新增獨立且預設關閉的自動上傳／自動下載開關；模型活動結束後閒置 15 分鐘上傳，進入頁面時檢查下載，僅同步可攜式 localStorage。
- 加入串流生命週期、fetch／XHR、原生事件與同源 iframe 活動觀測，以及自訂傳輸回報介面；不讀提示詞、回應或憑證，不保證關閉瀏覽器後準時執行。
- 共用跨分頁鎖、基準與版本衝突確認、強制完整救援備份、下載核對／復原、一次性重新載入保護，以及 1／5／15 分鐘有限重試。
- 新增帳戶隔離的原子提交與提交收據 API；全部驗證後一次寫入、版本競爭 HTTP 409、重試去重，保留手動 API。
- 更新三語介面與文件，保留 Android Termux 安裝指令；加入排程、復原、多分頁、串流與安全回歸測試。
- **升級必須重啟 SillyTavern 伺服器插件。備份仍僅涵蓋 localStorage。未對正式 NAS 部署或執行寫入測試。**

### 简体中文

- 独立、默认关闭的自动上传／下载开关：模型活动结束后空闲 15 分钟上传，进入页面检查下载，只同步可移植 localStorage。
- 流式 fetch／XHR、原生事件、同源 iframe 观测及活动回报接口，不读取提示词、响应或凭证。
- 跨标签页锁、版本冲突选择、强制完整救援备份、下载核对／回滚、防刷新循环和 1／5／15 分钟有限重试。
- 账户隔离的原子提交和收据 API，版本竞争返回 HTTP 409，重试去重；保留手动 API 和 Android 指令。
- **更新后重启服务器插件；备份仅含 localStorage。不保证浏览器关闭后准时上传，未部署正式 NAS。**

### English

- Independent, default-off automatic upload/download: upload after 15 idle minutes following model activity; check downloads on entry. Only portable localStorage is automatically synchronized.
- Observe streaming fetch/XHR, native generation events and accessible same-origin frames; expose a lifecycle bridge without inspecting prompts, responses or credentials.
- Add cross-tab locking, baseline/version conflict choices, mandatory full rescue backups, guarded download rollback, reload-loop prevention and bounded 1/5/15-minute retries.
- Add account-private atomic commits and receipts, HTTP 409 version conflicts and idempotent retries while retaining manual APIs. Update all three languages and preserve Android instructions.
- **Restart the server plugin after upgrading. Backups contain localStorage only. Closed-browser timing is not guaranteed. No production NAS deployment or mutation tests were performed.**

## 1.5.2 - 2026-09-22

- 繁體中文：匯入、還原及移除前自動備份改為預設開啟；保留已儲存的使用者選擇，舊版已關閉者可手動開啟。
- 简体中文：导入、恢复及删除前自动备份默认开启；保留已保存的用户选择，旧版已关闭者可手动开启。
- English: Enable pre-import/restore/removal backups by default while preserving saved preferences; previously disabled installations can opt in manually.

## 1.5.1 - 2026-09-22

- 繁體中文：桌面右側容量方塊圖隨左側列表伸展並對齊底部；手機維持上下排列。加入展開、搜尋及視窗尺寸變更的等高回歸檢查。
- 简体中文：桌面右侧容量方块图随左侧列表伸展并对齐底部；手机保持上下排列，新增布局回归检查。
- English: Stretch the desktop treemap to align with the tree's bottom while preserving the stacked mobile layout; test expansion, search and viewport resizing.

## 1.5.0 - 2026-09-22

### 繁體中文

- 新增三色一鍵清理分析、選取推薦項目及強制先備份的批次清理；保護規則優先，沿用過期預覽檢查與失敗復原，不自動刪除。
- 新增容量參考上限與手動確認的暫存鍵實測；顯示 UTF-16 估算範圍，測試達安全界線時只報下限。
- 新增副檔名／資料型態提示，不修改原鍵或 JSON 匯出格式；完整支援三語。
- 更新三語 README，保留 Android Termux 指令；擴充單元及隔離瀏覽器整合測試。
- **升級後請重啟 SillyTavern。完整備份仍僅含 localStorage，可能包含憑證；容量實測前請匯出重要資料並暫停其他分頁操作。**

### 简体中文

- 新增三色分析、推荐项选择及强制先备份的批量清理，保护规则优先，保留过期预览检查和失败回滚。
- 新增容量参考上限、手动容量实测及扩展名／值类型提示；不改原键，不自动清理或实测。
- 更新三语文档及测试。升级后请重启 SillyTavern；实测前导出重要数据并暂停其他操作。

### English

- Add three-color analysis and selectable recommendations, with mandatory full server backup before batch cleanup, protection-first rules, stale checks and rollback.
- Add a reference capacity ceiling, opt-in temporary-key capacity measurement and extension/value-type hints without renaming keys or changing archives.
- Update all three languages, documentation and tests. Restart SillyTavern after upgrading; export important data and pause other activity before probing capacity.

## 1.4.0 - 2026-09-22

### 繁體中文

- 新增五個帳戶共用的完整 localStorage 備份插槽，確認同步後先備份，失敗中止；支援原子寫入、帳戶內序列化、重試去重與最舊淘汰。
- 新增樹狀容量管理與方塊圖、搜尋／多選、完整／資料夾／單鍵 JSON 匯入匯出、預覽與範圍受限的合併／取代、移除及清理建議。
- 新增可選的匯入／還原／移除前備份（預設關閉）、內部鍵保護、變更前核對及失敗復原。
- 統一 32 MiB JSON 上限，顯示 UTF-16 用量估算；所有新增介面支援繁體中文、簡體中文及英文。
- 擴充測試並加入可重現的隔離 SillyTavern 瀏覽器／安全整合測試，更新三語 README。
- **升級需重啟伺服器插件。備份只涵蓋 localStorage，不含帳戶設定檔、聊天檔、Cookie 或 IndexedDB。完整快照與匯出檔可能含憑證。**

### 简体中文

- 新增五个账户共享的完整 localStorage 备份插槽；确认同步后先备份，失败中止，支持原子写入、并发串行化及重试去重。
- 新增树状清单与容量方块图、搜索多选、完整及局部 JSON 导入导出、合并／限定范围替换、删除和清理建议。
- 可选导入／恢复／删除前备份默认关闭；默认保护内部键，应用前检查预览，写入失败尝试回滚。
- 新增三语界面、32 MiB JSON 限制、UTF-16 容量估算及隔离环境集成测试。
- **升级后必须重启服务器插件。备份只包含 localStorage，可能包含凭证，不是完整 SillyTavern 备份。**

### English

- Add five account-scoped full localStorage snapshots before confirmed sync, with atomic publication, serialized writes, retry deduplication and oldest-first eviction.
- Add a storage tree and treemap, search/multi-select, full and partial JSON import/export, bounded merge/replace previews, removal and non-destructive cleanup suggestions.
- Add optional backups before local mutations (off by default), protected internal keys, stale-preview checks and rollback on write failures.
- Add complete en/zh-TW/zh-CN UI, a 32 MiB JSON limit, UTF-16 size estimates, multilingual documentation and isolated-host integration tests.
- **Restart the server plugin after upgrading. Backups contain localStorage only, potentially including credentials; they are not complete SillyTavern backups.**

## 1.3.1

- 修正 Docker 文件只涵蓋「為所有使用者安裝」路徑，導致「為自己安裝」後 server plugin 未載入並回傳 HTTP 404 的問題。
- Docker 安裝指令現在會自動偵測全域及帳戶專屬擴充路徑。
- 前端遇到 HTTP 404 時會顯示可操作的 server plugin 安裝提示。

## 1.3.0 - 2026-08-11

- Lowered the verified minimum SillyTavern version from 1.18.0 to 1.14.0.
- Lowered the server runtime requirement from Node.js 20 to Node.js 18.
- Added CI coverage for Node.js 18, 20, and 24.
- Verified the required frontend, account, CSRF, and server-plugin APIs against the official SillyTavern 1.14.0 source.

## 1.2.0 - 2026-08-11

- Published the extension for public GitHub installation and updates.
- Added a cross-platform server-plugin linker.
- Kept all synchronization strictly manual.
- Made upload mirror deletions from the selected source device.
- Added CI, public installation guidance, and an MIT license.
