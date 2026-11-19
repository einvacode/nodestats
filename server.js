// MikroTik ROS 7 monitoring backend (zero dependencies, Node 18+)
// Polls the router's REST API in the background and serves cached data to the dashboard,
// so opening the dashboard never adds load to the router.
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
  host: env('ROS_HOST', '192.168.88.1'),
  port: +env('ROS_PORT', 443),
  scheme: env('ROS_SCHEME', 'https'),
  user: env('ROS_USER', 'monitor'),
  pass: env('ROS_PASS', ''),
  insecure: env('ROS_INSECURE', '1') === '1',
  demo: env('DEMO', '0') === '1',
  port_web: +env('PORT', 3000),
  dashUser: env('DASH_USER', ''),
  dashPass: env('DASH_PASS', ''),
  fast: +env('POLL_SECONDS', 10) * 1000,
  slow: +env('SECRET_POLL_SECONDS', 300) * 1000,
  hide: (env('HIDE_IFACE_TYPES', 'pppoe-in,pppoe-out,l2tp-in,sstp-in,ovpn-in,pptp-in')).split(','),
};
const DB = require('./db');
const HIST_MAX = 360; // 360 * 10s = 1 hour

// ---- RouterOS REST ----
function rosGet(p) {
  return new Promise((resolve, reject) => {
    const lib = CFG.scheme === 'https' ? https : http;
    const req = lib.request({
      host: CFG.host, port: CFG.port, path: '/rest' + p, method: 'GET', timeout: 20000,
      auth: `${CFG.user}:${CFG.pass}`, rejectUnauthorized: !CFG.insecure,
      headers: { Accept: 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) return reject(new Error(`${res.statusCode} ${p}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout ' + p)));
    req.on('error', reject);
    req.end();
  });
}

// ---- state ----
const S = {
  updated: 0, error: null,
  resource: null, health: [], identity: '',
  secrets: [], secretsUpdated: 0,
  active: [],
  ifaces: [],              // current w/ rates
  prevIf: new Map(),       // name -> {rx,tx,t}
  hist: { t: [], online: [], cpu: [], rx: [], tx: [] },
  ifHist: new Map(),       // name -> {rx:[], tx:[]}
};
const push = (arr, v) => { arr.push(v); if (arr.length > HIST_MAX) arr.shift(); };

// ---- demo data ----
const demo = (() => {
  const secrets = Array.from({ length: 3200 }, (_, i) => ({
    name: `pelanggan${String(i + 1).padStart(4, '0')}`,
    profile: ['10M', '20M', '30M', '50M'][i % 4], disabled: i % 97 === 0 ? 'true' : 'false',
  }));
  const names = ['ether1-uplink', 'ether2-lan', 'sfp-plus1', 'bridge-pppoe', 'vlan10-pppoe', 'vlan20-hotspot', 'vlan30-mgmt', 'vlan40-cctv'];
  const cnt = Object.fromEntries(names.map((n) => [n, { rx: 1e12 * Math.random(), tx: 1e12 * Math.random() }]));
  return {
    secrets,
    tick() {
      const online = secrets.filter((s, i) => s.disabled !== 'true' && (i * 7 + Math.floor(Date.now() / 60000)) % 11 !== 0);
      const t = Date.now() / 1000;
      const base = 400e6 + 250e6 * Math.sin(t / 600);
      const ifaces = names.map((n, i) => {
        cnt[n].rx += (base / (i + 1.5)) * (CFG.fast / 1000) / 8 * (0.8 + Math.random() * 0.4);
        cnt[n].tx += (base / (i + 1.2)) * (CFG.fast / 1000) / 8 * (0.8 + Math.random() * 0.4);
        return { name: n, type: n.startsWith('vlan') ? 'vlan' : n.startsWith('bridge') ? 'bridge' : 'ether',
          running: n !== 'vlan40-cctv' || Math.random() > 0.05 ? 'true' : 'false', disabled: 'false',
          'rx-byte': String(Math.round(cnt[n].rx)), 'tx-byte': String(Math.round(cnt[n].tx)),
          'rx-error': '0', 'tx-error': '0', 'rx-drop': '0', 'tx-drop': '0', comment: '' };
      });
      return {
        resource: { uptime: '41d3h22m10s', version: '7.24.4 (stable)', 'cpu-load': String(Math.round(15 + 20 * Math.random())),
          'cpu-count': '40', 'cpu-frequency': '2400', 'free-memory': String(48e9), 'total-memory': String(64e9),
          'board-name': 'x86 (Dell R630)', platform: 'MikroTik', 'architecture-name': 'x86_64' },
        health: [{ name: 'cpu-temperature', value: String(48 + Math.round(Math.random() * 5)), type: 'C' }],
        identity: { name: 'DEMO-R630' },
        ifaces,
        active: online.map((s, i) => ({ name: s.name, address: `10.10.${(i >> 8) & 255}.${i & 255}`, uptime: `${i % 30}d${i % 24}h${i % 60}m`,
          'caller-id': `AA:BB:CC:${((i >> 8) & 255).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}:01`, service: 'pppoe' })),
      };
    },
  };
})();

// ---- pollers ----
async function pollFast() {
  try {
    let resource, health, identity, ifaces, active;
    if (CFG.demo) ({ resource, health, identity, ifaces, active } = demo.tick());
    else {
      [resource, health, identity, ifaces, active] = await Promise.all([
        rosGet('/system/resource'),
        rosGet('/system/health').catch(() => []),
        rosGet('/system/identity').catch(() => ({})),
        rosGet('/interface?.proplist=name,type,running,disabled,rx-byte,tx-byte,rx-error,tx-error,rx-drop,tx-drop,comment'),
        rosGet('/ppp/active?.proplist=name,address,uptime,caller-id,service'),
      ]);
    }
    const now = Date.now();
    const list = [];
    let totRx = 0, totTx = 0;
    for (const i of ifaces) {
      if (CFG.hide.includes(i.type) || i.name.startsWith('<')) continue;
      const rx = +i['rx-byte'] || 0, tx = +i['tx-byte'] || 0;
      const p = S.prevIf.get(i.name);
      let rxbps = 0, txbps = 0;
      if (p && now > p.t && rx >= p.rx && tx >= p.tx) {
        const dt = (now - p.t) / 1000;
        rxbps = ((rx - p.rx) * 8) / dt; txbps = ((tx - p.tx) * 8) / dt;
      }
      S.prevIf.set(i.name, { rx, tx, t: now });
      list.push({ name: i.name, type: i.type, running: i.running === 'true', disabled: i.disabled === 'true',
        rxbps, txbps, errors: (+i['rx-error'] || 0) + (+i['tx-error'] || 0),
        drops: (+i['rx-drop'] || 0) + (+i['tx-drop'] || 0), comment: i.comment || '' });
      if (['ether', 'sfp', 'qsfp', 'bonding'].includes(i.type) || /^(ether|sfp|qsfp|bond)/.test(i.name)) { totRx += rxbps; totTx += txbps; }
      let h = S.ifHist.get(i.name);
      if (!h) S.ifHist.set(i.name, (h = { rx: [], tx: [] }));
      push(h.rx, Math.round(rxbps)); push(h.tx, Math.round(txbps));
    }
    // login/logout events (diff of active sessions between polls)
    const cur = new Set(active.map((a) => a.name));
    if (S.prevActive) {
      const ts = Math.floor(now / 1000), ev = [];
      for (const n of cur) if (!S.prevActive.has(n)) ev.push({ ts, name: n, event: 'up' });
      for (const n of S.prevActive) if (!cur.has(n)) ev.push({ ts, name: n, event: 'down' });
      DB.addEvents(ev);
    }
    S.prevActive = cur;
    S.ifaces = list; S.active = active; S.resource = resource;
    S.health = Array.isArray(health) ? health : []; S.identity = identity.name || '';
    push(S.hist.t, now); push(S.hist.online, active.length); push(S.hist.cpu, +resource['cpu-load'] || 0);
    push(S.hist.rx, Math.round(totRx)); push(S.hist.tx, Math.round(totTx));
    S.updated = now; S.error = null;
    const sm = summary();
    DB.record({ t: now, online: sm.pppoe.online, offline: sm.pppoe.offline, cpu: sm.router.cpu, mem: sm.router.memUsedPct,
      rx: totRx, tx: totTx, ifs: list.map((i) => ({ name: i.name, rx: i.rxbps, tx: i.txbps, up: i.running || i.disabled })) });
  } catch (e) { S.error = e.message; console.error('[fast]', e.message); }
  setTimeout(pollFast, CFG.fast);
}
async function pollSlow() {
  try {
    S.secrets = CFG.demo ? demo.secrets : await rosGet('/ppp/secret?.proplist=name,profile,disabled,service,comment');
    S.secretsUpdated = Date.now();
  } catch (e) { console.error('[slow]', e.message); }
  setTimeout(pollSlow, CFG.slow);
}
pollSlow().then(pollFast);

// ---- API ----
function summary() {
  const activeSet = new Set(S.active.map((a) => a.name));
  const enabled = S.secrets.filter((s) => s.disabled !== 'true');
  const offline = enabled.filter((s) => !activeSet.has(s.name)).length;
  const r = S.resource || {};
  const total = +r['total-memory'] || 0, free = +r['free-memory'] || 0;
  const temp = S.health.find((h) => /temperature/.test(h.name));
  const profiles = {};
  const profOf = new Map(S.secrets.map((s) => [s.name, s.profile]));
  for (const a of S.active) { const p = profOf.get(a.name) || '-'; profiles[p] = (profiles[p] || 0) + 1; }
  return {
    updated: S.updated, error: S.error, demo: CFG.demo, identity: S.identity,
    router: { version: r.version, board: r['board-name'], uptime: r.uptime, cpu: +r['cpu-load'] || 0, cpuCount: +r['cpu-count'] || 0,
      memUsedPct: total ? Math.round(((total - free) / total) * 100) : 0, memTotal: total, temp: temp ? +temp.value : null },
    pppoe: { secrets: S.secrets.length, enabled: enabled.length, disabled: S.secrets.length - enabled.length,
      online: S.active.length, offline, pct: enabled.length ? +((S.active.length / enabled.length) * 100).toFixed(1) : 0, profiles },
    secretsUpdated: S.secretsUpdated,
    ifaces: S.ifaces,
  };
}
function pppoe(q) {
  const activeMap = new Map(S.active.map((a) => [a.name, a]));
  const search = (q.get('search') || '').toLowerCase();
  const status = q.get('status') || 'all';
  const page = Math.max(1, +q.get('page') || 1), size = Math.min(200, +q.get('size') || 50);
  let rows = [];
  if (status !== 'offline') for (const a of S.active) rows.push({ name: a.name, status: 'online', address: a.address, uptime: a.uptime, mac: a['caller-id'], profile: '' });
  if (status !== 'online') for (const s of S.secrets) if (s.disabled !== 'true' && !activeMap.has(s.name)) rows.push({ name: s.name, status: 'offline', profile: s.profile });
  const profOf = new Map(S.secrets.map((s) => [s.name, s.profile]));
  if (search) rows = rows.filter((r) => `${r.name} ${r.address || ''} ${r.mac || ''}`.toLowerCase().includes(search));
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const total = rows.length;
  rows = rows.slice((page - 1) * size, page * size).map((r) => ({ ...r, profile: r.profile || profOf.get(r.name) || '-' }));
  return { total, page, size, rows };
}
function history() {
  const ifs = {};
  for (const [k, v] of S.ifHist) ifs[k] = v;
  return { ...S.hist, ifaces: ifs };
}

// ---- HTTP ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const json = (res, o) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
http.createServer((req, res) => {
  if (CFG.dashUser) {
    const want = 'Basic ' + Buffer.from(`${CFG.dashUser}:${CFG.dashPass}`).toString('base64');
    if (req.headers.authorization !== want) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="NodeStats"' }); return res.end('Auth required'); }
  }
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/summary') return json(res, summary());
  if (u.pathname === '/api/pppoe') return json(res, pppoe(u.searchParams));
  if (u.pathname === '/api/history') {
    const q = u.searchParams, now = Math.floor(Date.now() / 1000);
    if (!q.get('from')) return json(res, history());
    const to = Math.min(+q.get('to') || now, now + 60), from = Math.max(0, +q.get('from'));
    return json(res, DB.history({ from, to, iface: q.get('iface') || '' }));
  }
  if (u.pathname === '/api/user') {
    const q = u.searchParams, now = Math.floor(Date.now() / 1000), name = q.get('name') || '';
    const a = S.active.find((x) => x.name === name), sec = S.secrets.find((x) => x.name === name);
    return json(res, { name, online: !!a, address: a?.address || null, uptime: a?.uptime || null, mac: a?.['caller-id'] || null,
      profile: sec?.profile || null, disabled: sec?.disabled === 'true',
      events: DB.userEvents({ name, from: +q.get('from') || now - 7 * 86400, to: +q.get('to') || now + 60 }) });
  }
  if (u.pathname === '/api/flaps') {
    const q = u.searchParams, now = Math.floor(Date.now() / 1000);
    const r = DB.flaps({ from: +q.get('from') || now - 86400, to: +q.get('to') || now, search: q.get('search') || '',
      page: Math.max(1, +q.get('page') || 1), size: Math.min(200, +q.get('size') || 50) });
    r.rows.forEach((x) => { x.online = S.prevActive ? S.prevActive.has(x.name) : null; });
    return json(res, r);
  }
  if (u.pathname === '/api/events') {
    const q = u.searchParams, now = Math.floor(Date.now() / 1000);
    return json(res, DB.events({ from: +q.get('from') || now - 86400, to: +q.get('to') || now, search: q.get('search') || '', type: q.get('type') || '',
      page: Math.max(1, +q.get('page') || 1), size: Math.min(200, +q.get('size') || 50) }));
  }
  const file = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[\\/])+/, ''));
  if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, d) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(d);
  });
}).listen(CFG.port_web, env('HOST', '0.0.0.0'), () => console.log(`NodeStats on http://localhost:${CFG.port_web}  ${CFG.demo ? '(DEMO mode)' : `-> ${CFG.host}`}`));
