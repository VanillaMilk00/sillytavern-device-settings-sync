# Changelog

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
