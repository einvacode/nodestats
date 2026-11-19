// Persistent storage using Node's built-in SQLite (node:sqlite, Node >= 22.5). No npm packages needed.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DIR, { recursive: true });
const db = new DatabaseSync(path.join(DIR, 'nodestats.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS samples (
    ts INTEGER PRIMARY KEY, online INTEGER, offline INTEGER, cpu REAL, mem REAL, rx REAL, tx REAL
  );
  CREATE TABLE IF NOT EXISTS if_samples (
    name TEXT NOT NULL, ts INTEGER NOT NULL, rx REAL, tx REAL, up INTEGER,
    PRIMARY KEY (name, ts)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, name TEXT NOT NULL, event TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_name ON events(name, ts);
`);

const SAMPLE_SEC = Math.max(10, +(process.env.SAMPLE_SECONDS || 60));
const RETENTION_DAYS = +(process.env.RETENTION_DAYS || 90);

const insSample = db.prepare('INSERT OR REPLACE INTO samples VALUES (?,?,?,?,?,?,?)');
const insIf = db.prepare('INSERT OR REPLACE INTO if_samples VALUES (?,?,?,?,?)');
const insEv = db.prepare('INSERT INTO events (ts,name,event) VALUES (?,?,?)');

const tx = (fn) => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };

// ---- aggregation: average all polls inside one SAMPLE_SEC window, then write one row ----
let acc = null;
function record(s) {
  const bucket = Math.floor(s.t / 1000 / SAMPLE_SEC) * SAMPLE_SEC;
  if (acc && acc.bucket !== bucket) flush();
  if (!acc) acc = { bucket, n: 0, online: 0, offline: 0, cpu: 0, mem: 0, rx: 0, tx: 0, ifs: new Map() };
  acc.n++; acc.online += s.online; acc.offline += s.offline; acc.cpu += s.cpu; acc.mem += s.mem; acc.rx += s.rx; acc.tx += s.tx;
  for (const i of s.ifs) {
    let a = acc.ifs.get(i.name);
    if (!a) acc.ifs.set(i.name, (a = { n: 0, rx: 0, tx: 0, up: 1 }));
    a.n++; a.rx += i.rx; a.tx += i.tx; if (!i.up) a.up = 0;
  }
}
function flush() {
  if (!acc) return;
  const a = acc; acc = null;
  try {
    tx(() => {
      insSample.run(a.bucket, Math.round(a.online / a.n), Math.round(a.offline / a.n), a.cpu / a.n, a.mem / a.n, a.rx / a.n, a.tx / a.n);
      for (const [name, v] of a.ifs) insIf.run(name, a.bucket, v.rx / v.n, v.tx / v.n, v.up);
    });
  } catch (e) { console.error('[db] flush', e.message); }
}
function addEvents(list) {
  if (!list.length) return;
  try { tx(() => list.forEach((e) => insEv.run(e.ts, e.name, e.event))); } catch (e) { console.error('[db] events', e.message); }
}

// ---- queries ----
const TARGET_POINTS = 400;
function history({ from, to, iface }) {
  const span = Math.max(60, to - from);
  const b = Math.max(SAMPLE_SEC, Math.ceil(span / TARGET_POINTS / SAMPLE_SEC) * SAMPLE_SEC);
  const rows = db.prepare(`
    SELECT (ts / ?1) * ?1 AS t, AVG(online) online, AVG(offline) offline, AVG(cpu) cpu, AVG(mem) mem, AVG(rx) rx, AVG(tx) tx,
           MAX(rx) rxmax, MAX(tx) txmax
    FROM samples WHERE ts BETWEEN ?2 AND ?3 GROUP BY ts / ?1 ORDER BY t`).all(b, from, to);
  const out = { bucket: b, t: [], online: [], offline: [], cpu: [], mem: [], rx: [], tx: [], ifaces: {} };
  for (const r of rows) {
    out.t.push(r.t * 1000); out.online.push(Math.round(r.online)); out.offline.push(Math.round(r.offline));
    out.cpu.push(+r.cpu.toFixed(1)); out.mem.push(+r.mem.toFixed(1)); out.rx.push(Math.round(r.rx)); out.tx.push(Math.round(r.tx));
  }
  if (iface) {
    const ir = db.prepare(`
      SELECT (ts / ?1) * ?1 AS t, AVG(rx) rx, AVG(tx) tx FROM if_samples
      WHERE name = ?2 AND ts BETWEEN ?3 AND ?4 GROUP BY ts / ?1 ORDER BY t`).all(b, iface, from, to);
    out.ifaces[iface] = { t: ir.map((r) => r.t * 1000), rx: ir.map((r) => Math.round(r.rx)), tx: ir.map((r) => Math.round(r.tx)) };
  }
  return out;
}
function events({ from, to, search, type, page, size }) {
  const where = ['e.ts BETWEEN ? AND ?']; const args = [from, to];
  if (search) { where.push('e.name LIKE ?'); args.push('%' + search + '%'); }
  if (type === 'up' || type === 'down') { where.push('e.event = ?'); args.push(type); }
  const w = where.join(' AND ');
  const total = db.prepare('SELECT COUNT(*) c FROM events e WHERE ' + w).get(...args).c;
  // for disconnects, 'back' = time of the next reconnect of the same user (may fall after the range end)
  const rows = db.prepare(`SELECT e.ts, e.name, e.event,
      CASE WHEN e.event = 'down' THEN (SELECT MIN(u.ts) FROM events u WHERE u.name = e.name AND u.event = 'up' AND u.id > e.id) END AS back
    FROM events e WHERE ${w} ORDER BY e.ts DESC, e.id DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
  const sum = db.prepare('SELECT event, COUNT(*) c, COUNT(DISTINCT name) u FROM events WHERE ts BETWEEN ? AND ? GROUP BY event').all(from, to);
  return { total, rows: rows.map((r) => ({ ts: r.ts * 1000, name: r.name, event: r.event, back: r.back ? r.back * 1000 : null })),
    summary: Object.fromEntries(sum.map((s) => [s.event, { count: s.c, users: s.u }])) };
}
function flaps({ from, to, search, page, size }) {
  const w = 'ts BETWEEN ? AND ?' + (search ? ' AND name LIKE ?' : '');
  const args = search ? [from, to, '%' + search + '%'] : [from, to];
  const base = `SELECT name, SUM(event = 'down') downs,
      MAX(CASE WHEN event = 'down' THEN ts END) last_down, MAX(CASE WHEN event = 'up' THEN ts END) last_up
    FROM events WHERE ${w} GROUP BY name HAVING downs > 0`;
  const total = db.prepare(`SELECT COUNT(*) c FROM (${base})`).get(...args).c;
  const rows = db.prepare(base + ' ORDER BY downs DESC, last_down DESC LIMIT ? OFFSET ?').all(...args, size, (page - 1) * size);
  const sum = db.prepare(`SELECT COALESCE(SUM(downs),0) c FROM (${base})`).get(...args).c;
  return { total, totalDowns: sum, rows: rows.map((r) => ({ name: r.name, downs: r.downs, lastDown: r.last_down * 1000, lastUp: r.last_up ? r.last_up * 1000 : null })) };
}
function userEvents({ name, from, to }) {
  const rows = db.prepare('SELECT ts, event FROM events WHERE name = ? AND ts BETWEEN ? AND ? ORDER BY ts DESC, id DESC LIMIT 2000').all(name, from, to);
  return rows.map((r) => ({ ts: r.ts * 1000, event: r.event }));
}
function prune() {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400;
  try {
    db.prepare('DELETE FROM samples WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM if_samples WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
  } catch (e) { console.error('[db] prune', e.message); }
}
prune(); setInterval(prune, 6 * 3600 * 1000).unref();
setInterval(flush, SAMPLE_SEC * 1000 + 2000).unref();
process.on('SIGTERM', () => { flush(); process.exit(0); });
process.on('SIGINT', () => { flush(); process.exit(0); });

module.exports = { record, addEvents, history, events, flaps, userEvents, SAMPLE_SEC, RETENTION_DAYS };
