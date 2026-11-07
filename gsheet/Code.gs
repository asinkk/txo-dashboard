// 台指策略訊號（Google 試算表獨立版）— 由 gsheet/build.py 從 src/Engine.js、src/App.js 合成，請改 src 再重新產生。
// 安裝：試算表「擴充功能 → Apps Script」，把這整份貼進 Code.gs 並儲存；上方函式選單選 setup（預設就是第一個）按「執行」，
// 授權後會更新一次並開啟每 15 分鐘自動更新。之後也可以用試算表上方的「台指策略」選單。

// 第一次安裝：更新一次＋開啟每 15 分鐘自動更新（放在最前面，Apps Script 的函式選單預設就是它）
function setup() { installTrigger(15); }

// ============================================================
// 台指策略訊號（Google 試算表獨立版）：計算核心
// 照 strategy/build_bars.py、backtest.py、v3.py、daily.py、live.py、trades_page.py 逐行改寫，
// 不用任何 Apps Script 功能，所以也能在 Node 跑測試（gsheet/test/）。
//
// 時間一律用「台北時間的分鐘數」（從 1970-01-01 00:00 起算的整數，當成 UTC 處理，不碰時區）。
// 日期 = 分鐘數 / 1440 取整數（day number）。
// ============================================================

var COST = 3;
var CAP = 200000, MULT = 10, FEE = 25;       // 本金 20 萬、1 口微台（每點 10 元）、每次下單 25 元
var V3P = {pullback: true, body_atr: 0.8, stop_atr: 1.5, be_r: 1.0, exit: 5.0};
var D2P = {entry: 20, body_atr: 0.0, macd: false, pullback: false, stop_atr: 1.0, be_r: 1.0, exit: 'ema20', entry_at: 'close'};
var D2_WARMUP = 60;

// ---------- 時間 ----------
function tMk(y, mo, d, h, mi) { return Math.round(Date.UTC(y, mo - 1, d, h || 0, mi || 0) / 60000); }
function tDay(t) { return Math.floor(t / 1440); }
function tHM(t) { return t - tDay(t) * 1440; }               // 當天第幾分鐘
function tCombine(day, hm) { return day * 1440 + hm; }
function hm(h, m) { return h * 60 + m; }
function tWeekday(t) { return (new Date(tDay(t) * 86400000).getUTCDay() + 6) % 7; }   // 週一 = 0（同 Python）
function dayWeekday(day) { return (new Date(day * 86400000).getUTCDay() + 6) % 7; }
function p2(n) { return (n < 10 ? '0' : '') + n; }
function tParts(t) { var d = new Date(t * 60000); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()]; }
function tFmt(t) { var p = tParts(t); return p[0] + '-' + p2(p[1]) + '-' + p2(p[2]) + ' ' + p2(p[3]) + ':' + p2(p[4]); }
function dFmt(day) { return tFmt(day * 1440).slice(0, 10); }
function tFromYmdHm(ymd, hhmm) {   // '20261105', '1500'
  ymd = String(ymd); hhmm = ('0000' + hhmm).slice(-4);
  return tMk(+ymd.slice(0, 4), +ymd.slice(4, 6), +ymd.slice(6, 8), +hhmm.slice(0, 2), +hhmm.slice(2, 4));
}
function dayFromIso(s) { return tDay(tMk(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10), 0, 0)); }
function isDayT(t) { var m = tHM(t); return m >= hm(8, 45) && m <= hm(13, 45); }
function nextWeekday(day) { day += 1; while (dayWeekday(day) >= 5) day += 1; return day; }

function usDst(t) {
  var y = tParts(t)[0];
  function nthSunday(year, month, n) {
    var first = tDay(tMk(year, month, 1, 0, 0));
    return first + (6 - dayWeekday(first) + 7) % 7 + 7 * (n - 1);
  }
  var d = tDay(t);
  return nthSunday(y, 3, 2) <= d && d < nthSunday(y, 11, 1);
}
function txRevised(t) {
  var m = tHM(t);
  if (m === hm(8, 45) || m === hm(9, 45) || m === hm(10, 45) || m === hm(11, 45)) return true;
  return usDst(t) ? (m === hm(21, 0) || m === hm(22, 0) || m === hm(23, 0)) : (m === hm(22, 0) || m === hm(23, 0) || m === 0);
}
function twiiRevised(t) { var h = Math.floor(tHM(t) / 60); return h >= 9 && h <= 12; }

