"""台指日K 策略：把 v3（60 分K）的條件改成日K，並重新調整參數。

資料只用已累積的兩份：
  - history/twii_60min.csv：加權指數日盤 60 分K（Yahoo，約 3 年）→ 合成日K
  - history/tx_1min/：台指期近月日夜盤 1 分K（約 1 個月）→ 合成日K（夜盤併入下一個交易日）
台指期只有 1 個月，指標算不出來，所以前面接上加權指數日K（依重疊日的價差平移）暖機，
只有訊號落在台指期期間的交易才算「台指期 1 個月」。

用法：python strategy/daily.py history/twii_60min.csv [history/tx_1min]
"""
import bisect, datetime as dt, itertools, statistics as st, sys
from collections import defaultdict, OrderedDict
from backtest import load, indicators, ema, COST

SPLIT = dt.datetime(2026, 3, 7)        # 跟 v3 一樣：之前挑參數，之後驗證
WARMUP = 60                             # 日K 前 60 根只算指標


# ---------- 日K 合成 ----------
def twii_daily(bars):
    """加權指數 60 分K → 日K（09:00 那根開盤、13:00 那根收盤）。"""
    T, O, H, L, C = bars
    d = OrderedDict()
    for t, o, h, l, c in zip(T, O, H, L, C):
        k = t.date()
        if k not in d:
            d[k] = [o, h, l, c]
        else:
            b = d[k]; b[1] = max(b[1], h); b[2] = min(b[2], l); b[3] = c
    return _pack(d)


def tx_daily(rows, night=True):
    """台指期 60 分K（build_bars 輸出）→ 日K。夜盤（15:00–05:00）算進下一個日盤的交易日，
    跟期交所的交易日定義一樣；最後一段沒有日盤的夜盤不算。night=False 只用日盤。"""
    day_starts = sorted({r[0] for r in rows if r[0].time() == dt.time(8, 45)})
    d = OrderedDict()
    for t, o, h, l, c, v in rows:
        if dt.time(8, 45) <= t.time() <= dt.time(13, 45):
            k = t.date()
        else:
            if not night:
                continue
            j = bisect.bisect_right(day_starts, t)
            if j >= len(day_starts):
                continue
            k = day_starts[j].date()
        if k not in d:
            d[k] = [o, h, l, c]
        else:
            b = d[k]; b[1] = max(b[1], h); b[2] = min(b[2], l); b[3] = c
    return _pack(d)


def _pack(d):
    T = [dt.datetime.combine(k, dt.time(0)) for k in d]
    O, H, L, C = ([v[i] for v in d.values()] for i in range(4))
    return T, O, H, L, C


def splice(base, tail):
    """把 tail（台指期日K）接在 base（加權指數日K）後面；base 依第一個重疊日的收盤價差平移。
    回傳 (合併日K, tail 第一天的索引)。"""
    t0 = tail[0][0]
    i = base[0].index(t0)
    off = tail[4][0] - base[4][i]
    head = tuple(base[0][:i] if k == 0 else [x + off for x in base[k][:i]] for k in range(5))
    return tuple(head[k] + list(tail[k]) for k in range(5)), i, off


