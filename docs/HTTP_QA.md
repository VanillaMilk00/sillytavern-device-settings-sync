# v1.13.0 HTTP 驗證紀錄 / HTTP validation

日期：2026-10-15（Asia/Taipei）。測試使用隔離 SillyTavern 1.14.0、獨立資料目錄與測試帳戶，Windows、Node.js 22.23.0、Edge Chromium 155。正式 NAS 未執行更新或寫入測試。

## 已通過的檢查

| 項目 | 結果 |
| --- | --- |
| Node 單元／行為測試 | 151 項 |
| 語法與發布 manifest 雜湊核對 | 通過 `npm run check` |
| 實際區網 IP 的非安全 HTTP | 18 項整合檢查 |
| HTTP 測試網域 | 9 項整合檢查，DNS 僅映射至隔離本機 |
| localhost 管理介面回歸 | 30 項 |
| localhost 自動模式回歸 | 16 項，含實際串流、XHR、iframe、取消、跨分頁與衝突 |
| 後端登入／CSRF／帳戶隔離 | 10 項 |

HTTP 瀏覽器檢查明確斷言 `isSecureContext === false`、`navigator.locks` 和 `crypto.subtle` 不可用；未以 localhost 的安全環境結果代替 HTTP 結果。

涵蓋：預設關閉、取消許可、四種自動開關組合、一般／完整／勾選範圍、HTTP 手動同步、錯誤可見性、診斷文字及 JSON 下載、缺少 Worker 時的手動 IndexedDB 預檢、手動 localStorage 降級、多分頁租約競爭與過期、舊持有者寫入拒絕、失聯活動暫停、傳輸中再次修改、回覆遺失後查收據、撤銷許可保留固定批次、重新載入後自動下載、IndexedDB 多塊備份與下載。

## 效能量測

以下是單次本機結果，不是跨裝置效能保證。完整測試與網域測試使用約 8 MiB 的 localStorage UTF-16 估算大型值，另保留正常酒館鍵。

| 測量 | 結果 |
| --- | --- |
| 同一小鍵直接賦值 1,000 次 | 一筆自動提交；約 5.8 ms 完成測試寫入 |
| 其後保存小鍵時讀取無關大型值 | 0 次 |
| Worker 處理 3,000,007 bytes 的中文／Emoji 字串 | 約 104.2 ms（含傳送與結果等待） |
| 主執行緒傳送工作至 Worker | 約 4.9 ms |
| 該字串差分 JSON | 64 bytes，未包含整份新值 |
| Worker 測量期間觀測到的主執行緒 >50 ms 長任務 | 0 |

SHA-256 另與 Node 伺服器逐位元組比對空值、標準字串、區塊填補邊界、中文、Emoji、不成對 surrogate、任意位元組切片與大型值。

## 重跑方式與限制

先啟動有獨立 `data-http-*` 資料目錄的隔離酒館；`tools/http-browser-smoke.mjs` 只接受本機介面位址，或明確映射至本機的 `dss-http.test`。設定 `DSS_QA_ALLOW_MUTATION=1`、`DSS_QA_URL`、`DSS_QA_DATA_ROOT`、`DSS_PLAYWRIGHT_MODULE` 及可選的 `DSS_QA_OUTPUT` 後執行：

```sh
node tools/http-browser-smoke.mjs
```

`DSS_QA_QUICK=1` 執行網域／能力降級子集；網域情境另設 `DSS_QA_LOCAL_IP`。JSON 結果與桌面／行動視窗截圖寫入輸出目錄。測試會修改測試帳戶資料，不能指向日常酒館。

實體 Android、Firefox、WebKit、HTTPS 憑證連線及完整瀏覽器程序重啟未實測。本次有桌面 Edge、412×915 行動視窗模擬與 localhost 安全環境回歸；未把行動視窗模擬稱作實體 Android。HTTP 關頁 keepalive 為盡力傳送，不能保證；未確認資料須於原瀏覽器重新開啟後核對續傳。

English: The tests above used a disposable SillyTavern host and genuinely insecure HTTP origins. All listed checks passed. Mobile viewport emulation does not establish physical Android compatibility. Firefox, WebKit, physical Android, certificate-based HTTPS and complete browser-process restart remain unverified. HTTP page-close delivery is best-effort; only a server receipt means success.
