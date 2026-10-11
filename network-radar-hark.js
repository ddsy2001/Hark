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

async function diagnose(ctx) {
  const env = ctx.env || {};
  const policy = clean(env.POLICY);
  const mask = clean(env.YS) !== '0';
  const rawTimeout = Number(env.TIMEOUT);
  const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? Math.min(10000, Math.max(1000, rawTimeout)) : 4500;
  const requested = clean(env.SERVICES).toLowerCase();
  const ids = requested
    ? [...new Set(requested.split(/[,，]/).map(clean))]
        .filter((id) => Object.prototype.hasOwnProperty.call(CATALOG, id)).slice(0, 8)
    : DEFAULTS;
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

  const jobs = ids.map(async (id) => {
    const [name, url, cat, sym] = CATALOG[id];
    const route = policy || clean(env[cat]);
    const r = await request(url, route);
    return { id, name, sym, route, ...classify(r) };
  });
  const [directIP, selectedIP, directTime, selectedTime, services] = await Promise.all([
    exit('DIRECT'), exit(policy),
    request('https://www.qq.com/favicon.ico', 'DIRECT'),
    request('https://cp.cloudflare.com/generate_204', policy),
    Promise.all(jobs),
  ]);

  const device = ctx.device || {};
  const network = clean((device.wifi || {}).ssid) || clean((device.cellular || {}).carrier) || '';
  const onWifi = !!clean((device.wifi || {}).ssid);
  const dns = Array.isArray(device.dnsServers) ? device.dnsServers.filter(Boolean) : [];
  return {
    policy, mask, ids, services, network, onWifi, dns,
    direct: { ...directIP, ...latency(directTime) },
    selected: { ...selectedIP, ...latency(selectedTime) },
  };
}

function classify(r) {
  const c = r.status;
  if (c >= 200 && c < 300) return { ok: true, label: '可访问', short: `${r.ms}ms`, color: C.ok, ms: r.ms };
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
  if (ms <= 800) return C.warn;
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
      T(e.msText, 15, e.msColor, 'bold'), ...(e.alive ? [T('ms', 9, C.dim, 'medium')] : [])], { gap: 3 }),
    T(`${e.ip} · ${locText(e)}`, 10, C.dim),
  ], { flex: 1, gap: 3, padding: [6, 10], borderRadius: 14 });
}

// 服务格子
function serviceCell(s) {
  return {
    type: 'stack', direction: 'row', alignItems: 'center', gap: 5, flex: 1,
    padding: [4, 8], borderRadius: 11, backgroundColor: C.glass,
    children: [
      icon(s.sym, s.color, 11),
      T(s.name, 11, C.text, 'medium'),
      spacer(),
      T(s.short, 10, s.color, 'semibold'),
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
    type: 'widget', padding: 12, gap: 6, backgroundGradient: bg(),
    children: [
      header(d),
      {
        type: 'stack', direction: 'row', gap: 8, height: 46,
        children: [
          exitMini('直连', 'house.fill', C.teal, d.direct, netName(d)),
          exitMini('所选', 'paperplane.fill', C.accent, d.selected, routeName(d)),
        ],
      },
      list.length ? serviceGrid(list, 3, 22, 4) : T('SERVICES 中没有有效服务名', 11, C.warn),
      ...(d.services.length > 6 ? [T(`另有 ${d.services.length - 6} 项 · 共 ${s.ok}/${s.total} 可访问`, 9, C.faint)] : []),
    ],
  };
}

function buildLarge(d) {
  const s = summary(d);
  const dnsText = d.mask ? `${d.dns.length} 个（地址隐藏）` : (d.dns.slice(0, 2).join(' / ') || '未获取');
  return {
    type: 'widget', padding: 14, gap: 8, backgroundGradient: bg(),
    children: [
      header(d),
      {
        type: 'stack', direction: 'row', gap: 10, alignItems: 'center', height: 80,
        children: [
          {
            type: 'stack', direction: 'column', alignItems: 'center', gap: 2, width: 76,
            children: [
              { type: 'image', src: segRingSvg(d.services, 120, 14), width: 56, height: 56 },
              row([T(`${s.ok}/${s.total}`, 13, s.color, 'bold'), T('可访问', 9, C.dim, 'medium')], { gap: 3, alignItems: 'end' }),
            ],
          },
          glass([
            row([icon(d.onWifi ? 'wifi' : 'antenna.radiowaves.left.and.right', C.accent, 11), T(netName(d), 11, C.text, 'semibold'), spacer(), T(routeName(d), 10, C.dim)]),
            row([T('直连出口', 10, C.dim), spacer(), T(`${d.direct.ip} · ${locText(d.direct)}`, 10, C.text, 'medium')]),
            row([T('所选出口', 10, C.dim), spacer(), T(`${d.selected.ip} · ${locText(d.selected)}`, 10, C.text, 'medium')]),
            row([T('设备 DNS', 10, C.dim), spacer(), T(dnsText, 10, C.text, 'medium')]),
          ], { flex: 1, gap: 4, padding: [8, 10] }),
        ],
      },
      {
        type: 'stack', direction: 'row', gap: 10, height: 58,
        children: [
          exitCard('直连延迟', 'house.fill', C.teal, d.direct, { big: 18, tag: 'qq.com' }),
          exitCard('所选延迟', 'paperplane.fill', C.accent, d.selected, { big: 18, tag: 'cloudflare' }),
        ],
      },
      d.services.length ? serviceGrid(d.services, 2, 24, 5) : T('SERVICES 中没有有效服务名', 11, C.warn),
      spacer(),
      T('网页可访问 ≠ 服务解锁；耗时为 HTTP 响应，非 Ping', 9, C.faint),
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
  const d = await diagnose(ctx);
  const family = ctx.widgetFamily || 'systemLarge';
  if (family.startsWith('accessory')) return buildLock(d, family);
  if (family === 'systemSmall') return buildSmall(d);
  if (family === 'systemMedium') return buildMedium(d);
  return buildLarge(d);
}
