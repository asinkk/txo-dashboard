"""用強化學習調整日K 策略 D2（2026-11-07）。

D2 的進場訊號不動（收盤創 20 日新高/新低、實體 ≥ 高低差 50%、EMA20/EMA60 同向、13:45 收盤前進場），
在上面試兩種強化學習，全部用「只看過去」的逐年前進（walk-forward）驗證：

  A. 參數調整（多臂吃角子老虎 / 折扣型 follow-the-leader）：D2 附近 36 組參數當成 36 支手臂，
     每次空手時，選「到今天為止已出場交易的折扣累積 R」最高的那一組，用它的規則判斷今天要不要進場、之後怎麼出場。
  B. 代理人學進出場（表格 Q-learning）：初始停損、1R 保本這兩條風險規則保留，
     代理人只學兩件事：(1) 訊號出現時做不做（進場濾網）(2) 持倉中每天收盤後「續抱 / 隔天開盤出場」，
     取代 D2「保本後收盤跌破 EMA20 出場」那一條。狀態很少（進場 9 格、持倉 90 格），
     沒看過夠多次的狀態一律照 D2 原規則（防過擬合）。

資料（Monkey 規則：加權指數只當回測歷史，交易以台指期為準）：
  - history/twii_daily.csv：加權指數日K 2000 年起（strategy/fetch_twii_daily.py），訓練＋逐年前進驗證 2008–2023
  - history/tx_daily.csv＋history/tx_1min：台指期近月日盤日K（08:45–13:45，跟 live.py 同一套），2024 年起當最後測試，
    模型只用測試年以前的加權指數訓練。

用法：python strategy/rl_daily.py [--out 結果資料夾]
"""
import argparse, csv, datetime as dt, math, os, random, statistics as st, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from backtest import indicators, COST
import daily

HERE = os.path.dirname(os.path.abspath(__file__))
HIST = os.path.join(HERE, "..", "history")
CAP, MULT, FEE = 200000, 10, 25          # 20 萬、1 口微台（每點 10 元）、每次下單 25 元
WARMUP = daily.WARMUP


# ---------- 資料 ----------
def load_twii_daily(path):
    T, O, H, L, C = [], [], [], [], []
    for r in csv.DictReader(open(path, encoding="utf-8")):
        T.append(dt.datetime.fromisoformat(r["date"]))
        for a, k in ((O, "open"), (H, "high"), (L, "low"), (C, "close")):
            a.append(float(r[k]))
    return T, O, H, L, C


def load_tx_day():
    import live
    raw = live.read_raw_minutes(os.path.join(HIST, "tx_1min"))
    bars, *_ = live.tx_daily_bars(os.path.join(HIST, "tx_daily.csv"), raw, night=False)
    return bars


class Mkt:
    """一份日K 加上 D2 會用到的指標與 RL 特徵。"""

    def __init__(self, bars, name):
        self.name, self.bars = name, bars
        self.T, self.O, self.H, self.L, self.C = bars
        self.n = len(self.C)
        self.ind = indicators(*bars)
        A, C = self.ind["ATR"], self.C
        # 波動分位：ATR/價格 在過去 250 天的排名（只用過去）
        vr = [a / c for a, c in zip(A, C)]
        self.vrank = [None] * self.n
        for i in range(self.n):
            w = vr[max(0, i - 250):i + 1]
            if len(w) >= 60:
                self.vrank[i] = sum(v <= vr[i] for v in w) / len(w)


# ---------- D2 引擎（跟 daily.run 同一套邏輯，拆成「訊號」與「單筆交易」兩段） ----------
def signal(m, p, i):
    """第 i 根收盤有沒有 D2 類型的突破訊號，回傳 +1 / -1 / None。"""
    C, O, H, L, ind = m.C, m.O, m.H, m.L, m.ind
    N = p["entry"]
    if i < max(WARMUP, N) or i >= m.n - 1:
        return None
    for s in (1, -1):
        if (ind["E20"][i] - ind["E60"][i]) * s <= 0:
            continue
        body, rng = (C[i] - O[i]) * s, H[i] - L[i]
        if not (body > 0 and body >= 0.5 * rng):
            continue
        w = C[i - N:i]
        if (C[i] > max(w)) if s > 0 else (C[i] < min(w)):
            return s
    return None