// ---------- Python 相容的四捨五入與格式 ----------
// 十進位四捨五入成字串，跟 Python 一樣：看二進位的精確值，剛好一半時取偶數
function decStr(a, n) {                     // a ≥ 0
  var ex = a.toFixed(60), dot = ex.indexOf('.');
  var tail = ex.slice(dot + 1 + n);
  if (/^50*$/.test(tail)) {                 // 剛好一半
    var lo = ex.slice(0, dot + 1 + n);
    if (n === 0) lo = lo.slice(0, -1);
    var last = Number(lo.charAt(lo.length - 1));
    if (last % 2 === 0) return lo;
  }
  return a.toFixed(n);
}
function pyRound(x) {                     // round(x)
  var v = Number(decStr(Math.abs(x), 0));
  return x < 0 ? -v : v;
}
function pyRoundN(x, n) {                 // round(x, n)
  var v = Number(decStr(Math.abs(x), n));
  return x < 0 ? -v : v;
}
// sum()：Python 3.12 起浮點數加總用補償加總（Neumaier），R 合計要用同一套才會一樣
function pySum(xs) {
  var s = 0, c = 0;
  for (var i = 0; i < xs.length; i++) {
    var x = xs[i], t = s + x;
    if (Math.abs(s) >= Math.abs(x)) c += (s - t) + x; else c += (x - t) + s;
    s = t;
  }
  return s + c;
}
function commas(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
// format(x, '[+],.Nf')
function fnum(x, n, plus) {
  var neg = x < 0 || (x === 0 && 1 / x < 0);
  var parts = decStr(Math.abs(x), n).split('.');
  var t = commas(parts[0]) + (parts.length > 1 ? '.' + parts[1] : '');
  return (neg ? '-' : plus ? '+' : '') + t;
}

// ---------- K 棒 ----------
// files：[{name:'Daily_2026_11_06', live:false, rows:[[t, contract, o, h, l, c, v], ...]}]，依 name 排序；
// rows 依（契約、時間）排序，跟 history 的 CSV 一樣。
function buildBars(files, minutes) {
  var data = [];
  files.forEach(function (f) {
    var vol = new Map(), last = new Map();
    f.rows.forEach(function (r) {
      vol.set(r[1], (vol.get(r[1]) || 0) + r[6]);
      last.set(r[1], r[5]);
    });
    var front = null, best = -1;
    vol.forEach(function (v, c) { if (v > best) { best = v; front = c; } });
    data.push({front: front, last: last, rows: f.rows.filter(function (r) { return r[1] === front; })});
  });
  var off = data.map(function () { return 0; });
  for (var i = data.length - 1; i > 0; i--) {
    off[i - 1] = off[i];
    var nw = data[i].front, old = data[i - 1].front;
    if (nw !== old) {
      var a = data[i - 1].last.get(nw), b = data[i - 1].last.get(old);
      if (a !== undefined && b !== undefined) off[i - 1] += a - b;
    }
  }
  var bars = new Map();
  data.forEach(function (d, k) {
    var o = off[k];
    d.rows.forEach(function (r) {
      var t = r[0], m = tHM(t), start, lastK;
      if (m >= hm(8, 45) && m <= hm(13, 45)) { start = tCombine(tDay(t), hm(8, 45)); lastK = Math.floor(300 / minutes) - 1; }
      else {
        var base = m >= hm(15, 0) ? tDay(t) : tDay(t) - 1;
        start = tCombine(base, hm(15, 0)); lastK = Math.floor(840 / minutes) - 1;
      }
      var kk = Math.min(Math.floor((t - start) / minutes), lastK);
      var key = start + kk * minutes;
      var b = bars.get(key);
      if (!b) bars.set(key, [r[2] + o, r[3] + o, r[4] + o, r[5] + o, r[6]]);
      else { b[1] = Math.max(b[1], r[3] + o); b[2] = Math.min(b[2], r[4] + o); b[3] = r[5] + o; b[4] += r[6]; }
    });
  });
  var keys = Array.from(bars.keys()).sort(function (a, b) { return a - b; });
  return keys.map(function (k) { var b = bars.get(k); return [k, b[0], b[1], b[2], b[3], b[4]]; });
}

// {交易日: Map(契約 -> [[t,o,h,l,c,v]])}
function readRawMinutes(files) {
  var out = new Map();
  files.forEach(function (f) {
    var fdate = dayFromIso(f.name.slice(6, 10) + '-' + f.name.slice(11, 13) + '-' + f.name.slice(14, 16));
    f.rows.forEach(function (r) {
      var t = r[0], td;
      if (!f.live) td = fdate;
      else if (isDayT(t)) td = tDay(t);
      else td = nextWeekday(tHM(t) >= hm(15, 0) ? tDay(t) : tDay(t) - 1);
      if (!out.has(td)) out.set(td, new Map());
      var cs = out.get(td);
      if (!cs.has(r[1])) cs.set(r[1], []);
      cs.get(r[1]).push([t, r[2], r[3], r[4], r[5], r[6]]);
    });
  });
  out.forEach(function (cs) { cs.forEach(function (ms) { ms.sort(function (a, b) { return a[0] - b[0]; }); }); });
  return out;
}

// 台指期近月連續日K（只用日盤），回傳 {bars:[T,O,H,L,C], i0, m（調整後 1 分K）}
// dailyRows：[[day, session('日盤'/'夜盤'), contract, o, h, l, c, v]]（tx_daily.csv 的順序）
function txDailyBars(dailyRows, raw) {
  var r2 = new Map();
  raw.forEach(function (cs, d) {
    var m = new Map();
    cs.forEach(function (ms, c) { var x = ms.filter(function (q) { return isDayT(q[0]); }); if (x.length) m.set(c, x); });
    if (m.size) r2.set(d, m);
  });
  raw = r2;
  var per = new Map();
  var sess = new Map();
  dailyRows.forEach(function (r) {
    var k = r[0] + '|' + r[2];
    if (!sess.has(k)) sess.set(k, {d: r[0], c: r[2], s: {}});
    sess.get(k).s[r[1]] = r;
  });
  sess.forEach(function (x) {
    if (raw.has(x.d)) return;
    var p = x.s['日盤'];
    if (!p) return;
    if (!per.has(x.d)) per.set(x.d, new Map());
    per.get(x.d).set(x.c, [p[3], p[4], p[5], p[6], p[7]]);
  });
  raw.forEach(function (cs, d) {
    cs.forEach(function (ms, c) {
      var h = -Infinity, l = Infinity, v = 0;
      ms.forEach(function (q) { h = Math.max(h, q[2]); l = Math.min(l, q[3]); v += q[5]; });
      if (!per.has(d)) per.set(d, new Map());
      per.get(d).set(c, [ms[0][1], h, l, ms[ms.length - 1][4], v]);
    });
  });
  var dates = Array.from(per.keys()).sort(function (a, b) { return a - b; });
  var front = dates.map(function (d) {
    var best = -1, f = null;
    per.get(d).forEach(function (b, c) { if (b[4] > best) { best = b[4]; f = c; } });
    return f;
  });
  var off = dates.map(function () { return 0; });
  for (var i = dates.length - 1; i > 0; i--) {
    off[i - 1] = off[i];
    var nw = front[i], old = front[i - 1], pm = per.get(dates[i - 1]);
    if (nw !== old && pm.has(nw)) off[i - 1] += pm.get(nw)[3] - pm.get(old)[3];
  }
  var T = [], O = [], H = [], L = [], C = [], m = [];
  dates.forEach(function (d, k) {
    var b = per.get(d).get(front[k]), o = off[k];
    T.push(d * 1440); O.push(b[0] + o); H.push(b[1] + o); L.push(b[2] + o); C.push(b[3] + o);
    var cs = raw.get(d);
    if (cs && cs.has(front[k])) cs.get(front[k]).forEach(function (q) { m.push([q[0], q[1] + o, q[2] + o, q[3] + o, q[4] + o, q[5]]); });
  });
  var i0 = -1;
  for (var j = 0; j < dates.length; j++) if (raw.has(dates[j])) { i0 = j; break; }
  return {bars: [T, O, H, L, C], i0: i0, m: m};
}

// 加權指數 60 分K → 日K
function twiiDaily(b) {
  var T = [], O = [], H = [], L = [], C = [], last = null;
  for (var i = 0; i < b[0].length; i++) {
    var d = tDay(b[0][i]);
    if (d !== last) { T.push(d * 1440); O.push(b[1][i]); H.push(b[2][i]); L.push(b[3][i]); C.push(b[4][i]); last = d; }
    else { var k = T.length - 1; H[k] = Math.max(H[k], b[2][i]); L[k] = Math.min(L[k], b[3][i]); C[k] = b[4][i]; }
  }
  return [T, O, H, L, C];
}

// ---------- 指標 ----------
function ema(x, p) {
  var k = 2 / (p + 1), out = [x[0]];
  for (var i = 1; i < x.length; i++) out.push(out[i - 1] + k * (x[i] - out[i - 1]));
  return out;
}
function pstdev(w) {
  var n = w.length, s = 0, i;
  for (i = 0; i < n; i++) s += w[i];
  var mu = s / n, ss = 0;
  for (i = 0; i < n; i++) ss += (w[i] - mu) * (w[i] - mu);
  return Math.sqrt(ss / n);
}
function indicators(b) {
  var H = b[2], L = b[3], C = b[4], n = C.length;
  var ind = {E10: ema(C, 10), E20: ema(C, 20), E60: ema(C, 60)};
  var e12 = ema(C, 12), e26 = ema(C, 26), macd = e12.map(function (v, i) { return v - e26[i]; }), sig = ema(macd, 9);
  ind.hist = macd.map(function (v, i) { return v - sig[i]; });
  var MID = new Array(n).fill(null), SD = new Array(n).fill(null);
  for (var i = 19; i < n; i++) {
    var w = C.slice(i - 19, i + 1), s = 0;
    for (var j = 0; j < 20; j++) s += w[j];
    MID[i] = s / 20; SD[i] = pstdev(w);
  }
  ind.MID = MID; ind.SD = SD;
  var ATR = [], a = null;
  for (i = 0; i < n; i++) {
    var tr = i === 0 ? H[i] - L[i] : Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
    a = a === null ? tr : a + (tr - a) / 14;
    ATR.push(a);
  }
  ind.ATR = ATR;
  return ind;
}

// ---------- v3.run ----------
function runV3(b, ind, allowed) {
  var T = b[0], O = b[1], H = b[2], L = b[3], C = b[4], n = C.length, p = V3P;
  var E20 = ind.E20, E60 = ind.E60, hist = ind.hist, MID = ind.MID, SD = ind.SD, ATR = ind.ATR;
  var trades = [], i = 100;
  while (i < n - 1) {
    var sig = null;
    if (!allowed || allowed(T[i])) {
      for (var si = 0; si < 2; si++) {
        var s = si === 0 ? 1 : -1;
        if (!((E20[i] - E60[i]) * s > 0)) continue;
        var body = (C[i] - O[i]) * s, rng = H[i] - L[i];
        if (body > 0 && body >= 0.5 * rng && body >= p.body_atr * ATR[i - 1] &&
            (C[i] - (MID[i] + 2 * SD[i] * s)) * s > 0 && hist[i] * s > 0) { sig = [s, '突破']; break; }
        if (p.pullback && body > 0 && body >= 0.5 * rng &&
            ((s > 0 ? L[i] : H[i]) - E20[i]) * s <= 0 && (C[i] - E20[i]) * s > 0 &&
            (C[i] - (s > 0 ? H[i - 1] : L[i - 1])) * s > 0 && (E60[i] - E60[i - 5]) * s > 0) { sig = [s, '拉回']; break; }
      }
    }
    if (!sig) { i++; continue; }
    var side = sig[0], kind = sig[1], e = O[i + 1];
    var ext = side > 0 ? L[i] : H[i];
    var raw = Math.abs(e - (ext - 0.1 * ATR[i] * side));
    if (raw > (p.stop_atr + 0.5) * ATR[i]) { i++; continue; }
    var stop = e - Math.max(Math.min(raw, p.stop_atr * ATR[i]), 0.5 * ATR[i]) * side;
    var R = Math.abs(e - stop);
    var pnl = 0, be = false, j = i + 1, best = e, stop0 = stop, xt = null, xp = null, open = false;
    while (j < n) {
      var worst = side > 0 ? L[j] : H[j];
      if ((worst - stop) * side <= 0) {
        var px = (O[j] - stop) * side > 0 ? stop : O[j];
        pnl = (px - e) * side; xt = T[j]; xp = px; break;
      }
      if (!be && (C[j] - e) * side >= p.be_r * R) { be = true; stop = e + COST * side; }
      if (j + 1 >= n) { pnl = (C[j] - e) * side; xt = T[j]; xp = C[j]; open = true; break; }
      if (be) {
        best = Math.max(best * side, C[j] * side) * side;
        var trail = best - p.exit * ATR[j] * side;
        if ((trail - stop) * side > 0) stop = trail;
      }
      j++;
    }
    var net = pnl - COST;
    trades.push({t: T[i], side: side, kind: kind, R: R, r: net / R, bars: j - i, entry: e, entry_t: T[i + 1],
                 stop0: stop0, stop: stop, exit_t: xt, exit: xp, open: open, be: be});
    i = j;
  }
  return trades;
}

// ---------- daily.run（D2） ----------
function runD2(b, ind, sigFrom) {
  var T = b[0], O = b[1], H = b[2], L = b[3], C = b[4], n = C.length, p = D2P;
  var E20 = ind.E20, E60 = ind.E60, hist = ind.hist, ATR = ind.ATR;
  var trades = [], i = D2_WARMUP;
  while (i < n - 1) {
    var sig = null;
    if (sigFrom === null || sigFrom === undefined || i >= sigFrom) {
      for (var si = 0; si < 2; si++) {
        var s = si === 0 ? 1 : -1;
        if ((E20[i] - E60[i]) * s <= 0) continue;
        var body = (C[i] - O[i]) * s, rng = H[i] - L[i];
        var strong = body > 0 && body >= 0.5 * rng;
        var N = p.entry, w = C.slice(i - N, i);
        var brk = s > 0 ? C[i] > Math.max.apply(null, w) : C[i] < Math.min.apply(null, w);
        if (strong && body >= p.body_atr * ATR[i - 1] && brk && (hist[i] * s > 0 || !p.macd)) { sig = [s, '突破']; break; }
      }
    }
    if (!sig) { i++; continue; }
    var side = sig[0], kind = sig[1];
    var e = C[i];
    var ext = side > 0 ? L[i] : H[i];
    var raw = Math.abs(e - (ext - 0.1 * ATR[i] * side));
    if (raw > (p.stop_atr + 0.5) * ATR[i]) { i++; continue; }
    var stop = e - Math.max(Math.min(raw, p.stop_atr * ATR[i]), 0.5 * ATR[i]) * side;
    var R = Math.abs(e - stop);
    var pnl = 0, be = false, j = i + 1, stop0 = stop, xt = null, xp = null, open = false, why = '';
    while (j < n) {
      var worst = side > 0 ? L[j] : H[j];
      if ((worst - stop) * side <= 0) {
        var gap = (O[j] - stop) * side <= 0;
        var px = gap ? O[j] : stop;
        pnl = (px - e) * side; xt = T[j]; xp = px;
        why = ((stop - e) * side > COST ? '移動停利' : be ? '保本停損' : '初始停損') + (gap ? '（跳空成交）' : '');
        break;
      }
      if (!be && (C[j] - e) * side >= p.be_r * R) { be = true; stop = e + COST * side; }
      if (j + 1 >= n) { pnl = (C[j] - e) * side; xt = T[j]; xp = C[j]; open = true; why = '持倉中'; break; }
      if (be && (C[j] - E20[j]) * side < 0) {
        pnl = (O[j + 1] - e) * side; xt = T[j + 1]; xp = O[j + 1]; why = '跌破EMA20'; j++; break;
      }
      j++;
    }
    var net = pnl - COST;
    trades.push({t: T[i], side: side, kind: kind, R: R, r: net / R, bars: j - i, entry: e, entry_t: T[i],
                 stop0: stop0, stop: stop, exit_t: xt, exit: xp, open: open, be: be, why: why});
    i = j;
  }
  return trades;
}

// ---------- live.py：評估最後一根 ----------
function withDummy(b, step) {
  var c = b[4][b[4].length - 1];
  return [b[0].concat([b[0][b[0].length - 1] + step]), b[1].concat([c]), b[2].concat([c]), b[3].concat([c]), b[4].concat([c])];
}
function evaluate(b, runner, step) {
  var ind = indicators(b);
  var trades = runner(b, ind);
  var b2 = withDummy(b, step);
  var trades2 = runner(b2, indicators(b2));
  var lastT = b[0][b[0].length - 1];
  var pos = null, sig = null, pend = null, k;
  for (k = 0; k < trades.length; k++) if (trades[k].open) { pos = trades[k]; break; }
  for (k = 0; k < trades2.length; k++) if (trades2[k].t === lastT) { sig = trades2[k]; break; }
  if (pos) {
    for (k = 0; k < trades2.length; k++) if (trades2[k].t === pos.t) { if (!trades2[k].open) pend = trades2[k]; break; }
  }
  return {ind: ind, trades: trades, pos: pos, sig: sig, pending_exit: pend};
}

function exitReasonV3(x) {
  var why = (x.stop - x.entry) * x.side > COST ? '移動停利' : x.be ? '保本停損' : '初始停損';
  return why + (pyRound(x.exit) !== pyRound(x.stop) ? '（跳空成交）' : '');
}
function lowerBound(a, v) { var lo = 0, hi = a.length; while (lo < hi) { var mid = (lo + hi) >> 1; if (a[mid] < v) lo = mid + 1; else hi = mid; } return lo; }
function firstTouch(mT, m, start, end, stop, side) {
  for (var i = lowerBound(mT, start); i < m.length && mT[i] < end; i++) {
    if (((side > 0 ? m[i][3] : m[i][2]) - stop) * side <= 0) return mT[i];
  }
  return null;
}
// 進出場時間精確到分鐘（同 live.refine_times，prev=None）
function refineTimes(trades, strat, m, dayOpen, dayClose) {
  dayOpen = dayOpen === undefined ? hm(8, 45) : dayOpen;
  dayClose = dayClose === undefined ? hm(13, 45) : dayClose;
  var mT = m.map(function (r) { return r[0]; });
  trades.forEach(function (x) {
    if (strat === 'd2') x.entry_t = tCombine(tDay(x.entry_t), dayClose);
    else if (x.why === undefined) x.why = x.open ? '' : exitReasonV3(x);
    if (x.open) return;
    var start, end;
    if (strat === 'd2') {
      var d = tDay(x.exit_t);
      if (x.why.indexOf('跌破') === 0) { x.exit_t = tCombine(d, dayOpen); return; }
      start = tCombine(d, dayOpen); end = tCombine(d, dayClose) + 1;
    } else { start = x.exit_t; end = x.exit_t + 60; }
    var t = firstTouch(mT, m, start, end, x.stop, x.side);
    if (t !== null) x.exit_t = t;
  });
  return trades;
}

// ---------- 條件明細 ----------
function ck(name, ok, detail) { return {name: name, ok: !!ok, detail: detail || ''}; }
function projStop(e, ext, atr, side, stopAtr, maxAtr) {
  var raw = Math.abs(e - (ext - 0.1 * atr * side));
  var stop = e - Math.max(Math.min(raw, stopAtr * atr), 0.5 * atr) * side;
  return {ok: raw <= maxAtr * atr, stop: stop, raw: raw};
}
function v3Checks(b, ind, i) {
  var T = b[0], O = b[1], H = b[2], L = b[3], C = b[4], p = V3P, out = {};
  var E20 = ind.E20, E60 = ind.E60, hist = ind.hist, MID = ind.MID, SD = ind.SD, ATR = ind.ATR;
  [[1, '多'], [-1, '空']].forEach(function (q) {
    var s = q[0], body = (C[i] - O[i]) * s, rng = H[i] - L[i];
    var strong = body > 0 && body >= 0.5 * rng, bb = MID[i] + 2 * SD[i] * s, prev = s > 0 ? H[i - 1] : L[i - 1];
    var gt = s > 0 ? '>' : '<', st = projStop(C[i], s > 0 ? L[i] : H[i], ATR[i], s, p.stop_atr, p.stop_atr + 0.5);
    var hhmm = tFmt(T[i]).slice(11);
    out[q[1]] = {
      common: [ck('可進場時段', txRevised(T[i]), hhmm + ' 這根'),
               ck('趨勢 EMA20 ' + gt + ' EMA60', (E20[i] - E60[i]) * s > 0, fnum(E20[i], 0) + ' / ' + fnum(E60[i], 0))],
      '突破': [ck((s > 0 ? '紅' : '黑') + 'K 實體 ≥ 高低差一半', strong, '實體 ' + fnum(C[i] - O[i], 0, true) + '、高低差 ' + fnum(rng, 0)),
               ck('實體 ≥ 0.8 ATR', body >= p.body_atr * ATR[i - 1], '需 ' + fnum(p.body_atr * ATR[i - 1], 0) + ' 點'),
               ck('收盤' + (s > 0 ? '站上布林上軌' : '跌破布林下軌'), (C[i] - bb) * s > 0, (s > 0 ? '上' : '下') + '軌 ' + fnum(bb, 0)),
               ck('MACD 柱' + (s > 0 ? '翻正' : '翻負'), hist[i] * s > 0, fnum(hist[i], 1, true))],
      '拉回': [ck((s > 0 ? '紅' : '黑') + 'K 實體 ≥ 高低差一半', strong, ''),
               ck((s > 0 ? '低點碰到' : '高點碰到') + ' EMA20', ((s > 0 ? L[i] : H[i]) - E20[i]) * s <= 0, 'EMA20 ' + fnum(E20[i], 0)),
               ck('收盤' + (s > 0 ? '站回' : '壓回') + ' EMA20', (C[i] - E20[i]) * s > 0, ''),
               ck('收盤' + (s > 0 ? '過前一根高點' : '破前一根低點'), (C[i] - prev) * s > 0, fnum(prev, 0)),
               ck('EMA60 比 5 根前' + (s > 0 ? '高' : '低'), (E60[i] - E60[i - 5]) * s > 0, fnum(E60[i] - E60[i - 5], 0, true))],
      stop: st
    };
  });
  return out;
}
function d2Checks(b, ind, i) {
  var O = b[1], H = b[2], L = b[3], C = b[4], p = D2P, out = {}, N = p.entry;
  var E20 = ind.E20, E60 = ind.E60, ATR = ind.ATR;
  [[1, '多'], [-1, '空']].forEach(function (q) {
    var s = q[0], body = (C[i] - O[i]) * s, rng = H[i] - L[i], w = C.slice(i - N, i);
    var lvl = s > 0 ? Math.max.apply(null, w) : Math.min.apply(null, w);
    var gt = s > 0 ? '>' : '<', st = projStop(C[i], s > 0 ? L[i] : H[i], ATR[i], s, p.stop_atr, p.stop_atr + 0.5);
    out[q[1]] = {
      common: [ck('趨勢 日EMA20 ' + gt + ' EMA60', (E20[i] - E60[i]) * s > 0, fnum(E20[i], 0) + ' / ' + fnum(E60[i], 0))],
      '突破': [ck('收盤創 ' + N + ' 日新' + (s > 0 ? '高' : '低'), (C[i] - lvl) * s > 0, '需' + (s > 0 ? '高於' : '低於') + ' ' + fnum(lvl, 0)),
               ck((s > 0 ? '紅' : '黑') + 'K 實體 ≥ 高低差一半', body > 0 && body >= 0.5 * rng,
                  '開 ' + fnum(O[i], 0) + '、實體 ' + fnum(C[i] - O[i], 0, true) + '、高低差 ' + fnum(rng, 0)),
               ck('停損距離 ≤ 1.5 ATR（不追太遠）', st.ok, fnum(st.raw, 0) + ' 點 / 上限 ' + fnum(1.5 * ATR[i], 0))],
      stop: st, level: lvl
    };
  });
  return out;
}

// ---------- 交易列 ----------
var FORWARD_START = tMk(2026, 11, 9, 8, 45);
var FORWARD_DAY0 = tMk(2026, 11, 9, 0, 0);
var TWO_YEARS = tMk(2024, 11, 7, 0, 0);
function whyText(x) { var w = x.why || ''; return x.side < 0 ? w.replace('跌破', '站上') : w; }
function twdOf(x) { return (x.r * x.R + COST) * MULT - (x.open ? FEE : 2 * FEE); }
function tradeRow(x, lastC) {
  if (x.open && lastC !== null && lastC !== undefined) {
    var pts = (lastC - x.entry) * x.side;
    x = Object.assign({}, x, {r: (pts - COST) / x.R});
  }
  return {signal: tFmt(x.t), kind: x.kind, side: x.side > 0 ? '多' : '空', entry_t: tFmt(x.entry_t), entry: pyRound(x.entry),
          stop0: pyRound(x.stop0), stop: pyRound(x.stop), exit_t: x.open ? '' : tFmt(x.exit_t), exit: x.open ? '' : pyRound(x.exit),
          r: pyRoundN(x.r, 2), pts: pyRound(x.r * x.R + COST), twd: pyRound(twdOf(x)), open: x.open, be: x.be, why: whyText(x),
          phase: x.t >= FORWARD_DAY0 ? '前測' : '回測'};
}

// 加權指數近 2 年回測（trades_page.twii_backtests）
function twiiBacktests(tw60) {
  var twd = twiiDaily(tw60);
  var v = runV3(tw60, indicators(tw60), twiiRevised).filter(function (x) { return x.t >= TWO_YEARS; });
  var d = runD2(twd, indicators(twd), null).filter(function (x) { return x.t >= TWO_YEARS; });
  var m = tw60[0].map(function (t, i) { return [t, tw60[1][i], tw60[2][i], tw60[3][i], tw60[4][i]]; });
  refineTimes(v, 'v3', m);
  refineTimes(d, 'd2', m, hm(9, 0), hm(13, 30));
  return {v3: v, d2: d};
}

// ---------- 資料缺口（live.find_gap） ----------
function findGap(histLast, newTimes, now) {
  function expected(a, b) {
    var out = [];
    for (var d = tDay(a); d <= tDay(b); d++) {
      if (dayWeekday(d) >= 5) continue;
      [hm(8, 45), hm(15, 0)].forEach(function (h) { var st = tCombine(d, h); if (a < st && st <= b - 5) out.push(st); });
    }
    return out;
  }
  if (histLast === null) return [];
  var nw = newTimes.filter(function (t) { return t > histLast; });
  if (!nw.length) return expected(histLast, now);
  var mn = Math.min.apply(null, nw), mx = Math.max.apply(null, nw);
  return expected(histLast, mn).concat(expected(mx, now));
}

function sessionState(now) {
  var wd = tWeekday(now), m = tHM(now);
  if (wd < 5 && m >= hm(8, 45) && m < hm(13, 45)) return '日盤交易中';
  if ((wd < 5 && m >= hm(15, 0)) || (wd >= 1 && wd <= 5 && m < hm(5, 0))) return '夜盤交易中';
  return '休市';
}
function fmtLag(m) {
  m = Math.max(0, pyRound(m));
  return m < 120 ? m + ' 分鐘' : m < 2880 ? Math.floor(m / 60) + ' 小時 ' + (m % 60) + ' 分' : Math.floor(m / 1440) + ' 天';
}

// ---------- 全部算一次（live.main 的計算部分） ----------
// input: {files（history＋即時，同 merged_dir 的結果）, daily（tx_daily 列）, twii（[T,O,H,L,C]）, now, prevGen, histLast}
function computeAll(input) {
  var now = input.now;
  var rows = buildBars(input.files, 60), m1 = buildBars(input.files, 1), raw = readRawMinutes(input.files);
  var T = rows.map(function (r) { return r[0]; });
  var hb = [T, rows.map(function (r) { return r[1]; }), rows.map(function (r) { return r[2]; }), rows.map(function (r) { return r[3]; }), rows.map(function (r) { return r[4]; })];
  var lastC = hb[4][hb[4].length - 1];
  var v3End = T[T.length - 1] + 60;
  var hv = evaluate(hb, function (b, ind) { return runV3(b, ind, txRevised); }, 60);
  var v3c = v3Checks(hb, hv.ind, T.length - 1);
  var sp = txDailyBars(input.daily, raw);
  var dlast = sp.bars[0][sp.bars[0].length - 1];
  var dClose = tCombine(tDay(dlast), hm(13, 45));
  var hd = evaluate(sp.bars, function (b, ind) { return runD2(b, ind, sp.i0); }, 1440);
  var d2c = d2Checks(sp.bars, hd.ind, sp.bars[0].length - 1);
  refineTimes(hv.trades, 'v3', m1);
  refineTimes(hd.trades, 'd2', sp.m);
  var tws = input.twii && input.twii[0].length > 200 ? twiiBacktests(input.twii) : {v3: [], d2: []};
  return {now: now, rows: rows, m1n: m1.length, hb: hb, lastC: lastC, v3End: v3End, v3Forming: now < v3End, hv: hv, v3c: v3c,
          sp: sp, dlast: dlast, dForming: now < dClose, hd: hd, d2c: d2c, tws: tws};
}

// 網頁 live.json 的內容（給即時訊號分頁用）
function liveSummary(res, prevGen) {
  var now = res.now, lastC = res.lastC;
  function sigTime(x, isV3) { return isV3 ? x.t + 60 : tCombine(tDay(x.t), hm(13, 45)); }
  function posInfo(r, strat) {
    var x = r.pos;
    if (!x) return null;
    var pts = (lastC - x.entry) * x.side, R = x.R, ind = r.ind;
    var d = {side: x.side > 0 ? '多' : '空', kind: x.kind, entry_t: tFmt(x.entry_t), entry: pyRound(x.entry), stop0: pyRound(x.stop0),
             stop: pyRound(x.stop), be: x.be, R: pyRound(R), pts: pyRound(pts), twd: pyRound(pts * MULT - FEE),
             to_stop: pyRound((lastC - x.stop) * x.side), be_at: pyRound(x.entry + 1.0 * R * x.side)};
    var lastI = ind.ATR.length - 1;
    d.trail_note = strat === 'v3'
      ? '保本後停損改成「進場後' + (x.side > 0 ? '最高收盤 − 5 ATR' : '最低收盤 + 5 ATR') + '」，只往有利方向移動；目前 ATR ' + fnum(ind.ATR[lastI], 0)
      : '保本後，收盤' + (x.side > 0 ? '跌破' : '站上') + '日 EMA20 就隔天開盤出場；目前 EMA20 ' + fnum(ind.E20[lastI], 0);
    if (r.pending_exit) d.pending_exit = (whyText(r.pending_exit) || '出場條件成立') + '：下一根 K 開盤出場';
    return d;
  }
  function sigInfo(r, isV3) {
    var x = r.sig;
    if (!x) return null;
    var st = sigTime(x, isV3);
    return {side: x.side > 0 ? '多' : '空', kind: x.kind, entry: pyRound(x.entry), stop: pyRound(x.stop0), R: pyRound(x.R),
            at: tFmt(st).slice(5), lag: Math.max(0, pyRound(now - st))};
  }
  function events(r, isV3) {
    if (prevGen === null || prevGen === undefined) return [];
    var out = [];
    r.trades.forEach(function (x) {
      var side = x.side > 0 ? '多' : '空';
      if (x.entry_t > prevGen) {
        var st = sigTime(x, isV3);
        out.push(tFmt(x.entry_t).slice(5) + ' ' + side + '單進場 ' + fnum(x.entry, 0) + '（訊號 ' + tFmt(st).slice(5) + ' 成立，' +
                 '試算表 ' + tFmt(now).slice(5) + ' 才更新到，晚了 ' + fmtLag(now - st) + '）');
      }
      if (!x.open && x.exit_t > prevGen) out.push(tFmt(x.exit_t).slice(5) + ' ' + side + '單出場 ' + fnum(x.exit, 0) + '（' + whyText(x) + '）');
    });
    return out;
  }
  function rec(r) {
    var tr = r.trades.map(function (x) { return tradeRow(x, lastC); });
    var fwd = tr.filter(function (q) { return q.phase === '前測'; }), bt = tr.filter(function (q) { return q.phase === '回測'; });
    function summ(rs) {
      var closed = rs.filter(function (q) { return !q.open; }), win = 0, twd = 0;
      var R = pySum(closed.map(function (q) { return q.r; }));
      closed.forEach(function (q) { if (q.r > 0.1) win++; });
      rs.forEach(function (q) { twd += q.twd; });
      return {n: closed.length, win: win, R: pyRoundN(R, 1), twd: twd};
    }
    return {all: tr, forward: fwd, backtest: bt, fsum: summ(fwd), bsum: summ(bt)};
  }
  var hv = res.hv, hd = res.hd, iv = hv.ind, idd = hd.ind, T = res.hb[0], li = T.length - 1, ld = idd.ATR.length - 1;
  return {
    last_price: lastC,
    v3: {bar: tFmt(T[li]), bar_end: tFmt(res.v3End).slice(11), forming: res.v3Forming, pos: posInfo(hv, 'v3'), sig: sigInfo(hv, true),
         checks: res.v3c, record: rec(hv), events: events(hv, true),
         levels: {E20: pyRound(iv.E20[li]), E60: pyRound(iv.E60[li]), ATR: pyRound(iv.ATR[li]),
                  BBU: pyRound(iv.MID[li] + 2 * iv.SD[li]), BBL: pyRound(iv.MID[li] - 2 * iv.SD[li])}},
    d2: {bar: dFmt(tDay(res.dlast)), forming: res.dForming, pos: posInfo(hd, 'd2'), sig: sigInfo(hd, false),
         checks: res.d2c, record: rec(hd), events: events(hd, false),
         levels: {E20: pyRound(idd.E20[ld]), E60: pyRound(idd.E60[ld]), ATR: pyRound(idd.ATR[ld])},
         bar_ohlc: [1, 2, 3, 4].map(function (k) { return pyRound(res.sp.bars[k][ld]); })}
  };
}

// ---------- 期交所 MIS 即時 1 分K（live.fetch_live 的解析部分） ----------
var MONTHS = 'ABCDEFGHIJKL';
function contractCode(sym, yearNow) {          // TXFK6-F → 202611
  var y = Math.floor(yearNow / 10) * 10 + Number(sym[4]);
  if (y < yearNow - 1) y += 10;
  return y * 100 + MONTHS.indexOf(sym[3]) + 1;
}
// 報價清單 → 成交量前兩大的台指期契約代號
function topSymbols(quoteList) {
  var futs = quoteList.filter(function (x) {
    var s = x.SymbolID || '';
    return s.indexOf('TXF') === 0 && s.length > 4 && MONTHS.indexOf(s[3]) >= 0;
  });
  futs = futs.map(function (x, i) { return [x, i]; });
  futs.sort(function (a, b) { return (-Math.trunc(parseFloat(a[0].CTotalVolume || 0) || 0)) - (-Math.trunc(parseFloat(b[0].CTotalVolume || 0) || 0)) || a[1] - b[1]; });
  return futs.slice(0, 2).map(function (q) { return q[0]; });
}
// getChartData1M 的 RtData → Map(t -> [o,h,l,c,v])；mt：'0' 日盤、'1' 夜盤
function parseChart(rt, mt) {
  var cd = String(rt.Quote.CDate), base = tDay(tMk(+cd.slice(0, 4), +cd.slice(4, 6), +cd.slice(6, 8), 0, 0));
  var bars = new Map();
  (rt.Ticks || []).forEach(function (q) {
    var tt = String(q[0]), hh = +tt.slice(0, 2), mm = +tt.slice(2, 4);
    var day = (mt === '1' && hh < 15) ? base + 1 : base;
    var ts = day * 1440 + hh * 60 + mm - 1;               // MIS 標的是這分鐘的結束時間
    var o = parseFloat(q[1]), h = parseFloat(q[2]), l = parseFloat(q[3]), c = parseFloat(q[4]), v = Math.trunc(parseFloat(q[5]));
    var b = bars.get(ts);
    if (!b) bars.set(ts, [o, h, l, c, v]);
    else { b[1] = Math.max(b[1], h); b[2] = Math.min(b[2], l); b[3] = c; b[4] += v; }
  });
  return bars;
}
// history 檔案＋即時盤別 → 計算用的檔案清單（同 live.merged_dir）。
// sessions：[{key, contracts: Map(契約 -> Map(t -> bar))}]，依 key（盤別開始）排序
function mergedFiles(hist, sessions) {
  var last = null;
  hist.slice(-2).forEach(function (f) { f.rows.forEach(function (r) { if (last === null || r[0] > last) last = r[0]; }); });
  var files = hist.slice();
  var stem = hist.length ? hist[hist.length - 1].name : 'Daily_0000_00_00';
  var added = 0;
  sessions.forEach(function (s, k) {
    var rows = [];
    s.contracts.forEach(function (bars, c) { bars.forEach(function (b, t) { if (last === null || t > last) rows.push([t, c, b[0], b[1], b[2], b[3], b[4]]); }); });
    if (!rows.length) return;
    rows.sort(function (a, b) { return a[1] - b[1] || a[0] - b[0]; });
    files.push({name: stem + '_live' + p2(k + 1), live: true, rows: rows});
    var front = null, best = -1;
    s.contracts.forEach(function (bars, c) { if (bars.size > best) { best = bars.size; front = c; } });
    rows.forEach(function (r) { if (r[1] === front) added++; });
  });
  return {files: files, last: last, added: added};
}

if (typeof module !== 'undefined') {
  module.exports = {tMk: tMk, tFmt: tFmt, dFmt: dFmt, tDay: tDay, tFromYmdHm: tFromYmdHm, dayFromIso: dayFromIso, buildBars: buildBars,
    readRawMinutes: readRawMinutes, txDailyBars: txDailyBars, indicators: indicators, runV3: runV3, runD2: runD2, evaluate: evaluate,
    refineTimes: refineTimes, v3Checks: v3Checks, d2Checks: d2Checks, twiiBacktests: twiiBacktests, twiiDaily: twiiDaily,
    findGap: findGap, computeAll: computeAll, liveSummary: liveSummary, whyText: whyText, tradeRow: tradeRow, txRevised: txRevised,
    fnum: fnum, pySum: pySum, pyRoundN: pyRoundN, pyRound: pyRound, nextWeekday: nextWeekday, isDayT: isDayT, hm: hm, tCombine: tCombine, tHM: tHM, contractCode: contractCode, topSymbols: topSymbols, parseChart: parseChart, mergedFiles: mergedFiles};
}

// ============================================================
// 台指策略訊號（Google 試算表獨立版）：抓資料、存資料、畫分頁、選單與自動更新
// 計算在 Engine.js（跟網頁 strategy/live.py 同一套規則，已逐筆比對）。
// 資料直接跟期交所（台指期）與 Yahoo（加權指數，只給回測）抓，不靠 GitHub。
// ============================================================

var APP = {
  MIS: 'https://mis.taifex.com.tw/futures/api/',
  LIST_URL: 'https://www.taifex.com.tw/cht/3/dlFutPrevious30DaysSalesData',
  FILE_URL: 'https://www.taifex.com.tw/file/taifex/Dailydownload/DailydownloadCSV/',
  DAILY_URL: 'https://www.taifex.com.tw/cht/3/futDataDown',
  TWII_URL: 'https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=60m&range=730d',
  SEED_URL: 'https://raw.githubusercontent.com/asinkk/txo-dashboard/main/history/',
  UA: 'Mozilla/5.0 (txo-gsheet)',
  BUDGET_MS: 4.5 * 60 * 1000,       // Apps Script 每次最多跑 6 分鐘，留一點給畫面
  DAILY_START: [2024, 1]
};
var SH = {live: '即時訊號', trades: '成交紀錄', info: '說明與狀態',
          hist: '資料_1分K', cache: '資料_即時1分K', daily: '資料_日行情', twii: '資料_加權60分'};
var C_UP = '#c2412d', C_DN = '#2f7d5b', C_ACC = '#2f5fd0', C_MUTED = '#5d6673', C_WARN = '#a86500',
    BG_WARN = '#fff4e0', BG_SIG = '#e8efff', BG_HEAD = '#eef1f5', BG_L = '#fbeeeb', BG_S = '#eaf4ef', C_LINE = '#dfe3e8';

// ---------- 選單 ----------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('台指策略')
    .addItem('立即更新', 'menuUpdate')
    .addSeparator()
    .addItem('開啟自動更新（每 15 分鐘）', 'menuAuto15')
    .addItem('開啟自動更新（每 30 分鐘）', 'menuAuto30')
    .addItem('停止自動更新', 'menuStop')
    .addSeparator()
    .addItem('補抓期交所歷史資料', 'menuBackfill')
    .addItem('從 GitHub 匯入舊資料（選用）', 'menuSeed')
    .addToUi();
}
function menuUpdate() { toast(runUpdate({manual: true})); showLive(); }
function showLive() { try { SpreadsheetApp.getActive().setActiveSheet(sheet(SH.live)); } catch (e) {} }
function menuAuto15() { installTrigger(15); }
function menuAuto30() { installTrigger(30); }
function menuStop() {
  removeTriggers();
  setProp('auto', '');
  toast('已停止自動更新');
  try { renderInfo(null); } catch (e) {}
}
function menuBackfill() { toast(runUpdate({manual: true, maint: true})); showLive(); }
function menuSeed() {
  var ui = SpreadsheetApp.getUi();
  var a = ui.alert('從 GitHub 匯入舊資料',
    '一次性從 asinkk/txo-dashboard 的 history 資料夾匯入：台指期 1 分K（2026/9/22 起）、台指期每日行情、加權指數 60 分K（2023/11 起）。\n' +
    '匯入後成交紀錄會跟網頁一樣長；之後所有更新都直接跟期交所抓，不再用 GitHub。不匯入也能用，只是台指期歷史從期交所能下載的最近 30 個交易日開始。\n\n要匯入嗎？',
    ui.ButtonSet.YES_NO);
  if (a !== ui.Button.YES) return;
  toast(seedFromGithub());
  toast(runUpdate({manual: true}));
  showLive();
}

