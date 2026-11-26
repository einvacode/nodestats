// MikroTik ROS 7 multi-router monitoring backend (zero dependencies, Node >= 22.13)
// One background collector per router polls its REST API and caches the result,
// so opening the dashboard never adds load to the routers.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

// ---- Telegram Bot Notifier (with Queue, Rate-Limiter & 429 Flood Protection) ----
const escTg = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmtTimeTg = (ms = Date.now()) => new Date(ms).toLocaleString('id-ID', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const fmtDurTg = (ms) => {
  let s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  s %= 60;
  return d ? `${d}h ${h}j ${m}m` : h ? `${h}j ${m}m` : m ? `${m}m ${s}d` : `${s}d`;
};
const TG_MAX_LEN = 3900; // Telegram hard limit is 4096 chars
const TG_MIN_INTERVAL_MS = 3200; // >=3.2s gap between messages (~18 msg/min, safe for Telegram groups limit of 20/min)
const tgQueue = [];
let tgWorkerRunning = false;
let tgLastSentAt = 0;
let tgCooldownUntil = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clampTgHtml(text) {
  if (text.length <= TG_MAX_LEN) return text;
  return text.slice(0, TG_MAX_LEN - 40).replace(/<[^>]*$/, '') + '\n<i>...(pesan dipotong)</i>';
}

function tgPostOne(botToken, chatId, text) {
  return new Promise((resolve, reject) => {
    const safeText = clampTgHtml(text);
    const payload = Buffer.from(JSON.stringify({
      chat_id: chatId,
      text: safeText,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }));
    const req = https.request({
      host: 'api.telegram.org',
      port: 443,
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      timeout: 12000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        try {
          const j = JSON.parse(body);
          if (!j.ok) {
            const err = new Error(j.description || `HTTP ${res.statusCode}`);
            err.retryAfter = j.parameters?.retry_after || (res.statusCode === 429 ? 30 : 0);
            return reject(err);
          }
          resolve(j);
        } catch {
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 160)}`));
          resolve({});
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Telegram API timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function sendTelegramMessage(text, overrideCfg = null) {
  const tg = overrideCfg || DB.getTelegramSettings();
  if (!overrideCfg && !tg.enabled) return { ok: false, skipped: true };
  const token = String(tg.botToken || '').trim();
  const rawChats = String(tg.chatId || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  if (!token || !rawChats.length) throw new Error('Bot Token dan Chat ID wajib diisi');
  const results = [];
  for (let i = 0; i < rawChats.length; i++) {
    if (i > 0) await sleep(1200); // safe pacing across multiple chat IDs
    results.push(await tgPostOne(token, rawChats[i], text));
  }
  return { ok: true, sent: results.length };
}

async function processTgQueue() {
  if (tgWorkerRunning) return;
  tgWorkerRunning = true;
  while (tgQueue.length > 0) {
    const now = Date.now();
    const waitMs = Math.max(0, tgCooldownUntil - now, (tgLastSentAt + TG_MIN_INTERVAL_MS) - now);
    if (waitMs > 0) await sleep(waitMs);
    const item = tgQueue.shift();
    if (!item) break;
    try {
      await sendTelegramMessage(item.text);
      tgLastSentAt = Date.now();
    } catch (e) {
      tgLastSentAt = Date.now();
      if (e.retryAfter && !item.retried) {
        const waitSec = Math.min(300, Math.max(5, +e.retryAfter || 30));
        console.warn(`[telegram] Rate limit 429, tunda ${waitSec} detik...`);
        tgCooldownUntil = Date.now() + (waitSec + 1) * 1000;
        item.retried = true;
        tgQueue.unshift(item);
      } else {
        console.error('[telegram]', e.message);
      }
    }
  }
  tgWorkerRunning = false;
}

function queueTelegram(text) {
  if (tgQueue.length >= 40) tgQueue.shift(); // Drop oldest if queue overflows to prevent flood backlog
  tgQueue.push({ text, retried: false });
  processTgQueue();
}


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
    this.prevIf = new Map(); this.prevActive = null; this.prevActiveMap = null;
    this.hist = { t: [], online: [], cpu: [], rx: [], tx: [] }; this.ifHist = new Map();
    this.popStates = new Map(); this.pollingPops = false;
    this.routerDownNotified = false; this.failCount = 0;
  }
  start() { this.stopped = false; this.pollSlow().then(() => { this.pollFast(); this.pollPopsLoop(); }); }
  stop() { this.stopped = true; this.timers.forEach(clearTimeout); this.timers = []; DB.forget(this.id); }
  later(fn, ms) { if (!this.stopped) this.timers.push(setTimeout(fn, ms)); }

  async pollOnePop(p) {
    if (!p.enabled) {
      this.popStates.set(p.id, { status: 'disabled', rttMs: null, lossPct: 0, lastCheck: Date.now(), lastChange: null, downSince: null });
      return null;
    }
    const prev = this.popStates.get(p.id);
    const now = Date.now();
    try {
      const res = await pingViaRouter(this.r, p.ip, !!this.demo);
      const status = res.up ? 'up' : 'down';
      const changed = prev && (prev.status === 'up' || prev.status === 'down') && prev.status !== status;
      const prevDownSince = prev?.downSince || prev?.lastChange || null;
      const lastChange = changed ? now : (prev?.lastChange || now);
      const downSince = status === 'down' ? (prev?.status === 'down' ? prev.downSince : now) : null;
      this.popStates.set(p.id, { status, rttMs: res.rttMs, lossPct: res.lossPct, lastCheck: now, lastChange, downSince, error: null });
      if (changed || (!prev && status === 'down')) {
        const detail = status === 'up' ? (res.rttMs != null ? `Reply ${res.rttMs} ms` : 'Reply OK') : 'Request timeout (100% loss)';
        DB.addPopEvent({
          pop_id: p.id, router_id: this.id, ts: Math.floor(now / 1000),
          name: p.name, ip: p.ip, event: status,
          detail,
        });
        return { pop: p, status, rttMs: res.rttMs, detail, prevDownSince, now };
      }
    } catch (e) {
      this.popStates.set(p.id, {
        status: prev?.status || 'pending', rttMs: null, lossPct: 100,
        lastCheck: now, lastChange: prev?.lastChange || now, downSince: prev?.downSince || null, error: e.message,
      });
    }
    return null;
  }
  notifyPopChanges(changes) {
    if (!changes.length) return;
    const tg = DB.getTelegramSettings();
    if (!tg.enabled) return;
    const brand = DB.getSettings().companyName || 'NodeStats';
    const rLabel = `${this.r.name}${this.identity ? ` (${this.identity})` : ''}`;
    const allPops = this.popsList().filter((x) => x.enabled);
    const curDowns = allPops.filter((x) => x.status === 'down');

    const downChanges = changes.filter((c) => c.status === 'down');
    const upChanges = changes.filter((c) => c.status === 'up');

    if (downChanges.length && tg.popDown) {
      const listStr = downChanges.map((c) => `<b>${escTg(c.pop.name)}</b>`).join(', ');
      const otherDowns = curDowns.filter((d) => !downChanges.some((c) => c.pop.id === d.id));
      let msg = `🚨 <b>POP TIDAK KONEK (${downChanges.length} POP)</b>\n`
        + `🏢 <b>${escTg(brand)}</b> · 🖥 Router: <b>${escTg(rLabel)}</b>\n`
        + `⚠️ Total POP Tidak Konek: <b>${curDowns.length} POP</b>\n\n`
        + `<b>POP Baru Down (${downChanges.length}):</b>\n${listStr}`;
      if (otherDowns.length) {
        const otherStr = otherDowns.slice(0, 80).map((d) => `<b>${escTg(d.name)}</b>`).join(', ');
        msg += `\n\n<b>POP Lain Masih Tidak Konek (${otherDowns.length}):</b>\n${otherStr}`
          + (otherDowns.length > 80 ? `, <i>...dan ${otherDowns.length - 80} lainnya</i>` : '');
      }
      msg += `\n\n🕒 Waktu: ${fmtTimeTg()}`;
      queueTelegram(msg);
    }

    if (upChanges.length && tg.popUp) {
      const listStr = upChanges.map((c) => `<b>${escTg(c.pop.name)}</b>`).join(', ');
      let msg = `✅ <b>POP KEMBALI KONEK (${upChanges.length} POP)</b>\n`
        + `🏢 <b>${escTg(brand)}</b> · 🖥 Router: <b>${escTg(rLabel)}</b>\n`
        + `⚠️ Sisa POP Tidak Konek: <b>${curDowns.length} POP</b>\n\n`
        + `<b>POP Kembali Konek (${upChanges.length}):</b>\n${listStr}`;
      if (curDowns.length) {
        const downStr = curDowns.slice(0, 80).map((d) => `<b>${escTg(d.name)}</b>`).join(', ');
        msg += `\n\n<b>POP Masih Tidak Konek (${curDowns.length}):</b>\n${downStr}`
          + (curDowns.length > 80 ? `, <i>...dan ${curDowns.length - 80} lainnya</i>` : '');
      }
      msg += `\n\n🕒 Waktu: ${fmtTimeTg()}`;
      queueTelegram(msg);
    }
  }
  async pollPops() {
    if (this.stopped || this.pollingPops) return;
    this.pollingPops = true;
    try {
      const pops = DB.listPops(this.id);
      const changes = [];
      for (const p of pops) {
        if (this.stopped) break;
        const ch = await this.pollOnePop(p);
        if (ch) changes.push(ch);
      }
      if (changes.length) this.notifyPopChanges(changes);
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
      const curMap = new Map(active.map((a) => [a.name, a]));
      const cur = new Set(curMap.keys());
      let downUsers = [], upUsers = [];
      if (this.prevActive) {
        const ts = Math.floor(now / 1000), ev = [];
        for (const n of cur) {
          if (!this.prevActive.has(n)) {
            ev.push({ ts, name: n, event: 'up' });
            upUsers.push(curMap.get(n) || { name: n });
          }
        }
        for (const n of this.prevActive) {
          if (!cur.has(n)) {
            ev.push({ ts, name: n, event: 'down' });
            downUsers.push((this.prevActiveMap && this.prevActiveMap.get(n)) || { name: n });
          }
        }
        DB.addEvents(this.id, ev);
      }
      this.prevActive = cur;
      this.prevActiveMap = curMap;
      this.ifaces = list; this.active = active; this.resource = resource;
      this.health = Array.isArray(health) ? health : []; this.identity = identity.name || '';
      push(this.hist.t, now); push(this.hist.online, active.length); push(this.hist.cpu, +resource['cpu-load'] || 0);
      push(this.hist.rx, Math.round(totRx)); push(this.hist.tx, Math.round(totTx));
      this.updated = now; this.error = null;
      const sm = this.summary();
      DB.record(this.id, { t: now, online: sm.pppoe.online, offline: sm.pppoe.offline, cpu: sm.router.cpu, mem: sm.router.memUsedPct, rx: totRx, tx: totTx,
        ifs: list.map((i) => ({ name: i.name, rx: i.rxbps, tx: i.txbps, up: i.running || i.disabled })) });

      if (this.routerDownNotified) {
        this.routerDownNotified = false;
        this.failCount = 0;
        const tg = DB.getTelegramSettings();
        if (tg.enabled && tg.routerDown) {
          const brand = DB.getSettings().companyName || 'NodeStats';
          const rLabel = `${this.r.name}${this.identity ? ` (${this.identity})` : ''}`;
          queueTelegram(`✅ <b>ROUTER TERHUBUNG KEMBALI</b>\n🏢 <b>${escTg(brand)}</b> · 🖥 Router: <b>${escTg(rLabel)}</b>\n⚠️ PPPoE Tidak Konek: <b>${sm.pppoe.offline} User</b>\n🕒 Waktu: ${fmtTimeTg(now)}`);
        }
      } else {
        this.failCount = 0;
      }
      if (downUsers.length || upUsers.length) {
        this.notifyPppoeChanges(downUsers, upUsers, sm);
      }
    } catch (e) {
      this.error = e.message;
      this.failCount = (this.failCount || 0) + 1;
      console.error(`[${this.r.name}]`, e.message);
      if (this.failCount >= 2 && !this.routerDownNotified) {
        this.routerDownNotified = true;
        const tg = DB.getTelegramSettings();
        if (tg.enabled && tg.routerDown) {
          const brand = DB.getSettings().companyName || 'NodeStats';
          const rLabel = `${this.r.name}${this.identity ? ` (${this.identity})` : ''}`;
          queueTelegram(`🚨 <b>ROUTER TERPUTUS / TIDAK DAPAT DIAKSES!</b>\n🏢 <b>${escTg(brand)}</b> · 🖥 Router: <b>${escTg(rLabel)}</b>\n🌐 Host: <code>${escTg(this.r.host)}:${this.r.port}</code>\n⚠️ Error: <code>${escTg(e.message)}</code>\n🕒 Waktu: ${fmtTimeTg()}`);
        }
      }
    }
    this.later(() => this.pollFast(), CFG.fast);
  }
  notifyPppoeChanges(downUsers, upUsers, sm) {
    const tg = DB.getTelegramSettings();
    if (!tg.enabled) return;
    const brand = DB.getSettings().companyName || 'NodeStats';
    const rLabel = `${this.r.name}${this.identity ? ` (${this.identity})` : ''}`;
    const activeSet = new Set(this.active.map((a) => a.name));
    const allOffline = this.secrets.filter((s) => s.disabled !== 'true' && !activeSet.has(s.name));
    const MAX_LIST = 150;

    if (downUsers.length >= (tg.pppoeMinDown || 1) && tg.pppoeDown) {
      const downSet = new Set(downUsers.map((u) => u.name));
      const otherOffline = allOffline.filter((s) => !downSet.has(s.name));
      const shown = downUsers.slice(0, MAX_LIST).map((u) => `<b>${escTg(u.name)}</b>`).join(', ');
      let msg = `🔻 <b>PPPoE TIDAK KONEK (${downUsers.length} User Baru Putus)</b>\n`
        + `🏢 <b>${escTg(brand)}</b> · 🖥 Router: <b>${escTg(rLabel)}</b>\n`
        + `⚠️ Total PPPoE Tidak Konek: <b>${allOffline.length} User</b>\n\n`
        + `<b>User Baru Putus (${downUsers.length}):</b>\n`
        + shown + (downUsers.length > MAX_LIST ? `, <i>...dan ${downUsers.length - MAX_LIST} lainnya</i>` : '');
      if (otherOffline.length) {
        const otherStr = otherOffline.slice(0, MAX_LIST).map((s) => escTg(s.name)).join(', ');
        msg += `\n\n<b>User Lain Masih Tidak Konek (${otherOffline.length}):</b>\n`
          + otherStr + (otherOffline.length > MAX_LIST ? `, <i>...dan ${otherOffline.length - MAX_LIST} lainnya</i>` : '');
      }
      msg += `\n\n🕒 Waktu: ${fmtTimeTg()}`;
      queueTelegram(msg);
    }

    if (upUsers.length >= (tg.pppoeMinDown || 1) && tg.pppoeUp) {
      const shown = upUsers.slice(0, MAX_LIST).map((u) => `<b>${escTg(u.name)}</b>`).join(', ');
      let msg = `🟢 <b>PPPoE KEMBALI KONEK (${upUsers.length} User)</b>\n`
        + `🏢 <b>${escTg(brand)}</b> · 🖥 Router: <b>${escTg(rLabel)}</b>\n`
        + `⚠️ Sisa PPPoE Tidak Konek: <b>${allOffline.length} User</b>\n\n`
        + `<b>User Kembali Konek (${upUsers.length}):</b>\n`
        + shown + (upUsers.length > MAX_LIST ? `, <i>...dan ${upUsers.length - MAX_LIST} lainnya</i>` : '');
      if (allOffline.length) {
        const offStr = allOffline.slice(0, MAX_LIST).map((s) => escTg(s.name)).join(', ');
        msg += `\n\n<b>User Masih Tidak Konek (${allOffline.length}):</b>\n`
          + offStr + (allOffline.length > MAX_LIST ? `, <i>...dan ${allOffline.length - MAX_LIST} lainnya</i>` : '');
      }
      msg += `\n\n🕒 Waktu: ${fmtTimeTg()}`;
      queueTelegram(msg);
    }
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

// ---- HTTP & Auth (Admin / NOC) ----
DB.ensureDefaultUsers(CFG.dashUser, CFG.dashPass);
const AUTH_SECRET = DB.getAuthSecret();
function signSession(u) {
  const payload = Buffer.from(JSON.stringify({ id: u.id, exp: Math.floor(Date.now() / 1000) + 30 * 86400 })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifySession(tok) {
  if (!tok || typeof tok !== 'string' || !tok.includes('.')) return null;
  const [payload, sig] = tok.split('.');
  const want = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  if (sig !== want) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!d.id || (d.exp && d.exp < Math.floor(Date.now() / 1000))) return null;
    return DB.getUser(d.id);
  } catch { return null; }
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function getAuthUser(req) {
  const cookies = parseCookies(req);
  const tok = cookies.ns_sess || req.headers['x-auth-token'];
  if (tok) {
    const u = verifySession(tok);
    if (u) return u;
  }
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const raw = Buffer.from(auth.slice(6), 'base64').toString();
    const idx = raw.indexOf(':');
    if (idx > 0) {
      const u = DB.verifyUser(raw.slice(0, idx), raw.slice(idx + 1));
      if (u) return u;
    }
  }
  return null;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const send = (res, code, o, extraHeaders = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(o));
};
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), q = u.searchParams, now = Math.floor(Date.now() / 1000);
  try {
    // CSRF guard: state-changing calls must carry a custom header (forces a CORS preflight for cross-site pages)
    if (req.method !== 'GET' && u.pathname.startsWith('/api/') && req.headers['x-requested-with'] !== 'nodestats') return send(res, 403, { error: 'forbidden' });

    const authUser = getAuthUser(req);

    // auth endpoints
    if (u.pathname === '/api/auth/me' && req.method === 'GET') {
      return send(res, 200, { user: authUser, settings: DB.getSettings() });
    }
    if (u.pathname === '/api/auth/login' && req.method === 'POST') {
      const b = await readBody(req);
      const user = DB.verifyUser(b.username, b.password);
      if (!user) return send(res, 401, { error: 'Username atau password salah' });
      const tok = signSession(user);
      const cookie = `ns_sess=${encodeURIComponent(tok)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`;
      return send(res, 200, { user, token: tok }, { 'Set-Cookie': cookie });
    }
    if (u.pathname === '/api/auth/logout' && req.method === 'POST') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'ns_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
    }

    // company / app settings (GET is public for branding on login page; POST/PUT requires Admin)
    if (u.pathname === '/api/settings' && req.method === 'GET') return send(res, 200, DB.getSettings());

    // All other /api/* endpoints require authentication
    if (u.pathname.startsWith('/api/') && !authUser) {
      return send(res, 401, { error: 'Silakan login terlebih dahulu' });
    }

    if (u.pathname === '/api/auth/password' && req.method === 'POST') {
      const b = await readBody(req);
      if (!DB.verifyUser(authUser.username, b.oldPassword)) return send(res, 400, { error: 'Password lama tidak sesuai' });
      const updated = DB.updateUser(authUser.id, { password: b.newPassword });
      return send(res, 200, { ok: true, user: updated });
    }

    if (u.pathname === '/api/settings' && (req.method === 'POST' || req.method === 'PUT')) {
      if (authUser.role !== 'admin') return send(res, 403, { error: 'Akses ditolak: Hanya Admin yang dapat mengubah data perusahaan' });
      const b = await readBody(req);
      if (b.logo && !/^(data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,|https?:\/\/)/i.test(String(b.logo).trim())) {
        return send(res, 400, { error: 'Format logo harus gambar (PNG/JPG/WEBP/SVG) atau URL http(s)' });
      }
      return send(res, 200, DB.setSettings(b));
    }

    // telegram notification settings & test
    if (u.pathname === '/api/telegram' && req.method === 'GET') {
      return send(res, 200, DB.getTelegramSettings());
    }
    if (u.pathname === '/api/telegram' && (req.method === 'POST' || req.method === 'PUT')) {
      const b = await readBody(req);
      return send(res, 200, DB.setTelegramSettings(b));
    }
    if (u.pathname === '/api/telegram/test' && req.method === 'POST') {
      const b = await readBody(req);
      const saved = DB.getTelegramSettings();
      const cfg = {
        botToken: b.botToken !== undefined ? b.botToken : saved.botToken,
        chatId: b.chatId !== undefined ? b.chatId : saved.chatId,
      };
      const brand = DB.getSettings().companyName || 'NodeStats';
      const rid = +q.get('router') || [...collectors.keys()][0];
      const c = collectors.get(rid);
      let statusSummary = '';
      if (c) {
        const sm = c.summary();
        const pops = sm.pops.filter((x) => x.enabled);
        const popDowns = pops.filter((x) => x.status === 'down');
        const activeSet = new Set(c.active.map((a) => a.name));
        const offlineUsers = c.secrets.filter((s) => s.disabled !== 'true' && !activeSet.has(s.name));
        statusSummary = `\n🖥 Router: <b>${escTg(c.r.name)}${c.identity ? ` (${escTg(c.identity)})` : ''}</b>\n`
          + `📡 POP Tidak Konek: <b>${popDowns.length} POP</b>\n`
          + `🔻 PPPoE Tidak Konek: <b>${offlineUsers.length} User</b>`;
        if (popDowns.length) {
          statusSummary += `\n\n🚨 <b>POP Tidak Konek (${popDowns.length}):</b>\n`
            + popDowns.slice(0, 80).map((p) => `<b>${escTg(p.name)}</b>`).join(', ');
          if (popDowns.length > 80) statusSummary += `, <i>...dan ${popDowns.length - 80} lainnya</i>`;
        }
        if (offlineUsers.length) {
          statusSummary += `\n\n🔻 <b>PPPoE Tidak Konek (${offlineUsers.length}):</b>\n`
            + offlineUsers.slice(0, 150).map((s) => `<b>${escTg(s.name)}</b>`).join(', ');
          if (offlineUsers.length > 150) statusSummary += `, <i>...dan ${offlineUsers.length - 150} lainnya</i>`;
        }
      }
      const msg = `🔔 <b>TES NOTIFIKASI TELEGRAM BERHASIL</b>\n`
        + `🏢 <b>${escTg(brand)}</b>${statusSummary}\n\n`
        + `✅ Bot Telegram sudah terhubung dan siap mengirimkan notifikasi POP Down/Up & Pelanggan PPPoE Down.\n`
        + `🕒 Waktu: ${fmtTimeTg()}`;
      try {
        const r = await sendTelegramMessage(msg, cfg);
        return send(res, 200, { ok: true, sent: r.sent });
      } catch (e) {
        return send(res, 400, { error: 'Gagal kirim ke Telegram: ' + e.message });
      }
    }

    // user management (Admin only)
    if (u.pathname === '/api/users' && req.method === 'GET') {
      if (authUser.role !== 'admin') return send(res, 403, { error: 'Hanya Admin yang dapat melihat daftar akun' });
      return send(res, 200, DB.listUsers());
    }
    if (u.pathname === '/api/users' && req.method === 'POST') {
      if (authUser.role !== 'admin') return send(res, 403, { error: 'Hanya Admin yang dapat membuat akun' });
      const b = await readBody(req);
      const created = DB.addUser({ username: b.username, password: b.password, role: b.role, name: b.name, routerIds: b.routerIds });
      return send(res, 200, { user: created, users: DB.listUsers() });
    }
    const mu = u.pathname.match(/^\/api\/users\/(\d+)$/);
    if (mu && req.method === 'PUT') {
      if (authUser.role !== 'admin') return send(res, 403, { error: 'Hanya Admin yang dapat mengubah akun' });
      const b = await readBody(req);
      const updated = DB.updateUser(+mu[1], { username: b.username, password: b.password, role: b.role, name: b.name, routerIds: b.routerIds });
      return send(res, 200, { user: updated, users: DB.listUsers() });
    }
    if (mu && req.method === 'DELETE') {
      if (authUser.role !== 'admin') return send(res, 403, { error: 'Hanya Admin yang dapat menghapus akun' });
      if (+mu[1] === authUser.id) return send(res, 400, { error: 'Tidak dapat menghapus akun yang sedang Anda gunakan login' });
      DB.deleteUser(+mu[1]);
      return send(res, 200, { ok: true, users: DB.listUsers() });
    }

    // self update (git)
    if (u.pathname === '/api/update/status' && req.method === 'GET') return send(res, 200, await UPD.status());
    if (u.pathname === '/api/update/check' && req.method === 'POST') return send(res, 200, await UPD.check());
    if (u.pathname === '/api/update/apply' && req.method === 'POST') {
      if (authUser.role !== 'admin') return send(res, 403, { error: 'Hanya Admin yang dapat melakukan update aplikasi' });
      return send(res, 200, await UPD.apply());
    }

    // Helper: check which routers this user is allowed to access (empty routerIds = all routers)
    const isRestrictedUser = authUser.role !== 'admin' && Array.isArray(authUser.routerIds) && authUser.routerIds.length > 0;
    const canAccessRouter = (id) => !isRestrictedUser || authUser.routerIds.includes(+id);

    // router management
    if (u.pathname === '/api/routers' && req.method === 'GET') {
      const list = DB.listRouters().filter((r) => canAccessRouter(r.id)).map(publicRouter);
      return send(res, 200, list);
    }
    if (u.pathname === '/api/routers' && req.method === 'POST') {
      if (isRestrictedUser) return send(res, 403, { error: 'Akun Anda dibatasi pada router tertentu dan tidak dapat menambah router baru' });
      const row = DB.addRouter(cleanInput(await readBody(req))); startCollector(row); return send(res, 200, publicRouter(row));
    }
    if (u.pathname === '/api/routers/test' && req.method === 'POST') {
      const b = await readBody(req), saved = b.id ? DB.getRouter(+b.id) : null;
      if (b.id && !canAccessRouter(+b.id)) return send(res, 403, { error: 'Akses router ditolak' });
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
      if (!canAccessRouter(+m[1])) return send(res, 403, { error: 'Akses router ditolak' });
      const row = DB.updateRouter(+m[1], cleanInput(await readBody(req), true));
      if (!row) return send(res, 404, { error: 'not found' });
      startCollector(row); return send(res, 200, publicRouter(row));
    }
    if (m && req.method === 'DELETE') {
      if (isRestrictedUser) return send(res, 403, { error: 'Akun Anda tidak diizinkan menghapus router' });
      const c = collectors.get(+m[1]); if (c) c.stop(); collectors.delete(+m[1]); DB.deleteRouter(+m[1]); return send(res, 200, { ok: true });
    }

    // per-router data
    if (u.pathname.startsWith('/api/')) {
      const allowedIds = [...collectors.keys()].filter((id) => canAccessRouter(id));
      const reqRid = +q.get('router');
      if (reqRid && !canAccessRouter(reqRid)) return send(res, 403, { error: 'Anda tidak memiliki akses ke router ini' });
      const rid = (reqRid && allowedIds.includes(reqRid)) ? reqRid : allowedIds[0];
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
          sort: q.get('sort') || 'downs', page: Math.max(1, +q.get('page') || 1), size: Math.min(200, +q.get('size') || 50) });
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

    // PWA dynamic manifest & icon (uses company name & uploaded logo from DB settings)
    if (u.pathname === '/manifest.json' && req.method === 'GET') {
      const s = DB.getSettings();
      const name = s.companyName || 'NodeStats';
      const icons = [{ src: '/pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }];
      if (s.logo && /^data:image\/png;base64,/i.test(s.logo)) {
        icons.unshift(
          { src: '/pwa-icon.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/pwa-icon.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        );
      }
      return send(res, 200, {
        name: name + (s.tagline ? ' – ' + s.tagline : ' – MikroTik & POP Monitor'),
        short_name: name.slice(0, 20),
        description: s.tagline || 'MikroTik & POP Monitoring Dashboard',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#020617',
        theme_color: '#0f172a',
        icons,
      }, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
    }
    if (u.pathname === '/pwa-icon.png' && req.method === 'GET') {
      const s = DB.getSettings();
      const mPng = String(s.logo || '').match(/^data:image\/png;base64,(.+)$/i);
      if (mPng) {
        const buf = Buffer.from(mPng[1], 'base64');
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
        return res.end(buf);
      }
      res.writeHead(302, { Location: '/pwa-icon.svg' });
      return res.end();
    }
    if (u.pathname === '/pwa-icon.svg' && req.method === 'GET') {
      const s = DB.getSettings();
      const ch = String(s.companyName || 'N').trim()[0]?.toUpperCase() || 'N';
      const safeCh = ch.replace(/[<>&"]/g, '');
      const hasImg = s.logo && /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,/i.test(s.logo);
      const inner = hasImg
        ? `<image href="${s.logo.replace(/"/g, '&quot;')}" x="56" y="56" width="400" height="400" preserveAspectRatio="xMidYMid meet"/>`
        : `<text x="256" y="340" font-family="system-ui,-apple-system,sans-serif" font-size="260" font-weight="800" fill="#38bdf8" text-anchor="middle">${safeCh}</text>`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><rect width="512" height="512" rx="112" fill="#0f172a"/><rect x="16" y="16" width="480" height="480" rx="96" fill="#0284c7" fill-opacity="0.16" stroke="#0284c7" stroke-opacity="0.4" stroke-width="8"/>${inner}</svg>`;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
      return res.end(svg);
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