def open_pos(m, p, i, s):
    """收盤進場；回傳 (進場價, 停損, R) 或 None（訊號K 端點離進場價太遠不做）。"""
    A = m.ind["ATR"][i]
    e = m.C[i]
    ext = m.L[i] if s > 0 else m.H[i]
    raw = abs(e - (ext - 0.1 * A * s))
    if raw > p.get("max_atr", p["stop_atr"] + 0.5) * A:
        return None
    stop = e - max(min(raw, p["stop_atr"] * A), 0.5 * A) * s
    return e, stop, abs(e - stop)


def hold_state(m, j, s, e, R, be, age):
    """持倉中第 j 根收盤的狀態（給 Q-learning）。"""
    u = (m.C[j] - e) * s / R
    ub = 0 if u < 0 else 1 if u < 1 else 2 if u < 2 else 3 if u < 3.5 else 4
    d = (m.C[j] - m.ind["E20"][j]) * s / m.ind["ATR"][j]
    db = 0 if d < 0 else 1 if d < 1 else 2
    ab = 0 if age <= 3 else 1 if age <= 10 else 2
    return ((ub * 3 + db) * 3 + ab) * 2 + int(be)          # 0..89


def entry_state(m, i, s):
    t = (m.ind["E20"][i] - m.ind["E60"][i]) * s / m.ind["ATR"][i]
    tb = 0 if t < 1 else 1 if t < 3 else 2
    v = m.vrank[i] if m.vrank[i] is not None else 0.5
    vb = 0 if v < 1 / 3 else 1 if v < 2 / 3 else 2
    return tb * 3 + vb                                     # 0..8


def d2_rule_exit(m, p, j, s, be):
    """D2 原本的出場規則（保本後收盤跌破 EMA20 / EMA10，或移動停利由 trade() 處理）。"""
    if not be or p["exit"] not in ("ema20", "ema10"):
        return False
    EX = m.ind["E20"] if p["exit"] == "ema20" else m.ind["E10"]
    return (m.C[j] - EX[j]) * s < 0


def trade(m, p, i, s, policy=None, path=None):
    """從第 i 根收盤進場走完一筆交易。policy(state, j, be, 持有天數) 回傳 True = 隔天開盤出場；None = 照 D2 規則。
    path 若是 list，會把每天的 (state, 收盤 R, 下一步) 記下來給 Q-learning 用。
    回傳跟 daily.run 同格式的 dict（r 已扣 COST 點）。"""
    o = open_pos(m, p, i, s)
    if o is None:
        return None
    e, stop, R = o
    T, O, H, L, C, A = m.T, m.O, m.H, m.L, m.C, m.ind["ATR"]
    stop0, be, best, j, still_open, why, xt, xp = stop, False, e, i + 1, False, "", None, None
    while j < m.n:
        worst = L[j] if s > 0 else H[j]
        if (worst - stop) * s <= 0:
            gap = (O[j] - stop) * s <= 0
            px = O[j] if gap else stop
            xt, xp = T[j], px
            why = ("移動停利" if (stop - e) * s > COST else "保本停損" if be else "初始停損") + ("（跳空成交）" if gap else "")
            break
        if not be and (C[j] - e) * s >= p["be_r"] * R:
            be, stop = True, e + COST * s
        if j + 1 >= m.n:
            xt, xp, still_open, why = T[j], C[j], True, "持倉中"
            break
        if policy is None:
            out = d2_rule_exit(m, p, j, s, be)
            if not out and be and p["exit"] not in ("ema20", "ema10"):
                best = max(best * s, C[j] * s) * s
                trail = best - p["exit"] * A[j] * s
                if (trail - stop) * s > 0:
                    stop = trail
        else:
            st_ = hold_state(m, j, s, e, R, be, j - i)
            out = policy(st_, j, be, j - i)
        if out:
            xt, xp, why = T[j + 1], O[j + 1], ("代理人出場" if policy else "跌破" + p["exit"].upper())
            j += 1
            break
        j += 1
    pnl = (xp - e) * s
    return dict(t=T[i], side=s, kind="突破", R=R, r=(pnl - COST) / R, bars=j - i, entry=e, entry_t=T[i], stop0=stop0,
                stop=stop, exit_t=xt, exit=xp, open=still_open, be=be, why=why, j=j)


