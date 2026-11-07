"""日K 版（D1）與 60 分K v3 的比較，含 20 萬元、1 口微台、每次下單 25 元的帳戶試算。
也測「日K 定方向、60 分K 進場」的混合版（v3 + 日線 EMA20 > EMA60 才做多、< 才做空）。
用法：python strategy/daily_compare.py history/twii_60min.csv history/tx_1min [輸出交易紀錄 csv]
"""
import bisect, csv, datetime as dt, sys
from backtest import load, indicators, twii_revised, tx_revised, COST
from build_bars import build
import v3, daily

CAP, MULT, FEE = 200000, 10, 25
START = dt.datetime(2024, 1, 29)   # 日K 指標暖機完的第一天，兩邊都從這天算
TWO = dt.datetime(2024, 11, 7)     # 跟 v3 交易紀錄 CSV 同一段「近 2 年」


def daily_filter(hourly_T, dbars, dind, close_hm):
    """每根 60 分K 對應「已收完」的最後一根日K 的 EMA20、EMA60（不偷看當天）。"""
    ends = [dt.datetime.combine(t.date(), close_hm) for t in dbars[0]]
    DC, DE = [], []
    for t in hourly_T:
        j = bisect.bisect_right(ends, t) - 1
        ok = j >= daily.WARMUP
        DC.append(dind["E20"][j] if ok else None); DE.append(dind["E60"][j] if ok else None)
    return DC, DE


def money(tr):
    """逐筆換算成 1 口微台的帳戶金額；最後一筆若還沒出場，只扣進場費用。"""
    eq = pk = CAP; dd = worst = 0; rows = []
    for x in tr:
        pts = x["r"] * x["R"] + COST          # 引擎扣的 COST 點加回，改扣實際費用
        fee = FEE if x["open"] else 2 * FEE
        twd = pts * MULT - fee
        eq += twd; pk = max(pk, eq); dd = min(dd, eq - pk); worst = min(worst, twd)
        rows.append(dict(x, pts=pts, fee=fee, twd=twd, eq=eq))
    return dict(eq=eq, dd=dd, worst=worst, fees=sum(r["fee"] for r in rows), rows=rows,
                unreal=sum(r["twd"] for r in rows if r["open"]))


def line(name, tr):
    s, m = daily.stats(tr), money(tr)
    avgR = sum(x["R"] for x in tr) / len(tr) if tr else 0
    maxR = max((x["R"] for x in tr), default=0)
    hold = sum((x["exit_t"] - x["entry_t"]).days for x in tr) / len(tr) if tr else 0
    top2 = sum(sorted(x["r"] for x in tr)[-2:]) if tr else 0
    print(f"{name:22s} {s['n']:3d} 筆 勝率 {s['win']:.0%} 合計 {s['tot']:+6.1f}R 回落 {s['dd']:5.1f}R t {s['t']:.2f} "
          f"前2筆 {top2:+5.1f}R | 停損平均 {avgR:4.0f} 點 最大 {maxR:4.0f} 點 持有 {hold:4.1f} 天 | "
          f"期末 {m['eq']:>9,.0f}（未實現 {m['unreal']:+,.0f}） 回落 {m['dd']:>8,.0f} 單筆最大虧 {m['worst']:>7,.0f} 費用 {m['fees']:,.0f}")
    return m