function installTrigger(minutes) {
  removeTriggers();
  ScriptApp.newTrigger('autoTick').timeBased().everyMinutes(minutes).create();
  setProp('auto', String(minutes));
  SpreadsheetApp.getActive().setSpreadsheetTimeZone('Asia/Taipei');
  SpreadsheetApp.getActive().setRecalculationInterval(SpreadsheetApp.RecalculationInterval.ON_CHANGE_AND_MINUTE);
  toast('已開啟自動更新：每 ' + minutes + ' 分鐘檢查一次，只在交易時段（與收盤後存檔）真的更新。先更新一次…');
  toast(runUpdate({manual: true}));
}
function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'autoTick') ScriptApp.deleteTrigger(t);
  });
}
function toast(msg) { try { SpreadsheetApp.getActive().toast(String(msg), '台指策略', 8); } catch (e) {} Logger.log(msg); }

// 自動更新：交易時段、收盤後 45 分鐘內（存完整的盤）、每天早上 06:00 後第一次（補期交所每日檔案）才真的跑
function autoTick() {
  var now = nowTpe(), wd = tWeekday(now), m = tHM(now);
  var inDay = wd < 5 && m >= hm(8, 40) && m <= hm(14, 30);
  var inNight = (wd < 5 && m >= hm(14, 55)) || (wd >= 1 && wd <= 5 && m <= hm(5, 45));
  var maint = m >= hm(6, 0) && m <= hm(8, 30) && getProp('maintDay') !== String(tDay(now));
  if (!(inDay || inNight || maint)) return;
  try { Logger.log(runUpdate({})); } catch (e) { Logger.log(e.stack || e); }   // 錯誤已寫在「說明與狀態」分頁
}