def run_rule(m, p, lo=0, hi=None, policy=None, take=None):
    """依序回測（空手才找訊號）。take(i, s) 回傳 False 就跳過這個訊號。只收 lo <= 訊號根 < hi 的交易。"""
    hi = m.n if hi is None else hi
    out, i = [], max(lo, WARMUP)
    while i < min(hi, m.n - 1):
        s = signal(m, p, i)
        if s is None or (take and not take(i, s)):
            i += 1; continue
        x = trade(m, p, i, s, policy)
        if x is None:
            i += 1; continue
        out.append(x)
        i = x["j"]
    return out


# ---------- A：參數調整（折扣型 follow-the-leader 吃角子老虎） ----------
ARMS = [dict(daily.D2, entry=N, stop_atr=sa, be_r=be, exit=ex)
        for N in (20, 40) for sa in (0.75, 1.0, 1.5) for be in (1.0, 1.5) for ex in ("ema20", "ema10", 3.0)]
D2_ARM = next(k for k, a in enumerate(ARMS) if all(a[x] == daily.D2[x] for x in ("entry", "stop_atr", "be_r", "exit")))


def arm_label(a):
    ex = a["exit"].upper() if isinstance(a["exit"], str) else f"{a['exit']:g}ATR移動停利"
    return f"{a['entry']}日新高/停損{a['stop_atr']:g}ATR/{a['be_r']:g}R保本/{ex}"


class Bandit:
    """每支手臂各自依序回測（用歷史資料 hist），在 day 那天只看 exit_t < day 的交易，
    分數 = Σ 0.5^(距今年數/半衰期) × R。分數比目前手臂高 margin 才換手（避免追雜訊）；
    累積不到 min_trades 筆或資料不足 2 年前，一律用 D2。"""

    def __init__(self, hist, half_life=3.0, margin=3.0, min_trades=15):
        import bisect
        self._bisect = bisect.bisect_left
        self.trades = [run_rule(hist, a) for a in ARMS]
        self.hl, self.margin, self.min_trades = half_life, margin, min_trades
        self.cur = D2_ARM
        self.t0 = hist.T[WARMUP]
        self.base = hist.T[0]
        # 分數 = Σ r·0.5^((day−exit)/hl) = 0.5^(day/hl) · Σ r·2^(exit/hl)，先做前綴和
        self.ex, self.cum = [], []
        for tr in self.trades:
            done = sorted((x["exit_t"], x["r"]) for x in tr if not x["open"])
            self.ex.append([t for t, _ in done])
            c, acc = [0.0], 0.0
            for t, r in done:
                acc += r * 2 ** (self._yr(t) / self.hl)
                c.append(acc)
            self.cum.append(c)

    def _yr(self, t):
        return (t - self.base).days / 365.25

    def scores(self, day):
        f = 0.5 ** (self._yr(day) / self.hl)
        return [cum[self._bisect(ex, day)] * f for ex, cum in zip(self.ex, self.cum)]

    def choose(self, day):
        if (day - self.t0).days < 730 or self._bisect(self.ex[D2_ARM], day) < self.min_trades:
            self.cur = D2_ARM
            return self.cur
        sc = self.scores(day)
        k = max(range(len(sc)), key=lambda a: sc[a])
        if sc[k] > sc[self.cur] + self.margin:
            self.cur = k
        return self.cur


