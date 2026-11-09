"""排程鬧鐘：GitHub 的 schedule 常延誤或漏跑，這支在一個長時間 job 裡自己看時鐘，
到了 txo.yml、strategy-live.yml、tx-ticks.yml 寫的 cron 時間就用 workflow_dispatch 觸發它們。

- 時間表直接讀那三個 workflow 的 cron（UTC），不用另外維護一份。
- 一次最多跑約 5 小時 45 分（job 上限 6 小時），到時候觸發下一棒自己再結束。
- 下一個排程時間在 90 分鐘以後（例如 06:30 存完 1 分K 到 08:48 開盤前）就先結束，
  由 clock.yml 自己的排程在開盤前再叫起來。
- 同時只留一個鬧鐘：開始時若有更早的鬧鐘還在跑，等兩分鐘（交棒用），還在就結束。

測試：python .github/clock.py --dry-run --now 2026-11-09T00:40 --minutes 120
"""
import argparse, datetime as dt, glob, json, os, re, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
TARGETS = ["txo.yml", "strategy-live.yml", "tx-ticks.yml"]
MAX_RUN = dt.timedelta(hours=5, minutes=45)
IDLE_GAP = dt.timedelta(minutes=90)
UTC = dt.timezone.utc
TPE = dt.timezone(dt.timedelta(hours=8))


def parse_field(s, lo, hi):
    out = set()
    for part in s.split(","):
        step = 1
        if "/" in part:
            part, step = part.split("/")
            step = int(step)
        if part == "*":
            a, b = lo, hi
        elif "-" in part:
            a, b = map(int, part.split("-"))
        else:
            a = b = int(part)
        out.update(range(a, b + 1, step))
    if hi == 7 and 7 in out:  # cron 的星期 7 也是星期日
        out.add(0)
    return out


def load_crons():
    crons = []
    for name in TARGETS:
        with open(os.path.join(HERE, "workflows", name), encoding="utf-8") as f:
            for expr in re.findall(r'^\s*-\s*cron:\s*["\']([^"\']+)["\']', f.read(), re.M):
                m, h, dom, mon, dow = expr.split()
                if dom != "*" or mon != "*":
                    sys.exit(f"{name} 的 cron「{expr}」用到日期／月份，鬧鐘不支援")
                crons.append((name, parse_field(m, 0, 59), parse_field(h, 0, 23), parse_field(dow, 0, 7)))
    return crons


def due(crons, t):
    """UTC 時間 t（到分鐘）要觸發的 workflow。"""
    dow = (t.weekday() + 1) % 7  # cron：0=星期日
    return sorted({n for n, ms, hs, ds in crons if t.minute in ms and t.hour in hs and dow in ds})


def next_slot(crons, t, limit=dt.timedelta(hours=24)):
    s = t.replace(second=0, microsecond=0) + dt.timedelta(minutes=1)
    end = t + limit
    while s <= end:
        if due(crons, s):
            return s
        s += dt.timedelta(minutes=1)
    return None


def gh(*args, dry):
    if dry:
        print("  [dry-run] gh", " ".join(args))
        return ""
    for i in range(3):
        r = subprocess.run(["gh", *args], capture_output=True, text=True)
        if r.returncode == 0:
            return r.stdout
        print("  gh 失敗：", r.stderr.strip())
        time.sleep(5 * (i + 1))
    return None


def older_clock_running(dry):
    if dry:
        return False
    me = int(os.environ.get("GITHUB_RUN_ID", "0"))
    out = gh("run", "list", "--workflow", "clock.yml", "--status", "in_progress",
             "--json", "databaseId", "--limit", "20", dry=False)
    ids = [r["databaseId"] for r in json.loads(out or "[]")]
    return any(i < me for i in ids)


def tpe(t):
    return t.astimezone(TPE).strftime("%m/%d %H:%M")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="不真的觸發、不睡覺，直接模擬時間")
    ap.add_argument("--now", help="測試用：假裝現在是 UTC YYYY-mm-ddTHH:MM（搭配 --dry-run）")
    ap.add_argument("--minutes", type=int, default=0, help="測試用：模擬多少分鐘")
    a = ap.parse_args()
    crons = load_crons()
    ref = os.environ.get("GITHUB_REF_NAME", "main")

    if a.dry_run:
        clock = dt.datetime.fromisoformat(a.now).replace(tzinfo=UTC) if a.now else dt.datetime.now(UTC)
        now = lambda: clock
    else:
        now = lambda: dt.datetime.now(UTC)

    # 交棒時前一棒還沒結束，等一下
    for _ in range(8):
        if not older_clock_running(a.dry_run):
            break
        time.sleep(15)
    else:
        print("已經有鬧鐘在跑，這次結束")
        return

    start = now()
    last = start.replace(second=0, microsecond=0) - dt.timedelta(minutes=1)
    print(f"鬧鐘開始：台北 {tpe(start)}")
    while True:
        t = now().replace(second=0, microsecond=0)
        while last < t:  # 補上中間每一分鐘，睡過頭也不會漏
            last += dt.timedelta(minutes=1)
            for name in due(crons, last):
                late = (now() - last).total_seconds() / 60
                print(f"台北 {tpe(last)} 觸發 {name}" + (f"（晚 {late:.0f} 分）" if late >= 2 else ""))
                gh("workflow", "run", name, "--ref", ref, dry=a.dry_run)
        nxt = next_slot(crons, t)
        if nxt is None or nxt - t > IDLE_GAP:
            print(f"下一次是台北 {tpe(nxt) if nxt else '24 小時後'}，先結束，等 clock.yml 排程再叫醒")
            return
        if now() - start >= MAX_RUN:
            print("快到 6 小時上限，交棒給下一個鬧鐘")
            gh("workflow", "run", "clock.yml", "--ref", ref, dry=a.dry_run)
            return
        if a.dry_run:
            if a.minutes and now() - start >= dt.timedelta(minutes=a.minutes):
                return
            clock += dt.timedelta(minutes=1)
        else:
            time.sleep(max(1, 60 - dt.datetime.now(UTC).second + 1))


if __name__ == "__main__":
    main()