// ---------- 小工具 ----------
function nowTpe() { return Math.floor(Date.now() / 60000) + 480; }
function props() { return PropertiesService.getDocumentProperties(); }
function getProp(k) { return props().getProperty(k) || ''; }
function setProp(k, v) { props().setProperty(k, String(v)); }
function sheet(name, hidden) {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name, ss.getNumSheets());
    if (hidden) sh.hideSheet();
  }
  return sh;
}
function readTable(name, ncol) {
  var sh = sheet(name, true), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, ncol).getValues();
}
function writeTable(name, header, rows) {
  var sh = sheet(name, true);
  sh.clearContents();
  var all = [header].concat(rows);
  if (sh.getMaxRows() < all.length) sh.insertRowsAfter(sh.getMaxRows(), all.length - sh.getMaxRows());
  if (sh.getMaxColumns() < header.length) sh.insertColumnsAfter(sh.getMaxColumns(), header.length - sh.getMaxColumns());
  sh.getRange(1, 1, all.length, header.length).setValues(all);
}
function appendTable(name, header, rows) {
  if (!rows.length) return;
  var sh = sheet(name, true), n = sh.getLastRow();
  if (n === 0) { sh.getRange(1, 1, 1, header.length).setValues([header]); n = 1; }
  if (sh.getMaxRows() < n + rows.length) sh.insertRowsAfter(sh.getMaxRows(), n + rows.length - sh.getMaxRows());
  sh.getRange(n + 1, 1, rows.length, header.length).setValues(rows);
}
function http(url, opt) {
  opt = opt || {};
  var o = {muteHttpExceptions: true, followRedirects: true, headers: {'User-Agent': APP.UA, 'Cache-Control': 'no-cache'}};
  if (opt.json) { o.method = 'post'; o.contentType = 'application/json'; o.payload = JSON.stringify(opt.json); }
  if (opt.form) { o.method = 'post'; o.contentType = 'application/x-www-form-urlencoded'; o.payload = opt.form; }
  var last = '';
  for (var k = 0; k < (opt.tries || 3); k++) {
    try {
      var r = UrlFetchApp.fetch(url, o);
      if (r.getResponseCode() === 200) return r;
      last = 'HTTP ' + r.getResponseCode();
      if (r.getResponseCode() === 404) break;
    } catch (e) { last = String(e.message || e); }
    if (k + 1 < (opt.tries || 3)) Utilities.sleep(1500 * (k + 1));
  }
  throw new Error('連不上 ' + url.split('?')[0] + '（' + last + '）');
}
function ymdNum(day) { var p = tParts(day * 1440); return p[0] * 10000 + p[1] * 100 + p[2]; }
function dayFromYmdNum(n) { n = Math.round(n); return tDay(tMk(Math.floor(n / 10000), Math.floor(n / 100) % 100, n % 100, 0, 0)); }
function serial(t) { return t / 1440 + 25569; }   // 台北時間分鐘數 → 試算表日期序號