def run_bandit(m, bandit, lo=0, hi=None, log=None):
    """在市場 m 上依序交易：空手時問 bandit 用哪組參數，用那組的訊號與出場規則。"""
    hi = m.n if hi is None else hi
    out, i = [], max(lo, WARMUP)
    while i < min(hi, m.n - 1):
        k = bandit.choose(m.T[i])
        p = ARMS[k]
        s = signal(m, p, i)
        x = trade(m, p, i, s) if s else None
        if x is None:
            i += 1; continue
        x["arm"] = k
        out.append(x)
        if log is not None:
            log.append((m.T[i], k))
        i = x["j"]
    return out


# ---------- B：表格 Q-learning（進場濾網 + 持倉中續抱/出場） ----------
MAX_HOLD = 150    # Q 代理人最多持有 150 個交易日（D2 原規則不受限）
_PATHS = {}


def all_paths(m, p):
    """每個訊號的持倉路徑，預先算好：[(狀態, 續抱獎勵, 出場獎勵, D2會不會出場, j) ... 或 ("stop", 獎勵, j)]。
    市場不受我們的動作影響，動作只決定什麼時候結束，所以整條路徑可以先算好；訓練時再依截止日切掉之後的部分。"""
    key = (id(m), tuple(sorted((k, str(v)) for k, v in p.items())))
    if key in _PATHS:
        return _PATHS[key]
    O, H, L, C = m.O, m.H, m.L, m.C
    res = []
    for i in range(WARMUP, m.n - 1):
        s = signal(m, p, i)
        o = open_pos(m, p, i, s) if s else None
        if not o:
            continue
        e, stop, R = o
        out, be, j, mark = [], False, i + 1, 0.0
        while j < m.n - 1:
            worst = L[j] if s > 0 else H[j]
            if (worst - stop) * s <= 0:                        # 今天盤中停損（不能選）
                px = O[j] if (O[j] - stop) * s <= 0 else stop
                out.append(("stop", (px - e) * s / R - COST / R - mark, j))
                break
            if not be and (C[j] - e) * s >= p["be_r"] * R:
                be, stop = True, e + COST * s
            today = (C[j] - e) * s / R - COST / R
            r_hold = today - mark                              # 前一天選續抱 → 今天收盤的變化
            r_exit = (O[j + 1] - C[j]) * s / R                 # 今天選出場 → 隔天開盤相對今天收盤
            st_ = hold_state(m, j, s, e, R, be, j - i)
            if j - i >= MAX_HOLD:
                st_ = -1                                       # 強制出場
            out.append((st_, r_hold, r_exit, d2_rule_exit(m, p, j, s, be), j))
            mark = today
            if st_ == -1:
                break
            j += 1
        res.append((i, s, out))
    _PATHS[key] = res
    return res


