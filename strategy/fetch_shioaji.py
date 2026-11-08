"""用永豐金 Shioaji API 抓台指期（TXF）多年 1 分K（含夜盤），存成和 history/tx_1min/ 一樣格式的檔案。

期交所免費的每筆成交資料只留 30 個交易日；Shioaji 的期貨歷史 K 棒從 2020-03-22 起，
需要永豐期貨帳戶的 API 金鑰（不用憑證，只查行情）。

用法（先 pip install shioaji）：
    set SJ_API_KEY=你的金鑰          (Windows；Mac/Linux 用 export)
    set SJ_SECRET_KEY=你的密鑰
    python strategy/fetch_shioaji.py [開始日 2020-03-23] [結束日 今天] [輸出資料夾 history/tx_1min_sj]
    python strategy/build_bars.py history/tx_1min_sj tx_60min_long.csv

- 抓近月（TXFR1）與次月（TXFR2）連續合約，每次最多 30 天。
- 每個交易日一個檔 Daily_YYYY_MM_DD.csv = 前一晚夜盤 + 當天日盤，欄位 date,time,contract,open,high,low,close,volume；
  time 是該分鐘的「開始」時間（Shioaji 的 ts 是分鐘結束，所以減 1 分鐘）。
- contract 填實際月份（依每月第三個星期三結算推算），build_bars.py 會用成交量挑近月並做換月回溯調整。
- 已經存在的日期檔不會重抓，可以中斷後再跑。
"""
import bisect, calendar, collections, csv, datetime as dt, os, sys, time


def third_wed(y, m):
    c = calendar.Calendar()
    weds = [d for d in c.itermonthdates(y, m) if d.month == m and d.weekday() == 2]
    return weds[2]


def add_month(y, m, k=1):
    m += k
    return y + (m - 1) // 12, (m - 1) % 12 + 1


def contract_of(day, which):
    """day 是交易日；which=1 近月、2 次月。回傳 'YYYYMM'。"""
    y, m = day.year, day.month
    if day > third_wed(y, m):
        y, m = add_month(y, m)
    if which == 2:
        y, m = add_month(y, m)
    return f"{y}{m:02d}"


def fetch(api, contract, start, end):
    """回傳 [(分鐘開始 datetime, o, h, l, c, v)]。"""
    out = []
    d = start
    while d <= end:
        e = min(d + dt.timedelta(days=29), end)
        for tries in range(4):
            try:
                kb = api.kbars(contract=contract, start=d.isoformat(), end=e.isoformat())
                break
            except Exception as ex:  # 網路或流量限制，等一下再試
                print("  重試", d, e, ex)
                time.sleep(5 * (tries + 1))
        else:
            raise SystemExit(f"抓不到 {d}~{e}")
        for ts, o, h, l, c, v in zip(kb.ts, kb.Open, kb.High, kb.Low, kb.Close, kb.Volume):
            t = dt.datetime(1970, 1, 1) + dt.timedelta(microseconds=ts // 1000) - dt.timedelta(minutes=1)
            out.append((t, o, h, l, c, int(v)))
        print(f"  {contract.code} {d}~{e}: 累計 {len(out)} 根")
        d = e + dt.timedelta(days=1)
        time.sleep(0.3)
    return out


def main():
    start = dt.date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else dt.date(2020, 3, 23)
    end = dt.date.fromisoformat(sys.argv[2]) if len(sys.argv) > 2 else dt.date.today()
    dst = sys.argv[3] if len(sys.argv) > 3 else os.path.join("history", "tx_1min_sj")
    os.makedirs(dst, exist_ok=True)

    import shioaji as sj
    api = sj.Shioaji()
    api.login(api_key=os.environ["SJ_API_KEY"], secret_key=os.environ["SJ_SECRET_KEY"], fetch_contract=True)
    txf = api.Contracts.Futures.TXF

    # 夜盤前一天 15:00 起，所以多抓一天
    bars = {1: fetch(api, txf.TXFR1, start - dt.timedelta(days=1), end),
            2: fetch(api, txf.TXFR2, start - dt.timedelta(days=1), end)}

    def is_day(t):
        return dt.time(8, 45) <= t.time() <= dt.time(13, 44)

    days = sorted({t.date() for t, *_ in bars[1] if is_day(t)})
    if not days:
        raise SystemExit("沒有日盤資料，檢查帳號權限或日期")

    def trading_day(t):
        if is_day(t):
            return t.date()
        base = t.date() if t.time() >= dt.time(15, 0) else t.date() - dt.timedelta(days=1)
        i = bisect.bisect_right(days, base)  # 夜盤屬於下一個有日盤的交易日
        return days[i] if i < len(days) else None

    files = collections.defaultdict(list)
    for which in (1, 2):
        for t, o, h, l, c, v in bars[which]:
            td = trading_day(t)
            if td is None or td < start:
                continue
            files[td].append((t, contract_of(td, which), o, h, l, c, v))

    n = 0
    for td, rows in sorted(files.items()):
        path = os.path.join(dst, td.strftime("Daily_%Y_%m_%d.csv"))
        if os.path.exists(path):
            continue
        rows.sort(key=lambda r: (r[1], r[0]))
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["date", "time", "contract", "open", "high", "low", "close", "volume"])
            for t, k, o, h, l, c, v in rows:
                w.writerow([t.strftime("%Y%m%d"), t.strftime("%H%M"), k, f"{o:g}", f"{h:g}", f"{l:g}", f"{c:g}", v])
        n += 1
    print(f"寫入 {n} 個交易日到 {dst}（{days[0]} ~ {days[-1]}）")
    api.logout()


if __name__ == "__main__":
    main()
