// Persistent storage using Node's built-in SQLite (node:sqlite, Node >= 22.13). Multi-router aware.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DIR, { recursive: true });
const db = new DatabaseSync(path.join(DIR, 'nodestats.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');

// ---- migration from single-router schema (all old data -> router id 1) ----
const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
const hasTable = (table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const legacy = hasTable('samples') && !hasCol('samples', 'router_id');
if (legacy) {
  db.exec(`DROP INDEX IF EXISTS idx_events_ts; DROP INDEX IF EXISTS idx_events_name;
    ALTER TABLE samples RENAME TO samples_old; ALTER TABLE if_samples RENAME TO if_samples_old; ALTER TABLE events RENAME TO events_old;`);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS routers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 443,
    scheme TEXT NOT NULL DEFAULT 'https', user TEXT NOT NULL DEFAULT 'monitor', pass TEXT NOT NULL DEFAULT '',
    insecure INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS samples (
    router_id INTEGER NOT NULL, ts INTEGER NOT NULL, online INTEGER, offline INTEGER, cpu REAL, mem REAL, rx REAL, tx REAL,
    PRIMARY KEY (router_id, ts)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS if_samples (
    router_id INTEGER NOT NULL, name TEXT NOT NULL, ts INTEGER NOT NULL, rx REAL, tx REAL, up INTEGER,
    PRIMARY KEY (router_id, name, ts)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, router_id INTEGER NOT NULL, ts INTEGER NOT NULL, name TEXT NOT NULL, event TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pops (
    id INTEGER PRIMARY KEY AUTOINCREMENT, router_id INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL, ip TEXT NOT NULL, location TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS pop_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pop_id INTEGER NOT NULL, router_id INTEGER NOT NULL,
    ts INTEGER NOT NULL, name TEXT NOT NULL, ip TEXT NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_events_r_ts ON events(router_id, ts);
  CREATE INDEX IF NOT EXISTS idx_events_r_name ON events(router_id, name, ts);
  CREATE INDEX IF NOT EXISTS idx_pop_events_r_ts ON pop_events(router_id, ts);
`);
if (legacy) {
  db.exec(`INSERT INTO samples SELECT 1, ts, online, offline, cpu, mem, rx, tx FROM samples_old;
    INSERT INTO if_samples SELECT 1, name, ts, rx, tx, up FROM if_samples_old;
    INSERT INTO events (router_id, ts, name, event) SELECT 1, ts, name, event FROM events_old ORDER BY id;
    DROP TABLE samples_old; DROP TABLE if_samples_old; DROP TABLE events_old;`);
  console.log('[db] migrated legacy data to router #1');
}

const SAMPLE_SEC = Math.max(10, +(process.env.SAMPLE_SECONDS || 60));
const RETENTION_DAYS = +(process.env.RETENTION_DAYS || 90);

const tx = (fn) => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };

// ---- company / app settings ----
const DEFAULT_SETTINGS = {
  companyName: 'NodeStats',
  tagline: '',
  address: '',
  contact: '',
  website: '',
  footer: '',
  logo: '',
};
const upSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    if (r.key in DEFAULT_SETTINGS) out[r.key] = r.value;
  }
  return out;
}
function setSettings(obj) {
  tx(() => {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (obj[k] !== undefined) {
        const max = k === 'logo' ? 400000 : 300;
        const val = String(obj[k] ?? '').trim().slice(0, max);
        upSetting.run(k, val);
      }
    }
  });
  return getSettings();
}

// ---- routers CRUD ----
const listRouters = () => db.prepare('SELECT * FROM routers ORDER BY id').all();
const getRouter = (id) => db.prepare('SELECT * FROM routers WHERE id = ?').get(id);
function addRouter(r) {
  const info = db.prepare('INSERT INTO routers (name, host, port, scheme, user, pass, insecure, enabled) VALUES (?,?,?,?,?,?,?,?)')
    .run(r.name, r.host, r.port, r.scheme, r.user, r.pass, r.insecure ? 1 : 0, r.enabled === false ? 0 : 1);
  return getRouter(Number(info.lastInsertRowid));
}
function updateRouter(id, r) {
  const cur = getRouter(id); if (!cur) return null;
  const m = { ...cur, ...r, pass: r.pass ? r.pass : cur.pass };
  db.prepare('UPDATE routers SET name=?, host=?, port=?, scheme=?, user=?, pass=?, insecure=?, enabled=? WHERE id=?')
    .run(m.name, m.host, m.port, m.scheme, m.user, m.pass, m.insecure ? 1 : 0, m.enabled ? 1 : 0, id);
  return getRouter(id);
}
function deleteRouter(id) {
  tx(() => {
    for (const t of ['samples', 'if_samples', 'events', 'pops', 'pop_events']) db.prepare(`DELETE FROM ${t} WHERE router_id = ?`).run(id);
    db.prepare('DELETE FROM routers WHERE id = ?').run(id);
  });
}

// ---- POPs CRUD & events ----
const listPops = (rid) => rid ? db.prepare('SELECT * FROM pops WHERE router_id = ? ORDER BY id').all(rid) : db.prepare('SELECT * FROM pops ORDER BY id').all();
const getPop = (id) => db.prepare('SELECT * FROM pops WHERE id = ?').get(id);
function addPop(p) {
  const info = db.prepare('INSERT INTO pops (router_id, name, ip, location, notes, enabled) VALUES (?,?,?,?,?,?)')
    .run(p.router_id || 1, p.name, p.ip, p.location || '', p.notes || '', p.enabled === false ? 0 : 1);
  return getPop(Number(info.lastInsertRowid));
}
function updatePop(id, p) {
  const cur = getPop(id); if (!cur) return null;
  const m = { ...cur, ...p };
  db.prepare('UPDATE pops SET router_id=?, name=?, ip=?, location=?, notes=?, enabled=? WHERE id=?')
    .run(m.router_id, m.name, m.ip, m.location || '', m.notes || '', m.enabled ? 1 : 0, id);
  return getPop(id);
}
function deletePop(id) {
  tx(() => {
    db.prepare('DELETE FROM pop_events WHERE pop_id = ?').run(id);
    db.prepare('DELETE FROM pops WHERE id = ?').run(id);
  });
}
function addPopEvent(e) {
  try {
    db.prepare('INSERT INTO pop_events (pop_id, router_id, ts, name, ip, event, detail) VALUES (?,?,?,?,?,?,?)')
      .run(e.pop_id, e.router_id, e.ts, e.name, e.ip, e.event, e.detail || '');
  } catch (err) { console.error('[db] pop_events', err.message); }
}
function listPopEvents(rid, limit = 100) {
  return db.prepare('SELECT * FROM pop_events WHERE router_id = ? ORDER BY ts DESC, id DESC LIMIT ?')
    .all(rid, limit).map((r) => ({ ...r, ts: r.ts * 1000 }));
}

// ---- aggregation: average all polls inside one SAMPLE_SEC window, then write one row ----
const insSample = db.prepare('INSERT OR REPLACE INTO samples VALUES (?,?,?,?,?,?,?,?)');
const insIf = db.prepare('INSERT OR REPLACE INTO if_samples VALUES (?,?,?,?,?,?)');
const insEv = db.prepare('INSERT INTO events (router_id,ts,name,event) VALUES (?,?,?,?)');
const accs = new Map(); // routerId -> acc

function record(rid, s) {
  const bucket = Math.floor(s.t / 1000 / SAMPLE_SEC) * SAMPLE_SEC;
  let acc = accs.get(rid);
  if (acc && acc.bucket !== bucket) { flush(rid); acc = null; }
  if (!acc) accs.set(rid, (acc = { bucket, n: 0, online: 0, offline: 0, cpu: 0, mem: 0, rx: 0, tx: 0, ifs: new Map() }));
  acc.n++; acc.online += s.online; acc.offline += s.offline; acc.cpu += s.cpu; acc.mem += s.mem; acc.rx += s.rx; acc.tx += s.tx;
  for (const i of s.ifs) {
    let a = acc.ifs.get(i.name);
    if (!a) acc.ifs.set(i.name, (a = { n: 0, rx: 0, tx: 0, up: 1 }));
    a.n++; a.rx += i.rx; a.tx += i.tx; if (!i.up) a.up = 0;
  }
}
function flush(rid) {
  const a = accs.get(rid); if (!a) return;
  accs.delete(rid);
  try {
    tx(() => {
      insSample.run(rid, a.bucket, Math.round(a.online / a.n), Math.round(a.offline / a.n), a.cpu / a.n, a.mem / a.n, a.rx / a.n, a.tx / a.n);
      for (const [name, v] of a.ifs) insIf.run(rid, name, a.bucket, v.rx / v.n, v.tx / v.n, v.up);
    });
  } catch (e) { console.error('[db] flush', e.message); }
}
function flushAll(force) {
  const cur = Math.floor(Date.now() / 1000 / SAMPLE_SEC) * SAMPLE_SEC;
  for (const [rid, a] of [...accs]) if (force || a.bucket < cur) flush(rid);
}
function addEvents(rid, list) {
  if (!list.length) return;
  try { tx(() => list.forEach((e) => insEv.run(rid, e.ts, e.name, e.event))); } catch (e) { console.error('[db] events', e.message); }
}
function forget(rid) { accs.delete(rid); }

// ---- queries ----
const TARGET_POINTS = 400;
function history({ rid, from, to, iface }) {
  const span = Math.max(60, to - from);
  const b = Math.max(SAMPLE_SEC, Math.ceil(span / TARGET_POINTS / SAMPLE_SEC) * SAMPLE_SEC);
  const rows = db.prepare(`
    SELECT (ts / ?1) * ?1 AS t, AVG(online) online, AVG(offline) offline, AVG(cpu) cpu, AVG(mem) mem, AVG(rx) rx, AVG(tx) tx
    FROM samples WHERE router_id = ?4 AND ts BETWEEN ?2 AND ?3 GROUP BY ts / ?1 ORDER BY t`).all(b, from, to, rid);
  const out = { bucket: b, t: [], online: [], offline: [], cpu: [], mem: [], rx: [], tx: [], ifaces: {} };
  for (const r of rows) {
    out.t.push(r.t * 1000); out.online.push(Math.round(r.online)); out.offline.push(Math.round(r.offline));
    out.cpu.push(+r.cpu.toFixed(1)); out.mem.push(+r.mem.toFixed(1)); out.rx.push(Math.round(r.rx)); out.tx.push(Math.round(r.tx));
  }
  if (iface) {
    const ir = db.prepare(`
      SELECT (ts / ?1) * ?1 AS t, AVG(rx) rx, AVG(tx) tx FROM if_samples
      WHERE router_id = ?5 AND name = ?2 AND ts BETWEEN ?3 AND ?4 GROUP BY ts / ?1 ORDER BY t`).all(b, iface, from, to, rid);
    out.ifaces[iface] = { t: ir.map((r) => r.t * 1000), rx: ir.map((r) => Math.round(r.rx)), tx: ir.map((r) => Math.round(r.tx)) };
  }
  return out;
}
function flaps({ rid, from, to, search, page, size }) {
  const w = 'router_id = ? AND ts BETWEEN ? AND ?' + (search ? ' AND name LIKE ?' : '');
  const args = search ? [rid, from, to, '%' + search + '%'] : [rid, from, to];
  const base = `SELECT name, SUM(event = 'down') downs,
      MAX(CASE WHEN event = 'down' THEN ts END) last_down, MAX(CASE WHEN event = 'up' THEN ts END) last_up
    FROM events WHERE ${w} GROUP BY name HAVING downs > 0`;
  const total = db.prepare(`SELECT COUNT(*) c FROM (${base})`).get(...args).c;
  const sum = db.prepare(`SELECT COALESCE(SUM(downs),0) c FROM (${base})`).get(...args).c;
  const rows = db.prepare(base + ' ORDER BY downs DESC, last_down DESC LIMIT ? OFFSET ?').all(...args, size, (page - 1) * size);
  return { total, totalDowns: sum, rows: rows.map((r) => ({ name: r.name, downs: r.downs, lastDown: r.last_down * 1000, lastUp: r.last_up ? r.last_up * 1000 : null })) };
}
function userEvents({ rid, name, from, to }) {
  return db.prepare('SELECT ts, event FROM events WHERE router_id = ? AND name = ? AND ts BETWEEN ? AND ? ORDER BY ts DESC, id DESC LIMIT 2000')
    .all(rid, name, from, to).map((r) => ({ ts: r.ts * 1000, event: r.event }));
}
function prune() {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400;
  try {
    for (const t of ['samples', 'if_samples', 'events', 'pop_events']) db.prepare(`DELETE FROM ${t} WHERE ts < ?`).run(cutoff);
  } catch (e) { console.error('[db] prune', e.message); }
}
prune(); setInterval(prune, 6 * 3600 * 1000).unref();
setInterval(() => flushAll(false), SAMPLE_SEC * 1000 + 2000).unref();
process.on('SIGTERM', () => { flushAll(true); process.exit(0); });
process.on('SIGINT', () => { flushAll(true); process.exit(0); });

module.exports = {
  getSettings, setSettings, listRouters, getRouter, addRouter, updateRouter, deleteRouter,
  listPops, getPop, addPop, updatePop, deletePop, addPopEvent, listPopEvents,
  record, forget, addEvents, history, flaps, userEvents, SAMPLE_SEC, RETENTION_DAYS,
};