class QAgent:
    """表格 Q-learning。市場路徑不受動作影響、動作只決定何時結束，所以每天都能同時看到
    「出場」的結果（隔天開盤價）與「續抱」的下一步，用整條路徑做離線（off-policy）Q-learning 經驗回放。
    防過擬合：狀態少；訪問不到 min_visits 次的狀態照 D2；學到的優勢要大於 margin（R）才推翻 D2 的動作。"""
    NS_H, NS_E = 90, 9

    def __init__(self, seed=0, min_visits=30, margin=0.10):
        self.rng = random.Random(seed)
        self.Qh = [[0.0, 0.0] for _ in range(self.NS_H)]   # [續抱, 出場]
        self.Nh = [0] * self.NS_H
        self.min_visits, self.margin = min_visits, margin
        self.Ge = {"rl": [[] for _ in range(self.NS_E)], "d2": [[] for _ in range(self.NS_E)]}

    def fit(self, m, p, lo, hi, epochs=40, alpha0=0.1):
        eps_list = [(i, s, [x for x in path if x[-1] < hi - 1])
                    for i, s, path in all_paths(m, p) if lo <= i < hi - 1]
        self.n_train = len(eps_list)
        for i, s, path in eps_list:
            for stp in path:
                if stp[0] not in ("stop", -1):
                    self.Nh[stp[0]] += 1
        for ep in range(epochs):
            alpha = alpha0 * (1 - 0.9 * ep / max(1, epochs - 1))
            self.rng.shuffle(eps_list)
            for i, s, path in eps_list:
                for k in range(len(path) - 1, -1, -1):          # 由後往前掃，價值傳得比較快
                    st_ = path[k]
                    if st_[0] in ("stop", -1):
                        continue
                    q = self.Qh[st_[0]]
                    q[1] += alpha * (st_[2] - q[1])                 # 出場：隔天開盤結束
                    if k + 1 >= len(path):
                        continue                                    # 資料到底，續抱的結果還不知道
                    nx = path[k + 1]
                    if nx[0] == "stop":
                        target = nx[1]
                    elif nx[0] == -1:
                        target = nx[1] + nx[2]
                    else:
                        target = nx[1] + max(self.Qh[nx[0]])
                    q[0] += alpha * (target - q[0])
        # 進場濾網：每個進場狀態，用學到的出場（或 D2 出場）實際會拿到多少 R
        for i, s, path in eps_list:
            es = entry_state(m, i, s)
            for mode in ("rl", "d2"):
                g = self.replay(path, mode, m, p, s)
                if g is not None:
                    self.Ge[mode][es].append(g)
        return self

    def act_exit(self, st_, d2_says):
        """True = 出場。樣本不夠或優勢不夠大就照 D2。"""
        if st_ == -1:
            return True
        if self.Nh[st_] < self.min_visits:
            return d2_says
        hold, ex = self.Qh[st_]
        if d2_says:
            return not (hold > ex + self.margin)
        return ex > hold + self.margin

    def replay(self, path, mode, m, p, s):
        G = 0.0
        for stp in path:
            if stp[0] == "stop":
                return G + stp[1]
            st_, rh, rx, d2x, j = stp
            G += rh
            if (self.act_exit(st_, d2x) if mode == "rl" else (d2x or st_ == -1)):
                return G + rx
        return None   # 訓練截止日還沒結束的不算

    def take(self, m, mode):
        def tk(i, s):
            g = self.Ge[mode][entry_state(m, i, s)]
            if len(g) < self.min_visits:
                return True
            mu, se = st.mean(g), st.stdev(g) / len(g) ** 0.5
            return mu + se >= 0           # 平均 R 加一個標準誤還是負的，才跳過
        return tk


def run_agent(m, p, agent, lo, hi, use_entry=True, use_exit=True):
    """依序回測 Q 代理人。"""
    hi = m.n if hi is None else hi
    out, i = [], max(lo, WARMUP)
    tk = agent.take(m, "rl" if use_exit else "d2") if use_entry else None
    while i < min(hi, m.n - 1):
        s = signal(m, p, i)
        if s is None or (tk and not tk(i, s)):
            i += 1; continue

        def pol(st_, j, be, age, s=s):
            d2x = d2_rule_exit(m, p, j, s, be)
            if not use_exit:
                return d2x
            return agent.act_exit(-1 if age >= MAX_HOLD else st_, d2x)
        x = trade(m, p, i, s, pol)
        if x is None:
            i += 1; continue
        if x["why"] == "代理人出場" and d2_rule_exit(m, p, x["j"] - 1, s, x["be"]):
            x["why"] = "跌破" + p["exit"].upper()
        out.append(x)
        i = x["j"]
    return out


# ---------- 統計 ----------
def money(tr):
    eq = pk = CAP; dd = 0
    for x in tr:
        pts = x["r"] * x["R"] + COST
        eq += pts * MULT - (FEE if x["open"] else 2 * FEE)
        pk = max(pk, eq); dd = min(dd, eq - pk)
    return eq, dd


def line(name, tr, cash=False):
    s = daily.stats(tr)
    txt = (f"{name:28s} {s['n']:3d} 筆 勝率 {s['win']:4.0%} 合計 {s['tot']:+7.1f}R 平均 {s['avg']:+.2f}R "
           f"回落 {s['dd']:6.1f}R PF {s['pf']:5.2f} t {s['t']:5.2f} 去掉最好1筆 {s['tot'] - max((x['r'] for x in tr), default=0):+6.1f}R")
    if cash:
        eq, dd = money(tr)
        txt += f" | 20萬1口微台 期末 {eq:>9,.0f} 回落 {dd:>8,.0f}"
    print(txt)
    return s


