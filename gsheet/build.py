"""把 src/Engine.js 與 src/App.js 合成一個 Code.gs（貼進 Apps Script 用）。用法：python3 gsheet/build.py"""
import os
here = os.path.dirname(os.path.abspath(__file__))
parts = [open(os.path.join(here, "src", f), encoding="utf-8").read() for f in ("Engine.js", "App.js")]
head = ("// 台指策略訊號（Google 試算表獨立版）— 由 gsheet/build.py 從 src/Engine.js、src/App.js 合成，請改 src 再重新產生。\n"
        "// 安裝：試算表「擴充功能 → Apps Script」，把這整份貼進 Code.gs，儲存後重新整理試算表，用上方「台指策略」選單。\n\n")
out = os.path.join(here, "Code.gs")
open(out, "w", encoding="utf-8").write(head + "\n".join(parts))
print("輸出", out, os.path.getsize(out), "bytes")
