"""v3 用 60 分K 與 30 分K 的台指期回測比較（history/tx_1min，日盤＋夜盤）。
用法：python strategy/compare_30m.py [history/tx_1min]
"""
import datetime as dt, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_bars import build
from backtest import indicators, tx_revised, tx_revised30
import v3


def bars(src, minutes):
    rows = build(src, minutes, verbose=False)
    return ([r[0] for r in rows], *([r[k] for r in rows] for k in range(1, 5)))


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join("history", "tx_1min")
    b60, b30 = bars(src, 60), bars(src, 30)
    # 30 分K 暖機 100 根約 2.6 天、60 分K 約 5 天；比較時兩邊都從 60 分K 第一筆可交易的時間算起
    start = b60[0][100]
    print(f"資料 {b60[0][0]:%Y-%m-%d} ~ {b60[0][-1]:%Y-%m-%d %H:%M}，比較區間從 {start:%Y-%m-%d %H:%M}")
    variants = [
        ("60 分K v3 限時段", b60, tx_revised, v3.V3),
        ("60 分K v3 不限時段", b60, None, v3.V3),
        ("30 分K v3 限時段（參數不變）", b30, tx_revised30, v3.V3),
        ("30 分K v3 不限時段（參數不變）", b30, None, v3.V3),
        ("30 分K 限時段 移動停利 7 ATR", b30, tx_revised30, dict(v3.V3, exit=7.0)),
        ("30 分K 不限時段 移動停利 7 ATR", b30, None, dict(v3.V3, exit=7.0)),
        ("30 分K 限時段 實體 1.0 ATR", b30, tx_revised30, dict(v3.V3, body_atr=1.0)),
        ("30 分K 不限時段 實體 1.0 ATR", b30, None, dict(v3.V3, body_atr=1.0)),
    ]
    for name, b, allowed, p in variants:
        tr = [x for x in v3.run(b, indicators(*b), allowed, "12:45" if b is b60 else "13:15", p) if x["t"] >= start]
        s = v3.stats(tr)
        pts = sum(x["r"] * x["R"] for x in tr)
        print(f"{name:<28} {v3.fmt(s)}  點數 {pts:+,.0f}")
