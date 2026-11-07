#!/bin/sh
# 計算核心跟 Python（strategy/live.py）逐行比對。用法：sh gsheet/test/run_tests.sh（在 repo 根目錄）
set -e
T=$(mktemp -d)
FIX=excel/strategy_vba/test/fixture_20261107
CMP=excel/strategy_vba/test/compare.py
mkdir -p $T/B/tx_1min
cp history/tx_daily.csv history/twii_60min.csv $T/B/
ls history/tx_1min/*.csv | head -n -2 | xargs -I{} cp {} $T/B/tx_1min/
for now in "2026-11-07 10:00" "2026-11-09 09:10"; do
  python3 excel/strategy_vba/test/ref_dump.py history "$now" "" $T/py.txt >/dev/null
  node gsheet/test/dump.js history "$now" "" $T/js.txt >/dev/null
  python3 $CMP $T/py.txt $T/js.txt
done
for now in "2026-11-07 06:00" "2026-11-07 13:40"; do
  python3 excel/strategy_vba/test/ref_dump.py $T/B "$now" $FIX $T/py.txt >/dev/null
  node gsheet/test/dump.js $T/B "$now" $FIX $T/js.txt >/dev/null
  python3 $CMP $T/py.txt $T/js.txt
done
python3 strategy/live.py --offline --now 2026-11-07T10:00 --out $T/web >/dev/null
node gsheet/test/live_check.js history "2026-11-07 10:00" $T/web/live.json
rm -rf $T