# ---------- 回測引擎 ----------
def run(bars, ind, p, start_i=WARMUP, sig_from=None):
    """跟 v3.run 同一套進出場邏輯，差別：
    - 每根 K 都可以進場（沒有時段濾網），在下一根（隔天）開盤市價成交；
    - 突破條件可選「收盤 > 布林上軌」或「收盤創 N 日新高」；
    - 參數都以日K 的 ATR 為單位。"""
    T, O, H, L, C = bars
    n = len(C)
    E10, E20, E60, hist = ind["E10"], ind["E20"], ind["E60"], ind["hist"]
    MID, SD, ATR = ind["MID"], ind["SD"], ind["ATR"]
    REG = ind.setdefault(("reg", p["regime"]), ema(C, p["regime"]) if p["regime"] else None)
    trades, i = [], start_i
    while i < n - 1:
        sig = None
        if sig_from is None or i >= sig_from:
            for s in (1, -1):
                if s < 0 and p["shorts"] == "none":
                    continue
                if s < 0 and p["shorts"] == "regime" and (C[i] - REG[i]) >= 0:
                    continue
                if p.get("trend", True) and (E20[i] - E60[i]) * s <= 0:
                    continue
                if p.get("slope") and (E60[i] - E60[i - p["slope"]]) * s <= 0:  # EMA60 要往同方向走
                    continue
                if p.get("vol_max") and ATR[i] / C[i] > p["vol_max"]:  # 日波動太大的時候不開新倉
                    continue
                body, rng = (C[i] - O[i]) * s, H[i] - L[i]
                strong = body > 0 and body >= 0.5 * rng
                if p["entry"] == "bb":
                    brk = (C[i] - (MID[i] + 2 * SD[i] * s)) * s > 0
                else:  # 收盤創 N 日新高 / 新低
                    N = p["entry"]
                    w = C[i - N:i]
                    brk = (C[i] > max(w)) if s > 0 else (C[i] < min(w))
                if strong and body >= p["body_atr"] * ATR[i - 1] and brk and (hist[i] * s > 0 or not p.get("macd", True)):
                    sig = (s, "突破"); break
                if p["pullback"] and strong \
                        and ((L[i] if s > 0 else H[i]) - E20[i]) * s <= 0 and (C[i] - E20[i]) * s > 0 \
                        and (C[i] - (H[i - 1] if s > 0 else L[i - 1])) * s > 0 \
                        and (E60[i] - E60[i - 5]) * s > 0:
                    sig = (s, "拉回"); break
        if not sig:
            i += 1
            continue
        side, kind = sig
        close_in = p.get("entry_at") == "close"   # 收盤前進場（台指期 13:45 收盤，比加權指數晚 15 分鐘）
        e = C[i] if close_in else O[i + 1]
        e += p.get("slip_atr", 0) * ATR[i] * side   # 假設成交比收盤價差（滑價、加權指數與台指期收盤差 15 分鐘）
        ext = L[i] if side > 0 else H[i]
        raw = abs(e - (ext - 0.1 * ATR[i] * side))
        if raw > p.get("max_atr", p["stop_atr"] + 0.5) * ATR[i]:  # 訊號K 端點離進場價太遠（跳空或長K）不做
            i += 1; continue
        stop = e - max(min(raw, p["stop_atr"] * ATR[i]), 0.5 * ATR[i]) * side
        R = abs(e - stop)
        if p.get("cap_pts") and R > p["cap_pts"]:  # 停損點數超過上限（1 口微台的金額風險太大）不做
            i += 1; continue
        pnl, be, j, best = 0.0, False, i + 1, e
        stop0, xt, xp, still_open, why = stop, None, None, False, ""
        while j < n:
            worst = L[j] if side > 0 else H[j]
            if (worst - stop) * side <= 0:
                gap = (O[j] - stop) * side <= 0
                px = O[j] if gap else stop
                pnl = (px - e) * side; xt, xp = T[j], px
                why = ("移動停利" if (stop - e) * side > COST else "保本停損" if be else "初始停損") + ("（跳空成交）" if gap else "")
                break
            if not be and (C[j] - e) * side >= p["be_r"] * R:
                be, stop = True, e + COST * side
            if j + 1 >= n:
                pnl = (C[j] - e) * side; xt, xp, still_open, why = T[j], C[j], True, "持倉中"
                break
            if be:
                if p["exit"] in ("ema20", "ema10"):
                    EX = E20 if p["exit"] == "ema20" else E10
                    if (C[j] - EX[j]) * side < 0:
                        pnl = (O[j + 1] - e) * side; xt, xp, why = T[j + 1], O[j + 1], "跌破" + p["exit"].upper(); j += 1; break
                else:
                    best = max(best * side, C[j] * side) * side
                    trail = best - p["exit"] * ATR[j] * side
                    if (trail - stop) * side > 0:
                        stop = trail
            j += 1
        net = pnl - COST
        trades.append(dict(t=T[i], side=side, kind=kind, R=R, r=net / R, bars=j - i, entry=e, entry_t=T[i] if close_in else T[i + 1],
                           stop0=stop0, stop=stop, exit_t=xt, exit=xp, open=still_open, be=be, why=why))
        i = j
    return trades


def stats(tr):
    if not tr:
        return dict(n=0, tot=0, avg=0, dd=0, pf=0, t=0, win=0)
    r = [x["r"] for x in tr]
    eq = pk = dd = 0
    for v in r:
        eq += v; pk = max(pk, eq); dd = min(dd, eq - pk)
    g = sum(v for v in r if v > 0); l = -sum(v for v in r if v < 0)
    t = st.mean(r) / st.stdev(r) * len(r) ** 0.5 if len(r) > 2 and st.stdev(r) else 0
    return dict(n=len(r), tot=sum(r), avg=st.mean(r), dd=dd, pf=g / l if l else 99, t=t,
                win=sum(v > 0.1 for v in r) / len(r))


