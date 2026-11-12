"""歷史成交紀錄頁 docs/trades.html：v3（限時段）與 v3 不限時段的每一筆模擬交易。由 live.py 呼叫。

  - 台指期（實際交易依據）：history/tx_1min 累積的日夜盤 1 分K（跟即時訊號頁同一份計算），時間精確到分鐘
  - 加權指數（回測用歷史資料，不是交易依據）：近 2 年（2024/11/7 起）加權指數日盤 60 分K，時間精確到那根 60 分K
試算：本金 20 萬、固定 1 口微台（每點 10 元）、每次下單 25 元。
"""
import datetime as dt, html
from backtest import indicators, twii_revised
import v3

TWO = dt.datetime(2024, 11, 7)   # 跟 daily_compare.py 的「近 2 年」同一天


def twii_backtests(tw60, refine):
    """tw60：加權指數 60 分K。回傳 {"v3": trades, "v3all": trades}（v3 限 09:00–12:00 開始的 K 開新倉，v3all 不限）。
    加權指數只有 60 分K，refine 找不到更細的 K，出場時間就是碰到停損的那根 60 分K。"""
    ind = indicators(*tw60)
    m = list(zip(*tw60))
    out = {}
    for key, allowed in (("v3", twii_revised), ("v3all", None)):
        out[key] = [x for x in v3.run(tw60, ind, allowed, "13:00", v3.V3) if x["t"] >= TWO]
        refine(out[key], m)
    return out


def esc(s):
    return html.escape(str(s))


def money(v):
    cls = "up" if v > 0 else "dn" if v < 0 else ""
    return f'<span class="{cls}">{v:+,.0f}</span>'


def ledger(rows, cap, show_phase):
    """rows 依時間由舊到新；輸出（摘要, 表格）。表格新的在上面，帳戶餘額照時間累加。"""
    if not rows:
        return '<p class="note">還沒有交易。</p>', ""
    eq = pk = cap
    dd = 0
    out = []
    for x in rows:
        eq += x["twd"]; pk = max(pk, eq); dd = min(dd, eq - pk)
        out.append((x, eq))
    closed = [x for x in rows if not x["open"]]
    win = sum(x["r"] > 0.1 for x in closed)
    unreal = sum(x["twd"] for x in rows if x["open"])
    summ = (f'<div class="tiles">'
            f'<div><span>帳戶</span><b>{eq:,.0f}</b><em>{money(eq - cap)} 元（{(eq - cap) / cap:+.1%}）</em></div>'
            f'<div><span>已出場</span><b>{len(closed)} 筆</b><em>賺 {win} 筆・勝率 {win / len(closed) if closed else 0:.0%}</em></div>'
            f'<div><span>合計</span><b>{sum(x["r"] for x in closed):+.1f}R</b><em>{"未實現 " + format(unreal, "+,.0f") + " 元" if unreal else "沒有持倉"}</em></div>'
            f'<div><span>最大回落</span><b>{dd:,.0f}</b><em>元</em></div></div>')
    heads = (["階段"] if show_phase else []) + ["進場時間", "方向", "進場價", "初始停損", "出場時間", "出場價", "出場原因", "點數", "R", "損益（元）", "帳戶"]
    body = []
    for x, e in reversed(out):
        cells = ([f'<span class="ph{" fw" if x["phase"] == "前測" else ""}">{esc(x["phase"])}</span>'] if show_phase else []) + [
            esc(x["entry_t"]), f'{"多" if x["side"] == "多" else "空"}・{esc(x["kind"])}', f'{x["entry"]:,}', f'{x["stop0"]:,}',
            "持倉中" if x["open"] else esc(x["exit_t"]), "" if x["open"] else f'{x["exit"]:,}',
            esc(x["why"]) if not x["open"] else f'停損 {x["stop"]:,}', f'{x["pts"]:+,}', f'{x["r"]:+.2f}', money(x["twd"]), f"{e:,.0f}"]
        body.append(f'<tr class="{"long" if x["side"] == "多" else "short"}{" open" if x["open"] else ""}">' + "".join(f"<td>{c}</td>" for c in cells) + "</tr>")
    tbl = (f'<div class="scroll"><table><thead><tr>{"".join(f"<th>{h}</th>" for h in heads)}</tr></thead>'
           f'<tbody>{"".join(body)}</tbody></table></div>')
    return summ, tbl


def section(title, note, rows, cap, show_phase):
    summ, tbl = ledger(rows, cap, show_phase)
    return f'<section class="card"><h2>{esc(title)}</h2><p class="note">{note}</p>{summ}{tbl}</section>'


