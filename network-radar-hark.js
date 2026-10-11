/**
 * Egern 网络诊断 · Hark 液态玻璃版
 * 基于 zhaohantao1360-hash/ai-workspace 的 network-radar.js（检测逻辑不变，重做界面）
 * POLICY：统一策略；LMT/AI：分类策略（POLICY 优先）；空值使用默认规则。
 * YS：默认 1，隐藏 IP；0 显示。TIMEOUT：请求超时毫秒，默认 4500。
 * SERVICES：逗号分隔服务名，最多 8 个。
 */

/* ==================== 检测 ==================== */

const CATALOG = {
  netflix: ['Netflix', 'https://www.netflix.com/', 'LMT', 'play.tv.fill'],
  youtube: ['YouTube', 'https://www.youtube.com/', 'LMT', 'play.rectangle.fill'],
  disney: ['Disney+', 'https://www.disneyplus.com/', 'LMT', 'sparkles.tv.fill'],
  spotify: ['Spotify', 'https://open.spotify.com/', 'LMT', 'music.note'],
  tiktok: ['TikTok', 'https://www.tiktok.com/', 'LMT', 'music.note.tv.fill'],
  prime: ['Prime', 'https://www.primevideo.com/', 'LMT', 'film.fill'],
  chatgpt: ['ChatGPT', 'https://chatgpt.com/', 'AI', 'bubble.left.and.bubble.right.fill'],
  claude: ['Claude', 'https://claude.ai/', 'AI', 'asterisk'],
  gemini: ['Gemini', 'https://gemini.google.com/', 'AI', 'sparkle'],
  deepseek: ['DeepSeek', 'https://chat.deepseek.com/', 'AI', 'water.waves'],
  grok: ['Grok', 'https://grok.com/', 'AI', 'xmark'],
  perplexity: ['Perplexity', 'https://www.perplexity.ai/', 'AI', 'magnifyingglass'],
};
const DEFAULTS = ['netflix', 'youtube', 'chatgpt', 'claude', 'gemini', 'perplexity'];

const clean = (v) => String(v == null ? '' : v).trim();