// ---------- 期交所 MIS 即時 1 分K ----------
function fetchLive(now) {
  var sessions = [], info = {}, year = tParts(now)[0];
  [['0', '日盤'], ['1', '夜盤']].forEach(function (q) {
    var mt = q[0], name = q[1], list;
    try {
      list = JSON.parse(http(APP.MIS + 'getQuoteList', {json: {MarketType: mt, SymbolType: 'F', KindID: '1', CID: 'TXF', ExpireMonth: '',
        RowSize: '全部', PageNo: '', SortColumn: '', AscDesc: 'A'}}).getContentText()).RtData.QuoteList;
    } catch (e) { info[name] = {error: '報價清單抓取失敗：' + e.message}; return; }
    var contracts = new Map(), key = null;
    topSymbols(list).forEach(function (f, k) {
      var rt;
      try { rt = JSON.parse(http(APP.MIS + 'getChartData1M', {json: {SymbolID: f.SymbolID}}).getContentText()).RtData; }
      catch (e) { if (!info[name]) info[name] = {error: '1 分K 抓取失敗：' + e.message}; return; }
      var bars = parseChart(rt, mt);
      if (!bars.size) return;
      contracts.set(contractCode(f.SymbolID, year), bars);
      if (k === 0) {
        var cd = String(rt.Quote.CDate);
        key = tMk(+cd.slice(0, 4), +cd.slice(4, 6), +cd.slice(6, 8), mt === '0' ? 8 : 15, mt === '0' ? 45 : 0);
        var mx = -Infinity;
        bars.forEach(function (b, t) { if (t > mx) mx = t; });
        info[name] = {symbol: f.SymbolID, name: f.DispCName, last: parseFloat(rt.Quote.CLastPrice || 0), date: cd,
                      last_minute: tFmt(mx), minutes: bars.size};
      }
    });
    if (contracts.size && key !== null) sessions.push({key: key, contracts: contracts});
  });
  sessions.sort(function (a, b) { return a.key - b.key; });
  return {sessions: sessions, info: info};
}

// 即時 1 分K 暫存（每個盤別、每個契約；history 補到的部分會刪掉）
var CACHE_HEAD = ['盤別開始', '契約', '時間', '開', '高', '低', '收', '量'];
function loadCache() {
  var m = new Map();
  readTable(SH.cache, 8).forEach(function (r) {
    var k = +r[0], c = +r[1];
    if (!m.has(k)) m.set(k, new Map());
    var s = m.get(k);
    if (!s.has(c)) s.set(c, new Map());
    s.get(c).set(+r[2], [+r[3], +r[4], +r[5], +r[6], +r[7]]);
  });
  return m;
}
function mergeCache(cache, sessions) {
  sessions.forEach(function (s) {
    if (!cache.has(s.key)) cache.set(s.key, new Map());
    var cs = cache.get(s.key);
    s.contracts.forEach(function (bars, c) {
      if (!cs.has(c)) cs.set(c, new Map());
      var old = cs.get(c);
      bars.forEach(function (b, t) { old.set(t, b); });
    });
  });
}
function pruneCache(cache, histLast) {
  if (histLast === null) return;
  cache.forEach(function (cs, k) {
    cs.forEach(function (bars, c) {
      bars.forEach(function (b, t) { if (t <= histLast) bars.delete(t); });
      if (!bars.size) cs.delete(c);
    });
    if (!cs.size) cache.delete(k);
  });
}
function saveCache(cache) {
  var rows = [];
  Array.from(cache.keys()).sort(function (a, b) { return a - b; }).forEach(function (k) {
    cache.get(k).forEach(function (bars, c) {
      Array.from(bars.keys()).sort(function (a, b) { return a - b; }).forEach(function (t) {
        var b = bars.get(t);
        rows.push([k, c, t, b[0], b[1], b[2], b[3], b[4]]);
      });
    });
  });
  writeTable(SH.cache, CACHE_HEAD, rows);
}
function cacheSessions(cache) {
  return Array.from(cache.keys()).sort(function (a, b) { return a - b; }).map(function (k) { return {key: k, contracts: cache.get(k)}; });
}

// ---------- 1 分K 歷史（期交所每筆成交 → 1 分K） ----------
var HIST_HEAD = ['交易日', '時間', '契約', '開', '高', '低', '收', '量'];
function loadHist() {
  var by = new Map();
  readTable(SH.hist, 8).forEach(function (r) {
    var f = String(r[0]);
    if (!by.has(f)) by.set(f, []);
    by.get(f).push([+r[1], +r[2], +r[3], +r[4], +r[5], +r[6], +r[7]]);
  });
  return Array.from(by.keys()).sort().map(function (f) {
    var rows = by.get(f);
    rows.sort(function (a, b) { return a[1] - b[1] || a[0] - b[0]; });
    return {name: 'Daily_' + f, live: false, rows: rows};
  });
}
function histLastOf(hist) {
  var last = null;
  hist.slice(-2).forEach(function (f) { f.rows.forEach(function (r) { if (last === null || r[0] > last) last = r[0]; }); });
  return last;
}
// tag：'2026_11_06'；rows：[t, 契約, o, h, l, c, v]。已經有同一天的就整份換掉
function saveHistFile(tag, rows, promoted) {
  var add = rows.map(function (r) { return [tag].concat(r); });
  var names = loadHistNames();
  if (names.indexOf(tag) >= 0) {
    var keep = readTable(SH.hist, 8).filter(function (r) { return String(r[0]) !== tag; });
    writeTable(SH.hist, HIST_HEAD, keep.concat(add));
  } else appendTable(SH.hist, HIST_HEAD, add);
  sheet(SH.hist, true).getRange('A:A').setNumberFormat('@');
  var pr = promotedTags().filter(function (x) { return x !== tag; });
  if (promoted) pr.push(tag);
  setProp('promoted', pr.join(','));
}
// 用即時 1 分K 存的交易日（期交所檔案或 GitHub 有的話會換掉）
function promotedTags() { return getProp('promoted') ? getProp('promoted').split(',') : []; }
function listZips() {
  var html = http(APP.LIST_URL).getContentText();
  var m = html.match(/Daily_\d{4}_\d{2}_\d{2}\.zip/g) || [];
  return Array.from(new Set(m)).sort();
}
// 一個每日成交 zip → 台指期（TX）1 分K（同 strategy/collect_ticks.py）
function zipTo1min(name) {
  var blob = http(APP.FILE_URL + name, {tries: 2}).getBlob().setContentType('application/zip');
  var txt = Utilities.unzip(blob)[0].getDataAsString('Big5');
  var re = /,TX *,/g, first = txt.search(/,TX *,/);
  if (first < 0) return [];
  var lastPos = Math.max(txt.lastIndexOf(',TX '), txt.lastIndexOf(',TX,'));
  var a = txt.lastIndexOf('\n', first) + 1, z = txt.indexOf('\n', lastPos);
  var part = txt.slice(a, z < 0 ? txt.length : z);
  txt = null;
  var bars = new Map();
  part.split('\n').forEach(function (line) {
    var row = line.split(',');
    if (row.length < 6 || row[1].trim() !== 'TX') return;
    var contract = row[2].trim();
    if (contract.indexOf('/') >= 0) return;
    var price = parseFloat(row[4]), vol = parseInt(row[5], 10);
    if (isNaN(price) || isNaN(vol) || !/^\s*-?\d+\s*$/.test(row[5])) return;
    var tm = ('000000' + row[3].trim()).slice(-6).slice(0, 4);
    var key = row[0].trim() + '|' + tm + '|' + contract;
    var b = bars.get(key);
    if (!b) bars.set(key, [price, price, price, price, vol]);
    else { b[1] = Math.max(b[1], price); b[2] = Math.min(b[2], price); b[3] = price; b[4] += vol; }
  });
  var rows = [];
  bars.forEach(function (b, key) {
    var k = key.split('|');
    rows.push([tFromYmdHm(k[0], k[1]), +k[2], b[0], b[1], b[2], b[3], b[4]]);
  });
  rows.sort(function (x, y) { return x[1] - y[1] || x[0] - y[0]; });
  return rows;
}
// 下載 history 還沒有的每日成交檔（新的先抓），時間快到就停，下次再繼續
function ingestZips(t0, log) {
  var names = listZips(), have = {}, hasDay = {};
  readTable(SH.hist, 2).forEach(function (r) { var f = String(r[0]); have[f] = true; if (isDayT(+r[1])) hasDay[f] = true; });
  promotedTags().forEach(function (n) { delete have[n]; });
  // 最新 3 個檔案若還沒有日盤（例如週五夜盤先出成下週一的檔案），重抓（同 collect_ticks 的 REFRESH_NEWEST）
  names.slice(-3).forEach(function (n) { var tag = n.slice(6, 16); if (have[tag] && !hasDay[tag]) delete have[tag]; });
  var todo = names.filter(function (n) { return !have[n.slice(6, 16)]; }).reverse();
  var done = 0;
  for (var i = 0; i < todo.length; i++) {
    if (Date.now() - t0 > APP.BUDGET_MS - 60000) { log.push('每日成交檔還有 ' + (todo.length - i) + ' 個沒抓，下次更新繼續'); break; }
    try {
      var rows = zipTo1min(todo[i]);
      if (rows.length) { saveHistFile(todo[i].slice(6, 16), rows); done++; }
      setProp('zipFail', '');
    } catch (e) {
      log.push('每日成交檔 ' + todo[i] + ' 失敗：' + e.message);
      setProp('zipFail', String(e.message || e).slice(0, 200));
      break;
    }
  }
  if (done) log.push('補進期交所每日成交檔 ' + done + ' 個');
  return done;
}
function loadHistNames() {
  var sh = sheet(SH.hist, true), n = sh.getLastRow();
  if (n < 2) return [];
  return Array.from(new Set(sh.getRange(2, 1, n - 1, 1).getValues().map(function (r) { return String(r[0]); })));
}
// 期交所每日檔案抓不到時的備援：把暫存的即時 1 分K 存成 history（夜盤＋隔天日盤 = 一個交易日，跟期交所檔案一樣）
function promoteCache(cache, now, log) {
  var have = {};
  loadHistNames().forEach(function (n) { have[n] = true; });
  var byTd = new Map();
  cache.forEach(function (cs, k) {
    var td = tHM(k) === hm(8, 45) ? tDay(k) : nextWeekday(tDay(k));
    if (!byTd.has(td)) byTd.set(td, []);
    byTd.get(td).push(k);
  });
  var n = 0;
  byTd.forEach(function (keys, td) {
    var hasDay = keys.some(function (k) { return tHM(k) === hm(8, 45); });
    if (!hasDay || now < tCombine(td, hm(14, 0))) return;
    var tag = dFmt(td).replace(/-/g, '_');
    if (have[tag]) return;
    var rows = [];
    keys.forEach(function (k) {
      cache.get(k).forEach(function (bars, c) { bars.forEach(function (b, t) { rows.push([t, c, b[0], b[1], b[2], b[3], b[4]]); }); });
    });
    rows.sort(function (x, y) { return x[1] - y[1] || x[0] - y[0]; });
    saveHistFile(tag, rows, true);
    n++;
  });
  if (n) log.push('期交所每日檔案抓不到，改用即時 1 分K 存了 ' + n + ' 個交易日');
}

