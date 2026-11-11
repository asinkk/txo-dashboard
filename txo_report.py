#!/usr/bin/env python3
"""台指週選盤面：抓期交所資料 → 計算 → 輸出單一 HTML 圖表頁。只用 Python 標準函式庫。

用法：
    python3 txo_report.py               # 輸出 docs/index.html，並把當次資料存到 history/
    python3 txo_report.py -o 報表.html   # 指定輸出檔
"""
import argparse, datetime as dt, json, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import txo_data  # noqa: E402
import txo_extra  # noqa: E402

FROZEN = getattr(sys, "frozen", False)  # 打包成 EXE 時為 True
RES = getattr(sys, "_MEIPASS", HERE)      # template.html 所在位置
BASE = os.path.dirname(sys.executable) if FROZEN else HERE  # 輸出檔放在 EXE 旁邊


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", default=os.path.join(BASE, "docs", "index.html"))
    ap.add_argument("--history", default=os.path.join(BASE, "history"), help="資料存檔資料夾，給空字串則不存")
    ap.add_argument("--no-open", action="store_true", help="EXE 版預設跑完會打開瀏覽器；排程執行時加這個參數")
    ap.add_argument("--history-at-close", action="store_true",
                    help="只在日盤收盤後（13:45–15:00）與夜盤收盤後（05:00–06:30）存檔，避免每半小時都存")
    a = ap.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        txo_data.main(tmp)
        data = {k: json.load(open(os.path.join(tmp, k + ".json"), encoding="utf-8"))
                for k in ("summary", "strikes", "pain", "pc_history")}
    if not data["summary"]:
        sys.exit("沒有抓到任何到期的資料，未更新頁面。")
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8)))
    data["generated"] = now.strftime("%Y-%m-%d %H:%M")
    data["extra"] = txo_extra.extra(a.history or BASE, data["summary"][0].get("atm_iv"))

    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    html = open(os.path.join(RES, "template.html"), encoding="utf-8").read()
    html = html.replace("/*__DATA__*/null", payload)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(html)

    hm = now.hour * 100 + now.minute
    at_close = 1345 <= hm < 1500 or 500 <= hm < 630
    # 給 Google 試算表 IMPORTDATA 用的 CSV
    import csv as _csv
    outdir = os.path.dirname(os.path.abspath(a.out))
    for k in ("summary", "strikes", "pain", "pc_history"):
        rows = data[k]
        if not rows: continue
        with open(os.path.join(outdir, k + ".csv"), "w", encoding="utf-8", newline="") as f:
            w = _csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader(); w.writerows(rows)

    if a.history and (at_close or not a.history_at_close):
        os.makedirs(a.history, exist_ok=True)
        with open(os.path.join(a.history, now.strftime("%Y-%m-%d_%H%M") + ".json"), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    s = data["summary"][0]
    print(f"已輸出 {a.out}")
    # 開盤前後或期交所資料還沒出時，有些欄位會是 None；這行只是紀錄，不能讓它中斷存檔
    f_ = lambda v, spec: "—" if v is None else format(v, spec)
    print(f"{s['label']}：合成期貨 {f_(s['forward'], ',.0f')}，預期波動 ±{f_(s['straddle'], ',.0f')}"
          f"（{f_(s['range_low'], ',')}–{f_(s['range_high'], ',')}），"
          f"ATM IV {f_(s['atm_iv'], '.1%')}，P/C(OI) {f_(s['pc_oi'], '')}，最大痛點 {f_(s['max_pain'], ',')}")
    if FROZEN and not a.no_open:
        import webbrowser
        webbrowser.open("file:///" + os.path.abspath(a.out).replace(os.sep, "/"))


if __name__ == "__main__":
    if FROZEN:
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.reconfigure(errors="replace")  # Windows 主控台遇到無法顯示的字元不要當掉
            except Exception:
                pass
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # 雙擊執行時讓視窗停住，才看得到錯誤
        if FROZEN and "--no-open" not in sys.argv:
            print("執行失敗：", repr(e))
            input("按 Enter 關閉視窗…")
        raise
