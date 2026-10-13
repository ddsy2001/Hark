/**
 * Egern 网上国网（国家电网）小组件 · Hark 液态玻璃版
 * 版式参考 jadkg/egern「南方电网小组件」：余额 / 昨日 / 本月 / 上月 + 近日用电柱状图。
 * 数据：运行时加载 Yuheng0101/X 的 95598.js（服务模式），用其登录网上国网并查询；本脚本只做兼容层和界面。
 * 环境变量：SGCC_USERNAME / SGCC_PASSWORD（网上国网账号密码）、SGCC_ACCOUNT（多户号时填户号后几位）、
 *          SGCC_POLICY（国网请求走的策略，默认 DIRECT）、SGCC_REFRESH（数据刷新间隔小时，默认 6）、SGCC_SCHEDULE（定时任务内部用）。
 */

const SRC_URL = 'https://raw.githubusercontent.com/Yuheng0101/X/main/Tasks/95598/95598.js';
const K = { data: 'sgcc_hark_data', src: 'sgcc_hark_src', err: 'sgcc_hark_err', lock: 'sgcc_hark_lock' };

/* ==================== 数据 ==================== */

function clean(v) { return String(v == null ? '' : v).trim(); }
function num(v) { const n = Number(String(v == null ? '' : v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : NaN; }

function headersObj(h) {
  const o = {};
  if (!h) return o;
  try {
    if (typeof h.forEach === 'function') { h.forEach((v, k) => { o[k] = v; }); return o; }
  } catch (_) {}
  try { Object.keys(h).forEach((k) => { o[k] = h[k]; }); } catch (_) {}
  return o;
}

async function loadSource(ctx) {
  let c = null;
  try { c = ctx.storage.getJSON(K.src); } catch (_) {}
  if (c && c.code && Date.now() - c.ts < 24 * 3600000) return c.code;
  try {
    const r = await ctx.http.get(SRC_URL, { timeout: 15000 });
    const code = await r.text();
    if (r.status === 200 && code.length > 10000) {
      try { ctx.storage.setJSON(K.src, { ts: Date.now(), code }); } catch (_) {}
      return code;
    }
  } catch (_) {}
  if (c && c.code) return c.code;
  throw new Error('查询脚本下载失败');
}

// 给 Surge 风格脚本搭一个兼容层（$httpClient / $persistentStore / $done），在服务模式下运行它
async function runSgcc(ctx, username, password) {
  const code = await loadSource(ctx);
  const policy = clean((ctx.env || {}).SGCC_POLICY) || 'DIRECT';
  const g = globalThis;
  const names = ['$httpClient', '$persistentStore', '$done', '$request', '$argument', '$notification', '$environment', '$script'];
  const saved = {};
  names.forEach((n) => { saved[n] = g[n]; });
  if (typeof g.URLSearchParams === 'undefined') {
    g.URLSearchParams = class {
      constructor() { this.p = []; }
      append(k, v) { this.p.push([k, v]); }
      entries() { return this.p[Symbol.iterator](); }
      toString() { return this.p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'); }
    };
  }
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      const timer = setTimeout(() => finish(reject, new Error('查询超时')), 55000);
      const http = (method) => (opts, cb) => {
        const o = typeof opts === 'string' ? { url: opts } : (opts || {});
        const t = Number(o.timeout) > 0 ? Number(o.timeout) : 15;
        const req = { headers: o.headers || {}, timeout: (t > 500 ? t : t * 1000) };
        if (o.body != null && method !== 'get' && method !== 'head') req.body = o.body;
        // 95598 会拒绝境外/代理出口（GB008），国网域名强制走直连
        if (/(^|\.)95598\.cn(\/|:|$)/.test(String(o.url).replace(/^https?:\/\//, '')) && policy) req.policy = policy;
        const fn = ctx.http[method] || ((u, r) => ctx.http.post(u, r));
        Promise.resolve(fn.call(ctx.http, o.url, req))
          .then(async (resp) => {
            const body = await resp.text();
            cb(null, { status: resp.status, statusCode: resp.status, headers: headersObj(resp.headers) }, body);
          })
          .catch((e) => cb(String((e && e.message) || e || '网络错误')));
      };
      g.$httpClient = { get: http('get'), post: http('post'), put: http('put'), delete: http('delete'), head: http('head'), patch: http('patch') };
      g.$persistentStore = {
        read: (k) => { try { const v = ctx.storage.get('sgcc_ps_' + k); return v == null ? null : v; } catch (_) { return null; } },
        write: (v, k) => { try { if (v == null) ctx.storage.remove && ctx.storage.remove('sgcc_ps_' + k); else ctx.storage.set('sgcc_ps_' + k, String(v)); return true; } catch (_) { return false; } },
      };
      g.$notification = { post() {} };
      g.$environment = { 'surge-version': '5.0', 'surge-build': '3000' };
      g.$script = { startTime: Date.now() / 1000, name: 'sgcc-hark' };
      g.$request = { url: 'https://api.wsgw-rewrite.com/electricity/bill/all?eleBill=1&dayElecQuantity31=1&monthElecQuantity=1', headers: {} };
      g.$argument = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
      g.$done = (res) => {
        clearTimeout(timer);
        const r = (res && (res.response || res)) || {};
        const body = typeof r.body === 'string' ? r.body : '';
        let data = null;
        try { data = JSON.parse(body); } catch (_) {}
        if (Array.isArray(data)) finish(resolve, data);
        else finish(reject, new Error(clean(typeof data === 'string' ? data : body).split('\n')[0] || '查询失败'));
      };
      try {
        (new Function(code))();
      } catch (e) {
        clearTimeout(timer);
        finish(reject, new Error('脚本运行失败：' + ((e && e.message) || e)));
      }
    });
  } finally {
    names.forEach((n) => { if (saved[n] === undefined) { try { delete g[n]; } catch (_) { g[n] = undefined; } } else g[n] = saved[n]; });
  }
}

function pickAccount(list, want) {
  if (!Array.isArray(list) || !list.length) return null;
  const w = clean(want);
  if (w) {
    const hit = list.find((x) => { const u = x.userInfo || {}; return [u.consNo_dst, u.consNo, u.consNoSrc].some((v) => clean(v).endsWith(w)); });
    if (hit) return hit;
  }
  return list[0];
}

function dayKey(s) {
  const d = clean(s).replace(/\D/g, '');
  return d.length >= 8 ? d.slice(0, 8) : '';
}

function parse(acc) {
  const u = acc.userInfo || {};
  const bill = acc.eleBill || {};
  const dq = acc.dayElecQuantity31 || acc.dayElecQuantity || {};
  const mq = acc.monthElecQuantity || {};
  const days = (Array.isArray(dq.sevenEleList) ? dq.sevenEleList : [])
    .map((x) => ({ key: dayKey(x.day), v: num(x.dayElePq) }))
    .filter((x) => x.key && Number.isFinite(x.v) && x.v >= 0)
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  const uniq = [];
  days.forEach((x) => { if (!uniq.length || uniq[uniq.length - 1].key !== x.key) uniq.push(x); });
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthDays = uniq.filter((x) => x.key.startsWith(ym));
  const months = (Array.isArray(mq.mothEleList) ? mq.mothEleList : Array.isArray(mq.monthEleList) ? mq.monthEleList : [])
    .map((x) => ({ key: clean(x.month).replace(/\D/g, '').slice(0, 6), v: num(x.monthEleNum), cost: num(x.monthEleCost) }))
    .filter((x) => x.key && Number.isFinite(x.v))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  const lastMonth = months.filter((x) => x.key < ym).pop() || null;
  const sum = num(bill.sumMoney);
  const owe = num(bill.historyOwe) > 0 || sum < 0;
  const last = uniq[uniq.length - 1] || null;
  const info = mq.dataInfo || {};
  return {
    name: clean(u.consName_dst || u.consName),
    consNo: clean(u.consNo_dst || u.consNo),
    org: clean(u.orgName),
    balance: Number.isFinite(sum) ? Math.abs(sum) : NaN,
    owe,
    prepay: num(bill.prepayBal),
    days: num(bill.dayNum),
    billDate: clean(bill.date),
    yesterday: last ? last.v : NaN,
    yesterdayKey: last ? last.key : '',
    monthUse: monthDays.length ? monthDays.reduce((a, b) => a + b.v, 0) : NaN,
    lastMonth,
    yearUse: num(info.totalEleNum),
    yearCost: num(info.totalEleCost),
    daily: uniq.slice(-30),
    months: months.filter((x) => x.key.startsWith(String(now.getFullYear()))),
  };
}

async function getData(ctx, force) {
  const env = ctx.env || {};
  const username = clean(env.SGCC_USERNAME);
  const password = clean(env.SGCC_PASSWORD);
  let cache = null;
  try { cache = ctx.storage.getJSON(K.data); } catch (_) {}
  if (!username || !password) return { configured: false, cache };
  const hours = Math.max(1, num(env.SGCC_REFRESH) || 6);
  const fresh = cache && cache.list && cache.user === username && Date.now() - cache.ts < hours * 3600000;
  if (fresh && !force) return { configured: true, cache };
  // 防并发：定时任务和小组件同时跑时，2 分钟内只登录一次
  let lock = 0;
  try { lock = Number(ctx.storage.get(K.lock) || 0); } catch (_) {}
  if (lock && Date.now() - lock < 120000 && cache && cache.list) return { configured: true, cache, busy: true };
  try { ctx.storage.set(K.lock, String(Date.now())); } catch (_) {}
  try {
    const list = await runSgcc(ctx, username, password);
    const next = { ts: Date.now(), user: username, list };
    try { ctx.storage.setJSON(K.data, next); ctx.storage.set(K.err, ''); } catch (_) {}
    return { configured: true, cache: next };
  } catch (e) {
    const msg = clean((e && e.message) || e).replace(/^Error:\s*/, '');
    try { ctx.storage.set(K.err, msg); } catch (_) {}
    return { configured: true, cache: cache && cache.user === username ? cache : null, error: msg };
  } finally {
    try { ctx.storage.set(K.lock, '0'); } catch (_) {}
  }
}

/* ==================== 界面 ==================== */

const C = {
  text: { light: '#000000', dark: '#FFFFFF' },
  dim: { light: '#3C3C4399', dark: '#EBEBF599' },
  faint: { light: '#3C3C4366', dark: '#EBEBF566' },
  glass: { light: '#FFFFFFA6', dark: '#FFFFFF14' },
  brand: '#00A3A0',
  bolt: '#FFD60A',
  blue: '#0A84FF',
  teal: '#64D2FF',
  ok: '#30D158',
  warn: '#FF9F0A',
  fail: '#FF453A',
};

function bg() {
  return {
    type: 'linear',
    colors: [{ light: '#E6FAF6', dark: '#04201E' }, { light: '#EAF3FF', dark: '#0A1630' }, { light: '#F1F6EC', dark: '#07120D' }],
    stops: [0, 0.55, 1],
    startPoint: { x: 0, y: 0 },
    endPoint: { x: 1, y: 1 },
  };
}
function svgUri(svg) { return 'data:image/svg+xml,' + encodeURIComponent(svg); }
function T(value, size, color, weight = 'regular', extra = {}) {
  return { type: 'text', text: String(value), font: { size, weight }, textColor: color || C.text, maxLines: 1, minScale: 0.6, ...extra };
}
function icon(name, color, size = 12) { return { type: 'image', src: `sf-symbol:${name}`, width: size, height: size, color }; }
function row(children, extra = {}) { return { type: 'stack', direction: 'row', alignItems: 'center', gap: 5, children, ...extra }; }
function col(children, extra = {}) { return { type: 'stack', direction: 'column', alignItems: 'start', gap: 2, children, ...extra }; }
function glass(children, extra = {}) { return { type: 'stack', direction: 'column', alignItems: 'start', gap: 4, padding: 10, borderRadius: 16, backgroundColor: C.glass, children, ...extra }; }
const spacer = () => ({ type: 'spacer' });

function fmt(v, d = 1) {
  if (!Number.isFinite(v)) return '--';
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  return v.toFixed(v % 1 === 0 && d === 1 ? 0 : d);
}
function money(v) { return Number.isFinite(v) ? v.toFixed(2) : '--'; }
function mmdd(key) { return key && key.length >= 8 ? `${Number(key.slice(4, 6))}/${Number(key.slice(6, 8))}` : ''; }
function hhmmOf(ts) { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function updText(ts) {
  if (!ts) return '';
  const d = new Date(ts), n = new Date();
  return d.toDateString() === n.toDateString() ? hhmmOf(ts) : `${d.getMonth() + 1}/${d.getDate()} ${hhmmOf(ts)}`;
}

function balColor(p) {
  if (p.owe) return C.fail;
  if (Number.isFinite(p.days) && p.days <= 7) return C.warn;
  if (Number.isFinite(p.balance) && p.balance < 20) return C.warn;
  return C.ok;
}

function barsSvg(vals, w, h, opts = {}) {
  const n = vals.length;
  if (!n) return svgUri(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'></svg>`);
  const max = Math.max(...vals, 0.1);
  const avg = vals.reduce((a, b) => a + b, 0) / n;
  const gap = n > 20 ? 2 : 3;
  const bw = Math.max(2, (w - gap * (n - 1)) / n);
  let s = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'><defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${opts.top || '#64D2FF'}'/><stop offset='1' stop-color='${opts.bottom || '#00A3A0'}'/></linearGradient></defs>`;
  vals.forEach((v, i) => {
    const bh = Math.max(2, (v / max) * (h - 2));
    const x = i * (bw + gap);
    const hot = v === max && v > 0;
    s += `<rect x='${x.toFixed(1)}' y='${(h - bh).toFixed(1)}' width='${bw.toFixed(1)}' height='${bh.toFixed(1)}' rx='${Math.min(3, bw / 2).toFixed(1)}' fill='${hot ? (opts.hot || '#FF9F0A') : 'url(#g)'}'${i === n - 1 && !hot ? " fill-opacity='1'" : ''}/>`;
  });
  const ay = h - (avg / max) * (h - 2);
  s += `<line x1='0' y1='${ay.toFixed(1)}' x2='${w}' y2='${ay.toFixed(1)}' stroke='#8E8E93' stroke-opacity='0.55' stroke-width='1' stroke-dasharray='3 3'/></svg>`;
  return svgUri(s);
}

function header(p, ts, compact) {
  const tail = p.consNo ? `尾号${p.consNo.replace(/\D/g, '').slice(-4) || p.consNo.slice(-4)}` : '';
  return row([
    { type: 'stack', width: 20, height: 20, borderRadius: 6, backgroundColor: { light: '#00A3A01F', dark: '#00A3A033' }, alignItems: 'center', justifyContent: 'center', children: [icon('bolt.fill', C.brand, 11)] },
    T(compact ? '国家电网' : '网上国网', 12, C.text, 'bold'),
    ...(!compact && (p.name || tail) ? [T(p.name || tail, 10, C.dim, 'medium')] : []),
    spacer(),
    icon('arrow.clockwise', C.faint, 9),
    T(updText(ts), 10, C.dim),
  ], { gap: 5, height: 20 });
}

function statCell(sym, tint, label, value, unit, sub) {
  return glass([
    row([icon(sym, tint, 10), T(label, 10, C.dim, 'medium')], { gap: 3 }),
    row([T(value, 17, C.text, 'bold'), T(unit, 9, C.dim, 'medium')], { alignItems: 'end', gap: 2 }),
    ...(sub ? [T(sub, 8, C.faint)] : []),
  ], { flex: 1, gap: 2, padding: [6, 8], borderRadius: 13 });
}

function balanceBlock(p, big = 24) {
  const c = balColor(p);
  return col([
    row([icon(p.owe ? 'exclamationmark.triangle.fill' : 'yensign.circle.fill', c, 10), T(p.owe ? '欠费' : '账户余额', 10, C.dim, 'medium')], { gap: 3 }),
    row([T('¥', 12, c, 'bold'), T(money(p.balance), big, c, 'bold')], { alignItems: 'end', gap: 1 }),
    T(Number.isFinite(p.days) ? `预计可用 ${fmt(p.days, 0)} 天` : (p.billDate ? `截至 ${p.billDate}` : ''), 9, C.faint),
  ], { gap: 1 });
}

function message(title, body, ts) {
  return {
    type: 'widget', padding: 14, gap: 6, backgroundGradient: bg(),
    children: [
      row([icon('bolt.fill', C.brand, 13), T('网上国网', 13, C.text, 'bold'), spacer(), ...(ts ? [T(updText(ts), 10, C.dim)] : [])]),
      spacer(),
      T(title, 15, C.text, 'semibold', { maxLines: 2 }),
      T(body, 11, C.dim, 'regular', { maxLines: 4, minScale: 0.7 }),
      spacer(),
    ],
  };
}

function errLine(r) {
  if (!r.error && !r.busy) return null;
  return row([icon('exclamationmark.circle.fill', C.warn, 9), T(r.busy ? '正在更新…' : `更新失败，显示缓存：${r.error}`, 8, C.warn)], { gap: 3 });
}

function buildSmall(p, r) {
  const vals = p.daily.slice(-10).map((x) => x.v);
  const e = errLine(r);
  return {
    type: 'widget', padding: 12, gap: 5, backgroundGradient: bg(),
    children: [
      header(p, r.cache.ts, true),
      balanceBlock(p, 22),
      spacer(),
      row([
        col([T(`昨日 ${mmdd(p.yesterdayKey)}`, 8, C.faint), row([T(fmt(p.yesterday), 13, C.text, 'bold'), T('度', 8, C.dim)], { alignItems: 'end', gap: 1 })], { gap: 0, flex: 1 }),
        col([T('本月', 8, C.faint), row([T(fmt(p.monthUse), 13, C.text, 'bold'), T('度', 8, C.dim)], { alignItems: 'end', gap: 1 })], { gap: 0, flex: 1 }),
      ], { gap: 6 }),
      e || { type: 'image', src: barsSvg(vals, 140, 20), width: 130, height: 20 },
    ],
  };
}

function buildMedium(p, r) {
  const list = p.daily.slice(-14);
  const vals = list.map((x) => x.v);
  const peak = vals.length ? Math.max(...vals) : NaN;
  const lm = p.lastMonth;
  const e = errLine(r);
  return {
    type: 'widget', padding: 12, gap: 6, backgroundGradient: bg(),
    children: [
      header(p, r.cache.ts, false),
      row([
        glass([balanceBlock(p, 22)], { padding: [6, 9], borderRadius: 13, width: 104 }),
        statCell('sun.max.fill', C.warn, '昨日', fmt(p.yesterday), '度', mmdd(p.yesterdayKey)),
        statCell('calendar', C.blue, '本月', fmt(p.monthUse), '度', ''),
        statCell('clock.arrow.circlepath', '#BF5AF2', '上月', fmt(lm ? lm.v : NaN, 0), '度', lm && Number.isFinite(lm.cost) ? `¥${money(lm.cost)}` : ''),
      ], { gap: 5, height: 58 }),
      glass([
        row([T(`近${list.length || 14}日用电`, 9, C.dim, 'medium'), spacer(), ...(e ? [e] : [T(`峰值 ${fmt(peak)} 度 · 虚线为均值`, 8, C.faint)])], { gap: 4 }),
        { type: 'image', src: barsSvg(vals, 300, 22), width: 300, height: 22 },
      ], { gap: 3, padding: [5, 8], borderRadius: 13 }),
    ],
  };
}

function monthBars(p) {
  const now = new Date();
  const y = now.getFullYear();
  const map = {};
  p.months.forEach((m) => { map[m.key] = m.v; });
  const vals = [];
  for (let i = 1; i <= 12; i += 1) vals.push(map[`${y}${String(i).padStart(2, '0')}`] || 0);
  return vals.slice(0, Math.max(now.getMonth(), 1));
}

function buildLarge(p, r) {
  const list = p.daily.slice(-30);
  const vals = list.map((x) => x.v);
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
  const peak = vals.length ? Math.max(...vals) : NaN;
  const mv = monthBars(p);
  const lm = p.lastMonth;
  const e = errLine(r);
  return {
    type: 'widget', padding: 12, gap: 7, backgroundGradient: bg(),
    children: [
      header(p, r.cache.ts, false),
      row([
        glass([balanceBlock(p, 28)], { padding: [8, 10], borderRadius: 14, flex: 1 }),
        col([
          row([statCell('sun.max.fill', C.warn, '昨日', fmt(p.yesterday), '度', mmdd(p.yesterdayKey)),
            statCell('calendar', C.blue, '本月', fmt(p.monthUse), '度', '')], { gap: 6 }),
          row([statCell('clock.arrow.circlepath', '#BF5AF2', '上月', fmt(lm ? lm.v : NaN, 0), '度', lm && Number.isFinite(lm.cost) ? `¥${money(lm.cost)}` : ''),
            statCell('chart.bar.fill', C.teal, '今年', fmt(p.yearUse, 0), '度', Number.isFinite(p.yearCost) ? `¥${money(p.yearCost)}` : '')], { gap: 6 }),
        ], { gap: 6, flex: 1.6 }),
      ], { gap: 6, height: 110 }),
      glass([
        row([icon('chart.bar.xaxis', C.brand, 10), T(`近${list.length || 30}日用电`, 10, C.text, 'semibold'), spacer(),
          T(`日均 ${fmt(avg)} · 峰值 ${fmt(peak)} 度`, 9, C.dim)], { gap: 4 }),
        { type: 'image', src: barsSvg(vals, 300, 38), width: 300, height: 38 },
        row([T(mmdd(list[0] && list[0].key), 8, C.faint), spacer(), T(mmdd(list.length ? list[list.length - 1].key : ''), 8, C.faint)]),
      ], { gap: 4, padding: [8, 10], borderRadius: 14 }),
      glass([
        row([icon('calendar.badge.clock', '#BF5AF2', 10), T(`${new Date().getFullYear()} 年月度用电`, 10, C.text, 'semibold'), spacer(),
          T(mv.length ? `共 ${mv.length} 个月` : '暂无', 9, C.dim)], { gap: 4 }),
        { type: 'image', src: barsSvg(mv, 300, 28, { top: '#BF5AF2', bottom: '#5E5CE6', hot: '#FF9F0A' }), width: 300, height: 28 },
        row([T('1月', 8, C.faint), spacer(), T(`${mv.length}月`, 8, C.faint)]),
      ], { gap: 4, padding: [8, 10], borderRadius: 14 }),
      e || row([icon('building.2', C.faint, 9), T(p.org || '国家电网', 8, C.faint), spacer(), T(p.billDate ? `余额截至 ${p.billDate}` : '', 8, C.faint)], { gap: 3 }),
    ],
  };
}

function buildLock(p, r, family) {
  const bal = `${p.owe ? '欠' : ''}¥${money(p.balance)}`;
  if (family === 'accessoryInline') {
    return { type: 'widget', children: [{ type: 'text', text: `⚡ ${bal} · 昨日 ${fmt(p.yesterday)}度`, maxLines: 1, minScale: 0.6 }] };
  }
  if (family === 'accessoryCircular') {
    return {
      type: 'widget', padding: 4,
      children: [spacer(),
        { type: 'image', src: 'sf-symbol:bolt.fill', width: 12, height: 12 },
        { type: 'text', text: money(p.balance), font: { size: 12, weight: 'bold' }, textAlign: 'center', maxLines: 1, minScale: 0.5 },
        { type: 'text', text: `${fmt(p.yesterday)}度`, font: { size: 9 }, textAlign: 'center', opacity: 0.7, maxLines: 1, minScale: 0.5 },
        spacer()],
    };
  }
  return {
    type: 'widget', padding: [2, 4], gap: 2,
    children: [
      row([{ type: 'image', src: 'sf-symbol:bolt.fill', width: 10, height: 10 }, { type: 'text', text: `电费 ${bal}`, font: { size: 'caption1', weight: 'semibold' } }, spacer()], { gap: 4 }),
      { type: 'text', text: `昨日 ${fmt(p.yesterday)}度 · 本月 ${fmt(p.monthUse)}度`, font: { size: 'caption2' }, opacity: 0.8, maxLines: 1, minScale: 0.6 },
      { type: 'text', text: Number.isFinite(p.days) ? `预计可用 ${fmt(p.days, 0)} 天` : `更新 ${updText(r.cache.ts)}`, font: { size: 'caption2' }, opacity: 0.7, maxLines: 1, minScale: 0.6 },
    ],
  };
}

export default async function (ctx) {
  const env = ctx.env || {};
  if (clean(env.SGCC_SCHEDULE) === 'true') {
    const r = await getData(ctx, true);
    if (r.error && /风控|密码|账号/.test(r.error)) {
      try { ctx.notify({ title: '网上国网', body: r.error.slice(0, 120) }); } catch (_) {}
    }
    return;
  }
  const family = ctx.widgetFamily || 'systemMedium';
  const r = await getData(ctx, false);
  if (!r.configured) return message('还没填写账号', '到 Egern「工具 → 模块 → 网上国网」里填写网上国网的手机号和密码，保存后刷新小组件。');
  if (!r.cache || !r.cache.list) {
    const hint = /GB008/.test(r.error || '') ? '\n国网拒绝了请求，多半是走了境外/代理出口。确认模块「国网请求策略」为 DIRECT，或换成国内节点。' : '';
    return message('暂时取不到数据', (r.error || '请稍后刷新') + hint, null);
  }
  const acc = pickAccount(r.cache.list, env.SGCC_ACCOUNT);
  if (!acc) return message('没有绑定户号', '请先在网上国网 App 里绑定用电户号。', r.cache.ts);
  const p = parse(acc);
  if (family.startsWith('accessory')) return buildLock(p, r, family);
  if (family === 'systemSmall') return buildSmall(p, r);
  if (family === 'systemMedium') return buildMedium(p, r);
  return buildLarge(p, r);
}