// ---------- 台指期每日行情（D2 日K 暖機） ----------
var DAILY_HEAD = ['日期', '盤別', '契約', '開', '高', '低', '收', '量'];
function loadDaily() {
  return readTable(SH.daily, 8).map(function (r) {
    return [dayFromYmdNum(+r[0]), String(r[1]), +r[2], +r[3], +r[4], +r[5], +r[6], +r[7]];
  });
}
function fetchDailyMonth(y, m) {
  var first = tDay(tMk(y, m, 1, 0, 0)), last = tDay(tMk(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1, 0, 0)) - 1;
  var body = 'down_type=1&commodity_id=TX&queryStartDate=' + dFmt(first).replace(/-/g, '/') + '&queryEndDate=' + dFmt(last).replace(/-/g, '/');
  var text = http(APP.DAILY_URL, {form: body}).getContentText('Big5');
  if (/^\s*</.test(text)) return [];
  var out = [];
  text.split(/\r?\n/).forEach(function (line) {
    var row = line.split(',');
    if (row.length < 18 || row[1].trim() !== 'TX') return;
    var sess = row[17].trim();
    if (sess !== '一般' && sess !== '盤後') return;
    var c = row[2].trim();
    if (c.indexOf('/') >= 0 || !/^\d+$/.test(c)) return;
    var o = parseFloat(row[3]), h = parseFloat(row[4]), l = parseFloat(row[5]), cl = parseFloat(row[6]), v = parseInt(row[9], 10);
    if ([o, h, l, cl, v].some(isNaN)) return;
    out.push([+row[0].trim().replace(/\//g, ''), sess === '一般' ? '日盤' : '夜盤', +c, o, h, l, cl, v]);
  });
  return out;
}
function dailySort(a, b) {      // 跟 tx_daily.csv 一樣依（日期、盤別、契約）排序；Python 字串比較「夜盤」排在「日盤」前面
  return a[0] - b[0] || (a[1] === b[1] ? 0 : a[1] === '夜盤' ? -1 : 1) || String(a[2]).localeCompare(String(b[2]));
}
function updateDaily(now, t0, log) {
  var rows = readTable(SH.daily, 8), map = new Map();
  rows.forEach(function (r) { map.set(r[0] + '|' + r[1] + '|' + r[2], r); });
  var y = APP.DAILY_START[0], m = APP.DAILY_START[1];
  if (rows.length) {
    var lastDay = dayFromYmdNum(Math.max.apply(null, rows.map(function (r) { return +r[0]; }))) - 10;
    var p = tParts(lastDay * 1440); y = p[0]; m = p[1];
  }
  var np = tParts(now), got = 0, stopped = false;
  while (y < np[0] || (y === np[0] && m <= np[1])) {
    if (Date.now() - t0 > APP.BUDGET_MS - 90000) { stopped = true; break; }
    try {
      fetchDailyMonth(y, m).forEach(function (r) { map.set(r[0] + '|' + r[1] + '|' + r[2], r); got++; });
    } catch (e) { log.push('每日行情 ' + y + '/' + m + ' 失敗：' + e.message); }
    if (m === 12) { y++; m = 1; } else m++;
  }
  var all = Array.from(map.values());
  all.sort(dailySort);
  writeTable(SH.daily, DAILY_HEAD, all);
  if (stopped) log.push('每日行情還沒抓完（到 ' + y + '/' + m + '），下次更新繼續');
  return got;
}

// ---------- 加權指數 60 分K（Yahoo，只給回測） ----------
var TWII_HEAD = ['開始時間', '開', '高', '低', '收'];
function loadTwii() {
  var rows = readTable(SH.twii, 5);
  return [rows.map(function (r) { return +r[0]; }), rows.map(function (r) { return +r[1]; }), rows.map(function (r) { return +r[2]; }),
          rows.map(function (r) { return +r[3]; }), rows.map(function (r) { return +r[4]; })];
}
function updateTwii(now, log) {
  var d;
  try { d = JSON.parse(http(APP.TWII_URL, {tries: 2}).getContentText()).chart.result[0]; }
  catch (e) { log.push('加權指數（Yahoo）抓取失敗：' + e.message); return 0; }
  var map = new Map();
  readTable(SH.twii, 5).forEach(function (r) { map.set(+r[0], r); });
  var q = d.indicators.quote[0], today = tDay(now), n = 0;
  (d.timestamp || []).forEach(function (ts, i) {
    var o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (o === null || h === null || l === null || c === null) return;
    var t = Math.floor(ts / 60) + 480;
    if (tHM(t) === hm(13, 30) || tDay(t) === today) return;
    var r2 = function (x) { return Math.round(x * 100) / 100; };
    map.set(t, [t, r2(o), r2(h), r2(l), r2(c)]);
    n++;
  });
  var all = Array.from(map.values()).sort(function (a, b) { return a[0] - b[0]; });
  writeTable(SH.twii, TWII_HEAD, all);
  return n;
}

// ---------- 從 GitHub 匯入舊資料（選用，一次） ----------
function seedFromGithub() {
  var t0 = Date.now(), log = [];
  var have = {};
  loadHistNames().forEach(function (n) { have[n] = true; });
  promotedTags().forEach(function (n) { delete have[n]; });
  var names = [], d = tDay(tMk(2026, 9, 1, 0, 0)), end = tDay(nowTpe()) + 7;   // 週五夜盤的檔名是下週一
  for (; d <= end; d++) if (dayWeekday(d) < 5) { var tag = dFmt(d).replace(/-/g, '_'); if (!have[tag]) names.push(tag); }
  var added = 0;
  for (var i = 0; i < names.length; i += 20) {
    var batch = names.slice(i, i + 20);
    var rs = UrlFetchApp.fetchAll(batch.map(function (n) {
      return {url: APP.SEED_URL + 'tx_1min/Daily_' + n + '.csv', muteHttpExceptions: true};
    }));
    rs.forEach(function (r, k) {
      if (r.getResponseCode() !== 200) return;
      var lines = r.getContentText().trim().split(/\r?\n/).slice(1);
      var rows = lines.map(function (l) {
        var v = l.split(',');
        return [tFromYmdHm(v[0], v[1]), +v[2], +v[3], +v[4], +v[5], +v[6], +v[7]];
      });
      rows.sort(function (x, y) { return x[1] - y[1] || x[0] - y[0]; });
      if (rows.length) { saveHistFile(batch[k], rows); added++; }
    });
  }
  log.push('1 分K ' + added + ' 天');
  try {
    var txt = http(APP.SEED_URL + 'tx_daily.csv').getContentText().trim().split(/\r?\n/).slice(1);
    var map = new Map();
    readTable(SH.daily, 8).forEach(function (r) { map.set(r[0] + '|' + r[1] + '|' + r[2], r); });
    txt.forEach(function (l) {
      var v = l.split(','), r = [+v[0].replace(/-/g, ''), v[1], +v[2], +v[3], +v[4], +v[5], +v[6], +v[7]];
      var k = r[0] + '|' + r[1] + '|' + r[2];
      if (!map.has(k)) map.set(k, r);
    });
    var all = Array.from(map.values()); all.sort(dailySort);
    writeTable(SH.daily, DAILY_HEAD, all);
    log.push('每日行情 ' + txt.length + ' 列');
  } catch (e) { log.push('每日行情失敗：' + e.message); }
  try {
    var tw = http(APP.SEED_URL + 'twii_60min.csv').getContentText().trim().split(/\r?\n/).slice(1);
    var m2 = new Map();
    readTable(SH.twii, 5).forEach(function (r) { m2.set(+r[0], r); });
    tw.forEach(function (l) {
      var v = l.split(','), s = v[0];
      var t = tMk(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16));
      if (!m2.has(t)) m2.set(t, [t, +v[1], +v[2], +v[3], +v[4]]);
    });
    writeTable(SH.twii, TWII_HEAD, Array.from(m2.values()).sort(function (a, b) { return a[0] - b[0]; }));
    log.push('加權指數 ' + tw.length + ' 根');
  } catch (e) { log.push('加權指數失敗：' + e.message); }
  setProp('seeded', tFmt(nowTpe()));
  return '已從 GitHub 匯入：' + log.join('、') + '（' + Math.round((Date.now() - t0) / 1000) + ' 秒）';
}

// ---------- 主流程 ----------
function runUpdate(opt) {
  opt = opt || {};
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(opt.manual ? 30000 : 2000)) return '另一個更新正在跑，稍後再試';
  var t0 = Date.now(), now = nowTpe(), log = [];
  try {
    var live = fetchLive(now);
    var cache = loadCache();
    mergeCache(cache, live.sessions);

    // 每天一次（06:00 後）或手動：期交所每日成交檔、每日行情、加權指數；中途發現缺盤也會補抓（每小時最多一次）
    var hist = loadHist(), histLast = histLastOf(hist);
    var newT = [];
    cache.forEach(function (cs) { cs.forEach(function (b) { b.forEach(function (_, t) { newT.push(t); }); }); });
    var gap = findGap(histLast, newT, now);
    var daily0 = sheet(SH.daily, true).getLastRow() < 2, twii0 = sheet(SH.twii, true).getLastRow() < 2;
    var maint = opt.maint || daily0 || hist.length === 0 ||
                (tHM(now) >= hm(6, 0) && getProp('maintDay') !== String(tDay(now)));
    var gapTry = gap.length && now - (+getProp('gapTry') || 0) >= 60;
    if (maint || gapTry) {
      if (gapTry) setProp('gapTry', now);
      // 每日成交檔解不開（例如檔案太大）時，同一天不再重試，改用即時 1 分K 存檔
      if (!getProp('zipFail') || getProp('zipFailDay') !== String(tDay(now)) || opt.maint) {
        try { ingestZips(t0, log); } catch (e) { log.push('期交所每日成交檔：' + e.message); setProp('zipFail', String(e.message || e).slice(0, 200)); }
        if (getProp('zipFail')) setProp('zipFailDay', tDay(now));
      }
      if (getProp('zipFail')) promoteCache(cache, now, log);
      if (maint) {
        try { updateDaily(now, t0, log); } catch (e) { log.push('每日行情：' + e.message); }
        if (twii0 || tWeekday(now) < 6) updateTwii(now, log);
        setProp('maintDay', tDay(now));
      }
      hist = loadHist(); histLast = histLastOf(hist);
    }
    pruneCache(cache, histLast);
    saveCache(cache);

    var sessions = cacheSessions(cache);
    var mg = mergedFiles(hist, sessions);
    newT = [];
    sessions.forEach(function (s) { s.contracts.forEach(function (b) { b.forEach(function (_, t) { newT.push(t); }); }); });
    gap = findGap(mg.last, newT, now);
    // 用即時 1 分K 存的交易日如果沒有前一晚的夜盤（那時還沒開始抓），也算缺口
    var pr = promotedTags();
    hist.slice(-10).forEach(function (f) {
      if (pr.indexOf(f.name.slice(6)) < 0 || f.rows.some(function (r) { return !isDayT(r[0]); })) return;
      var td = dayFromIso(f.name.slice(6).replace(/_/g, '-')), pd = td - 1;
      while (dayWeekday(pd) >= 5) pd--;
      gap.push(tCombine(pd, hm(15, 0)));
    });
    gap.sort(function (x, y) { return x - y; });
    var nbars = mg.files.reduce(function (a, f) { return a + f.rows.length; }, 0);
    if (nbars < 3000) {
      renderInfo({now: now, log: log.concat(['台指期 1 分K 只有 ' + nbars + ' 筆，還不夠算 v3（至少要 5 個交易日）。請用選單「補抓期交所歷史資料」或「從 GitHub 匯入舊資料」。']), hist: hist, cache: cache});
      return '資料還不夠，先補抓歷史資料';
    }
    var prevGen = getProp('prevGen') ? +getProp('prevGen') : null;
    var res = computeAll({files: mg.files, daily: loadDaily(), twii: loadTwii(), now: now});
    var sum = liveSummary(res, prevGen);
    renderLive(sum, res, {now: now, prevGen: prevGen, info: live.info, gap: gap, histLast: mg.last, added: mg.added});
    renderTrades(sum, res, now);
    setProp('prevGen', now);
    var msg = '現價 ' + fnum(res.lastC, 0) + '；v3 ' + (sum.v3.pos ? '持' + sum.v3.pos.side + '單' : '空手') + (sum.v3.sig ? '、有訊號' : '') +
              '；D2 ' + (sum.d2.pos ? '持' + sum.d2.pos.side + '單' : '空手') + (sum.d2.sig ? '、有訊號' : '') +
              '（' + Math.round((Date.now() - t0) / 1000) + ' 秒）';
    log.push(msg);
    renderInfo({now: now, log: log, hist: hist, cache: cache});
    return msg;
  } catch (e) {
    log.push('錯誤：' + (e.stack || e.message || e));
    try { renderInfo({now: now, log: log}); } catch (e2) {}
    throw e;
  } finally {
    lock.releaseLock();
  }
}

// ---------- 畫分頁 ----------
function Canvas(ncol) { this.n = ncol; this.v = []; this.st = []; }
// cells：值的陣列；s：整列格式 {bg, fc, b, fs, it}；cs：個別格子的格式陣列
Canvas.prototype.row = function (cells, s, cs) {
  var r = [], st = [];
  for (var i = 0; i < this.n; i++) {
    r.push(cells && i < cells.length && cells[i] !== null && cells[i] !== undefined ? cells[i] : '');
    st.push(Object.assign({}, s || {}, (cs && cs[i]) || {}));
  }
  this.v.push(r); this.st.push(st);
  return this.v.length;
};
Canvas.prototype.text = function (txt, s) { var r = this.row([txt], s); return r; };
Canvas.prototype.blank = function () { return this.row([]); };
Canvas.prototype.flush = function (sh, widths) {
  var n = this.v.length, m = this.n;
  sh.clear();
  if (sh.getMaxRows() < n + 5) sh.insertRowsAfter(sh.getMaxRows(), n + 5 - sh.getMaxRows());
  if (sh.getMaxColumns() < m) sh.insertColumnsAfter(sh.getMaxColumns(), m - sh.getMaxColumns());
  var rg = sh.getRange(1, 1, n, m);
  var nf = [], bg = [], fc = [], fw = [], fs = [], ha = [], vals = [];
  for (var i = 0; i < n; i++) {
    var a = [], b = [], c = [], d = [], e = [], f = [], v = [];
    for (var j = 0; j < m; j++) {
      var s = this.st[i][j], x = this.v[i][j];
      var isF = typeof x === 'string' && x.charAt(0) === '=';
      a.push(s.nf || (typeof x === 'number' ? '#,##0' : isF ? 'General' : '@'));
      b.push(s.bg || null); c.push(s.fc || null); d.push(s.b ? 'bold' : 'normal'); e.push(s.fs || 10);
      f.push(s.ha || (typeof x === 'number' ? 'right' : 'left'));
      v.push(x);
    }
    nf.push(a); bg.push(b); fc.push(c); fw.push(d); fs.push(e); ha.push(f); vals.push(v);
  }
  rg.setNumberFormats(nf);
  rg.setValues(vals);
  rg.setBackgrounds(bg); rg.setFontColors(fc); rg.setFontWeights(fw); rg.setFontSizes(fs); rg.setHorizontalAlignments(ha);
  rg.setFontFamily('Arial').setVerticalAlignment('middle').setWrap(false);
  if (widths) widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setHiddenGridlines(true);
};

var MUTED = {fc: C_MUTED};
function moneyStyle(v) { return {fc: v > 0 ? C_UP : v < 0 ? C_DN : null}; }
function sideStyle(side) { return side === '多' ? {bg: C_UP, fc: '#ffffff', b: true, ha: 'center'} : {bg: C_DN, fc: '#ffffff', b: true, ha: 'center'}; }

function renderLive(d, res, ctx) {
  var now = ctx.now, cv = new Canvas(6), sess = sessionState(now);
  var src = Object.keys(ctx.info).filter(function (k) { return ctx.info[k].last_minute; })
    .map(function (k) { return k + ' ' + ctx.info[k].last_minute.slice(5); }).join('・') || '沒有即時資料';
  cv.row(['台指策略即時訊號', '', '', '', '台指期近月', d.last_price], {}, [{b: true, fs: 16}, {}, {}, {}, {fc: C_MUTED, ha: 'right'}, {b: true, fs: 18}]);
  var age = '=IFERROR(LET(m,ROUND((NOW()-F2)*1440),IF(m<1,"（剛剛）",IF(m<120,"（"&m&" 分鐘前）","（"&ROUND(m/60)&" 小時前）"))),"")';
  cv.row([sess + '・試算表更新於台北 ' + tFmt(now), '', '', '', age, serial(now)], MUTED, [{}, {}, {}, {}, {ha: 'right'}, {nf: 'yyyy-mm-dd hh:mm', fc: '#bbbbbb'}]);
  cv.row(['台指期近月（日盤＋夜盤）・資料到 ' + src], MUTED);
  var stale = '=IF(AND((NOW()-F2)*1440>45,OR(AND(WEEKDAY(NOW(),2)<=5,HOUR(NOW())*60+MINUTE(NOW())>=525,HOUR(NOW())*60+MINUTE(NOW())<=830),' +
              'AND(WEEKDAY(NOW(),2)<=5,HOUR(NOW())*60+MINUTE(NOW())>=900),AND(WEEKDAY(NOW(),2)>=2,WEEKDAY(NOW(),2)<=6,HOUR(NOW())*60+MINUTE(NOW())<=300))),' +
              '"⚠ 交易時段中，這頁已經 "&ROUND((NOW()-F2)*1440)&" 分鐘沒有更新（自動更新可能停了或被延誤），價格、停損與訊號可能過時。","")';
  cv.row([stale], {fc: C_WARN, b: true});
  if (ctx.gap.length) cv.row(['⚠ 資料缺口：' + ctx.gap.map(function (g) { return tFmt(g).slice(5); }).join('、') +
    ' 開始的盤沒有資料（期交所即時資料沒抓到、每日檔案還沒出，或那天是假日）。指標與訊號可能不準，等下一次補抓。'], {bg: BG_WARN, fc: C_WARN});
  Object.keys(ctx.info).forEach(function (k) { if (ctx.info[k].error) cv.row(['⚠ ' + k + '：' + ctx.info[k].error], {bg: BG_WARN, fc: C_WARN}); });
  var dst = usDst(now), nightWin = dst ? '21:00–23:00' : '22:00–00:00';
  stratCard(cv, 'v3・60 分K', '60 分K 收完才看訊號；日盤 08:45–11:45、夜盤 ' + nightWin + ' 開始的 K 才開新倉', d.v3, 'v3', now);
  stratCard(cv, 'D2・日K', '收盤創 20 日新高/新低，13:45 收盤前進場；台指期日K 只算日盤（08:45–13:45），夜盤不算', d.d2, 'd2', now);
  recordBlock(cv, 'v3 模擬交易紀錄', d.v3.record);
  recordBlock(cv, 'D2 模擬交易紀錄', d.d2.record);
  cv.blank();
  var auto = getProp('auto');
  cv.text(auto ? '自動更新：每 ' + auto + ' 分鐘檢查一次，交易時段（日盤 08:45–13:45、夜盤 15:00–05:00）才真的更新；Google 的排程可能晚幾分鐘，請看上面的「資料到」時間。'
               : '自動更新沒開：用上方選單「台指策略 → 開啟自動更新」。', MUTED);
  cv.text('每次更新都從期交所重新抓整個日盤、夜盤的 1 分K，從頭重算 K 棒、部位與停損，所以中間漏跑幾次不會漏掉 K 棒或停損；晚到的進出場會標「上次更新之後」。', MUTED);
  cv.text('「形成中」表示那根 K 還沒收完，條件是用現價先算，收K前都可能變。v3 要等 60 分K 收完、下一根開盤才進場；D2 是日K 收盤前進場。', MUTED);
  cv.text('試算：本金 20 萬、1 口微台（每點 10 元）、每次下單 25 元；R 是以初始停損點數為 1 的倍數。', MUTED);
  cv.text('資料：兩套策略的訊號、部位、停損都只用台指期近月（TX）；v3 含夜盤，D2 日K 只算日盤。加權指數只用在「成交紀錄」分頁的回測。', MUTED);
  cv.flush(sheet(SH.live), [150, 150, 150, 150, 150, 150]);
  var sh = sheet(SH.live);
  sh.setFrozenRows(0);
}

function checkRows(cv, chk) {
  ['多', '空'].forEach(function (side) {
    var c = chk[side], groups = ['突破', '拉回'].filter(function (g) { return c[g]; });
    var okG = groups.filter(function (g) { return c.common.concat(c[g]).every(function (x) { return x.ok; }); });
    var badge = okG.length ? okG.join('、') + '條件全到' : '未成立';
    cv.row(['做' + side, badge], {bg: BG_HEAD, b: true}, [{}, okG.length ? {bg: C_ACC, fc: '#ffffff'} : {fc: C_MUTED}]);
    function rows(items) {
      items.forEach(function (x) {
        cv.row([x.ok ? '✓' : '✗', x.name, '', x.detail], x.ok ? {} : MUTED, [{ha: 'center', fc: x.ok ? C_ACC : C_MUTED, b: x.ok}, {}, {}, {fc: C_MUTED}]);
      });
    }
    rows(c.common);
    groups.forEach(function (g) {
      cv.row([groups.length > 1 ? g + '進場' : '進場條件'], {fc: C_MUTED, b: true});
      rows(c[g]);
    });
    cv.row(['若現在進場，停損約 ' + fnum(c.stop.stop, 0) + '（' + fnum(Math.abs(c.stop.raw), 0) + ' 點前的端點，最多 1–1.5 ATR）'], MUTED);
  });
}

function stratCard(cv, name, sub, s, kind, now) {
  var pos = s.pos, sig = s.sig;
  cv.blank();
  var status = pos ? '持' + pos.side + '單' : '空手';
  cv.row([name, '', '', '', '', status], {bg: BG_HEAD, b: true, fs: 13}, [{}, {}, {}, {}, {}, pos ? sideStyle(pos.side) : {fc: C_MUTED, ha: 'center'}]);
  cv.text(sub, MUTED);
  var barTxt = kind === 'v3'
    ? '最後一根 60 分K：' + s.bar.slice(5) + ' 起' + (s.forming ? '，形成中（' + s.bar_end + ' 收）' : '，已收完')
    : '最後一根日K（只算日盤）：' + s.bar.slice(5) + (s.forming ? '，形成中（13:45 收）' : '，已收盤；夜盤不算');
  cv.text(barTxt, MUTED);
  if (sig) {
    var when = kind === 'v3' ? '下一根 60 分K 開盤進場' : s.forming ? '13:45 收盤前進場' : '應已在 13:45 收盤前進場';
    var tag = s.forming ? '形成中：若以現價收K' : '訊號 ' + sig.at + ' 成立' + (sig.lag > 10 ? '（試算表晚了 ' + fmtLag(sig.lag) + '才更新到）' : '');
    cv.row(['● ' + tag + '，做' + sig.side + '（' + sig.kind + '）→ ' + when + '，參考價 ' + fnum(sig.entry, 0) + '、停損 ' + fnum(sig.stop, 0) +
            '（' + fnum(sig.R, 0) + ' 點）'], {bg: BG_SIG, fc: C_ACC, b: true});
  }
  if (s.events && s.events.length) {
    cv.row(['上次更新之後：'], {bg: BG_WARN, fc: C_WARN});
    s.events.forEach(function (e) { cv.row(['  ' + e], {bg: BG_WARN, fc: C_WARN}); });
  }
  if (pos) {
    if (pos.pending_exit) cv.row(['⚠ ' + pos.pending_exit + (s.forming ? '（以現價計，收K時再確認）' : '')], {bg: BG_WARN, fc: C_WARN, b: true});
    cv.row(['進場', '目前停損', '未實現（點）', '未實現（元，1 口微台）', '初始停損', '風險（點）'], {fc: C_MUTED});
    cv.row([pos.entry, pos.stop, pos.pts, pos.twd, pos.stop0, pos.R], {b: true, fs: 14},
           [{}, {}, Object.assign({nf: '+#,##0;-#,##0;0'}, moneyStyle(pos.pts)), Object.assign({nf: '+#,##0;-#,##0;0'}, moneyStyle(pos.twd)), {}, {}]);
    cv.row([pos.entry_t.slice(5) + '・' + pos.kind, '距現價 ' + fnum(pos.to_stop, 0) + ' 點'], MUTED);
    var beTxt = pos.be ? '已保本' : '收盤到 ' + fnum(pos.be_at, 0) + ' 就把停損移到進場價（保本）';
    cv.text(beTxt + '。' + pos.trail_note + '。', MUTED);
  }
  var lv = s.levels, lvTxt;
  if (kind === 'v3') lvTxt = 'EMA20 ' + fnum(lv.E20, 0) + '・EMA60 ' + fnum(lv.E60, 0) + '・布林 ' + fnum(lv.BBL, 0) + '–' + fnum(lv.BBU, 0) + '・ATR ' + fnum(lv.ATR, 0);
  else {
    var o = s.bar_ohlc;
    lvTxt = '日EMA20 ' + fnum(lv.E20, 0) + '・EMA60 ' + fnum(lv.E60, 0) + '・日ATR ' + fnum(lv.ATR, 0) + '・最後日K 開' + fnum(o[0], 0) + ' 高' + fnum(o[1], 0) +
            ' 低' + fnum(o[2], 0) + ' 收' + fnum(o[3], 0);
  }
  cv.text(lvTxt, MUTED);
  cv.row([pos ? '進場條件明細（持倉中，不會再開新倉）' : '進場條件（看最後一根 K' + (s.forming ? '，以現價計）' : '）')], {fc: C_MUTED, b: true});
  checkRows(cv, s.checks);
}

function recordBlock(cv, title, r) {
  cv.blank();
  cv.row([title], {bg: BG_HEAD, b: true, fs: 13});
  var fs = r.fsum, bs = r.bsum;
  cv.text('前測（2026/11/09 起）已出場 ' + fs.n + ' 筆、賺 ' + fs.win + ' 筆、合計 ' + fnum(fs.R, 1, true) + 'R、' + fnum(fs.twd, 0, true) + ' 元（含未實現）', MUTED);
  if (!r.forward.length) cv.text('還沒有交易。', MUTED);
  else {
    cv.row(['進場', '方向', '進場價', '出場', '出場價', 'R・元'], {fc: C_MUTED});
    r.forward.slice().reverse().forEach(function (x) {
      cv.row([x.entry_t.slice(5), x.side + '・' + x.kind, x.entry, x.open ? '持倉中' : x.exit_t.slice(5), x.open ? '' : x.exit,
              fnum(x.r, 2, true) + 'R・' + fnum(x.twd, 0, true) + ' 元'], {bg: x.side === '多' ? BG_L : BG_S});
    });
  }
  cv.text('前測開始前（台指期累積資料回測）：' + bs.n + ' 筆 ' + fnum(bs.R, 1, true) + 'R、' + fnum(bs.twd, 0, true) + ' 元・每筆明細在「成交紀錄」分頁', MUTED);
}

function renderTrades(d, res, now) {
  var cv = new Canvas(12);
  cv.row(['台指策略成交紀錄'], {b: true, fs: 16});
  cv.text('v3（60 分K）與 D2（日K）每一筆模擬交易・台北 ' + tFmt(now) + ' 產生・台指期持倉以現價 ' + fnum(res.lastC, 0) + ' 計', MUTED);
  var txStart = res.hb[0].length ? tFmt(res.hb[0][0]).slice(0, 10) : '';
  cv.blank();
  cv.row(['台指期・實際交易依據（' + txStart + ' 起；v3 含夜盤，D2 只算日盤）'], {fc: C_MUTED, b: true, fs: 12});
  ledger(cv, 'v3・60 分K', '進場是訊號 K 收完後下一根 60 分K 開盤；停損出場時間是 1 分K 第一次碰到停損的那一分鐘。「前測」是 2026/11/9 規則定案後的交易。',
         d.v3.record.all, true);
  ledger(cv, 'D2・日K（只算日盤）', '日K 只用日盤 08:45–13:45，夜盤不算；進場是訊號當天 13:45 收盤；停損出場時間是日盤 1 分K 第一次碰到停損的那一分鐘；保本後收盤破 EMA20 是隔天 08:45 開盤出場。',
         d.d2.record.all, true);
  cv.blank();
  var tw = {v3: res.tws.v3.map(function (x) { var r = tradeRow(x); r.phase = '回測'; return r; }),
            d2: res.tws.d2.map(function (x) { var r = tradeRow(x); r.phase = '回測'; return r; })};
  cv.row(['加權指數・回測用歷史資料（2024/11/07 起，近 2 年，只有日盤；不是實際交易依據）'], {fc: C_MUTED, b: true, fs: 12});
  ledger(cv, 'v3・60 分K', '價格是加權指數點數，當成 1 口微台每點 10 元試算。資料只有 60 分K，所以時間是那根 60 分K 的開始時間。', tw.v3, false);
  ledger(cv, 'D2・日K', '進場是訊號當天 13:30 收盤；停損出場時間是第一根碰到停損的 60 分K；保本後收盤破 EMA20 是隔天 09:00 開盤出場。', tw.d2, false);
  cv.blank();
  cv.text('試算：本金 200,000 元、固定 1 口微台（每點 10 元）、每次下單 25 元（來回 50 元）；點數是進出場價差，損益（元）已扣下單費用；R 是以初始停損點數為 1 的倍數（另扣 3 點滑價成本）。', MUTED);
  cv.text('台指期價格已換算成目前近月合約（換月時回溯調整），所以早期的價格會跟當時實際報價差一個價差。', MUTED);
  cv.flush(sheet(SH.trades), [70, 120, 80, 80, 80, 120, 80, 150, 70, 70, 90, 90]);
}

function ledger(cv, title, note, rows, showPhase) {
  cv.blank();
  cv.row([title], {bg: BG_HEAD, b: true, fs: 13});
  cv.text(note, MUTED);
  if (!rows.length) { cv.text('還沒有交易。', MUTED); return; }
  var eq = CAP, pk = CAP, dd = 0, out = [];
  rows.forEach(function (x) { eq += x.twd; pk = Math.max(pk, eq); dd = Math.min(dd, eq - pk); out.push([x, eq]); });
  var closed = rows.filter(function (x) { return !x.open; }), win = closed.filter(function (x) { return x.r > 0.1; }).length;
  var unreal = rows.filter(function (x) { return x.open; }).reduce(function (a, x) { return a + x.twd; }, 0);
  var totR = pySum(closed.map(function (x) { return x.r; }));
  cv.row(['帳戶', '', '已出場', '', '合計', '', '最大回落'], {fc: C_MUTED});
  cv.row([eq, '', closed.length + ' 筆', '', fnum(totR, 1, true) + 'R', '', dd], {b: true, fs: 13}, [{}, {}, {ha: 'left'}, {}, {}, {}, {nf: '#,##0'}]);
  cv.row([fnum(eq - CAP, 0, true) + ' 元（' + fnum((eq - CAP) / CAP * 100, 1, true) + '%）', '', '賺 ' + win + ' 筆・勝率 ' + (closed.length ? fnum(win / closed.length * 100, 0) : '0') + '%', '',
          unreal ? '未實現 ' + fnum(unreal, 0, true) + ' 元' : '沒有持倉', '', '元'], MUTED);
  var heads = ['階段', '進場時間', '方向', '進場價', '初始停損', '出場時間', '出場價', '出場原因', '點數', 'R', '損益（元）', '帳戶'];
  if (!showPhase) heads = heads.slice(1).concat(['']);
  cv.row(heads, {fc: C_MUTED, b: true, bg: BG_HEAD});
  out.slice().reverse().forEach(function (q) {
    var x = q[0], e = q[1];
    var cells = [x.entry_t, x.side + '・' + x.kind, x.entry, x.stop0, x.open ? '持倉中' : x.exit_t, x.open ? '' : x.exit,
                 x.open ? '停損 ' + fnum(x.stop, 0) : x.why, x.pts, x.r, x.twd, e];
    var cs = [{}, {}, {}, {}, {}, {}, {}, {nf: '+#,##0;-#,##0;0'}, {nf: '+0.00;-0.00;0.00'}, Object.assign({nf: '+#,##0;-#,##0;0'}, moneyStyle(x.twd)), {}];
    if (showPhase) { cells.unshift(x.phase); cs.unshift(x.phase === '前測' ? {fc: '#ffffff', bg: C_ACC, ha: 'center'} : {fc: C_MUTED, ha: 'center'}); }
    else { cells.push(''); cs.push({}); }
    cv.row(cells, {bg: x.side === '多' ? BG_L : BG_S, b: x.open}, cs);
  });
}

function renderInfo(ctx) {
  var cv = new Canvas(4), now = nowTpe();
  cv.row(['說明與狀態'], {b: true, fs: 16});
  cv.blank();
  cv.row(['怎麼用'], {bg: BG_HEAD, b: true});
  [
    '1. 第一次：上方選單「台指策略 → 立即更新」。會跳出 Google 授權，按「進階 → 前往（不安全）→ 允許」（這是你自己的腳本）。',
    '2. 開自動更新：「台指策略 → 開啟自動更新（每 15 分鐘）」。關掉試算表也會繼續跑，Google 會在伺服器上執行。',
    '3. 第一次會從期交所下載最近 30 個交易日的每筆成交、2024 年起的台指期每日行情與加權指數，可能要跑好幾次才抓完（每次最多 6 分鐘），沒抓完的下次自動接著抓。',
    '4. 想要歷史成交紀錄跟網頁一樣長，可以選單「從 GitHub 匯入舊資料」一次；之後所有更新都直接跟期交所抓。',
    '資料都存在這個試算表隱藏的「資料_」分頁裡（右鍵分頁列可以取消隱藏查看）。'
  ].forEach(function (t) { cv.text(t); });
  cv.blank();
  cv.row(['狀態'], {bg: BG_HEAD, b: true});
  var auto = getProp('auto');
  cv.row(['自動更新', auto ? '開啟（每 ' + auto + ' 分鐘）' : '關閉'], {}, [{fc: C_MUTED}, {b: true, fc: auto ? C_ACC : C_WARN}]);
  cv.row(['這次執行', tFmt(ctx && ctx.now || now)], {}, [{fc: C_MUTED}]);
  cv.row(['上次每日維護', getProp('maintDay') ? dFmt(+getProp('maintDay')) : '—'], {}, [{fc: C_MUTED}]);
  if (getProp('zipFail')) cv.row(['期交所每日成交檔', '抓不到（' + getProp('zipFail') + '）→ 改用即時 1 分K 存檔'], {}, [{fc: C_MUTED}, {fc: C_WARN}]);
  if (getProp('seeded')) cv.row(['GitHub 舊資料', '已在 ' + getProp('seeded') + ' 匯入'], {}, [{fc: C_MUTED}]);
  if (ctx && ctx.hist) {
    var h = ctx.hist;
    cv.row(['1 分K 歷史', h.length ? h.length + ' 個交易日（' + h[0].name.slice(6).replace(/_/g, '/') + ' – ' + h[h.length - 1].name.slice(6).replace(/_/g, '/') + '）' : '還沒有'], {}, [{fc: C_MUTED}]);
  }
  if (ctx && ctx.cache) {
    var ks = Array.from(ctx.cache.keys()).sort(function (a, b) { return a - b; });
    cv.row(['即時 1 分K 暫存', ks.length ? ks.map(function (k) { return tFmt(k).slice(5) + (tHM(k) === hm(8, 45) ? ' 日盤' : ' 夜盤'); }).join('、') : '沒有'], {}, [{fc: C_MUTED}]);
  }
  if (ctx && ctx.log && ctx.log.length) {
    cv.blank();
    cv.row(['這次執行紀錄'], {bg: BG_HEAD, b: true});
    ctx.log.forEach(function (t) { cv.text(String(t).slice(0, 500), /錯誤|失敗/.test(t) ? {fc: C_WARN} : {}); });
  }
  cv.flush(sheet(SH.info), [140, 520, 120, 120]);
}
