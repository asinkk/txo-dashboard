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
