"""台指 60 分K 趨勢＋布林擠壓突破策略回測：草稿版與修訂版。

資料是 CSV（start,open,high,low,close,volume），兩種來源：
    tx    build_bars.py 產生的台指期日夜盤 60 分K（只有最近累積的天數）
    twii  加權指數日盤 60 分K（Yahoo，約 3 年；沒有夜盤，09:00 起 5 根）
用法：
    python strategy/backtest.py tx_60min.csv tx
    python strategy/backtest.py twii_60min.csv twii
每筆以 2 單位計（可分批出場），每單位扣 COST 點來回成本。結果以 R（初始風險倍數）表示。
"""
import csv, datetime as dt, statistics, sys
from collections import defaultdict

COST = 3
# 修訂版 v2（2026-11-07 依近 2 年加權指數回測調整）：拿掉擠壓條件、突破 K 實體 ≥ 0.8 ATR、保本後只用 EMA20 全部出場
V2 = dict(squeeze_on=False, body_atr=0.8, stop_atr=1.5, max_atr=2.0, be_r=1.0, exit_mode="ema20")


def load(path):
    rows = [r for r in csv.DictReader(open(path, encoding="utf-8")) if not r["start"].endswith("13:30")]
    T = [dt.datetime.strptime(r["start"], "%Y-%m-%d %H:%M") for r in rows]
    O, H, L, C = ([float(r[k]) for r in rows] for k in ("open", "high", "low", "close"))
    return T, O, H, L, C


def ema(x, p):
    k, out = 2 / (p + 1), [x[0]]
    for v in x[1:]:
        out.append(out[-1] + k * (v - out[-1]))
    return out


def us_dst(d):
    def nth_sunday(year, month, n):
        first = dt.date(year, month, 1)
        return first + dt.timedelta(days=(6 - first.weekday()) % 7 + 7 * (n - 1))
    return nth_sunday(d.year, 3, 2) <= d.date() < nth_sunday(d.year, 11, 1)


# 各資料來源的時段濾網（看訊號 K 的開始時間）
def tx_draft(t):
    return t.strftime("%H:%M") in ("08:45", "09:45", "10:45", "21:00", "22:00", "23:00")


def tx_revised(t):
    hm = t.strftime("%H:%M")
    if hm in ("08:45", "09:45", "10:45", "11:45"):
        return True
    return hm in (("21:00", "22:00", "23:00") if us_dst(t) else ("22:00", "23:00", "00:00"))


def twii_draft(t):
    return t.hour in (9, 10, 11)


def twii_revised(t):
    return t.hour in (9, 10, 11, 12)  # 13:00 是收盤前最後一根，不開新倉


def indicators(T, O, H, L, C):
    n = len(C)
    ind = dict(E10=ema(C, 10), E20=ema(C, 20), E60=ema(C, 60))
    macd = [a - b for a, b in zip(ema(C, 12), ema(C, 26))]
    ind["hist"] = [a - b for a, b in zip(macd, ema(macd, 9))]
    MID, SD = [None] * n, [None] * n
    for i in range(19, n):
        w = C[i - 19:i + 1]
        MID[i], SD[i] = sum(w) / 20, statistics.pstdev(w)
    ind["MID"], ind["SD"] = MID, SD
    ind["BBW"] = [4 * SD[i] / MID[i] if MID[i] else None for i in range(n)]
    ATR, a = [], None
    for i in range(n):
        tr = H[i] - L[i] if i == 0 else max(H[i] - L[i], abs(H[i] - C[i - 1]), abs(L[i] - C[i - 1]))
        a = tr if a is None else a + (tr - a) / 14
        ATR.append(a)
    ind["ATR"] = ATR
    return ind


