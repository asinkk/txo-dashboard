// 比對 liveSummary 與 Python live.json（--offline）的部位、訊號、指標、紀錄摘要
const fs = require('fs'), path = require('path'), E = require('../src/Engine.js');
const [data, nowS, pyJson] = process.argv.slice(2);
const now = E.tMk(+nowS.slice(0, 4), +nowS.slice(5, 7), +nowS.slice(8, 10), +nowS.slice(11, 13), +nowS.slice(14, 16));
function csv(p) { const L = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/); const h = L[0].split(','); return L.slice(1).map(l => { const v = l.split(','); const o = {}; h.forEach((k, i) => o[k] = v[i]); return o; }); }
const src = path.join(data, 'tx_1min');
const hist = fs.readdirSync(src).filter(f => /^Daily_.*\.csv$/.test(f)).sort().map(f => ({name: f.slice(0, -4), live: false,
  rows: csv(path.join(src, f)).map(r => [E.tFromYmdHm(r.date, r.time), +r.contract, +r.open, +r.high, +r.low, +r.close, +r.volume])}));
const daily = csv(path.join(data, 'tx_daily.csv')).map(r => [E.dayFromIso(r.date), r.session, +r.contract, +r.open, +r.high, +r.low, +r.close, +r.volume]);
const res = E.computeAll({files: hist, daily, twii: null, now});
const js = E.liveSummary(res, null), py = JSON.parse(fs.readFileSync(pyJson, 'utf8'));
let bad = 0;
function cmp(name, a, b) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) { bad++; console.log('不同', name, '\n  PY', y, '\n  JS', x); } }
for (const k of ['v3', 'd2']) {
  cmp(k + '.pos', js[k].pos, py[k].pos); cmp(k + '.sig', js[k].sig, py[k].sig); cmp(k + '.levels', js[k].levels, py[k].levels);
  cmp(k + '.fsum', js[k].record.fsum, py[k].record.fsum); cmp(k + '.bsum', js[k].record.bsum, py[k].record.bsum);
  cmp(k + '.backtest', js[k].record.backtest, py[k].record.backtest); cmp(k + '.bar', js[k].bar, py[k].bar); cmp(k + '.forming', js[k].forming, py[k].forming);
}
cmp('d2.ohlc', js.d2.bar_ohlc, py.d2.bar_ohlc); cmp('last', js.last_price, py.last_price);
console.log(bad ? `不同 ${bad} 項` : '全部相同');
process.exit(bad ? 1 : 0);