if __name__ == "__main__":
    hb = load(sys.argv[1]); hind = indicators(*hb)
    data = daily.load_all(sys.argv[1], sys.argv[2])
    db, dind = data["tw"]
    sp, si, i0, off = data["tx"]
    rows = build(sys.argv[2], verbose=False)
    tb = ([r[0] for r in rows], *([r[k] for r in rows] for k in range(1, 5))); tind = indicators(*tb)
    tx_start = sp[0][i0]

    # 混合版：日K 定方向、60 分K 照 v3 進出場
    hind[("reg", "d", "13:00")] = daily_filter(hb[0], db, dind, dt.time(13, 30))
    tind[("reg", "d", "12:45")] = daily_filter(tb[0], sp, si, dt.time(13, 45))
    HYB = dict(v3.V3, regime="d", longs="regime", shorts="regime")

    strat = {
        "v3（60 分K）": lambda: [x for x in v3.run(hb, hind, twii_revised, "13:00", v3.V3) if x["t"] >= START],
        "v3 條件直接搬到日K": lambda: daily.run(db, dind, daily.D_V3),
        "日K D1": lambda: daily.run(db, dind, daily.D1),
        "日K D2（收盤進場）": lambda: daily.run(db, dind, daily.D2),
        "混合：日K方向+60分K": lambda: [x for x in v3.run(hb, hind, twii_revised, "13:00", HYB) if x["t"] >= START],
    }
    txs = {
        "v3（60 分K）": lambda: [x for x in v3.run(tb, tind, tx_revised, "12:45", v3.V3) if x["t"] >= tx_start],
        "v3 條件直接搬到日K": lambda: daily.run(sp, si, daily.D_V3, sig_from=i0),
        "日K D1": lambda: daily.run(sp, si, daily.D1, sig_from=i0),
        "日K D2（收盤進場）": lambda: daily.run(sp, si, daily.D2, sig_from=i0),
        "混合：日K方向+60分K": lambda: [x for x in v3.run(tb, tind, tx_revised, "12:45", HYB) if x["t"] >= tx_start],
    }
    res = {k: f() for k, f in strat.items()}
    for title, cut in ((f"== 加權指數 {START:%Y/%m/%d} 起（約 2.8 年）", START), (f"== 近 2 年 {TWO:%Y/%m/%d} 起", TWO),
                       (f"== 驗證段 {daily.SPLIT:%Y/%m/%d} 起", daily.SPLIT)):
        print(title)
        for k, tr in res.items():
            line(k, [x for x in tr if x["t"] >= cut])
    print(f"== 台指期日夜盤 {tx_start:%Y/%m/%d} 起（約 1 個月；日K 指標用加權指數平移 {off:+.0f} 點暖機）")
    for k, f in txs.items():
        line(k, f())
    for cut in (START, TWO):
        T, C = db[0], db[4]
        i = next(i for i, t in enumerate(T) if t >= cut)
        pk = C[i]; mdd = 0
        for c in C[i:]:
            pk = max(pk, c); mdd = min(mdd, (c - pk) * MULT)
        print(f"對照：{cut:%Y/%m/%d} 起 1 口微台買進持有 期末 {CAP + (C[-1] - C[i]) * MULT - 2 * FEE:,.0f}，回落 {mdd:,.0f}")

    print("== 日K D2 交易明細（加權指數）")
    m = money(res["日K D2（收盤進場）"])
    for x in m["rows"]:
        print(f"{x['t']:%Y-%m-%d} {x['kind']} {'多' if x['side'] > 0 else '空'} 進 {x['entry']:.0f} 停損 {x['R']:.0f} 點 "
              f"出 {x['exit_t']:%Y-%m-%d} {x['exit']:.0f} {x['why']} {x['r']:+.2f}R {x['twd']:+,.0f} 元 帳戶 {x['eq']:,.0f}")
    print("== 日K D2 台指期 1 個月明細")
    for x in money(txs["日K D2（收盤進場）"]())["rows"]:
        print(f"{x['t']:%Y-%m-%d} {'多' if x['side'] > 0 else '空'} 進 {x['entry_t']:%m/%d} {x['entry']:.0f} 停損 {x['R']:.0f} 點 "
              f"出 {x['exit_t']:%m/%d} {x['exit']:.0f} {x['why']} {x['r']:+.2f}R {x['twd']:+,.0f} 元")

    if len(sys.argv) > 3:
        with open(sys.argv[3], "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["序號", "類型", "方向", "訊號日", "進場日", "進場價", "初始停損", "停損點數", "出場日", "出場價", "出場原因",
                        "損益點(毛)", "費用(元)", "損益(元)", "累計帳戶(元)", "R倍數", "持有天數(交易日)"])
            for n, x in enumerate(m["rows"], 1):
                w.writerow([n, x["kind"], "多" if x["side"] > 0 else "空", f"{x['t']:%Y-%m-%d}", f"{x['entry_t']:%Y-%m-%d}",
                            f"{x['entry']:.0f}", f"{x['stop0']:.0f}", f"{x['R']:.0f}", f"{x['exit_t']:%Y-%m-%d}", f"{x['exit']:.0f}",
                            x["why"], f"{x['pts']:.0f}", x["fee"], f"{x['twd']:.0f}", f"{x['eq']:.0f}", f"{x['r']:.2f}", x["bars"]])
        print("輸出", sys.argv[3])
