"""抓加權指數日K（Yahoo，2000 年起），存到 history/twii_daily.csv。只當回測用的歷史資料（不用在即時訊號）。
用法：python strategy/fetch_twii_daily.py [輸出 csv]
"""
import csv, datetime as dt, json, os, sys, time, urllib.request

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join("history", "twii_daily.csv")
p1 = int(dt.datetime(2000, 1, 1, tzinfo=dt.timezone.utc).timestamp())
p2 = int(time.time())
URL = f"https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=1d&period1={p1}&period2={p2}"
req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
d = json.load(urllib.request.urlopen(req, timeout=60))["chart"]["result"][0]
q = d["indicators"]["quote"][0]
today = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).date()
rows = []
for i, t in enumerate(d["timestamp"]):
    o, h, l, c = (q[k][i] for k in ("open", "high", "low", "close"))
    if None in (o, h, l, c) or min(o, h, l, c) <= 0:
        continue
    day = (dt.datetime.fromtimestamp(t, dt.timezone.utc) + dt.timedelta(hours=8)).date()
    if day >= today:          # 當天還沒收完的不存
        continue
    rows.append((day.isoformat(), f"{o:.2f}", f"{max(o, h, c):.2f}", f"{min(o, l, c):.2f}", f"{c:.2f}", q["volume"][i] or 0))
with open(out, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["date", "open", "high", "low", "close", "volume"])
    w.writerows(rows)
print("輸出", out, len(rows), "根", rows[0][0], "~", rows[-1][0])
