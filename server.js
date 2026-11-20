// MikroTik ROS 7 multi-router monitoring backend (zero dependencies, Node >= 22.13)
// One background collector per router polls its REST API and caches the result,
// so opening the dashboard never adds load to the routers.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ---- config (.env) ----
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}
const env = (k, d) => process.env[k] ?? d;
const CFG = {
  portWeb: +env('PORT', 3000),
  dashUser: env('DASH_USER', ''),
  dashPass: env('DASH_PASS', ''),
  fast: +env('POLL_SECONDS', 10) * 1000,
  slow: +env('SECRET_POLL_SECONDS', 300) * 1000,
  hide: env('HIDE_IFACE_TYPES', 'pppoe-in,pppoe-out,l2tp-in,sstp-in,ovpn-in,pptp-in').split(','),
};
const DB = require('./db');
const UPD = require('./update');
const HIST_MAX = 360; // 360 * 10s = 1 hour

// ---- RouterOS REST ----
function rosReq(r, method, p, payload, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const lib = r.scheme === 'https' ? https : http;
    const data = payload ? Buffer.from(JSON.stringify(payload)) : null;
    const headers = { Accept: 'application/json', Connection: 'close' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const req = lib.request({
      host: r.host, port: r.port, path: '/rest' + p, method, agent: false, timeout,
      auth: `${r.user}:${r.pass}`, rejectUnauthorized: !r.insecure, headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) return reject(new Error(`${res.statusCode} ${p}: ${body.slice(0, 200)}`));
        try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout ' + p)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const rosGet = (r, p) => rosReq(r, 'GET', p);
const rosPost = (r, p, body, timeout = 10000) => rosReq(r, 'POST', p, body, timeout);

function parseRosTimeMs(s) {
  if (!s) return null;
  const str = String(s);
  let ms = 0, ok = false;
  const sec = str.match(/(\d+(?:\.\d+)?)s/);
  const msec = str.match(/(\d+(?:\.\d+)?)ms/);
  const usec = str.match(/(\d+(?:\.\d+)?)us/);
  if (sec) { ms += parseFloat(sec[1]) * 1000; ok = true; }
  if (msec) { ms += parseFloat(msec[1]); ok = true; }
  if (usec) { ms += parseFloat(usec[1]) / 1000; ok = true; }
  if (!ok && !isNaN(parseFloat(str))) return +parseFloat(str).toFixed(2);
  return ok ? +ms.toFixed(2) : null;
}

async function pingViaRouter(r, ip, isDemo) {
  if (isDemo) {
    const down = /\.99$|^down/i.test(ip);
    return down ? { up: false, rttMs: null, lossPct: 100 } : { up: true, rttMs: +(1.2 + Math.random() * 4).toFixed(1), lossPct: 0 };
  }
  const runPing = async (count) => {
    const res = await rosPost(r, '/ping', { address: ip, count: String(count), interval: '250ms' }, 8000);
    const arr = Array.isArray(res) ? res : [];
    const last = arr[arr.length - 1] || {};
    const recv = +last.received || arr.filter((x) => x.time || x['avg-rtt']).length;
    const sent = +last.sent || arr.length || count;
    const rttMs = parseRosTimeMs(last['avg-rtt'] || last.time);
    const lossPct = sent ? Math.round(((sent - recv) / sent) * 100) : 100;
    return { up: recv > 0, rttMs, lossPct };
  };
  const first = await runPing(2);
  if (first.up) return first;
  // Retry once on 100% loss to avoid false alarm on transient single drop
  return await runPing(2);
}

// ---- demo data (router with host "demo") ----
function makeDemo(count) {
  const secrets = Array.from({ length: count }, (_, i) => ({
    name: `pelanggan${String(i + 1).padStart(4, '0')}`, profile: ['10M', '20M', '30M', '50M'][i % 4], disabled: i % 97 === 0 ? 'true' : 'false',
  }));
  const names = ['ether1-uplink', 'ether2-lan', 'sfp-plus1', 'bridge-pppoe', 'vlan10-pppoe', 'vlan20-hotspot', 'vlan30-mgmt', 'vlan40-cctv'];
  const cnt = Object.fromEntries(names.map((n) => [n, { rx: 1e12 * Math.random(), tx: 1e12 * Math.random() }]));
  const scale = count / 3200;
  return {
    secrets,
    tick() {
      const online = secrets.filter((s, i) => s.disabled !== 'true' && (i * 7 + Math.floor(Date.now() / 60000)) % 11 !== 0);
      const base = (400e6 + 250e6 * Math.sin(Date.now() / 1000 / 600)) * scale;
      const ifaces = names.map((n, i) => {
        cnt[n].rx += (base / (i + 1.5)) * (CFG.fast / 1000) / 8 * (0.8 + Math.random() * 0.4);
        cnt[n].tx += (base / (i + 1.2)) * (CFG.fast / 1000) / 8 * (0.8 + Math.random() * 0.4);
        return { name: n, type: n.startsWith('vlan') ? 'vlan' : n.startsWith('bridge') ? 'bridge' : 'ether', running: 'true', disabled: 'false',
          'rx-byte': String(Math.round(cnt[n].rx)), 'tx-byte': String(Math.round(cnt[n].tx)), 'rx-error': '0', 'tx-error': '0', 'rx-drop': '0', 'tx-drop': '0', comment: '' };
      });
      return {
        resource: { uptime: '41d3h22m10s', version: '7.24.4 (stable)', 'cpu-load': String(Math.round(15 + 20 * Math.random())), 'cpu-count': '40',
          'free-memory': String(48e9), 'total-memory': String(64e9), 'board-name': 'x86 (demo)' },
        health: [{ name: 'cpu-temperature', value: String(48 + Math.round(Math.random() * 5)), type: 'C' }],
        identity: { name: 'DEMO-' + count }, ifaces,
        active: online.map((s, i) => ({ name: s.name, address: `10.10.${(i >> 8) & 255}.${i & 255}`, uptime: `${i % 30}d${i % 24}h${i % 60}m`,
          'caller-id': `AA:BB:CC:${((i >> 8) & 255).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}:01`, service: 'pppoe' })),
      };
    },
  };
}

// ---- one collector per router ----
const push = (arr, v) => { arr.push(v); if (arr.length > HIST_MAX) arr.shift(); };
class Collector {
  constructor(row) {
    this.r = row; this.id = row.id; this.stopped = true; this.timers = [];
    this.demo = row.host === 'demo' ? makeDemo(row.id % 2 ? 3200 : 900) : null;
    this.updated = 0; this.error = null; this.resource = null; this.health = []; this.identity = '';
    this.secrets = []; this.secretsUpdated = 0; this.active = []; this.ifaces = [];
    this.prevIf = new Map(); this.prevActive = null;
    this.hist = { t: [], online: [], cpu: [], rx: [], tx: [] }; this.ifHist = new Map();
    this.popStates = new Map(); this.pollingPops = false;
  }
  start() { this.stopped = false; this.pollSlow().then(() => { this.pollFast(); this.pollPopsLoop(); }); }
  stop() { this.stopped = true; this.timers.forEach(clearTimeout); this.timers = []; DB.forget(this.id); }
  later(fn, ms) { if (!this.stopped) this.timers.push(setTimeout(fn, ms)); }

  async pollOnePop(p) {
    if (!p.enabled) {
      this.popStates.set(p.id, { status: 'disabled', rttMs: null, lossPct: 0, lastCheck: Date.now(), lastChange: null, downSince: null });
      return;
    }
    const prev = this.popStates.get(p.id);
    const now = Date.now();
    try {
      const res = await pingViaRouter(this.r, p.ip, !!this.demo);
      const status = res.up ? 'up' : 'down';
      const changed = prev && (prev.status === 'up' || prev.status === 'down') && prev.status !== status;
      const lastChange = changed ? now : (prev?.lastChange || now);
      const downSince = status === 'down' ? (prev?.status === 'down' ? prev.downSince : now) : null;
      this.popStates.set(p.id, { status, rttMs: res.rttMs, lossPct: res.lossPct, lastCheck: now, lastChange, downSince, error: null });
      if (changed || (!prev && status === 'down')) {
        DB.addPopEvent({
          pop_id: p.id, router_id: this.id, ts: Math.floor(now / 1000),
          name: p.name, ip: p.ip, event: status,
          detail: status === 'up' ? (res.rttMs != null ? `Reply ${res.rttMs} ms` : 'Reply OK') : 'Request timeout (100% loss)',
        });
      }
    } catch (e) {
      this.popStates.set(p.id, {
        status: prev?.status || 'pending', rttMs: null, lossPct: 100,
        lastCheck: now, lastChange: prev?.lastChange || now, downSince: prev?.downSince || null, error: e.message,
      });
    }
  }
  async pollPops() {
    if (this.stopped || this.pollingPops) return;
    this.pollingPops = true;
    try {
      const pops = DB.listPops(this.id);
      for (const p of pops) {
        if (this.stopped) break;
        await this.pollOnePop(p);
      }
    } catch (e) { console.error(`[${this.r.name}] pops`, e.message); }
    this.pollingPops = false;
  }
  async pollPopsLoop() {
    if (this.stopped) return;
    await this.pollPops();
    this.later(() => this.pollPopsLoop(), CFG.fast);
  }
  popsList() {
    return DB.listPops(this.id).map((p) => {
      const st = this.popStates.get(p.id) || { status: p.enabled ? 'pending' : 'disabled', rttMs: null, lossPct: 0, lastCheck: 0, lastChange: null, downSince: null };
      return { id: p.id, router_id: p.router_id, name: p.name, ip: p.ip, location: p.location, notes: p.notes, enabled: !!p.enabled, ...st };
    });
  }

  async pollFast() {
    if (this.stopped) return;
    try {
      let resource, health, identity, ifaces, active;
      if (this.demo) ({ resource, health, identity, ifaces, active } = this.demo.tick());
      else {
        const g = (p) => rosGet(this.r, p);
        const ifProp = '.proplist=name,type,running,disabled,rx-byte,tx-byte,rx-error,tx-error,rx-drop,tx-drop,comment';
        resource = await g('/system/resource');
        health = await g('/system/health').catch(() => []);
        identity = this.identity ? { name: this.identity } : await g('/system/identity').catch(() => ({}));
        ifaces = await g('/interface?-dynamic=&' + ifProp);
        if (!Array.isArray(ifaces) || !ifaces.length) ifaces = await g('/interface?' + ifProp);
        active = await g('/ppp/active?.proplist=name,address,uptime,caller-id,service');
      }
      if (this.stopped) return;
      const now = Date.now(), list = []; let totRx = 0, totTx = 0;
      for (const i of ifaces) {
        if (CFG.hide.includes(i.type) || i.name.startsWith('<')) continue;
        const rx = +i['rx-byte'] || 0, tx = +i['tx-byte'] || 0, p = this.prevIf.get(i.name);
        let rxbps = 0, txbps = 0;
        if (p && now > p.t && rx >= p.rx && tx >= p.tx) { const dt = (now - p.t) / 1000; rxbps = ((rx - p.rx) * 8) / dt; txbps = ((tx - p.tx) * 8) / dt; }
        this.prevIf.set(i.name, { rx, tx, t: now });
        list.push({ name: i.name, type: i.type, running: i.running === 'true', disabled: i.disabled === 'true', rxbps, txbps,
          errors: (+i['rx-error'] || 0) + (+i['tx-error'] || 0), drops: (+i['rx-drop'] || 0) + (+i['tx-drop'] || 0), comment: i.comment || '' });
        if (['ether', 'sfp', 'qsfp', 'bonding'].includes(i.type) || /^(ether|sfp|qsfp|bond)/.test(i.name)) { totRx += rxbps; totTx += txbps; }
        let h = this.ifHist.get(i.name);
        if (!h) this.ifHist.set(i.name, (h = { rx: [], tx: [] }));
        push(h.rx, Math.round(rxbps)); push(h.tx, Math.round(txbps));
      }
      // login/logout events = diff of active sessions between polls
      const cur = new Set(active.map((a) => a.name));
      if (this.prevActive) {
        const ts = Math.floor(now / 1000), ev = [];
        for (const n of cur) if (!this.prevActive.has(n)) ev.push({ ts, name: n, event: 'up' });
        for (const n of this.prevActive) if (!cur.has(n)) ev.push({ ts, name: n, event: 'down' });
        DB.addEvents(this.id, ev);
      }
      this.prevActive = cur;
      this.ifaces = list; this.active = active; this.resource = resource;
      this.health = Array.isArray(health) ? health : []; this.identity = identity.name || '';
      push(this.hist.t, now); push(this.hist.online, active.length); push(this.hist.cpu, +resource['cpu-load'] || 0);
      push(this.hist.rx, Math.round(totRx)); push(this.hist.tx, Math.round(totTx));
      this.updated = now; this.error = null;
      const sm = this.summary();
      DB.record(this.id, { t: now, online: sm.pppoe.online, offline: sm.pppoe.offline, cpu: sm.router.cpu, mem: sm.router.memUsedPct, rx: totRx, tx: totTx,
        ifs: list.map((i) => ({ name: i.name, rx: i.rxbps, tx: i.txbps, up: i.running || i.disabled })) });
    } catch (e) { this.error = e.message; console.error(`[${this.r.name}]`, e.message); }
    this.later(() => this.pollFast(), CFG.fast);
  }
  async pollSlow() {
    if (this.stopped) return;
    try {
      if (this.demo) {
        this.secrets = this.demo.secrets;
      } else {
        const id = await rosGet(this.r, '/system/identity').catch(() => null);
        if (id && id.name) this.identity = id.name;
        this.secrets = await rosGet(this.r, '/ppp/secret?.proplist=name,profile,disabled,service,comment');
      }
      this.secretsUpdated = Date.now();
    } catch (e) { console.error(`[${this.r.name}] secrets`, e.message); }
    this.later(() => this.pollSlow(), CFG.slow);
  }

  summary() {
    const activeSet = new Set(this.active.map((a) => a.name));
    const enabled = this.secrets.filter((s) => s.disabled !== 'true');
    const offline = enabled.filter((s) => !activeSet.has(s.name)).length;
    const r = this.resource || {}, total = +r['total-memory'] || 0, free = +r['free-memory'] || 0;
    const temp = this.health.find((h) => /temperature/.test(h.name));
    const profOf = new Map(this.secrets.map((s) => [s.name, s.profile])), profiles = {};
    for (const a of this.active) { const p = profOf.get(a.name) || '-'; profiles[p] = (profiles[p] || 0) + 1; }
    return {
      updated: this.updated, error: this.error, demo: !!this.demo, identity: this.identity, name: this.r.name,
      router: { version: r.version, board: r['board-name'], uptime: r.uptime, cpu: +r['cpu-load'] || 0, cpuCount: +r['cpu-count'] || 0,
        memUsedPct: total ? Math.round(((total - free) / total) * 100) : 0, memTotal: total, temp: temp ? +temp.value : null },
      pppoe: { secrets: this.secrets.length, enabled: enabled.length, disabled: this.secrets.length - enabled.length, online: this.active.length,
        offline, pct: enabled.length ? +((this.active.length / enabled.length) * 100).toFixed(1) : 0, profiles },
      secretsUpdated: this.secretsUpdated, ifaces: this.ifaces, pops: this.popsList(),
    };
  }
  pppoe(q) {
    const activeMap = new Map(this.active.map((a) => [a.name, a]));
    const search = (q.get('search') || '').toLowerCase(), status = q.get('status') || 'all';
    const page = Math.max(1, +q.get('page') || 1), size = Math.min(200, +q.get('size') || 50);
    let rows = [];
    if (status !== 'offline') for (const a of this.active) rows.push({ name: a.name, status: 'online', address: a.address, uptime: a.uptime, mac: a['caller-id'], profile: '' });
    if (status !== 'online') for (const s of this.secrets) if (s.disabled !== 'true' && !activeMap.has(s.name)) rows.push({ name: s.name, status: 'offline', profile: s.profile });
    const profOf = new Map(this.secrets.map((s) => [s.name, s.profile]));
    if (search) rows = rows.filter((r) => `${r.name} ${r.address || ''} ${r.mac || ''}`.toLowerCase().includes(search));
    rows.sort((a, b) => a.name.localeCompare(b.name));
    const total = rows.length;
    rows = rows.slice((page - 1) * size, page * size).map((r) => ({ ...r, profile: r.profile || profOf.get(r.name) || '-' }));
    return { total, page, size, rows };
  }
  liveHistory() { const ifaces = {}; for (const [k, v] of this.ifHist) ifaces[k] = v; return { ...this.hist, ifaces }; }
}

// ---- router registry ----
const collectors = new Map();
function startCollector(row) {
  const old = collectors.get(row.id); if (old) old.stop();
  const c = new Collector(row); collectors.set(row.id, c);
  if (row.enabled) c.start();
  return c;
}
// first run: seed from .env (old single-router setup) or DEMO=1
if (!DB.listRouters().length) {
  if (process.env.ROS_HOST) {
    DB.addRouter({ name: env('ROS_NAME', 'Router Utama'), host: process.env.ROS_HOST, port: +env('ROS_PORT', 443), scheme: env('ROS_SCHEME', 'https'),
      user: env('ROS_USER', 'monitor'), pass: env('ROS_PASS', ''), insecure: env('ROS_INSECURE', '1') === '1' });
    console.log('[init] router dari .env ditambahkan');
  } else if (env('DEMO', '0') === '1') {
    DB.addRouter({ name: 'Demo Router A', host: 'demo', port: 443, scheme: 'https', user: 'x', pass: '', insecure: true });
    DB.addRouter({ name: 'Demo Router B', host: 'demo', port: 443, scheme: 'https', user: 'x', pass: '', insecure: true });
  }
}
DB.listRouters().forEach(startCollector);

const publicRouter = (r) => {
  const c = collectors.get(r.id), s = c && r.enabled ? c.summary() : null;
  return { id: r.id, name: r.name, host: r.host, port: r.port, scheme: r.scheme, user: r.user, insecure: !!r.insecure, enabled: !!r.enabled, hasPass: !!r.pass,
    status: s && { updated: s.updated, error: s.error, identity: s.identity, online: s.pppoe.online, offline: s.pppoe.offline, cpu: s.router.cpu } };
};
function cleanInput(b, partial) {
  const o = {};
  const str = (k, max = 120) => { if (b[k] !== undefined) o[k] = String(b[k]).trim().slice(0, max); };
  ['name', 'host', 'user'].forEach((k) => str(k)); str('pass', 200);
  if (b.scheme !== undefined) o.scheme = b.scheme === 'http' ? 'http' : 'https';
  if (b.port !== undefined) o.port = Math.min(65535, Math.max(1, +b.port || 443));
  if (b.insecure !== undefined) o.insecure = !!b.insecure;
  if (b.enabled !== undefined) o.enabled = !!b.enabled;
  if (!partial) {
    if (!o.name || !o.host) throw new Error('Nama dan host wajib diisi');
    Object.assign(o, { port: o.port ?? 443, scheme: o.scheme ?? 'https', user: o.user || 'monitor', pass: o.pass || '', insecure: o.insecure ?? true });
  }
  return o;
}
const readBody = (req) => new Promise((resolve, reject) => {
  let s = ''; req.on('data', (c) => { s += c; if (s.length > 524288) req.destroy(); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new Error('JSON tidak valid')); } });
});

// ---- HTTP ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const send = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
http.createServer(async (req, res) => {
  if (CFG.dashUser) {
    const want = 'Basic ' + Buffer.from(`${CFG.dashUser}:${CFG.dashPass}`).toString('base64');
    if (req.headers.authorization !== want) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="NodeStats"' }); return res.end('Auth required'); }
  }
  const u = new URL(req.url, 'http://x'), q = u.searchParams, now = Math.floor(Date.now() / 1000);
  try {
    // CSRF guard: state-changing calls must carry a custom header (forces a CORS preflight for cross-site pages)
    if (req.method !== 'GET' && u.pathname.startsWith('/api/') && req.headers['x-requested-with'] !== 'nodestats') return send(res, 403, { error: 'forbidden' });
    // company / app settings
    if (u.pathname === '/api/settings' && req.method === 'GET') return send(res, 200, DB.getSettings());
    if (u.pathname === '/api/settings' && (req.method === 'POST' || req.method === 'PUT')) {
      const b = await readBody(req);
      if (b.logo && !/^(data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,|https?:\/\/)/i.test(String(b.logo).trim())) {
        return send(res, 400, { error: 'Format logo harus gambar (PNG/JPG/WEBP/SVG) atau URL http(s)' });
      }
      return send(res, 200, DB.setSettings(b));
    }
    // self update (git)
    if (u.pathname === '/api/update/status' && req.method === 'GET') return send(res, 200, await UPD.status());
    if (u.pathname === '/api/update/check' && req.method === 'POST') return send(res, 200, await UPD.check());
    if (u.pathname === '/api/update/apply' && req.method === 'POST') {
      if (!CFG.dashUser) return send(res, 403, { error: 'Isi DASH_USER/DASH_PASS dulu sebelum memakai update' });
      return send(res, 200, await UPD.apply());
    }
    // router management
    if (u.pathname === '/api/routers' && req.method === 'GET') return send(res, 200, DB.listRouters().map(publicRouter));
    if (u.pathname === '/api/routers' && req.method === 'POST') {
      const row = DB.addRouter(cleanInput(await readBody(req))); startCollector(row); return send(res, 200, publicRouter(row));
    }
    if (u.pathname === '/api/routers/test' && req.method === 'POST') {
      const b = await readBody(req), saved = b.id ? DB.getRouter(+b.id) : null;
      const cfg = { ...(saved || {}), ...cleanInput(b, true) };
      if (!b.pass && saved) cfg.pass = saved.pass;
      if (cfg.host === 'demo') return send(res, 200, { ok: true, identity: 'DEMO', version: 'demo' });
      try {
        const [id, rs] = await Promise.all([rosGet(cfg, '/system/identity'), rosGet(cfg, '/system/resource')]);
        return send(res, 200, { ok: true, identity: id.name, version: rs.version, board: rs['board-name'] });
      } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    }
    const m = u.pathname.match(/^\/api\/routers\/(\d+)$/);
    if (m && req.method === 'PUT') {
      const row = DB.updateRouter(+m[1], cleanInput(await readBody(req), true));
      if (!row) return send(res, 404, { error: 'not found' });
      startCollector(row); return send(res, 200, publicRouter(row));
    }
    if (m && req.method === 'DELETE') {
      const c = collectors.get(+m[1]); if (c) c.stop(); collectors.delete(+m[1]); DB.deleteRouter(+m[1]); return send(res, 200, { ok: true });
    }

    // per-router data
    if (u.pathname.startsWith('/api/')) {
      const rid = +q.get('router') || [...collectors.keys()][0];
      const c = collectors.get(rid);
      if (!c) return send(res, 404, { error: 'no router' });
      if (u.pathname === '/api/summary') return send(res, 200, { ...c.summary(), routerId: c.id });
      if (u.pathname === '/api/pppoe') return send(res, 200, c.pppoe(q));
      if (u.pathname === '/api/history') {
        if (!q.get('from')) return send(res, 200, c.liveHistory());
        return send(res, 200, DB.history({ rid: c.id, from: Math.max(0, +q.get('from')), to: Math.min(+q.get('to') || now, now + 60), iface: q.get('iface') || '' }));
      }
      if (u.pathname === '/api/user') {
        const name = q.get('name') || '', a = c.active.find((x) => x.name === name), sec = c.secrets.find((x) => x.name === name);
        return send(res, 200, { name, online: !!a, address: a?.address || null, uptime: a?.uptime || null, mac: a?.['caller-id'] || null,
          profile: sec?.profile || null, disabled: sec?.disabled === 'true',
          events: DB.userEvents({ rid: c.id, name, from: +q.get('from') || now - 7 * 86400, to: +q.get('to') || now + 60 }) });
      }
      if (u.pathname === '/api/flaps') {
        const r = DB.flaps({ rid: c.id, from: +q.get('from') || now - 86400, to: +q.get('to') || now, search: q.get('search') || '',
          page: Math.max(1, +q.get('page') || 1), size: Math.min(200, +q.get('size') || 50) });
        r.rows.forEach((x) => { x.online = c.prevActive ? c.prevActive.has(x.name) : null; });
        return send(res, 200, r);
      }
      if (u.pathname === '/api/pops' && req.method === 'GET') {
        return send(res, 200, { pops: c.popsList(), events: DB.listPopEvents(c.id, 100) });
      }
      if (u.pathname === '/api/pops' && req.method === 'POST') {
        const b = await readBody(req);
        const name = String(b.name || '').trim().slice(0, 120);
        const ip = String(b.ip || '').trim().slice(0, 120);
        if (!name || !ip) return send(res, 400, { error: 'Nama POP dan IP wajib diisi' });
        const row = DB.addPop({
          router_id: c.id, name, ip,
          location: String(b.location || '').trim().slice(0, 120),
          notes: String(b.notes || '').trim().slice(0, 200),
          enabled: b.enabled !== false,
        });
        await c.pollOnePop(row);
        return send(res, 200, { pops: c.popsList(), events: DB.listPopEvents(c.id, 100) });
      }
      if (u.pathname === '/api/pops/check' && req.method === 'POST') {
        await c.pollPops();
        return send(res, 200, { pops: c.popsList(), events: DB.listPopEvents(c.id, 100) });
      }
      const mp = u.pathname.match(/^\/api\/pops\/(\d+)$/);
      if (mp && req.method === 'PUT') {
        const id = +mp[1], b = await readBody(req), cur = DB.getPop(id);
        if (!cur) return send(res, 404, { error: 'POP tidak ditemukan' });
        const upd = {};
        if (b.name !== undefined) upd.name = String(b.name).trim().slice(0, 120);
        if (b.ip !== undefined) upd.ip = String(b.ip).trim().slice(0, 120);
        if (b.location !== undefined) upd.location = String(b.location).trim().slice(0, 120);
        if (b.notes !== undefined) upd.notes = String(b.notes).trim().slice(0, 200);
        if (b.enabled !== undefined) upd.enabled = !!b.enabled;
        const row = DB.updatePop(id, upd);
        await c.pollOnePop(row);
        return send(res, 200, { pops: c.popsList(), events: DB.listPopEvents(c.id, 100) });
      }
      if (mp && req.method === 'DELETE') {
        const id = +mp[1];
        c.popStates.delete(id);
        DB.deletePop(id);
        return send(res, 200, { pops: c.popsList(), events: DB.listPopEvents(c.id, 100) });
      }
      return send(res, 404, { error: 'unknown endpoint' });
    }

    // static files
    const file = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[\\/])+/, ''));
    if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (e, d) => {
      if (e) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(d);
    });
  } catch (e) { send(res, 400, { error: e.message }); }
}).listen(CFG.portWeb, env('HOST', '0.0.0.0'), () => console.log(`NodeStats on http://localhost:${CFG.portWeb}  (${collectors.size} router)`));
UPD.schedule();