def fmt(s):
    return (f"{s['n']:>3} 筆 勝率 {s['win']:.0%} 平均 {s['avg']:+.2f}R 合計 {s['tot']:+6.1f}R "
            f"回落 {s['dd']:5.1f}R PF {s['pf']:.2f} t {s['t']:.2f}")


GRID = dict(
    entry=["bb", 20, 55],
    body_atr=[0.0, 0.3, 0.5, 0.8],
    pullback=[False, True],
    stop_atr=[1.0, 1.5, 2.0],
    be_r=[1.0, 1.5, 2.0],
    exit=["ema20", 2.0, 3.0, 4.0, 5.0],
    macd=[True, False],
    shorts=["all", "regime", "none"],
    regime=[120],
)
# 把 v3 原封不動搬到日K（參數全照 60 分K）
D_V3 = dict(entry="bb", body_atr=0.8, pullback=True, stop_atr=1.5, be_r=1.0, exit=5.0, shorts="all", regime=120)
# 日K 調整版（2026-11-07，前段挑參數，見 README）
# 收盤創 20 日新高（新低）、實體 ≥ 高低差 50%、EMA20 > EMA60；停損 1 ATR、1R 保本、保本後收盤跌破 EMA20 出場
D1 = dict(entry=20, body_atr=0.0, macd=False, pullback=False, stop_atr=1.0, be_r=1.0, exit="ema20", shorts="all", regime=120)
# D2（2026-11-07 第二次調整）：D1 改成訊號當天收盤前進場（加權指數 13:30 收盤後、台指期 13:45 收盤前），不等隔天開盤
D2 = dict(D1, entry_at="close")


def load_all(twii_path, tx_dir=None):
    tw = twii_daily(load(twii_path))
    out = dict(tw=(tw, indicators(*tw)))
    if tx_dir:
        from build_bars import build
        rows = build(tx_dir, verbose=False)
        for key, night in (("tx", True), ("txday", False)):
            tx = tx_daily(rows, night)
            sp, i0, off = splice(tw, tx)
            out[key] = (sp, indicators(*sp), i0, off)
    return out


if __name__ == "__main__":
    data = load_all(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    b, ind = data["tw"]
    print("加權指數日K", len(b[0]), "根", b[0][0].date(), "→", b[0][-1].date(), "，第", WARMUP, "根起有訊號：", b[0][WARMUP].date())
    res = []
    for combo in itertools.product(*GRID.values()):
        p = dict(zip(GRID, combo))
        if p["entry"] != "bb" and p["body_atr"] > 0.5:
            continue
        tr = run(b, ind, p)
        res.append((p, stats([x for x in tr if x["t"] < SPLIT]), stats([x for x in tr if x["t"] >= SPLIT]), stats(tr)))
    print("組合數", len(res))

    def show(p, ins, oos, al):
        print(p); print("   前段", fmt(ins)); print("   後段", fmt(oos)); print("   全部", fmt(al))
        for key in ("tx", "txday"):
            if key in data:
                sp, si, i0, off = data[key]
                print(f"   台指期1月{'(日夜)' if key == 'tx' else '(只日盤)'}", fmt(stats(run(sp, si, p, sig_from=i0))))

    for name, cfg in (("v3 條件直接搬到日K", D_V3), ("日K 調整版 D1", D1), ("日K D2（收盤進場）", D2)):
        print("==", name)
        tr = run(b, ind, cfg)
        show(cfg, stats([x for x in tr if x["t"] < SPLIT]), stats([x for x in tr if x["t"] >= SPLIT]), stats(tr))
    print("== 前段合計 R 最高 15 組（前段至少 12 筆）")
    for r in sorted([r for r in res if r[1]["n"] >= 12], key=lambda r: -r[1]["tot"])[:15]:
        show(*r)
    print("== 各參數值平均（前段 / 後段 合計 R）")
    for k in GRID:
        for v in GRID[k]:
            sub = [r for r in res if r[0][k] == v]
            if sub:
                print(f"   {k}={v}: {sum(r[1]['tot'] for r in sub) / len(sub):+.1f} / "
                      f"{sum(r[2]['tot'] for r in sub) / len(sub):+.1f}  ({len(sub)})")
