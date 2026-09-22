# Changelog

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
