// 用 Node 跑 Engine.js，輸出跟 excel/strategy_vba/test/ref_dump.py 一樣格式的文字檔，再用 compare.py 比對。
// 用法：node dump.js 資料夾(含 tx_1min、tx_daily.csv、twii_60min.csv) "YYYY-MM-DD HH:MM" 測試資料夾或空字串 輸出檔
const fs = require('fs'), path = require('path');
const E = require('../src/Engine.js');
const [data, nowS, fix, out] = process.argv.slice(2);
const now = E.tMk(+nowS.slice(0, 4), +nowS.slice(5, 7), +nowS.slice(8, 10), +nowS.slice(11, 13), +nowS.slice(14, 16));
function csv(p) { const L = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/); const h = L[0].split(','); return L.slice(1).map(l => { const v = l.split(','); const o = {}; h.forEach((k, i) => o[k] = v[i]); return o; }); }
const src = path.join(data, 'tx_1min');
const hist = fs.readdirSync(src).filter(f => /^Daily_.*\.csv$/.test(f)).sort().map(f => ({name: f.slice(0, -4), live: false,
  rows: csv(path.join(src, f)).map(r => [E.tFromYmdHm(r.date, r.time), +r.contract, +r.open, +r.high, +r.low, +r.close, +r.volume])}));
let sessions = [];
if (fix) {
  const year = +nowS.slice(0, 4);
  for (const mt of ['0', '1']) {
    const q = JSON.parse(fs.readFileSync(path.join(fix, `quotes_${mt}.json`), 'utf8')).RtData.QuoteList;
    const contracts = new Map(); let key = null;
    E.topSymbols(q).forEach((f, k) => {
      const rt = JSON.parse(fs.readFileSync(path.join(fix, `chart_${f.SymbolID}.json`), 'utf8')).RtData;
      const bars = E.parseChart(rt, mt);
      if (!bars.size) return;
      contracts.set(E.contractCode(f.SymbolID, year), bars);
      if (k === 0) key = Math.min(...bars.keys());
    });
    if (contracts.size && key !== null) sessions.push({key, contracts});
  }
  sessions.sort((a, b) => a.key - b.key);
}
const mg = E.mergedFiles(hist, sessions);
const newT = []; sessions.forEach(s => s.contracts.forEach(b => b.forEach((_, t) => newT.push(t))));
const gap = E.findGap(mg.last, newT, now);
const daily = csv(path.join(data, 'tx_daily.csv')).map(r => [E.dayFromIso(r.date), r.session, +r.contract, +r.open, +r.high, +r.low, +r.close, +r.volume]);
const tw = csv(path.join(data, 'twii_60min.csv')).filter(r => !r.start.endsWith('13:30'));
const twii = [tw.map(r => E.tMk(+r.start.slice(0, 4), +r.start.slice(5, 7), +r.start.slice(8, 10), +r.start.slice(11, 13), +r.start.slice(14, 16))),
  tw.map(r => +r.open), tw.map(r => +r.high), tw.map(r => +r.low), tw.map(r => +r.close)];
const t0 = Date.now();
const res = E.computeAll({files: mg.files, daily, twii, now});
const ms = Date.now() - t0;
const f6 = x => String(Math.round(x * 1e6) / 1e6), tm = E.tFmt;
const L = [];
const rows = res.rows, T = rows.map(r => r[0]);
L.push(`N60\t${T.length}\t${tm(T[0])}\t${tm(T[T.length - 1])}`);
rows.forEach(r => L.push(`B60\t${tm(r[0])}\t${f6(r[1])}\t${f6(r[2])}\t${f6(r[3])}\t${f6(r[4])}`));
L.push(`M1\t${res.m1n}`);
const sp = res.sp.bars;
L.push(`ND\t${sp[0].length}\t${res.sp.i0}`);
sp[0].forEach((t, i) => L.push(`BD\t${E.dFmt(E.tDay(t))}\t${f6(sp[1][i])}\t${f6(sp[2][i])}\t${f6(sp[3][i])}\t${f6(sp[4][i])}`));
const iv = res.hv.ind, idd = res.hd.ind, last = a => a[a.length - 1];
L.push('IND60\t' + ['E20', 'E60', 'hist', 'MID', 'SD', 'ATR'].map(k => f6(last(iv[k]))).join('\t'));
L.push('INDD\t' + ['E20', 'E60', 'ATR'].map(k => f6(last(idd[k]))).join('\t'));
function trs(nm, trades) {
  trades.forEach(x => L.push(['TR', nm, tm(x.t), String(x.side), x.kind, f6(x.R), f6(x.r), f6(x.entry), tm(x.entry_t), f6(x.stop0), f6(x.stop),
    x.open ? '' : tm(x.exit_t), f6(x.exit), String(+x.open), String(+x.be), E.whyText(x)].join('\t')));
}
trs('v3', res.hv.trades); trs('d2', res.hd.trades); trs('tw_v3', res.tws.v3); trs('tw_d2', res.tws.d2);
[['v3', res.hv], ['d2', res.hd]].forEach(([nm, r]) => L.push(`POS\t${nm}\t${r.pos ? r.trades.indexOf(r.pos) : -1}`));
[['v3', res.hv], ['d2', res.hd]].forEach(([nm, r]) => { if (r.sig) { const x = r.sig; L.push(`SIG\t${nm}\t${x.side}\t${x.kind}\t${f6(x.entry)}\t${f6(x.stop0)}`); } });
[['v3', res.hv], ['d2', res.hd]].forEach(([nm, r]) => { if (r.pending_exit) L.push(`PEND\t${nm}\t${E.whyText(r.pending_exit) || '出場條件成立'}`); });
[[1, res.v3c], [2, res.d2c]].forEach(([st, chk]) => [[1, '多'], [2, '空']].forEach(([sd, side]) => {
  const c = chk[side]; ['common', '突破', '拉回'].forEach(g => (c[g] || []).forEach(x => L.push(`CK\t${st}\t${sd}\t${g}\t${+x.ok}\t${x.name}\t${x.detail}`)));
}));
[[1, '多'], [2, '空']].forEach(([sd, side]) => [[1, res.v3c], [2, res.d2c]].forEach(([st, chk]) => {
  const s = chk[side].stop; L.push(`STOP\t${st}\t${sd}\t${+s.ok}\t${f6(s.stop)}\t${f6(s.raw)}`);
}));
gap.forEach(g => L.push(`GAP\t${tm(g)}`));
fs.writeFileSync(out, L.join('\n') + '\n');
console.log('ok', L.length, 'lines; compute', ms, 'ms; live added', mg.added);
