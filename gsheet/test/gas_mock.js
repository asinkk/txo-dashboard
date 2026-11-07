// 在 Node 裡模擬 Apps Script（SpreadsheetApp、UrlFetchApp、Utilities…），用真的網路跑 App.js，找執行期錯誤。
// 用法：node gas_mock.js 狀態檔.json 指令 [參數]
//   指令：update（runUpdate 手動）、maint（補抓）、seed（GitHub 匯入）、tick（autoTick）、dump 分頁名稱
//   環境變數 NOW=YYYY-MM-DDTHH:MM 假裝現在的台北時間；FIXTURE=資料夾 讓 MIS 用測試資料；NOZIP=1 模擬每日成交檔解不開
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process'), os = require('os');
const [stateFile, cmd, arg] = process.argv.slice(2);
const st = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {sheets: {}, order: [], props: {}};

function colNum(s) { let n = 0; for (const ch of s) n = n * 26 + ch.charCodeAt(0) - 64; return n; }
class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, {sh, r, c, nr, nc}); }
  getValues() { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) { const v = (this.sh.d.v[this.r - 1 + i] || [])[this.c - 1 + j]; row.push(v === undefined || v === null ? '' : v); } out.push(row); } return out; }
  setValues(vals) {
    if (vals.length !== this.nr || vals.some(r => r.length !== this.nc)) throw new Error(`setValues 大小不符 ${vals.length}x${vals[0] && vals[0].length} vs ${this.nr}x${this.nc}`);
    if (this.r - 1 + this.nr > this.sh.d.maxR) throw new Error('超過列數');
    for (let i = 0; i < this.nr; i++) { const R = this.r - 1 + i; this.sh.d.v[R] = this.sh.d.v[R] || []; for (let j = 0; j < this.nc; j++) {
      let v = vals[i][j]; if (v !== '' && typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') throw new Error('不支援的值 ' + v);
      if (typeof v === 'number' && !isFinite(v)) throw new Error(`第 ${R + 1} 列有 NaN/Infinity`);
      this.sh.d.v[R][this.c - 1 + j] = v; } }
    return this;
  }
  _chk(a, nm) { if (a.length !== this.nr || a.some(r => r.length !== this.nc)) throw new Error(nm + ' 大小不符'); return this; }
  setNumberFormats(a) { return this._chk(a, 'setNumberFormats'); }
  setBackgrounds(a) { return this._chk(a, 'setBackgrounds'); }
  setFontColors(a) { return this._chk(a, 'setFontColors'); }
  setFontWeights(a) { return this._chk(a, 'setFontWeights'); }
  setFontSizes(a) { return this._chk(a, 'setFontSizes'); }
  setHorizontalAlignments(a) { return this._chk(a, 'setHorizontalAlignments'); }
  setNumberFormat() { return this; } setFontFamily() { return this; } setVerticalAlignment() { return this; } setWrap() { return this; }
}
class Sheet {
  constructor(name) { this.name = name; if (!st.sheets[name]) { st.sheets[name] = {v: [], maxR: 1000, maxC: 26, hidden: false}; st.order.push(name); } this.d = st.sheets[name]; }
  getName() { return this.name; }
  getLastRow() { let n = 0; this.d.v.forEach((r, i) => { if (r && r.some(x => x !== '' && x !== undefined && x !== null)) n = i + 1; }); return n; }
  getMaxRows() { return this.d.maxR; } getMaxColumns() { return this.d.maxC; }
  insertRowsAfter(a, n) { this.d.maxR += n; } insertColumnsAfter(a, n) { this.d.maxC += n; }
  getRange(a, b, c, d) {
    if (typeof a === 'string') { const m = a.match(/^([A-Z]+)(\d*):([A-Z]+)(\d*)$/); return new Range(this, m[2] ? +m[2] : 1, colNum(m[1]), m[4] ? +m[4] - (m[2] ? +m[2] : 1) + 1 : this.d.maxR, colNum(m[3]) - colNum(m[1]) + 1); }
    if (b > this.d.maxC || a < 1) throw new Error('getRange 超出範圍');
    return new Range(this, a, b, c || 1, d || 1);
  }
  clear() { this.d.v = []; } clearContents() { this.d.v = []; } hideSheet() { this.d.hidden = true; }
  setColumnWidth() {} setHiddenGridlines() {} setFrozenRows() {}
}
const ss = {
  getSheetByName: n => st.sheets[n] ? new Sheet(n) : null, insertSheet: n => new Sheet(n), getNumSheets: () => st.order.length, setActiveSheet() {},
  toast: m => console.log('[toast]', m), setSpreadsheetTimeZone() {}, setRecalculationInterval() {}
};
function curl(url, o) {
  const args = ['-sS', '-L', '--max-time', '120', '-o', '-', '-w', '\n%{http_code}', '-A', (o.headers || {})['User-Agent'] || 'x'];
  if (o.method === 'post') args.push('-X', 'POST', '-H', 'Content-Type: ' + o.contentType, '--data-binary', o.payload);
  args.push(url);
  if (process.env.FIXTURE && url.includes('mis.taifex')) {
    const body = JSON.parse(o.payload);
    const key = url.endsWith('getQuoteList') ? `quotes_${body.MarketType}` : `chart_${body.SymbolID}`;
    const f = path.join(process.env.FIXTURE, key + '.json');
    return {code: fs.existsSync(f) ? 200 : 404, buf: fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from('')};
  }
  const out = cp.execFileSync('curl', args, {maxBuffer: 1 << 30});
  const i = out.lastIndexOf(10);
  return {code: +out.slice(i + 1).toString(), buf: out.slice(0, i)};
}
function blob(buf, name) {
  return {setContentType() { return this; }, getBytes: () => Array.from(buf), getName: () => name || 'blob',
          getDataAsString: cs => new TextDecoder(cs ? cs.toLowerCase() : 'utf-8').decode(buf), _buf: buf};
}
function resp(r) { return {getResponseCode: () => r.code, getContentText: cs => new TextDecoder(cs ? cs.toLowerCase() : 'utf-8').decode(r.buf), getBlob: () => blob(r.buf)}; }
let fetchN = 0;
const g = {
  console, Logger: {log: m => console.log('[log]', String(m).slice(0, 300))},
  SpreadsheetApp: {getActive: () => ss, getUi: () => ({alert: () => 'YES', Button: {YES: 'YES'}, ButtonSet: {}}), RecalculationInterval: {ON_CHANGE_AND_MINUTE: 1}},
  PropertiesService: {getDocumentProperties: () => ({getProperty: k => st.props[k] === undefined ? null : st.props[k], setProperty: (k, v) => { st.props[k] = String(v); }})},
  LockService: {getDocumentLock: () => ({tryLock: () => true, releaseLock() {}})},
  UrlFetchApp: {fetch: (u, o) => { fetchN++; return resp(curl(u, o || {})); }, fetchAll: rs => rs.map(r => { fetchN++; return resp(curl(r.url, r)); })},
  Utilities: {sleep() {}, unzip: b => {
    if (process.env.NOZIP) throw new Error('模擬：Blob 太大');
    const tmp = path.join(os.tmpdir(), 'gz' + process.pid + '.zip'); fs.writeFileSync(tmp, b._buf);
    const names = cp.execFileSync('unzip', ['-Z1', tmp]).toString().trim().split('\n');
    return names.map(n => blob(cp.execFileSync('unzip', ['-p', tmp, n], {maxBuffer: 1 << 30}), n)); }},
  ScriptApp: {getProjectTriggers: () => [], newTrigger: () => ({timeBased: () => ({everyMinutes: () => ({create() {}})})}), deleteTrigger() {}}
};
vm.createContext(g);
const src = path.join(__dirname, '..', 'src');
vm.runInContext(fs.readFileSync(path.join(src, 'Engine.js'), 'utf8') + '\n' + fs.readFileSync(path.join(src, 'App.js'), 'utf8'), g, {filename: 'Code.gs'});
if (process.env.NOW) {
  const s = process.env.NOW;
  vm.runInContext(`nowTpe = function () { return tMk(${+s.slice(0, 4)}, ${+s.slice(5, 7)}, ${+s.slice(8, 10)}, ${+s.slice(11, 13)}, ${+s.slice(14, 16)}); }`, g);
}
const t0 = Date.now();
let out;
if (cmd === 'update') out = g.runUpdate({manual: true});
else if (cmd === 'maint') out = g.runUpdate({manual: true, maint: true});
else if (cmd === 'seed') out = g.seedFromGithub();
else if (cmd === 'tick') out = g.autoTick();
else if (cmd === 'dump') {
  const d = st.sheets[arg];
  console.log((d ? d.v : []).map(r => (r || []).map(x => x === undefined ? '' : x).join(' | ').replace(/( \| )+$/, '')).join('\n'));
}
if (cmd !== 'dump') {
  console.log('結果:', out, '｜', ((Date.now() - t0) / 1000).toFixed(1), '秒，網路請求', fetchN, '次');
  console.log('分頁:', st.order.map(n => n + '(' + new Sheet(n).getLastRow() + ')').join(' '));
  console.log('屬性:', JSON.stringify(st.props));
}
fs.writeFileSync(stateFile, JSON.stringify(st));
