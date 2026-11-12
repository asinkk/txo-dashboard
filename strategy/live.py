"""即時策略看板：台指期 v3 四個版本（60 分K、30 分K 各兩版）目前的訊號、部位、停損與進場條件。
  - v3：原規則，只在日盤 08:45–11:45、夜盤 21:00–23:00（美國冬令 22:00–00:00）開始的 60 分K 開新倉
  - v3 不限時段：規則相同，但日夜盤任何一根 60 分K 收完都可以開新倉
  - v3・30 分K／v3 不限時段・30 分K：同一套規則與參數（指標根數不變），改用 30 分K；
    限時段版的開倉時段跟 60 分K 一樣（落在上述 60 分K 裡的 30 分K 都可以開）

資料：
  - history/tx_1min/：每天台北 06:30 存的期交所每筆成交（轉成 1 分K）
  - 期交所 MIS 即時 1 分K（getChartData1M）：補上目前或最近一個日盤、夜盤還沒存進 history 的部分
訊號、部位、停損全部只用台指期近月的日盤＋夜盤 60 分K／30 分K。
加權指數（history/twii_60min.csv）只用在歷史成交紀錄頁的回測，不影響這裡的訊號。
策略規則完全沿用 v3.run（V3），這裡只負責接資料、判斷最後一根 K 是否已收完、
把結果整理成網頁。條件明細（✓/✗）是顯示用的重算，判斷進出場以 run() 的結果為準。

用法：python strategy/live.py [--src history/tx_1min] [--twii history/twii_60min.csv] [--out docs] [--offline]
"""
import argparse, bisect, csv, datetime as dt, glob, html, json, os, shutil, sys, tempfile, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_bars import build
from backtest import load, indicators, tx_revised, tx_revised30, us_dst, COST
import v3
import trades_page
import collect_ticks

MIS = "https://mis.taifex.com.tw/futures/api/"
MONTHS = "ABCDEFGHIJKL"
FORWARD_START = dt.datetime(2026, 11, 9, 8, 45)   # v3 規則 11/7 定案，11/9 起算前測（不限時段版沿用同一天，之前都算回測）
CAP, MULT, FEE = 200000, 10, 25                   # 本金 20 萬、1 口微台（每點 10 元）、每次下單 25 元
# 兩個版本規則都是 v3.V3，只差「哪些時段開始的 60 分K 可以開新倉」：
#   v3    日盤 08:45–11:45、夜盤 21:00–23:00（美國冬令 22:00–00:00）開始的 K（backtest.tx_revised）
#   v3all 不限時段，日夜盤任何一根 60 分K 收完都可以開新倉（Monkey 2026-11-10 要求加這一版並列）
#   v3_30 / v3all_30  同樣兩版改用 30 分K（Monkey 2026-11-12 要求加 30 分K 版本），參數不變；前測從 11/12 夜盤算起
# (key, 開倉時段, K 棒分鐘數, 前測開始)
FORWARD_START30 = dt.datetime(2026, 11, 12, 15, 0)
STRATS = (("v3", tx_revised, 60, FORWARD_START), ("v3all", None, 60, FORWARD_START),
          ("v3_30", tx_revised30, 30, FORWARD_START30), ("v3all_30", None, 30, FORWARD_START30))
NAMES = {"v3": "v3（限時段）", "v3all": "v3 不限時段", "v3_30": "v3・30 分K（限時段）", "v3all_30": "v3 不限時段・30 分K"}


def now_tpe():
    return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None, microsecond=0) + dt.timedelta(hours=8)