def render(tx, tws, now, last_c, tx_start, consts, trade_row):
    cap, mult, fee, cost = consts
    tw = {k: [trade_row(x) for x in v] for k, v in tws.items()}
    for rs in tw.values():
        for r in rs:
            r["phase"] = "回測"
    return f"""<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>台指策略成交紀錄</title>
<style>
:root {{ --bg:#f6f7f9; --panel:#fff; --fg:#1b1f24; --muted:#5d6673; --line:#dfe3e8; --up:#c2412d; --dn:#2f7d5b;
  --accent:#2f5fd0; --rowl:rgba(194,65,45,.05); --rows:rgba(47,125,91,.06);
  --font:"Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#14171b; --panel:#1c2026; --fg:#e8ebef; --muted:#9aa3ae; --line:#2c323a;
  --up:#ef7a63; --dn:#5cc296; --accent:#7ea2ff; --rowl:rgba(239,122,99,.07); --rows:rgba(92,194,150,.07); color-scheme:dark; }} }}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--fg); font-family:var(--font); font-size:15px; line-height:1.5; }}
main {{ max-width:1100px; margin:0 auto; padding:16px; }}
h1 {{ font-size:20px; margin:0; }} h2 {{ font-size:17px; margin:0 0 2px; }}
.part {{ font-size:15px; color:var(--muted); font-weight:600; margin:22px 0 0; }}
.note, .asof {{ color:var(--muted); font-size:12.5px; margin:4px 0; }}
nav {{ display:flex; gap:6px; flex-wrap:wrap; margin:10px 0 0; }}
nav a {{ font-size:13px; border:1px solid var(--line); border-radius:999px; padding:3px 10px; text-decoration:none; background:var(--panel); }}
.card {{ background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; margin-top:12px; scroll-margin-top:8px; }}
.tiles {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:8px; margin:10px 0; }}
.tiles div {{ border:1px solid var(--line); border-radius:8px; padding:8px; }}
.tiles span {{ display:block; font-size:12px; color:var(--muted); }}
.tiles b {{ display:block; font-size:18px; font-weight:600; font-variant-numeric:tabular-nums; }}
.tiles em {{ display:block; font-style:normal; font-size:12px; color:var(--muted); }}
.scroll {{ overflow-x:auto; border:1px solid var(--line); border-radius:8px; }}
table {{ border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; font-size:13px; }}
th, td {{ padding:6px 8px; text-align:right; border-bottom:1px solid var(--line); white-space:nowrap; }}
th {{ color:var(--muted); font-weight:500; position:sticky; top:0; background:var(--panel); }}
td:nth-child(-n+3), th:nth-child(-n+3) {{ text-align:left; }}
tr.long td {{ background:var(--rowl); }} tr.short td {{ background:var(--rows); }}
tr.open td {{ font-weight:600; }}
.ph {{ font-size:11.5px; color:var(--muted); border:1px solid var(--line); border-radius:999px; padding:0 6px; }}
.ph.fw {{ color:#fff; background:var(--accent); border-color:var(--accent); }}
.up {{ color:var(--up); }} .dn {{ color:var(--dn); }}
a {{ color:var(--accent); }}
footer {{ margin:20px 0 40px; }}
</style></head><body><main>
<h1>台指策略成交紀錄</h1>
<p class="asof">v3 60 分K（限時段）與 v3 不限時段每一筆模擬交易・台北 {now:%Y-%m-%d %H:%M} 產生・台指期持倉以現價 {last_c:,.0f} 計</p>
<nav><a href="#tx-v3">台指期 v3 限時段</a><a href="#tx-v3all">台指期 v3 不限時段</a><a href="#tw-v3">加權指數回測 v3 限時段</a><a href="#tw-v3all">加權指數回測 v3 不限時段</a><a href="live.html">← 即時訊號</a></nav>
<p class="part">台指期・實際交易依據（{esc(tx_start)} 起，日盤＋夜盤 60 分K）</p>
<div id="tx-v3">{section("v3・60 分K（限時段）", "只在日盤 08:45–11:45、夜盤 21:00–23:00（美國冬令 22:00–00:00）開始的 60 分K 開新倉。進場是訊號 K 收完後下一根 60 分K 開盤；停損出場時間是 1 分K 第一次碰到停損的那一分鐘。「前測」是 2026/11/9 規則定案後的交易。", tx["v3"], cap, True)}</div>
<div id="tx-v3all">{section("v3 不限時段・60 分K", "規則跟 v3 一樣，但日盤、夜盤任何一根 60 分K 收完都可以開新倉（日盤最後一根 12:45 的訊號在 15:00 夜盤開盤進場、夜盤最後一根 04:00 的訊號在 08:45 日盤開盤進場）。「前測」同樣從 2026/11/9 算起。", tx["v3all"], cap, True)}</div>
<p class="part">加權指數・回測用歷史資料（{TWO:%Y/%m/%d} 起，近 2 年，只有日盤；不是實際交易依據）</p>
<div id="tw-v3">{section("v3・60 分K（限時段）", "只在 09:00–12:00 開始的 60 分K 開新倉（13:00 收盤前最後一根不開）。價格是加權指數點數，當成 1 口微台每點 10 元試算。資料只有 60 分K，所以時間是那根 60 分K 的開始時間（例如 10:00 代表 10:00–11:00 之間）。", tw["v3"], cap, False)}</div>
<div id="tw-v3all">{section("v3 不限時段・60 分K", "每一根 60 分K 收完都可以開新倉（含 13:00 最後一根，訊號隔天 09:00 開盤進場）。其他同上。", tw["v3all"], cap, False)}</div>
<footer><p class="note">試算：本金 {cap:,} 元、固定 1 口微台（每點 {mult} 元）、每次下單 {fee} 元（來回 {2 * fee} 元）；點數是進出場價差，損益（元）已扣下單費用；R 是以初始停損點數為 1 的倍數（另扣 {cost} 點滑價成本）。
台指期價格已換算成目前近月合約（換月時回溯調整），所以早期的價格會跟當時實際報價差一個價差。每半小時跟即時訊號頁一起更新。</p>
<p class="note"><a href="live.html">即時訊號</a>・<a href="strategy.html">v3 前測（每日）</a>・<a href="index.html">選擇權盤面</a></p></footer>
</main></body></html>
"""
