# 台指策略訊號（Google 試算表獨立版）

網頁 `docs/live.html`（即時訊號）與 `docs/trades.html`（成交紀錄）的 Google 試算表版：Apps Script 直接跟期交所抓台指期近月資料，
在 Google 的伺服器上算 v3（60 分K，日盤＋夜盤）與 D2（日K，只算日盤），交易時段定時更新。不靠 GitHub、不用開電腦。

| 檔案 | 內容 |
| --- | --- |
| `src/Engine.js` | 計算：1 分K → 60 分K／日K（換月回溯調整）、指標、v3、D2、進出場時間到分鐘、條件明細、成交紀錄。照 `strategy/` 的 Python 逐行改寫，不用任何 Apps Script 功能 |
| `src/App.js` | 抓資料（MIS 即時 1 分K、每日成交 zip、每日行情、Yahoo 加權指數）、存在隱藏分頁、畫「即時訊號」「成交紀錄」「說明與狀態」、選單、定時觸發 |
| `Code.gs` | 上面兩個合成的單一檔案，貼進 Apps Script 用（`python3 gsheet/build.py` 產生） |
| `test/` | `dump.js`、`live_check.js`：用 Node 跑 Engine.js，跟 Python 參考結果比對；`gas_mock.js`：在 Node 模擬 Apps Script，用真的網路跑 App.js |

## 安裝

1. 開一個新的 Google 試算表 →「擴充功能 → Apps Script」→ 把 `Code.gs` 整份貼上取代原本內容 → 儲存。
2. 回到試算表重新整理，上方會多一個「台指策略」選單 →「立即更新」。第一次會要求授權（「Google 尚未驗證這個應用程式」→ 進階 → 前往 → 允許）。
3. 「台指策略 → 開啟自動更新（每 15 分鐘）」。之後關掉試算表也會在 Google 伺服器上跑。
4. 選用：「從 GitHub 匯入舊資料」一次，讓台指期歷史從 2026/9/22 開始（跟網頁一樣）；不匯入就從期交所能下載的最近 30 個交易日開始。

## 資料流程

- 每次更新：期交所 MIS 日盤、夜盤各抓成交量前兩大的契約 1 分K（`getQuoteList`、`getChartData1M`），存進「資料_即時1分K」。
- 每天 06:00 後第一次（或發現缺盤時，每小時最多一次）：期交所「前 30 個交易日每筆成交」zip → 只取 TX 轉 1 分K 存進「資料_1分K」
  （最新 3 個檔案若還沒有日盤會重抓，同 `collect_ticks.py`）；`futDataDown` 台指期每日行情（2024 起）；Yahoo 加權指數 60 分K。
- 每日成交 zip 解開有 100MB，若 Apps Script 吃不下，會改把即時 1 分K 存成當天的歷史（夜盤＋隔天日盤 = 一個交易日），之後 zip 或 GitHub 有資料時會換掉。
- 計算跟 `strategy/live.py` 完全一樣：history ＋還沒進 history 的即時 1 分K → 60 分K／日K → `v3.run`、`daily.run(D2)` → 部位、訊號、條件、成交紀錄。
- 自動更新：時間觸發每 15（或 30）分鐘一次；只在日盤 08:40–14:30、夜盤 14:55–05:45、早上 06:00–08:30 維護時才真的抓資料。

## 驗證

`sh gsheet/test/run_tests.sh`（repo 根目錄）：

- 完整 history（11/7 10:00、11/9 09:10）以及「history 少最後兩天、靠即時資料補」（`excel/strategy_vba/test/fixture_20261107`，11/7 06:00、13:40），
  60 分K、日K、指標、v3／D2／加權指數回測每一筆交易、條件明細、停損、資料缺口，跟 Python 逐行比對 0 差異。
- 部位、訊號、指標、前測／回測摘要跟 `live.py` 的 `live.json` 相同。

`node gsheet/test/gas_mock.js 狀態.json update`：模擬 Apps Script，真的連期交所與 Yahoo。2026-11-07 跑過：
期交所 zip 轉出的 30 天 1 分K、每日行情 7,875 列、加權指數 3,624 根，都跟 repo 的 `history/` 一模一樣；`NOZIP=1` 測過 zip 解不開的備援。
真正的 Google Apps Script 環境（UrlFetchApp 能不能連到期交所、100MB 解壓縮、觸發器）要在試算表裡實際跑。
