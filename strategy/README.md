# 台指期 60 分K 策略回測

策略說明在 Claude 文件「台指期 60 分K 波段策略（修訂版）」。這個資料夾放資料累積與回測程式，只用 Python 標準函式庫。

| 檔案 | 用途 |
| --- | --- |
| `collect_ticks.py` | 下載期交所「前 30 個交易日期貨每筆成交資料」，把台指期（TX）轉成 1 分K，存到 `history/tx_1min/` |
| `build_bars.py` | 把 1 分K 合成近月連續的 60 分K（日盤 08:45 起、夜盤 15:00 起，換月回溯調整） |
| `fetch_twii.py` | 抓加權指數日盤 60 分K（Yahoo，約 3 年），合併存到 `history/twii_60min.csv` |
| `backtest.py` | 回測草稿版、修訂版 v1、v2 與幾個參數變化 |
| `optimize.py` | v2 參數搜尋：前 16 個月挑參數，後 8 個月驗證 |
| `simulate.py` | 固定口數試算帳戶金額（預設 20 萬、1 口微台、每次下單 25 元），含買進持有對照 |
| `forward.py` | v3 前測：每天用累積的台指期日夜盤資料跑 v3，輸出 `docs/strategy.html` 與 `history/forward_trades.csv`（2026/11/9 起算前測） |
| `v3.py` | v3：加上拉回進場、5 ATR 移動停利、日線濾網選項，含參數搜尋 |
| `daily.py` | 日K 版：把 60 分K 合成日K（台指期夜盤併入下一個交易日），回測 v3 條件直接搬到日K 與調整版 D1，含參數搜尋 |
| `daily_compare.py` | D1、v3、混合版（日K 定方向 + 60 分K 進場）比較，含 20 萬元 1 口微台試算，可輸出 D1 交易紀錄 |

期交所只留最近 30 個交易日，`.github/workflows/tx-ticks.yml` 每天台北 06:30 自動存一次，資料會越累積越長。

```
python strategy/build_bars.py history/tx_1min tx_60min.csv
python strategy/backtest.py tx_60min.csv tx
python strategy/backtest.py history/twii_60min.csv twii 2024-11-07   # 近 2 年日盤
python strategy/optimize.py history/twii_60min.csv tx_60min.csv
python strategy/v3.py history/twii_60min.csv tx_60min.csv
```

2026-11-07 結果（近 2 年加權指數日盤）：v1 19 筆 +8.8R；v2 30 筆 +33.0R、最大回落 −6.0R、獲利因子 2.46。
後 8 個月（驗證段）v2 +4.4R；台指期日夜盤 1 個月 v2 +6.5R。

`build_bars.py` 第三個參數可以改 K 棒分鐘數，例如 `15`。

v3（3 年加權指數日盤，2026/3/7 前挑參數）：66 筆 +80.6R、最大回落 −13.3R、t 值 2.08；驗證段 20 筆 +26.5R；台指期 1 個月 7 筆 +11.5R。

日K 版（2026-11-07，同一份 3 年加權指數合成日K，2024/1/29 起有訊號，2026/3/7 前挑參數）：
D1 = 收盤創 20 日新高（新低）、紅K實體 ≥ 高低差 50%、日 EMA20 > EMA60；停損 1 ATR、收盤獲利 1R 保本、保本後收盤跌破 EMA20 隔天開盤出場。
19 筆 +58.4R、最大回落 −4.0R；20 萬元 1 口微台近 2 年期末 327,360 元（v3 401,191 元，其中 66,826 元是未實現）。

```
python strategy/daily.py history/twii_60min.csv history/tx_1min
python strategy/daily_compare.py history/twii_60min.csv history/tx_1min d1_trades.csv
```

D2（同日第二次調整）：D1 改成訊號當天收盤前進場（加權指數 13:30 收盤確認、台指期 13:45 收盤前下單），其他不變。
21 筆 +70.9R；20 萬元 1 口微台近 2 年期末 352,205 元（含 11/5 空單未實現 18,219 元），最大回落 31,626 元。
假設每筆進場多滑 0.1 ATR 仍有 346 千元左右；停損 0.5 ATR 的版本帳面更高，但多滑 0.05 ATR 就從 358 千元掉到 297 千元，所以不採用。
`daily.py` 的新選項：`entry_at`（open/close）、`slip_atr`、`cap_pts`（停損點數上限）、`vol_max`（ATR/價格上限）、`slope`、`exit="ema10"`。