def run(bars, ind, revised, allowed=None, fallback60=False, stop_atr=1.5, max_atr=2.0,
        be_r=1.0, exit_mode="split", squeeze_on=True, squeeze_pct=0.2, body_atr=0.5,
        chand_k=3.0, target_r=2.0, start=None, end=None, sides=(1, -1)):
    """revised=False 是草稿規則；revised=True 是修訂版，其餘參數只對修訂版有效。
    exit_mode：split（保本後 EMA10 出一半、EMA20 全出）、ema20、chand（保本後用最高收盤 − chand_k×ATR 移動停利）、
               target（target_r 倍 R 先出一半，剩下 EMA20）。be_r=None 表示不設保本。"""
    T, O, H, L, C = bars
    n = len(C)
    E10, E20, E60, hist = ind["E10"], ind["E20"], ind["E60"], ind["hist"]
    MID, SD, BBW, ATR = ind["MID"], ind["SD"], ind["BBW"], ind["ATR"]
    sq_key = ("sq", squeeze_pct)
    if sq_key not in ind:
        low = [False] * n
        for j in range(n):
            w = [x for x in BBW[max(19, j - 100):j + 1] if x]
            low[j] = len(w) >= 40 and sorted(w).index(BBW[j]) <= squeeze_pct * (len(w) - 1)
        ind[sq_key] = [any(low[max(0, i - 6):i]) for i in range(n)]
    SQ = ind[sq_key]

    trades, skipped, i = [], 0, 100
    while i < n - 1:
        side = 0
        in_range = (start is None or T[i] >= start) and (end is None or T[i] < end)
        if in_range and (allowed is None or allowed(T[i])):
            for s in sides:
                body, rng = (C[i] - O[i]) * s, H[i] - L[i]
                if revised:
                    strong = body > 0 and body >= 0.5 * rng and body >= body_atr * ATR[i - 1]
                    mom = hist[i] * s > 0
                else:
                    strong = body > 0 and body >= 0.6 * rng
                    mom = hist[i] * s > 0 and (hist[i] - hist[i - 1]) * s > 0
                sq = SQ[i] if (squeeze_on or not revised) else True
                if (E20[i] - E60[i]) * s > 0 and (C[i] - (MID[i] + 2 * SD[i] * s)) * s > 0 \
                        and strong and mom and sq:
                    side = s
        if not side:
            i += 1
            continue
        e = O[i + 1]
        ext = L[i] if side > 0 else H[i]
        if revised:
            raw = abs(e - (ext - 0.1 * ATR[i] * side))
            if raw > max_atr * ATR[i]:
                skipped += 1; i += 1; continue
            stop = e - min(raw, stop_atr * ATR[i]) * side
        else:
            stop = ext - 10 * side
            if abs(e - stop) > 90:
                skipped += 1
                if not fallback60:
                    i += 1; continue
                stop = e - 60 * side
        R = abs(e - stop)
        units, pnl, be, partial, j, best = 2, 0.0, False, False, i + 1, e
        while j < n:
            worst = L[j] if side > 0 else H[j]
            if (worst - stop) * side <= 0:  # 觸及停損；跳空時以開盤價成交
                px = stop if (O[j] - stop) * side > 0 else O[j]
                pnl += units * (px - e) * side; units = 0; break
            if revised and exit_mode == "target" and not partial:
                tgt = e + target_r * R * side
                if ((H[j] if side > 0 else L[j]) - tgt) * side >= 0:
                    pnl += (max(tgt * side, O[j] * side) * side - e) * side; units -= 1; partial = True
            if not be:
                if revised:
                    hit = be_r is not None and (C[j] - e) * side >= be_r * R
                else:
                    hit = ((H[j] if side > 0 else L[j]) - e) * side >= R
                if hit:
                    be, stop = True, e + (COST * side if revised else 0)
            if j + 1 >= n:
                pnl += units * (C[j] - e) * side; units = 0; break
            active = (be or be_r is None) if revised else True
            if revised and exit_mode == "chand":
                best = max(best * side, C[j] * side) * side
                if active:
                    trail = best - chand_k * ATR[j] * side
                    if (trail - stop) * side > 0:
                        stop = trail
                j += 1
                continue
            if (exit_mode == "split" or not revised) and active and not partial and (C[j] - E10[j]) * side < 0:
                pnl += (O[j + 1] - e) * side; units -= 1; partial = True
            if active and (C[j] - E20[j]) * side < 0:
                pnl += units * (O[j + 1] - e) * side; units = 0; j += 1; break
            j += 1
        net = pnl - 2 * COST
        trades.append(dict(t=T[i], side=side, R=R, pts=net, r=net / (2 * R), bars=j - i))
        i = j
    return trades, skipped