def idx(m, day):
    return next((i for i, t in enumerate(m.T) if t >= day), m.n)


def yearly(tr):
    out = {}
    for x in tr:
        out[x["t"].year] = out.get(x["t"].year, 0) + x["r"]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", help="輸出交易紀錄 CSV 的資料夾")
    ap.add_argument("--seeds", type=int, default=5)
    a = ap.parse_args()

    tw = Mkt(load_twii_daily(os.path.join(HIST, "twii_daily.csv")), "加權指數")
    tx = Mkt(load_tx_day(), "台指期日盤")
    p = daily.D2
    print(f"加權指數日K {tw.n} 根 {tw.T[0]:%Y-%m-%d} ~ {tw.T[-1]:%Y-%m-%d}；台指期日盤日K {tx.n} 根 {tx.T[0]:%Y-%m-%d} ~ {tx.T[-1]:%Y-%m-%d}")

    # 引擎檢查：跟 daily.run 的 D2 一模一樣
    for m in (tw, tx):
        ref = daily.run(m.bars, m.ind, p)
        mine = run_rule(m, p)
        same = [(x["t"], round(x["r"], 6)) for x in ref] == [(x["t"], round(x["r"], 6)) for x in mine]
        print(f"引擎檢查 {m.name}: daily.run {len(ref)} 筆，rl_daily {len(mine)} 筆，{'完全相同' if same else '不同！'}")

    WF0, WF1 = 2008, 2024           # 加權指數逐年前進驗證 2008–2023
    TXY = sorted({t.year for t in tx.T[WARMUP:]})

    # ---- A：參數調整 ----
    print("\n== A. 參數調整（36 組 D2 鄰近參數，空手時選折扣累積 R 最高的一組）")
    bandit = Bandit(tw)
    logA = []
    trA_tw = run_bandit(tw, bandit, idx(tw, dt.datetime(WF0, 1, 1)), idx(tw, dt.datetime(WF1, 1, 1)), logA)
    trA_tw24 = run_bandit(tw, Bandit(tw), idx(tw, dt.datetime(WF1, 1, 1)))
    trA_tx = run_bandit(tx, Bandit(tw))       # 台指期：手臂分數用加權指數已出場的交易（只看過去）
    used = {}
    for _, k in logA:
        used[k] = used.get(k, 0) + 1
    print("   2008–2023 實際用到的參數（筆數）：", "；".join(f"{arm_label(ARMS[k])} ×{v}" for k, v in sorted(used.items(), key=lambda kv: -kv[1])))
    sc = bandit.scores(dt.datetime(2024, 1, 1))
    top = sorted(range(len(ARMS)), key=lambda k: -sc[k])[:5]
    print("   2024/1/1 分數前 5：", "；".join(f"{arm_label(ARMS[k])} {sc[k]:+.1f}" for k in top), f"｜D2 {sc[D2_ARM]:+.1f}")

    # ---- B：Q-learning ----
    print(f"\n== B. Q-learning 代理人（每年用前面所有年份的加權指數重新訓練，{a.seeds} 個亂數種子）")
    resB = {k: [] for k in ("tw", "tw24", "tx", "tw_exit", "tw_entry")}
    years = list(range(WF0, tw.T[-1].year + 1))
    for seed in range(a.seeds):
        runs = {k: [] for k in resB}
        nxt = {k: 0 for k in resB}           # 上一筆出場的位置，跨年持倉要接著走，不能重疊
        for y in years:
            ag = QAgent(seed).fit(tw, p, 0, idx(tw, dt.datetime(y, 1, 1)))
            lo, hi = idx(tw, dt.datetime(y, 1, 1)), idx(tw, dt.datetime(y + 1, 1, 1))
            jobs = [("tw", tw, True, True), ("tw_exit", tw, False, True), ("tw_entry", tw, True, False)] if y < WF1 \
                else [("tw24", tw, True, True)]
            if y in TXY:
                jobs.append(("tx", tx, True, True))
            for key, m, ue, ux in jobs:
                l2, h2 = (lo, hi) if m is tw else (idx(tx, dt.datetime(y, 1, 1)), idx(tx, dt.datetime(y + 1, 1, 1)))
                tr = run_agent(m, p, ag, max(l2, nxt[key]), h2, use_entry=ue, use_exit=ux)
                if tr:
                    nxt[key] = tr[-1]["j"]
                runs[key] += tr
        for k in resB:
            resB[k].append(runs[k])
    last_agent = QAgent(0).fit(tw, p, 0, idx(tw, dt.datetime(2024, 1, 1)))

    def med(runs):
        tots = [sum(x["r"] for x in tr) for tr in runs]
        k = sorted(range(len(runs)), key=lambda i: tots[i])[len(runs) // 2]
        return runs[k], tots

    print("\n== 比較 1：加權指數 2008–2023 逐年前進（每一年都只用之前的資料學）")
    d2_tw = run_rule(tw, p, idx(tw, dt.datetime(WF0, 1, 1)), idx(tw, dt.datetime(WF1, 1, 1)))
    line("D2（原規則）", d2_tw)
    line("A 參數調整", trA_tw)
    for key, name in (("tw", "B Q-learning（進場+出場）"), ("tw_exit", "B 只學出場"), ("tw_entry", "B 只學進場濾網")):
        tr, tots = med(resB[key])
        line(name + "（中位數種子）", tr)
        print(f"{'':28s} 5 個種子合計 R：{', '.join(f'{v:+.1f}' for v in tots)}")

    print("\n== 比較 2：加權指數 2024 起（測試段，D2 參數本來就是在這段挑的，所以 D2 這裡是樣本內）")
    line("D2（原規則）", run_rule(tw, p, idx(tw, dt.datetime(WF1, 1, 1))), True)
    line("A 參數調整", trA_tw24, True)
    tr, tots = med(resB["tw24"])
    line("B Q-learning（中位數種子）", tr, True)
    print(f"{'':28s} 5 個種子合計 R：{', '.join(f'{v:+.1f}' for v in tots)}")

    print("\n== 比較 3：台指期日盤日K 2024 起（實際交易用的資料；模型只用之前年份的加權指數訓練）")
    d2_tx = run_rule(tx, p)
    line("D2（原規則）", d2_tx, True)
    line("A 參數調整", trA_tx, True)
    trB_tx, tots = med(resB["tx"])
    line("B Q-learning（中位數種子）", trB_tx, True)
    print(f"{'':28s} 5 個種子合計 R：{', '.join(f'{v:+.1f}' for v in tots)}")

    print("\n== 各年 R（加權指數 2008–2023）：D2 / A / B")
    yd, ya, yb = yearly(d2_tw), yearly(trA_tw), yearly(med(resB["tw"])[0])
    print("   " + "  ".join(f"{y}: {yd.get(y, 0):+.1f}/{ya.get(y, 0):+.1f}/{yb.get(y, 0):+.1f}" for y in range(WF0, WF1)))
    for nm, yy in (("A", ya), ("B", yb)):
        diff = [yy.get(y, 0) - yd.get(y, 0) for y in range(WF0, WF1)]
        print(f"   {nm} 比 D2 好的年數 {sum(d > 0.05 for d in diff)}、差的年數 {sum(d < -0.05 for d in diff)}、一樣 {sum(abs(d) <= 0.05 for d in diff)}")

    print("\n== B 的敏感度：最長持有天數（代理人學到「跌破 EMA20 也續抱」，所以這個上限很關鍵）")
    global MAX_HOLD
    keep = MAX_HOLD
    for mh in (60, 100, 150, 250):
        MAX_HOLD = mh; _PATHS.clear()
        trs, nxt = [], 0
        for y in range(WF0, WF1):
            ag = QAgent(0).fit(tw, p, 0, idx(tw, dt.datetime(y, 1, 1)))
            tr = run_agent(tw, p, ag, max(idx(tw, dt.datetime(y, 1, 1)), nxt), idx(tw, dt.datetime(y + 1, 1, 1)))
            if tr:
                nxt = tr[-1]["j"]
            trs += tr
        line(f"B 最長持有 {mh} 天 2008–2023", trs)
    MAX_HOLD = keep; _PATHS.clear()

    print("\n== Q 代理人（用 2000–2023 加權指數訓練）學到的進場濾網：趨勢強度 × 波動分位")
    names_t, names_v = ("EMA20−60<1ATR", "1–3ATR", ">3ATR"), ("低波動", "中波動", "高波動")
    tk = last_agent.take(tw, "rl")
    for es in range(9):
        g = last_agent.Ge["rl"][es]
        mu = st.mean(g) if g else 0
        se = st.stdev(g) / len(g) ** 0.5 if len(g) > 1 else 0
        verdict = "樣本不足，照 D2 做" if len(g) < last_agent.min_visits else ("跳過" if mu + se < 0 else "做")
        print(f"   {names_t[es // 3]:14s} {names_v[es % 3]}  樣本 {len(g):3d}  平均 {mu:+.2f}R ± {se:.2f}  → {verdict}")
    nz = [s_ for s_ in range(90) if last_agent.Nh[s_] >= last_agent.min_visits]
    print(f"   持倉狀態有足夠樣本的格數：{len(nz)} / 90")
    ub_n, db_n, ab_n = ("虧損", "0–1R", "1–2R", "2–3.5R", ">3.5R"), ("收<EMA20", "EMA20上0–1ATR", "EMA20上>1ATR"), ("≤3天", "4–10天", ">10天")
    for s_ in nz:
        be = s_ % 2; ab = (s_ // 2) % 3; db = (s_ // 6) % 3; ub = s_ // 18
        hold, ex = last_agent.Qh[s_]
        d2x = bool(be and db == 0)
        rl = last_agent.act_exit(s_, d2x)
        flag = "" if rl == d2x else ("  ← 跟 D2 不同：" + ("出場" if rl else "續抱"))
        print(f"   {ub_n[ub]:6s} {db_n[db]:13s} {ab_n[ab]:6s} {'已保本' if be else '未保本'} 樣本 {last_agent.Nh[s_]:5d} "
              f"Q續抱 {hold:+.2f} Q出場 {ex:+.2f}{flag}")

    print("\n== 台指期日盤：B 與 D2 逐筆對照")
    for x in trB_tx:
        print(f"   B  {x['t']:%Y-%m-%d} {'多' if x['side'] > 0 else '空'} 出 {x['exit_t']:%Y-%m-%d} {x['why']:10s} {x['r']:+6.2f}R")

    if a.out:
        os.makedirs(a.out, exist_ok=True)
        for nm, tr in (("D2_台指期日盤", d2_tx), ("A參數調整_台指期日盤", trA_tx), ("B_Qlearning_台指期日盤", trB_tx)):
            path = os.path.join(a.out, f"RL_{nm}_20萬1口微台.csv")
            eq = CAP
            with open(path, "w", newline="", encoding="utf-8-sig") as f:
                w = csv.writer(f)
                w.writerow(["序號", "方向", "訊號/進場日(13:45)", "進場價", "停損點數", "出場日", "出場價", "出場原因", "R", "損益(元)", "累計帳戶(元)", "參數"])
                for n, x in enumerate(tr, 1):
                    twd = (x["r"] * x["R"] + COST) * MULT - (FEE if x["open"] else 2 * FEE)
                    eq += twd
                    w.writerow([n, "多" if x["side"] > 0 else "空", f"{x['t']:%Y-%m-%d}", f"{x['entry']:.0f}", f"{x['R']:.0f}",
                                f"{x['exit_t']:%Y-%m-%d}", f"{x['exit']:.0f}", x["why"], f"{x['r']:.2f}", f"{twd:.0f}", f"{eq:.0f}",
                                arm_label(ARMS[x["arm"]]) if "arm" in x else "D2"])
            print("輸出", path)


if __name__ == "__main__":
    main()