async function diagnose(ctx, large) {
  const env = ctx.env || {};
  const policy = clean(env.POLICY);
  const mask = clean(env.YS) !== '0';
  const rawTimeout = Number(env.TIMEOUT);
  const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? Math.min(10000, Math.max(1000, rawTimeout)) : 4500;
  const requested = clean(env.SERVICES).toLowerCase();
  const ids = requested
    ? [...new Set(requested.split(/[,，]/).map(clean))]
        .filter((id) => Object.prototype.hasOwnProperty.call(CATALOG, id)).slice(0, large ? 12 : 8)
    : (large ? Object.keys(CATALOG) : DEFAULTS);
  const cache = new Map();

  function request(url, route = '', body = false) {
    const key = JSON.stringify([url, route, body]);
    if (!cache.has(key)) cache.set(key, (async () => {
      const start = Date.now();
      try {
        const options = {
          timeout, redirect: 'follow', credentials: 'omit',
          headers: { 'Cache-Control': 'no-cache', Accept: '*/*' },
        };
        if (route) options.policy = route;
        const resp = await ctx.http.get(url, options);
        const text = body ? await resp.text() : '';
        return { status: resp.status, text, ms: Math.max(1, Date.now() - start) };
      } catch (_) {
        return { status: 0, text: '', ms: 0 };
      }
    })());
    return cache.get(key);
  }

  async function exit(route) {
    const r = await request('https://www.cloudflare.com/cdn-cgi/trace', route, true);
    if (r.status < 200 || r.status >= 300) return { ip: '检测失败', loc: '', ok: false };
    const data = {};
    for (const line of r.text.split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0) data[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    const ip = data.ip || '';
    if (!ip) return { ip: '未获取', loc: data.loc || '', ok: false };
    const hidden = ip.includes(':') ? 'IPv6 已隐藏' : ip.replace(/^(\d+\.\d+)\.\d+\.\d+$/, '$1.*.*');
    const shown = mask ? (hidden === ip ? 'IP 已隐藏' : hidden) : ip;
    return { ip: shown, loc: data.loc || '', ok: true, v6: ip.includes(':') };
  }

  // 出口归属（城市 / ISP / ASN），仅大号查询
  async function geo(route) {
    if (!large) return {};
    const r = await request('https://ipwho.is/?lang=zh-CN', route, true);
    try {
      const j = JSON.parse(r.text || '{}');
      if (!j.success) return {};
      const conn = j.connection || {};
      return { city: j.city || j.region || '', country: j.country || '', isp: conn.isp || conn.org || '', asn: conn.asn ? `AS${conn.asn}` : '' };
    } catch (_) { return {}; }
  }

  const jobs = ids.map(async (id) => {
    const [name, url, cat, sym] = CATALOG[id];
    const route = policy || clean(env[cat]);
    const [r, e] = await Promise.all([request(url, route), exit(route)]);
    return { id, name, sym, cat, route, loc: e.loc || '', ...classify(r) };
  });
  const [directIP, selectedIP, directTime, selectedTime, services, directGeo, selectedGeo] = await Promise.all([
    exit('DIRECT'), exit(policy),
    request('https://www.qq.com/favicon.ico', 'DIRECT'),
    request('https://cp.cloudflare.com/generate_204', policy),
    Promise.all(jobs),
    geo('DIRECT'), geo(policy),
  ]);

  const device = ctx.device || {};
  const network = clean((device.wifi || {}).ssid) || clean((device.cellular || {}).carrier) || '';
  const onWifi = !!clean((device.wifi || {}).ssid);
  const dns = Array.isArray(device.dnsServers) ? device.dnsServers.filter(Boolean) : [];
  return {
    policy, mask, ids, services, network, onWifi, dns,
    direct: { ...directIP, ...latency(directTime), ...directGeo },
    selected: { ...selectedIP, ...latency(selectedTime), ...selectedGeo },
  };
}

function classify(r) {
  const c = r.status;
  if (c >= 200 && c < 300) {
    const short = r.ms >= 1000 ? `${(r.ms / 1000).toFixed(1)}s` : `${r.ms}ms`;
    // 图标按状态（绿），数字按网页加载速度分级
    const speed = r.ms <= 1500 ? C.ok : r.ms <= 3500 ? C.mid : C.slow;
    return { ok: true, label: '可访问', short, color: C.ok, speed, ms: r.ms };
  }
  if (c === 401 || c === 403 || c === 451) return { ok: false, label: `受限 ${c}`, short: `${c}`, color: C.warn };
  if (c === 429) return { ok: false, label: '限流 429', short: '429', color: C.warn };
  if (c === 0) return { ok: false, label: '请求失败', short: '失败', color: C.fail };
  return { ok: false, label: `HTTP ${c}`, short: `${c}`, color: C.warn };
}

function latency(r) {
  if (r.status >= 200 && r.status < 300) return { ms: r.ms, msText: String(r.ms), msColor: msColor(r.ms), alive: true };
  return { ms: 0, msText: r.status ? String(r.status) : '超时', msColor: C.fail, alive: false };
}

function msColor(ms) {
  if (ms <= 300) return C.ok;
  if (ms <= 800) return C.mid;
  return C.fail;
}

/* ==================== 样式 ==================== */

const C = {
  text: { light: '#000000', dark: '#FFFFFF' },
  dim: { light: '#3C3C4399', dark: '#EBEBF599' },
  faint: { light: '#3C3C4366', dark: '#EBEBF566' },
  glass: { light: '#FFFFFFA6', dark: '#FFFFFF1A' },
  accent: '#0A84FF',
  teal: '#64D2FF',
  ok: '#30D158',
  warn: '#FF9F0A',
  mid: { light: '#B88A00', dark: '#FFD60A' },
  slow: '#FF9F0A',
  fail: '#FF453A',
};

function bg() {
  return {
    type: 'linear',
    colors: [{ light: '#E8F4FF', dark: '#06172E' }, { light: '#EEF0FF', dark: '#0D1030' }, { light: '#E9FBF6', dark: '#03140F' }],
    stops: [0, 0.55, 1],
    startPoint: { x: 0, y: 0 },
    endPoint: { x: 1, y: 1 },
  };
}

function svgUri(svg) { return 'data:image/svg+xml,' + encodeURIComponent(svg); }

// 可访问比例圆环：每个服务一段，按状态着色
function segRingSvg(services, size, stroke) {
  const h = size / 2, r = h - stroke / 2, n = Math.max(1, services.length);
  const gap = n > 1 ? 0.06 : 0; // 弧度间隔
  let body = `<circle cx='${h}' cy='${h}' r='${r}' fill='none' stroke='#8E8E93' stroke-opacity='0.18' stroke-width='${stroke}'/>`;
  services.forEach((s, i) => {
    const a0 = (i / n) * 2 * Math.PI + gap / 2, a1 = ((i + 1) / n) * 2 * Math.PI - gap / 2;
    const p = (a) => [(h + r * Math.sin(a)).toFixed(2), (h - r * Math.cos(a)).toFixed(2)];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    const color = s.color;
    if (n === 1) body += `<circle cx='${h}' cy='${h}' r='${r}' fill='none' stroke='${color}' stroke-width='${stroke}'/>`;
    else body += `<path d='M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1} ${y1}' fill='none' stroke='${color}' stroke-width='${stroke}' stroke-linecap='round'/>`;
  });
  return svgUri(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${size} ${size}'>${body}</svg>`);
}

// 延迟条：0~1000ms 映射
function msBarSvg(ms, color, w, h) {
  const p = ms > 0 ? Math.max(0.06, Math.min(1, ms / 1000)) : 1;
  const r = h / 2;
  return svgUri(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'><rect width='${w}' height='${h}' rx='${r}' fill='#8E8E93' fill-opacity='0.2'/><rect width='${(w * p).toFixed(1)}' height='${h}' rx='${r}' fill='${color}'/></svg>`);
}

function T(value, size, color, weight = 'regular', extra = {}) {
  return { type: 'text', text: String(value), font: { size, weight }, textColor: color || C.text, maxLines: 1, minScale: 0.6, ...extra };
}
function icon(name, color, size = 12) {
  return { type: 'image', src: `sf-symbol:${name}`, width: size, height: size, color };
}
function dot(color, d = 6) {
  return { type: 'stack', width: d, height: d, borderRadius: d / 2, backgroundColor: color, children: [] };
}
function row(children, extra = {}) {
  return { type: 'stack', direction: 'row', alignItems: 'center', gap: 5, children, ...extra };
}
function col(children, extra = {}) {
  return { type: 'stack', direction: 'column', alignItems: 'start', gap: 2, children, ...extra };
}
function glass(children, extra = {}) {
  return { type: 'stack', direction: 'column', alignItems: 'start', gap: 4, padding: 10, borderRadius: 16, backgroundColor: C.glass, children, ...extra };
}
const spacer = () => ({ type: 'spacer' });

function hhmm() {
  const d = new Date();
  return [d.getHours(), d.getMinutes()].map((v) => String(v).padStart(2, '0')).join(':');
}
function flag(loc) {
  if (!/^[A-Z]{2}$/.test(loc || '')) return '';
  return String.fromCodePoint(...[...loc].map((c) => 0x1F1E6 + c.charCodeAt(0) - 65));
}
function locText(e) { return e.loc ? `${flag(e.loc)} ${e.loc}` : '地区未知'; }

function summary(d) {
  const ok = d.services.filter((s) => s.ok).length;
  const total = d.services.length;
  const color = !total ? C.dim : ok === total ? C.ok : ok === 0 ? C.fail : C.warn;
  return { ok, total, color };
}

function header(d, title = '网络诊断') {
  const s = summary(d);
  return row([
    icon('dot.radiowaves.left.and.right', C.accent, 13),
    T(title, 13, C.text, 'semibold'),
    spacer(),
    dot(s.color),
    T(`更新 ${hhmm()}`, 10, C.dim),
  ]);
}

function routeName(d) { return d.policy || '默认规则'; }
function netName(d) {
  if (d.mask) return d.onWifi ? 'Wi-Fi' : '蜂窝网络';
  return d.network || (d.onWifi ? 'Wi-Fi' : '网络未知');
}

// 出口卡：标题 / 大号延迟 / IP · 地区
function exitCard(label, sym, tint, e, o = {}) {
  return glass([
    row([icon(sym, tint, 11), T(label, 10, C.dim, 'medium'), spacer(), ...(o.tag ? [T(o.tag, 9, C.faint)] : [])], { gap: 4 }),
    row([
      T(e.msText, o.big || 22, e.msColor, 'bold'),
      ...(e.alive ? [T('ms', 10, C.dim, 'medium')] : []),
    ], { alignItems: 'end', gap: 2 }),
    { type: 'image', src: msBarSvg(e.ms, e.msColor, 120, 4), width: o.barW || 120, height: 4 },
  ], { flex: 1, gap: 3, padding: [8, 10] });
}

// 中号紧凑出口卡：一行延迟、一行出口
function exitMini(label, sym, tint, e, tag) {
  return glass([
    row([icon(sym, tint, 10), T(label, 10, C.dim, 'medium'), T(tag, 9, C.faint), spacer(),
      T(e.msText, 18, e.msColor, 'bold'), ...(e.alive ? [T('ms', 9, C.dim, 'medium')] : [])], { gap: 3 }),
    T(`${e.ip} · ${locText(e)}`, 11, C.dim),
  ], { flex: 1, gap: 4, padding: [8, 10], borderRadius: 16 });
}

// 服务格子
function serviceCell(s) {
  return {
    type: 'stack', direction: 'row', alignItems: 'center', gap: 5, flex: 1,
    padding: [4, 8], borderRadius: 11, backgroundColor: C.glass,
    children: [
      icon(s.sym, s.color, 12),
      T(s.name, 12, C.text, 'medium', { minScale: 0.85 }),
      spacer(),
      T(s.short, 11, s.speed || s.color, 'semibold', { minScale: 0.85 }),
    ],
  };
}
function serviceGrid(services, cols, rowH, gap = 6) {
  const rows = [];
  for (let i = 0; i < services.length; i += cols) {
    const part = services.slice(i, i + cols).map(serviceCell);
    while (part.length < cols) part.push({ type: 'stack', flex: 1, children: [] });
    rows.push({ type: 'stack', direction: 'row', gap: 6, height: rowH, children: part });
  }
  return { type: 'stack', direction: 'column', gap, children: rows };
}

/* ==================== 布局 ==================== */

function buildSmall(d) {
  const s = summary(d);
  return {
    type: 'widget', padding: 14, gap: 6, backgroundGradient: bg(),
    children: [
      row([icon('dot.radiowaves.left.and.right', C.accent, 12), T('网络诊断', 12, C.text, 'semibold'), spacer(), T(hhmm(), 10, C.dim)]),
      spacer(),
      row([
        col([
          T('所选延迟', 10, C.dim, 'medium'),
          row([T(d.selected.msText, 26, d.selected.msColor, 'bold'), ...(d.selected.alive ? [T('ms', 10, C.dim, 'medium')] : [])], { alignItems: 'end', gap: 2 }),
        ], { gap: 0 }),
        spacer(),
        {
          type: 'stack', direction: 'column', alignItems: 'center', gap: 2,
          children: [
            { type: 'image', src: segRingSvg(d.services, 100, 14), width: 40, height: 40 },
            T(`${s.ok}/${s.total}`, 10, s.color, 'bold'),
          ],
        },
      ], { gap: 6 }),
      spacer(),
      T(`${flag(d.selected.loc)} ${d.selected.ip}`, 10, C.dim),
      T(`直连 ${d.direct.msText}${d.direct.alive ? 'ms' : ''} · ${routeName(d)}`, 10, C.dim),
    ],
  };
}

function buildMedium(d) {
  const s = summary(d);
  const list = d.services.slice(0, 6);
  return {
    type: 'widget', padding: 12, gap: 8, backgroundGradient: bg(),
    children: [
      header(d),
      {
        type: 'stack', direction: 'row', gap: 8, height: 54,
        children: [
          exitMini('直连', 'house.fill', C.teal, d.direct, netName(d)),
          exitMini('所选', 'paperplane.fill', C.accent, d.selected, routeName(d)),
        ],
      },
      list.length ? serviceGrid(list, 3, 28, 6) : T('SERVICES 中没有有效服务名', 11, C.warn),
      ...(d.services.length > 6 ? [T(`另有 ${d.services.length - 6} 项 · 共 ${s.ok}/${s.total} 可访问`, 9, C.faint)] : []),
    ],
  };
}

/* ---------- 大号：雷达仪表盘 ---------- */

// 品牌小方块：字母或 SF 图标
const BRAND = {
  netflix: { bg: '#E50914', t: 'N' },
  youtube: { bg: '#FF0000', s: 'play.fill' },
  disney: { bg: '#113CCF', t: 'D+' },
  spotify: { bg: '#1DB954', s: 'dot.radiowaves.left.and.right' },
  tiktok: { bg: '#111111', s: 'music.note' },
  prime: { bg: '#00A8E1', s: 'play.rectangle.fill' },
  chatgpt: { bg: '#10A37F', s: 'circle.hexagongrid.fill' },
  claude: { bg: '#D97757', t: 'AI' },
  gemini: { bg: '#4285F4', s: 'sparkles' },
  deepseek: { bg: '#4D6BFE', t: 'D' },
  grok: { bg: '#222222', s: 'xmark' },
  perplexity: { bg: '#1F8A8A', s: 'magnifyingglass' },
};

function gaugeSvg(pct, color, w) {
  const stroke = 10, r = (w - stroke) / 2, cx = w / 2, cy = w / 2, h = w / 2 + stroke / 2;
  const p = Math.max(0, Math.min(1, Number(pct) || 0));
  const pt = (a) => [(cx - r * Math.cos(a)).toFixed(2), (cy - r * Math.sin(a)).toFixed(2)];
  const [x0, y0] = pt(0), [x1, y1] = pt(Math.PI), [xp, yp] = pt(Math.PI * p);
  let body = `<path d='M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}' fill='none' stroke='${color}' stroke-opacity='0.2' stroke-width='${stroke}' stroke-linecap='round'/>`;
  if (p > 0.005) body += `<path d='M ${x0} ${y0} A ${r} ${r} 0 0 1 ${xp} ${yp}' fill='none' stroke='${color}' stroke-width='${stroke}' stroke-linecap='round'/>`;
  return svgUri(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'>${body}</svg>`);
}

function tile(child, color, size) {
  return { type: 'stack', width: size, height: size, borderRadius: size * 0.3, backgroundColor: color, alignItems: 'center', justifyContent: 'center', direction: 'row', children: [child] };
}

function brandTile(id, size) {
  const b = BRAND[id] || { bg: '#8E8E93', t: '?' };
  const inner = b.t
    ? T(b.t, b.t.length > 1 ? size * 0.4 : size * 0.52, '#FFFFFF', 'heavy', { minScale: 0.5 })
    : icon(b.s, '#FFFFFF', size * 0.52);
  return tile(inner, b.bg, size);
}

function pill(text, color) {
  return { type: 'stack', direction: 'row', padding: [2, 6], borderRadius: 8, backgroundColor: color + '26', children: [T(text, 9, color, 'semibold')] };
}

// 卡片底部的小指标：图标+标题 / 数值
function stat(sym, label, value, color) {
  return col([
    row([icon(sym, C.dim, 8), T(label, 8, C.dim, 'medium')], { gap: 2 }),
    T(value, 10, color || C.text, 'semibold'),
  ], { alignItems: 'center', gap: 1, flex: 1 });
}

function svcTile(s) {
  const st = s.ok ? 'OK' : s.short;
  return {
    type: 'stack', direction: 'row', alignItems: 'center', gap: 5, flex: 1,
    padding: [4, 5], borderRadius: 10, backgroundColor: C.glass,
    children: [
      brandTile(s.id, 22),
      col([
        T(s.name, 10, C.text, 'semibold', { minScale: 0.7 }),
        row([
          T(s.loc ? `${flag(s.loc)} ${s.loc}` : '--', 8, C.dim, 'medium'),
          T(st, 8, s.ok ? C.ok : s.color, 'bold'),
        ], { gap: 3 }),
      ], { gap: 1 }),
      spacer(),
    ],
  };
}

function catCard(title, sym, symColor, list) {
  const ok = list.filter((x) => x.ok).length;
  const color = !list.length ? '#8E8E93' : ok === list.length ? C.ok : ok === 0 ? C.fail : C.warn;
  const items = list.slice(0, 6);
  const rows = [];
  for (let i = 0; i < 6; i += 2) {
    const a = items[i], b = items[i + 1];
    rows.push({ type: 'stack', direction: 'row', gap: 5, height: 34, children: [
      a ? svcTile(a) : { type: 'stack', flex: 1, children: [] },
      b ? svcTile(b) : { type: 'stack', flex: 1, children: [] },
    ] });
  }
  return glass([
    row([icon(sym, symColor, 12), T(title, 12, C.text, 'bold'), spacer(), pill(`${ok}/${list.length}`, color)]),
    ...(list.length ? rows : [T('未选择该类站点', 10, C.dim)]),
  ], { flex: 1, gap: 5, padding: 8 });
}

function buildLarge(d) {
  const s = summary(d);
  const now = new Date();
  const week = '日一二三四五六'[now.getDay()];
  const date = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} 周${week}`;
  const lmt = d.services.filter((x) => x.cat === 'LMT');
  const ai = d.services.filter((x) => x.cat === 'AI');
  const pct = s.total ? s.ok / s.total : 0;
  const gColor = pct >= 0.99 ? C.ok : pct >= 0.5 ? C.warn : C.fail;
  const dnsText = d.mask ? `${d.dns.length} 个` : (d.dns[0] || '--');
  const proxyOk = d.selected.alive;

  const headerRow = row([
    tile(icon('waveform.path.ecg', C.accent, 16), { light: '#0A84FF1F', dark: '#0A84FF33' }, 30),
    col([
      row([T('网络诊断雷达', 14, C.text, 'bold'), pill('Hark', '#BF5AF2')], { gap: 4 }),
      T('Egern · 全面网络状态检测', 8, C.dim),
    ], { gap: 1 }),
    spacer(),
    col([T('当前策略', 7, C.dim), row([icon('scope', C.accent, 9), T(routeName(d), 10, C.text, 'semibold')], { gap: 2 })], { gap: 1 }),
    col([T(hhmm(), 15, C.text, 'bold'), T(date, 8, C.dim)], { gap: 0, alignItems: 'end' }),
  ], { gap: 8, height: 32 });

  const localCard = glass([
    row([icon(d.onWifi ? 'wifi' : 'antenna.radiowaves.left.and.right', C.accent, 11), T('本地网络', 12, C.text, 'bold'), spacer(), pill(d.direct.alive ? '已连接' : '异常', d.direct.alive ? C.ok : C.fail)]),
    row([
      tile(icon(d.onWifi ? 'wifi' : 'antenna.radiowaves.left.and.right', C.accent, 20), { light: '#0A84FF1A', dark: '#0A84FF2E' }, 38),
      col([
        T(netName(d), 11, C.text, 'semibold'),
        T(`${flag(d.direct.loc)} ${d.direct.city || d.direct.loc || '地区未知'}`, 10, C.dim),
        T(d.direct.isp || d.direct.ip, 9, C.faint),
      ], { gap: 1, flex: 1 }),
    ], { gap: 6 }),
    row([
      stat('clock', '直连延迟', d.direct.alive ? `${d.direct.ms}ms` : d.direct.msText, d.direct.msColor),
      stat('globe', 'IP 类型', d.direct.v6 ? 'IPv6' : 'IPv4'),
      stat('server.rack', 'DNS', dnsText),
    ], { gap: 2 }),
  ], { flex: 1, gap: 5, padding: 8 });

  const proxyCard = glass([
    row([icon('point.3.connected.trianglepath.dotted', '#BF5AF2', 11), T('当前代理', 12, C.text, 'bold'), spacer(), pill(proxyOk ? '连接正常' : '连接异常', proxyOk ? C.ok : C.fail)]),
    row([
      tile(T(flag(d.selected.loc) || '🌐', 20, C.text), { light: '#BF5AF21A', dark: '#BF5AF22E' }, 38),
      col([
        T(`${flag(d.selected.loc)} ${d.selected.city || d.selected.loc || '--'}`, 10, C.text, 'semibold'),
        T(d.selected.isp || d.selected.ip, 9, C.dim),
        T(d.selected.asn || d.selected.ip, 8, C.faint),
      ], { gap: 1, flex: 1 }),
      col([
        { type: 'image', src: gaugeSvg(pct, gColor, 80), width: 52, height: 29 },
        T(`${Math.round(pct * 100)}%`, 11, gColor, 'bold'),
      ], { alignItems: 'center', gap: 0 }),
    ], { gap: 6 }),
    row([
      stat('clock', '延迟', d.selected.alive ? `${d.selected.ms}ms` : d.selected.msText, d.selected.msColor),
      stat('checkmark.seal', '可访问', `${s.ok}/${s.total}`, s.color),
      stat('paperplane', '策略', routeName(d)),
    ], { gap: 2 }),
  ], { flex: 1, gap: 5, padding: 8 });

  const foot = (sym, color, label, value, vColor) => row([
    icon(sym, color, 13),
    col([T(label, 7, C.dim), T(value, 9, vColor || C.text, 'semibold')], { gap: 0 }),
  ], { gap: 4, flex: 1 });

  return {
    type: 'widget', padding: 12, gap: 7, backgroundGradient: bg(),
    children: [
      headerRow,
      { type: 'stack', direction: 'row', gap: 8, height: 100, children: [localCard, proxyCard] },
      { type: 'stack', direction: 'row', gap: 8, height: 150, children: [
        catCard('流媒体解锁', 'play.rectangle.fill', '#0A84FF', lmt),
        catCard('AI 解锁检测', 'sparkles', '#BF5AF2', ai),
      ] },
      { type: 'stack', direction: 'row', gap: 6, height: 26, padding: [0, 4], children: [
        foot('server.rack', C.accent, 'ISP / 厂商', d.selected.isp || '--', C.accent),
        foot('number', C.warn, 'ASN', d.selected.asn || '--', C.warn),
        foot('checkmark.shield.fill', C.ok, '可访问率', `${Math.round(pct * 100)}%`, gColor),
        foot('arrow.clockwise', C.accent, '更新时间', hhmm(), C.accent),
      ] },
    ],
  };
}

function buildLock(d, family) {
  const s = summary(d);
  const ms = `${d.selected.msText}${d.selected.alive ? 'ms' : ''}`;
  if (family === 'accessoryInline') {
    return { type: 'widget', children: [{ type: 'text', text: `网络 ${ms} · ${s.ok}/${s.total} 可访问`, maxLines: 1, minScale: 0.6 }] };
  }
  if (family === 'accessoryCircular') {
    return {
      type: 'widget', padding: 6,
      backgroundImage: segRingSvg(d.services.map((x) => ({ ...x, color: x.ok ? '#FFFFFF' : '#FFFFFF55' })), 60, 6),
      children: [
        spacer(),
        { type: 'text', text: `${s.ok}/${s.total}`, font: { size: 14, weight: 'bold' }, textAlign: 'center' },
        { type: 'text', text: ms, font: { size: 9 }, textAlign: 'center', opacity: 0.7, maxLines: 1, minScale: 0.5 },
        spacer(),
      ],
    };
  }
  const bad = d.services.filter((x) => !x.ok).map((x) => x.name);
  return {
    type: 'widget', padding: [2, 4], gap: 2,
    children: [
      row([{ type: 'image', src: 'sf-symbol:dot.radiowaves.left.and.right', width: 10, height: 10 },
        { type: 'text', text: `网络 ${ms}`, font: { size: 'caption1', weight: 'semibold' } }, spacer(),
        { type: 'text', text: `${s.ok}/${s.total}`, font: { size: 'caption2' }, opacity: 0.7 }], { gap: 4 }),
      { type: 'text', text: `${flag(d.selected.loc)} ${d.selected.ip}`, font: { size: 'caption2' }, opacity: 0.8, maxLines: 1, minScale: 0.6 },
      { type: 'text', text: bad.length ? `异常：${bad.join('、')}` : '全部站点可访问', font: { size: 'caption2' }, opacity: 0.7, maxLines: 1, minScale: 0.6 },
    ],
  };
}

export default async function (ctx) {
  const family = ctx.widgetFamily || 'systemLarge';
  const d = await diagnose(ctx, family === 'systemLarge' || family === 'systemExtraLarge');
  if (family.startsWith('accessory')) return buildLock(d, family);
  if (family === 'systemSmall') return buildSmall(d);
  if (family === 'systemMedium') return buildMedium(d);
  return buildLarge(d);
}