def summary(trades):
    if not trades:
        return dict(n=0)
    rs = [t["r"] for t in trades]
    eq, peak, dd = 0, 0, 0
    for r in rs:
        eq += r; peak = max(peak, eq); dd = min(dd, eq - peak)
    gain = sum(r for r in rs if r > 0); loss = -sum(r for r in rs if r < 0)
    return dict(n=len(rs), win=sum(r > 0.1 for r in rs) / len(rs), be=sum(abs(r) <= 0.1 for r in rs) / len(rs),
                avg=sum(rs) / len(rs), tot=sum(rs), dd=dd, pf=gain / loss if loss else float("inf"),
                avg_stop=sum(t["R"] for t in trades) / len(trades),
                hold=statistics.median(t["bars"] for t in trades))


def line(name, trades, skipped):
    s = summary(trades)
    if not s["n"]:
        return f"{name}: 0 筆（停損過遠跳過 {skipped}）"
    return (f"{name}: {s['n']} 筆 勝率 {s['win']:.0%} 保本 {s['be']:.0%} 平均 {s['avg']:+.2f}R "
            f"合計 {s['tot']:+.1f}R 最大回落 {s['dd']:.1f}R 獲利因子 {s['pf']:.2f} "
            f"平均停損 {s['avg_stop']:.0f} 點 持有中位數 {s['hold']:.0f} 根（跳過 {skipped}）")


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "tx_60min.csv"
    src = sys.argv[2] if len(sys.argv) > 2 else "tx"
    start = dt.datetime.strptime(sys.argv[3], "%Y-%m-%d") if len(sys.argv) > 3 else None
    draft_f, rev_f = (tx_draft, tx_revised) if src == "tx" else (twii_draft, twii_revised)
    bars = load(path)
    ind = indicators(*bars)
    print("K 棒", len(bars[0]), "根：", bars[0][0], "~", bars[0][-1], "；統計起點", start or bars[0][0])
    print(line("草稿版（停損 >90 點不做）", *run(bars, ind, False, draft_f, start=start)))
    print(line("草稿版（>90 點改固定 60 點）", *run(bars, ind, False, draft_f, fallback60=True, start=start)))
    print(line("修訂版 v1", *run(bars, ind, True, rev_f, start=start)))
    v2, sk = run(bars, ind, True, rev_f, start=start, **V2)
    print(line("修訂版 v2", v2, sk))
    print(line("v2（無時段濾網）", *run(bars, ind, True, None, start=start, **V2)))
    print(line("v2（停損 2 ATR）", *run(bars, ind, True, rev_f, start=start, **dict(V2, stop_atr=2.0, max_atr=2.5))))
    print(line("v2（保本 1.5R）", *run(bars, ind, True, rev_f, start=start, **dict(V2, be_r=1.5))))
    print(line("v2（EMA10 出一半）", *run(bars, ind, True, rev_f, start=start, **dict(V2, exit_mode="split"))))
    by = defaultdict(list)
    for t in v2:
        by[t["t"].year].append(t)
    for y in sorted(by):
        print(line(f"  v2 {y}", by[y], 0))
    for side, nm in ((1, "多"), (-1, "空")):
        print(line(f"  v2 只看{nm}單", [t for t in v2 if t["side"] == side], 0))
    for t in v2:
        print(f"   {t['t']:%Y-%m-%d %H:%M} {'多' if t['side'] > 0 else '空'} 停損 {t['R']:.0f} 點 {t['r']:+.2f}R")