# ---------- 即時 1 分K ----------
def post(ep, body):
    req = urllib.request.Request(MIS + ep, json.dumps(body).encode(),
                                 {"Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (txo-dashboard)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def contract_code(sym, year_now):
    """TXFK6-F → 202611（月份字母 A–L，年份個位數）。"""
    y = year_now // 10 * 10 + int(sym[4])
    if y < year_now - 1:
        y += 10
    return f"{y}{MONTHS.index(sym[3]) + 1:02d}"


def fetch_live(now):
    """回傳 (sessions, info)。sessions：[(開始時間, {契約: {datetime: [o,h,l,c,v]}})]，每個盤別一筆；
    每個盤別抓成交量前兩大的契約，換月時 build_bars 才算得出新舊月價差。"""
    sessions, info = [], {}
    for mt, name in (("0", "日盤"), ("1", "夜盤")):
        try:
            q = post("getQuoteList", {"MarketType": mt, "SymbolType": "F", "KindID": "1", "CID": "TXF", "ExpireMonth": "",
                                      "RowSize": "全部", "PageNo": "", "SortColumn": "", "AscDesc": "A"})["RtData"]["QuoteList"]
        except Exception as e:
            info[name] = {"error": f"報價清單抓取失敗：{e}"}
            continue
        futs = [x for x in q if x.get("SymbolID", "").startswith("TXF") and len(x["SymbolID"]) > 4 and x["SymbolID"][3] in MONTHS]
        futs.sort(key=lambda x: -int(float(x.get("CTotalVolume") or 0)))
        by_contract, start = {}, None
        for k, f in enumerate(futs[:2]):
            try:
                d = post("getChartData1M", {"SymbolID": f["SymbolID"]})["RtData"]
            except Exception as e:
                info.setdefault(name, {"error": f"1 分K 抓取失敗：{e}"})
                continue
            base = dt.datetime.strptime(d["Quote"]["CDate"], "%Y%m%d")
            bars = {}
            for t, o, h, l, c, v in d.get("Ticks") or []:
                hh, mm = int(t[:2]), int(t[2:4])
                day = base + dt.timedelta(days=1) if mt == "1" and hh < 15 else base
                ts = day + dt.timedelta(minutes=hh * 60 + mm - 1)   # MIS 標的是這分鐘的結束時間
                o, h, l, c, v = float(o), float(h), float(l), float(c), int(float(v))
                b = bars.get(ts)
                if b is None:
                    bars[ts] = [o, h, l, c, v]
                else:
                    b[1] = max(b[1], h); b[2] = min(b[2], l); b[3] = c; b[4] += v
            if not bars:
                continue
            by_contract[contract_code(f["SymbolID"], now.year)] = bars
            if k == 0:
                start = min(bars)
                info[name] = {"symbol": f["SymbolID"], "name": f.get("DispCName"), "last": float(d["Quote"]["CLastPrice"] or 0),
                              "ref": float(d["Quote"]["CRefPrice"] or 0), "date": d["Quote"]["CDate"],
                              "last_minute": f"{max(bars):%Y-%m-%d %H:%M}", "minutes": len(bars)}
        if by_contract and start:
            sessions.append((start, by_contract))
    sessions.sort(key=lambda s: s[0])
    return sessions, info


def merged_dir(src, sessions):
    """把 history 的檔案連到暫存資料夾，再把 history 還沒有的即時分K 依盤別各寫成一個檔案，接在最後。"""
    files = sorted(glob.glob(os.path.join(src, "Daily_*.csv")))
    if not files:
        sys.exit(f"{src} 沒有 Daily_*.csv")
    last = None
    for f in files[-2:]:
        for r in csv.DictReader(open(f, encoding="utf-8")):
            t = dt.datetime.strptime(r["date"] + r["time"], "%Y%m%d%H%M")
            last = t if last is None or t > last else last
    tmp = tempfile.mkdtemp(prefix="txlive_")
    for f in files:
        shutil.copy(f, tmp)
    added, stem = 0, os.path.basename(files[-1])[:-4]
    for k, (_, by_contract) in enumerate(sessions, 1):
        rows = [(c, t, b) for c, bars in by_contract.items() for t, b in bars.items() if t > last]
        if not rows:
            continue
        rows.sort(key=lambda x: (x[0], x[1]))
        with open(os.path.join(tmp, f"{stem}_live{k}.csv"), "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["date", "time", "contract", "open", "high", "low", "close", "volume"])
            for c, t, (o, h, l, cl, v) in rows:
                w.writerow([f"{t:%Y%m%d}", f"{t:%H%M}", c, f"{o:g}", f"{h:g}", f"{l:g}", f"{cl:g}", v])
        front = max(by_contract, key=lambda x: len(by_contract[x]))
        added += sum(1 for c, *_ in rows if c == front)
    return tmp, last, added


def fmt_lag(m):
    m = max(0, round(m))
    return f"{m} 分鐘" if m < 120 else f"{m // 60} 小時 {m % 60} 分" if m < 2880 else f"{m // 1440} 天"


# ---------- 資料缺口 ----------
def history_last(src):
    files = sorted(glob.glob(os.path.join(src, "Daily_*.csv")))
    last = None
    for f in files[-2:]:
        for r in csv.DictReader(open(f, encoding="utf-8")):
            t = dt.datetime.strptime(r["date"] + r["time"], "%Y%m%d%H%M")
            last = t if last is None or t > last else last
    return last


def find_gap(hist_last, sessions, now):
    """應該開盤卻沒有資料的盤別開始時間：history 最後一分鐘到即時資料第一分鐘之間，以及即時資料最後一分鐘到現在之間。
    只看平日 08:45 日盤、15:00 夜盤，不知道國定假日，所以假日會被當成缺口（補抓時期交所沒有檔案，只會留下提示）。"""
    def expected(a, b):
        out, d = [], a.date()
        while d <= b.date():
            if d.weekday() < 5:
                for hm in (dt.time(8, 45), dt.time(15, 0)):
                    st = dt.datetime.combine(d, hm)
                    if a < st <= b - dt.timedelta(minutes=5):
                        out.append(st)
            d += dt.timedelta(days=1)
        return out
    new = [t for _, bc in sessions for bars in bc.values() for t in bars if t > hist_last]
    if not new:
        return expected(hist_last, now)
    return expected(hist_last, min(new)) + expected(max(new), now)   # 中間缺的盤＋現在這盤即時資料沒出來


# ---------- K 棒 ----------
def with_dummy(bars, step):
    """在最後面多接一根「開高低收都等於最後收盤」的假 K，讓 run() 也會檢查最後一根 K 的訊號與出場。"""
    T, O, H, L, C = bars
    c = C[-1]
    return (T + [T[-1] + step], O + [c], H + [c], L + [c], C + [c])


def evaluate(bars, runner, step):
    ind = indicators(*bars)
    trades = runner(bars, ind)
    b2 = with_dummy(bars, step)
    trades2 = runner(b2, indicators(*b2))
    pos = next((x for x in trades if x["open"]), None)
    sig = next((x for x in trades2 if x["t"] == bars[0][-1]), None)
    pending_exit = None
    if pos:
        y = next((x for x in trades2 if x["t"] == pos["t"]), None)
        if y and not y["open"]:
            pending_exit = y
    return dict(ind=ind, trades=trades, pos=pos, sig=sig, pending_exit=pending_exit)


# ---------- 進出場時間（精確到分鐘） ----------
def exit_reason_v3(x):
    why = "移動停利" if (x["stop"] - x["entry"]) * x["side"] > COST else "保本停損" if x["be"] else "初始停損"
    return why + ("（跳空成交）" if round(x["exit"]) != round(x["stop"]) else "")


def first_touch(mT, m, start, end, stop, side):
    """[start, end) 之間第一根碰到停損的 1 分K 時間。"""
    i = bisect.bisect_left(mT, start)
    while i < len(m) and mT[i] < end:
        if (((m[i][3] if side > 0 else m[i][2]) - stop) * side) <= 0:
            return mT[i]
        i += 1
    return None


def refine_times(trades, m, minutes=60):
    """run() 的時間是 K 棒（60 或 30 分K）的開始時間。停損出場改成 1 分K 第一次碰到停損的那一分鐘（m 是換月調整後的 1 分K）。"""
    mT = [r[0] for r in m]
    for x in trades:
        x.setdefault("why", "" if x["open"] else exit_reason_v3(x))
        if x["open"]:
            continue
        t = first_touch(mT, m, x["exit_t"], x["exit_t"] + dt.timedelta(minutes=minutes), x["stop"], x["side"])
        if t:
            x["exit_t"] = t
    return trades


# ---------- 條件明細（顯示用） ----------
def ck(name, ok, detail=""):
    return {"name": name, "ok": bool(ok), "detail": detail}


def proj_stop(e, ext, atr, side, stop_atr, max_atr):
    raw = abs(e - (ext - 0.1 * atr * side))
    stop = e - max(min(raw, stop_atr * atr), 0.5 * atr) * side
    return raw <= max_atr * atr, stop, raw


def v3_checks(bars, ind, i, allowed=tx_revised):
    """allowed=None 表示不限建立新倉時間（不列「可進場時段」這一項）。"""
    T, O, H, L, C = bars
    E20, E60, hist, MID, SD, ATR = (ind[k] for k in ("E20", "E60", "hist", "MID", "SD", "ATR"))
    p, out = v3.V3, {}
    for s, side in ((1, "多"), (-1, "空")):
        body, rng = (C[i] - O[i]) * s, H[i] - L[i]
        strong = body > 0 and body >= 0.5 * rng
        bb = MID[i] + 2 * SD[i] * s
        prev = H[i - 1] if s > 0 else L[i - 1]
        gt = ">" if s > 0 else "<"
        ok_stop, stop, raw = proj_stop(C[i], L[i] if s > 0 else H[i], ATR[i], s, p["stop_atr"], p["stop_atr"] + 0.5)
        out[side] = {
            "common": ([ck("可進場時段", allowed(T[i]), f"{T[i]:%H:%M} 這根")] if allowed else []) +
                      [ck(f"趨勢 EMA20 {gt} EMA60", (E20[i] - E60[i]) * s > 0, f"{E20[i]:,.0f} / {E60[i]:,.0f}")],
            "突破": [ck(f"{'紅' if s > 0 else '黑'}K 實體 ≥ 高低差一半", strong, f"實體 {(C[i] - O[i]):+,.0f}、高低差 {rng:,.0f}"),
                     ck("實體 ≥ 0.8 ATR", body >= p["body_atr"] * ATR[i - 1], f"需 {p['body_atr'] * ATR[i - 1]:,.0f} 點"),
                     ck(f"收盤{'站上布林上軌' if s > 0 else '跌破布林下軌'}", (C[i] - bb) * s > 0, f"{'上' if s > 0 else '下'}軌 {bb:,.0f}"),
                     ck(f"MACD 柱{'翻正' if s > 0 else '翻負'}", hist[i] * s > 0, f"{hist[i]:+,.1f}")],
            "拉回": [ck(f"{'紅' if s > 0 else '黑'}K 實體 ≥ 高低差一半", strong, ""),
                     ck(f"{'低點碰到' if s > 0 else '高點碰到'} EMA20", ((L[i] if s > 0 else H[i]) - E20[i]) * s <= 0, f"EMA20 {E20[i]:,.0f}"),
                     ck(f"收盤{'站回' if s > 0 else '壓回'} EMA20", (C[i] - E20[i]) * s > 0, ""),
                     ck(f"收盤{'過前一根高點' if s > 0 else '破前一根低點'}", (C[i] - prev) * s > 0, f"{prev:,.0f}"),
                     ck(f"EMA60 比 5 根前{'高' if s > 0 else '低'}", (E60[i] - E60[i - 5]) * s > 0, f"{E60[i] - E60[i - 5]:+,.0f}")],
            "stop": {"ok": ok_stop, "stop": stop, "raw": raw},
        }
    return out


# ---------- 輸出 ----------
def twd(x):
    return (x["r"] * x["R"] + COST) * MULT - (FEE if x["open"] else 2 * FEE)


def why_text(x):
    return x.get("why", "")


def trade_row(x, last_c=None, fwd=FORWARD_START):
    """last_c：持倉中的交易用這個價格算未實現損益（台指期用現價；None 表示用 run() 最後一根收盤）。
    fwd：前測開始時間（訊號 K 在這之後算「前測」）。60 分K 版沿用原本「11/9 當天 0 點起」的算法。"""
    if x["open"] and last_c is not None:
        pts = (last_c - x["entry"]) * x["side"]
        x = dict(x, r=(pts - COST) / x["R"])
    return {"signal": f"{x['t']:%Y-%m-%d %H:%M}", "kind": x["kind"], "side": "多" if x["side"] > 0 else "空",
            "entry_t": f"{x['entry_t']:%Y-%m-%d %H:%M}", "entry": round(x["entry"]), "stop0": round(x["stop0"]),
            "stop": round(x["stop"]), "exit_t": "" if x["open"] else f"{x['exit_t']:%Y-%m-%d %H:%M}",
            "exit": "" if x["open"] else round(x["exit"]), "r": round(x["r"], 2), "pts": round(x["r"] * x["R"] + COST),
            "twd": round(twd(x)), "open": x["open"], "be": x["be"], "why": why_text(x),
            "phase": "前測" if x["t"] >= (fwd.replace(hour=0, minute=0) if fwd == FORWARD_START else fwd) else "回測"}


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--src", default=os.path.join(here, "..", "history", "tx_1min"))
    ap.add_argument("--twii", default=os.path.join(here, "..", "history", "twii_60min.csv"))
    ap.add_argument("--out", default=os.path.join(here, "..", "docs"))
    ap.add_argument("--offline", action="store_true", help="不抓即時分K，只用 history")
    ap.add_argument("--now", help="測試用：假裝現在是台北時間 YYYY-mm-ddTHH:MM")
    a = ap.parse_args()

    now = dt.datetime.strptime(a.now, "%Y-%m-%dT%H:%M") if a.now else now_tpe()
    sessions, info = ([], {}) if a.offline else fetch_live(now)
    # 06:30 的存檔漏跑時，期交所即時 1 分K 只留最近一個日盤、一個夜盤，中間會缺。這時先去期交所補抓每日成交檔。
    gap = find_gap(history_last(a.src), sessions, now)
    if gap and not a.offline:
        print("資料缺口", [f"{g:%m-%d %H:%M}" for g in gap], "→ 補抓期交所每日成交")
        try:
            collect_ticks.collect(a.src, refresh=0)
        except Exception as e:
            print("補抓失敗", e)
        gap = find_gap(history_last(a.src), sessions, now)
    prev_gen = None
    try:
        prev_gen = dt.datetime.strptime(json.load(open(os.path.join(a.out, "live.json"), encoding="utf-8"))["generated"], "%Y-%m-%d %H:%M")
    except Exception:
        pass
    tmp, hist_last, added = merged_dir(a.src, sessions)
    try:
        rows = build(tmp, verbose=False)
        m1 = build(tmp, 1, verbose=False)   # 換月調整後的 1 分K，找停損觸價時間用
        rows30 = build(tmp, 30, verbose=False)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    def to_bars(rs):
        return ([r[0] for r in rs], *([r[k] for r in rs] for k in range(1, 5)))
    hbs = {60: to_bars(rows), 30: to_bars(rows30)}
    T = hbs[60][0]
    last_c = hbs[60][4][-1]

    # 最後一根 K 收完了沒（同分鐘數的版本用同一套 K 棒）
    bar_end = {mn: b[0][-1] + dt.timedelta(minutes=mn) for mn, b in hbs.items()}
    res = {}
    for key, allowed, mn, fwd in STRATS:
        hb = hbs[mn]
        r = evaluate(hb, lambda b, ind: v3.run(b, ind, allowed, "12:45" if mn == 60 else "13:15", v3.V3), dt.timedelta(minutes=mn))
        r["checks"] = v3_checks(hb, r["ind"], len(hb[0]) - 1, allowed)
        refine_times(r["trades"], m1, mn)
        r["mn"], r["fwd"] = mn, fwd
        res[key] = r

    def pos_info(r):
        x = r["pos"]
        if not x:
            return None
        pts = (last_c - x["entry"]) * x["side"]
        R = x["R"]
        d = {"side": "多" if x["side"] > 0 else "空", "kind": x["kind"], "entry_t": f"{x['entry_t']:%Y-%m-%d %H:%M}",
             "entry": round(x["entry"]), "stop0": round(x["stop0"]), "stop": round(x["stop"]), "be": x["be"], "R": round(R),
             "pts": round(pts), "twd": round(pts * MULT - FEE), "to_stop": round((last_c - x["stop"]) * x["side"]),
             "be_at": round(x["entry"] + 1.0 * R * x["side"]),
             "trail_note": (f"保本後停損改成「進場後{'最高收盤 − 5 ATR' if x['side'] > 0 else '最低收盤 + 5 ATR'}」，只往有利方向移動；"
                            f"目前 ATR {r['ind']['ATR'][-1]:,.0f}")}
        if r["pending_exit"]:
            d["pending_exit"] = f"{why_text(r['pending_exit']) or '出場條件成立'}：下一根 K 開盤出場"
        return d

    def sig_time(x, mn):
        """訊號確認（K 棒收完）的時間 = 訊號 K 的結束。"""
        return x["t"] + dt.timedelta(minutes=mn)

    def sig_info(r):
        x = r["sig"]
        if not x:
            return None
        sig_t = lambda x: sig_time(x, r["mn"])
        return {"side": "多" if x["side"] > 0 else "空", "kind": x["kind"], "entry": round(x["entry"]),
                "stop": round(x["stop0"]), "R": round(x["R"]), "at": f"{sig_t(x):%m-%d %H:%M}",
                "lag": max(0, round((now - sig_t(x)).total_seconds() / 60))}

    def events(r):
        """上一次網頁更新之後發生的進出場（排程延誤或漏跑時，中間發生的事會在這裡補講）。"""
        if not prev_gen:
            return []
        out = []
        for x in r["trades"]:
            side = "多" if x["side"] > 0 else "空"
            if x["entry_t"] > prev_gen:
                st = sig_time(x, r["mn"])
                out.append(f"{x['entry_t']:%m-%d %H:%M} {side}單進場 {x['entry']:,.0f}（訊號 {st:%m-%d %H:%M} 成立，"
                           f"網頁 {now:%m-%d %H:%M} 才更新到，晚了 {fmt_lag((now - st).total_seconds() / 60)}）")
            if not x["open"] and x["exit_t"] > prev_gen:
                out.append(f"{x['exit_t']:%m-%d %H:%M} {side}單出場 {x['exit']:,.0f}（{why_text(x)}）")
        return out

    def rec(r):
        tr = [trade_row(x, last_c, r["fwd"]) for x in r["trades"]]
        fwd = [x for x in tr if x["phase"] == "前測"]
        bt = [x for x in tr if x["phase"] == "回測"]
        def summ(rs):
            closed = [x for x in rs if not x["open"]]
            return {"n": len(closed), "win": sum(x["r"] > 0.1 for x in closed), "R": round(sum(x["r"] for x in closed), 1),
                    "twd": sum(x["twd"] for x in rs)}
        return {"forward": fwd, "backtest": bt, "fsum": summ(fwd), "bsum": summ(bt), "fstart": f"{r['fwd']:%Y/%m/%d %H:%M}"}

    def levels(ind):
        return {k: round(ind[k][-1]) for k in ("E20", "E60", "ATR")} | \
               {"BBU": round(ind["MID"][-1] + 2 * ind["SD"][-1]), "BBL": round(ind["MID"][-1] - 2 * ind["SD"][-1])}
    data = {
        "generated": f"{now:%Y-%m-%d %H:%M}", "prev_generated": f"{prev_gen:%Y-%m-%d %H:%M}" if prev_gen else "",
        "gap": [f"{g:%m-%d %H:%M}" for g in gap],
        "last_price": last_c, "history_last": f"{hist_last:%Y-%m-%d %H:%M}", "live_minutes_added": added, "live": info,
    }
    for key, _, mn, _ in STRATS:
        r = res[key]
        data[key] = {"minutes": mn, "bar": f"{hbs[mn][0][-1]:%Y-%m-%d %H:%M}", "bar_end": f"{bar_end[mn]:%H:%M}",
                     "forming": now < bar_end[mn], "pos": pos_info(r), "sig": sig_info(r), "checks": r["checks"],
                     "record": rec(r), "events": events(r), "levels": levels(r["ind"])}
    os.makedirs(a.out, exist_ok=True)
    json.dump(data, open(os.path.join(a.out, "live.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=str)
    open(os.path.join(a.out, "live.html"), "w", encoding="utf-8").write(render(data, now))
    tws = trades_page.twii_backtests(load(a.twii), refine_times)
    tx = {key: [trade_row(x, last_c, fwd) for x in res[key]["trades"]] for key, _, _, fwd in STRATS}
    open(os.path.join(a.out, "trades.html"), "w", encoding="utf-8").write(
        trades_page.render(tx, tws, now, last_c, f"{T[0]:%Y-%m-%d}", (CAP, MULT, FEE, COST), trade_row))
    print(f"現價 {last_c:,.0f}；history 到 {hist_last}，補上即時 {added} 分鐘；" + "；".join(
        f"{NAMES[k]} {'持倉' if res[k]['pos'] else '空手'}{'、訊號' if res[k]['sig'] else ''}" for k, *_ in STRATS))


# ---------- 網頁 ----------
def session_state(now):
    wd, t = now.weekday(), now.time()
    if wd < 5 and dt.time(8, 45) <= t < dt.time(13, 45):
        return "日盤交易中"
    if (wd < 5 and t >= dt.time(15, 0)) or (1 <= wd <= 5 and t < dt.time(5, 0)):
        return "夜盤交易中"
    return "休市"


def money(v):
    cls = "up" if v > 0 else "dn" if v < 0 else ""
    return f'<span class="{cls}">{v:+,.0f}</span>'


def esc(s):
    return html.escape(str(s))


def checks_html(chk):
    def rows(items):
        return "".join(f'<li class="{"ok" if c["ok"] else "no"}"><span class="mk">{"✓" if c["ok"] else "✗"}</span>'
                       f'<span>{esc(c["name"])}</span><span class="dt">{esc(c["detail"])}</span></li>' for c in items)
    out = []
    for side in ("多", "空"):
        c = chk[side]
        groups = [g for g in ("突破", "拉回") if g in c]
        all_ok = {g: all(x["ok"] for x in c["common"] + c[g]) for g in groups}
        badge = "、".join(g for g in groups if all_ok[g])
        head = f'<span class="pill {"go" if badge else ""}">{esc(badge + "條件全到") if badge else "未成立"}</span>'
        body = f'<ul class="ck">{rows(c["common"])}</ul>'
        for g in groups:
            title = f"{g}進場" if len(groups) > 1 else "進場條件"
            body += f'<p class="gt">{title}</p><ul class="ck">{rows(c[g])}</ul>'
        st = c["stop"]
        body += f'<p class="note">若現在進場，停損約 {st["stop"]:,.0f}（{abs(st["raw"]):,.0f} 點前的端點，最多 1–1.5 ATR）</p>'
        out.append(f'<details class="side"{" open" if badge else ""}><summary>做{side} {head}</summary>{body}</details>')
    return "".join(out)


def strat_card(name, sub, s, prev_gen_txt=""):
    pos, sig = s["pos"], s["sig"]
    mn = s.get("minutes", 60)
    bar_txt = (f"最後一根 {mn} 分K：{s['bar'][5:]} 起{'，形成中（' + s['bar_end'] + ' 收）' if s['forming'] else '，已收完'}")
    if pos:
        st_cls = "long" if pos["side"] == "多" else "short"
        status = f'<span class="state {st_cls}">持{pos["side"]}單</span>'
        p = pos
        be_txt = "已保本" if p["be"] else f"收盤到 {p['be_at']:,} 就把停損移到進場價（保本）"
        pend = f'<p class="alert">⚠ {esc(p["pending_exit"])}{"（以現價計，收K時再確認）" if s["forming"] else ""}</p>' if p.get("pending_exit") else ""
        body = f"""{pend}<div class="kv">
<div><span>進場</span><b>{p['entry']:,}</b><em>{p['entry_t'][5:]}・{esc(p['kind'])}</em></div>
<div><span>目前停損</span><b>{p['stop']:,}</b><em>距現價 {p['to_stop']:,} 點</em></div>
<div><span>未實現</span><b>{money(p['pts'])} 點</b><em>{money(p['twd'])} 元（1 口微台）</em></div>
<div><span>初始停損</span><b>{p['stop0']:,}</b><em>風險 {p['R']:,} 點</em></div>
</div><p class="note">{esc(be_txt)}。{esc(p['trail_note'])}。</p>"""
    else:
        status = '<span class="state flat">空手</span>'
        body = ""
    if sig:
        when = f"下一根 {mn} 分K 開盤進場"
        tag = "形成中：若以現價收K" if s["forming"] else f"訊號 {sig['at']} 成立" + (f"（網頁晚了 {fmt_lag(sig['lag'])}才更新到）" if sig["lag"] > 10 else "")
        body = (f'<p class="alert sig">● {tag}，做{sig["side"]}（{esc(sig["kind"])}）→ {when}，'
                f'參考價 {sig["entry"]:,}、停損 {sig["stop"]:,}（{sig["R"]:,} 點）</p>') + body
    if s.get("events"):
        prev = f"上次更新（{esc(prev_gen_txt)}）之後" if prev_gen_txt else "上次更新之後"
        body = f'<p class="alert">{prev}：<br>' + "<br>".join(esc(e) for e in s["events"]) + "</p>" + body
    lv = s["levels"]
    lv_txt = f"EMA20 {lv['E20']:,}・EMA60 {lv['E60']:,}・布林 {lv['BBL']:,}–{lv['BBU']:,}・ATR {lv['ATR']:,}"
    chk_title = "進場條件（看最後一根 K" + ("，以現價計）" if s["forming"] else "）")
    if pos:
        chk = f'<details><summary class="sub">進場條件明細（持倉中，不會再開新倉）</summary>{checks_html(s["checks"])}</details>'
    else:
        chk = f'<h3>{chk_title}</h3>{checks_html(s["checks"])}'
    return f"""<section class="card">
<div class="ch"><div><h2>{esc(name)}</h2><p class="sub">{esc(sub)}</p></div>{status}</div>
<p class="sub">{esc(bar_txt)}</p>
{body}
<p class="lv">{esc(lv_txt)}</p>
{chk}
</section>"""


def record_html(title, r):
    def table(rows):
        if not rows:
            return '<p class="note">還沒有交易。</p>'
        head = "".join(f"<th>{h}</th>" for h in ("進場", "方向", "進場價", "出場", "出場價", "R", "元"))
        body = "".join(
            "<tr>" + "".join(f"<td>{c}</td>" for c in (
                esc(x["entry_t"][5:]), f'{x["side"]}・{esc(x["kind"])}', f'{x["entry"]:,}',
                "持倉中" if x["open"] else esc(x["exit_t"][5:]), "" if x["open"] else f'{x["exit"]:,}',
                f'{x["r"]:+.2f}', money(x["twd"]))) + "</tr>" for x in reversed(rows))
        return f'<div class="scroll"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'
    fs, bs = r["fsum"], r["bsum"]
    return f"""<section class="card"><h2>{esc(title)}</h2>
<p class="sub">前測（{r.get('fstart', f'{FORWARD_START:%Y/%m/%d}')} 起）已出場 {fs['n']} 筆、賺 {fs['win']} 筆、合計 {fs['R']:+.1f}R、{money(fs['twd'])} 元（含未實現）</p>
{table(r['forward'])}
<p class="sub">前測開始前（台指期累積資料回測）：{bs['n']} 筆 {bs['R']:+.1f}R、{money(bs['twd'])} 元・<a href="trades.html">完整歷史成交紀錄 →</a></p>
</section>"""


def render(d, now):
    sess = session_state(now)
    live = d["live"]
    src = "・".join(f"{k} {v['last_minute'][5:]}" for k, v in live.items() if "last_minute" in v) or "沒有即時資料"
    errs = "".join(f'<p class="alert">⚠ {esc(k)}：{esc(v["error"])}</p>' for k, v in live.items() if "error" in v)
    gap = (f'<p class="alert">⚠ 資料缺口：{esc("、".join(d["gap"]))} 開始的盤沒有資料（期交所即時資料沒抓到、每日檔案還沒出，或那天是假日）。'
           f'指標與訊號可能不準，等下一次補抓。</p>' if d.get("gap") else "")
    dst = us_dst(now)
    night_win = "21:00–23:00" if dst else "22:00–00:00"
    night_win30 = "21:00–23:30" if dst else "22:00–00:30"
    return f"""<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="600">
<title>台指策略即時訊號</title>
<style>
:root {{ --bg:#f6f7f9; --panel:#fff; --fg:#1b1f24; --muted:#5d6673; --line:#dfe3e8; --up:#c2412d; --dn:#2f7d5b;
  --accent:#2f5fd0; --warn:#a86500; --warnbg:#fff4e0; --sigbg:#e8efff;
  --font:"Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#14171b; --panel:#1c2026; --fg:#e8ebef; --muted:#9aa3ae; --line:#2c323a;
  --up:#ef7a63; --dn:#5cc296; --accent:#7ea2ff; --warn:#f0b35a; --warnbg:#3a2c14; --sigbg:#1e2a48; color-scheme:dark; }} }}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--fg); font-family:var(--font); font-size:15px; line-height:1.5; }}
main {{ max-width:1180px; margin:0 auto; padding:16px; }}
.cols {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,500px),1fr)); gap:0 12px; align-items:start; }}
h1 {{ font-size:20px; margin:0; }} h2 {{ font-size:17px; margin:0; }} h3 {{ font-size:13px; color:var(--muted); font-weight:500; margin:14px 0 4px; }}
.sub, .note, .asof {{ color:var(--muted); font-size:12.5px; margin:4px 0; }}
.top {{ display:flex; justify-content:space-between; align-items:flex-end; gap:8px; flex-wrap:wrap; }}
.price {{ font-size:28px; font-variant-numeric:tabular-nums; margin:0; }}
.card {{ background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; margin-top:12px; }}
.ch {{ display:flex; justify-content:space-between; align-items:flex-start; gap:8px; }}
.state {{ font-weight:600; padding:4px 10px; border-radius:999px; white-space:nowrap; font-size:14px; border:1px solid var(--line); }}
.state.long {{ color:#fff; background:var(--up); border-color:var(--up); }}
.state.short {{ color:#fff; background:var(--dn); border-color:var(--dn); }}
.state.flat {{ color:var(--muted); }}
.kv {{ display:grid; grid-template-columns:1fr 1fr; gap:8px; margin:10px 0 4px; }}
.kv div {{ border:1px solid var(--line); border-radius:8px; padding:8px; }}
.kv > div > span {{ display:block; font-size:12px; color:var(--muted); }}
.kv b {{ display:block; font-size:19px; font-weight:600; font-variant-numeric:tabular-nums; }}
.kv em {{ display:block; font-style:normal; font-size:12px; color:var(--muted); }}
.alert {{ background:var(--warnbg); color:var(--warn); border-radius:8px; padding:8px 10px; margin:8px 0; font-size:14px; }}
.alert.sig {{ background:var(--sigbg); color:var(--accent); font-weight:600; }}
.lv {{ font-size:12.5px; color:var(--muted); border-top:1px dashed var(--line); padding-top:8px; margin:10px 0 0; font-variant-numeric:tabular-nums; }}
details.side {{ border:1px solid var(--line); border-radius:8px; margin:6px 0; padding:0 10px; }}
details.side summary {{ padding:8px 0; cursor:pointer; font-weight:600; }}
.pill {{ font-size:12px; font-weight:500; color:var(--muted); border:1px solid var(--line); border-radius:999px; padding:1px 8px; margin-left:6px; }}
.pill.go {{ color:#fff; background:var(--accent); border-color:var(--accent); }}
.gt {{ font-size:12.5px; color:var(--muted); margin:8px 0 2px; }}
ul.ck {{ list-style:none; padding:0; margin:0 0 6px; }}
ul.ck li {{ display:grid; grid-template-columns:20px 1fr auto; gap:6px; padding:3px 0; font-size:14px; }}
ul.ck li.ok .mk {{ color:var(--accent); font-weight:700; }} ul.ck li.no {{ color:var(--muted); }}
.dt {{ font-size:12px; color:var(--muted); text-align:right; font-variant-numeric:tabular-nums; }}
.scroll {{ overflow-x:auto; margin-top:8px; }}
table {{ border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; font-size:13px; }}
th, td {{ padding:5px 6px; text-align:right; border-bottom:1px solid var(--line); white-space:nowrap; }}
th {{ color:var(--muted); font-weight:500; }} th:nth-child(-n+2), td:nth-child(-n+2) {{ text-align:left; }}
.up {{ color:var(--up); }} .dn {{ color:var(--dn); }}
a {{ color:var(--accent); }}
footer {{ margin:20px 0 40px; }}
</style></head><body><main>
<div class="top"><div><h1>台指策略即時訊號</h1>
<p class="asof">{esc(sess)}・網頁產生於台北 {esc(d['generated'])}（<span id="age">—</span>）</p></div>
<div style="text-align:right"><p class="price">{d['last_price']:,.0f}</p><p class="asof">台指期近月（日盤＋夜盤）・資料到 {esc(src)}</p></div></div>
<p class="alert" id="stale" hidden></p>
{gap}{errs}
<div class="cols">
{strat_card("v3・60 分K（限時段）", f"60 分K 收完才看訊號；日盤 08:45–11:45、夜盤 {night_win} 開始的 K 才開新倉", d["v3"], d["prev_generated"][5:])}
{strat_card("v3 不限時段・60 分K", "規則跟 v3 一樣，但日盤、夜盤任何一根 60 分K 收完都可以開新倉", d["v3all"], d["prev_generated"][5:])}
</div>
<div class="cols">
{strat_card("v3・30 分K（限時段）", f"同一套 v3 規則改用 30 分K，收完才看訊號；開倉時段同 60 分K 版（日盤 08:45–12:15、夜盤 {night_win30} 開始的 30 分K）", d["v3_30"], d["prev_generated"][5:])}
{strat_card("v3 不限時段・30 分K", "同一套 v3 規則改用 30 分K，日盤、夜盤任何一根 30 分K 收完都可以開新倉", d["v3all_30"], d["prev_generated"][5:])}
</div>
<div class="cols">
{record_html("v3（限時段）模擬交易紀錄", d["v3"]["record"])}
{record_html("v3 不限時段 模擬交易紀錄", d["v3all"]["record"])}
</div>
<div class="cols">
{record_html("v3・30 分K（限時段）模擬交易紀錄", d["v3_30"]["record"])}
{record_html("v3 不限時段・30 分K 模擬交易紀錄", d["v3all_30"]["record"])}
</div>
<footer>
<p class="note">GitHub Actions 在交易時段大約每 30 分鐘更新一次：日盤台北 08:48–13:48（:18、:48），
夜盤 15:04–05:04（:04、:34）。GitHub 的排程是盡力而為，常晚 5–30 分鐘，偶爾會漏跑，所以請看上面的「資料到」時間，不要拿這頁當下單依據。
每次更新都從期交所重新抓整個日盤、夜盤的 1 分K，從頭重算 K 棒、部位與停損，所以中間漏跑幾次不會漏掉 K 棒，也不會漏掉停損；
晚到的進出場會在卡片上標「上次更新之後」並寫晚了幾分鐘。每天 06:30 的存檔若漏跑，下一次更新發現缺盤會自動去期交所補抓。</p>
<p class="note">「形成中」表示那根 K 還沒收完，條件是用現價先算，收K前都可能變。每個版本的訊號都要等自己的 K 棒（60 或 30 分K）收完、下一根開盤才進場；各版本獨立計算，同一時間可能一邊持倉、一邊空手。
試算：本金 20 萬、1 口微台（每點 10 元）、每次下單 25 元；R 是以初始停損點數為 1 的倍數。</p>
<p class="note"><b>資料：訊號、部位、停損都只用台指期近月（TX）日盤＋夜盤 60 分K／30 分K</b>：期交所每筆成交轉 1 分K（history 到 {esc(d['history_last'])}）＋期交所即時 1 分K。
加權指數只是歷史成交紀錄頁裡的回測資料，不用在這頁。規則：<code>strategy/v3.py</code> 的 V3；限時段用 <code>backtest.tx_revised</code>（30 分K 用 <code>tx_revised30</code>），不限時段版不套時段濾網；30 分K 版參數跟 60 分K 完全相同（EMA20/60、布林 20、ATR 都是同樣根數）。
<a href="trades.html">歷史成交紀錄</a>・<a href="strategy.html">v3 前測（每日）</a>・<a href="index.html">選擇權盤面</a></p>
</footer>
</main>
<script>
(function () {{
  // 用看網頁的人的時鐘算這頁多久沒更新；交易時段超過 45 分鐘就提醒（GitHub 排程延遲或漏跑）
  var gen = new Date("{d['generated'].replace(' ', 'T')}:00+08:00"), now = new Date();
  var m = Math.round((now - gen) / 60000);
  var age = document.getElementById("age");
  if (age) age.textContent = m < 1 ? "剛剛" : m < 120 ? m + " 分鐘前" : Math.round(m / 60) + " 小時前";
  var tp = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  var wd = tp.getDay(), mins = tp.getHours() * 60 + tp.getMinutes();
  var open = (wd >= 1 && wd <= 5 && mins >= 525 && mins <= 830) || (wd >= 1 && wd <= 5 && mins >= 900) || (wd >= 2 && wd <= 6 && mins <= 300);
  if (open && m > 45) {{
    var el = document.getElementById("stale");
    el.hidden = false;
    el.textContent = "⚠ 交易時段中，這頁已經 " + (m < 120 ? m + " 分鐘" : Math.round(m / 60) + " 小時") + "沒有更新（GitHub 排程延遲或漏跑），價格、停損與訊號可能過時。";
  }}
}})();
</script>
</body></html>
"""


if __name__ == "__main__":
    main()
