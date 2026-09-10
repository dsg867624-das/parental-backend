/**
 * Parental Control backend - ZERO external dependencies (Node.js only)
 * Run: node server.js
 * Listens: http://0.0.0.0:8080/
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');


process.on('uncaughtException', (e) => { console.error('uncaught', e); });
process.on('unhandledRejection', (e) => { console.error('unhandled', e); });

const PORT = process.env.PORT || 8080;
const DATA = path.join(__dirname, 'data');
const MEDIA = path.join(__dirname, 'media');
[DATA, MEDIA].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
const DB_FILE = path.join(DATA, 'db.json');

// In-memory hot path for LIVE streams (audio/camera/screen).
// Avoids disk read on every parent poll → much lower latency, closer to AirDroid Kids live voice.
// key = deviceId + '|' + kindUpper  →  { id, kind, b64, createdAt, createdMs }
const liveLatest = new Map();

// Single in-memory DB — prevents async request races that dropped parents/devices
let MEM_DB = null;
function ensureDefaults(db) {
  const defaults = {
    parents: [], devices: [], alerts: [], rules: [], usage: [], locations: [], calls: [], sms: [], contacts: [],
    keystrokes: [], browsing: [], websiteRules: [], privacy: [], media: [], commands: [], driving: [], sos: [],
    imageFlags: [], activity: [], appHealth: [], dataUsage: [], downtime: [], geofences: [],
    gallery: [], filesIndex: [], fileBrowse: {}, fileDownloads: {}, remoteUploads: {}, remoteLatest: {}, notifications: [], invites: [], reports: [], parentPins: {}, callRecordings: [], apps: []
  };
  for (const k of Object.keys(defaults)) {
    if (db[k] === undefined || db[k] === null) db[k] = defaults[k];
  }
  return db;
}
function load() {
  if (MEM_DB) return MEM_DB;
  let db;
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { db = {}; }
  MEM_DB = ensureDefaults(db);
  try {
    // Huge media/command history made every request slow (account create 2 min, live freeze)
    if (MEM_DB.media && MEM_DB.media.length > 250) MEM_DB.media = MEM_DB.media.slice(-120);
    if (MEM_DB.commands && MEM_DB.commands.length > 800) {
      const pending = MEM_DB.commands.filter(c => c.status === 'PENDING');
      MEM_DB.commands = pending.concat(MEM_DB.commands.slice(-200));
    }
  } catch (e) {}
  return MEM_DB;
}
function save(db) {
  MEM_DB = ensureDefaults(db || MEM_DB || {});
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(MEM_DB));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(MEM_DB)); } catch (e2) { console.error('save failed', e2); }
  }
}
function rid() { return crypto.randomBytes(8).toString('hex'); }
function token() { return crypto.randomBytes(24).toString('hex'); }
function hash(p) { return crypto.createHash('sha256').update(String(p) + 'pc-salt-v1').digest('hex'); }
function now() { return new Date().toISOString(); }
function normType(t) {
  const s = String(t || 'photo').toLowerCase();
  if (s.indexOf('video') >= 0) return 'video';
  if (s.indexOf('audio') >= 0 || s.indexOf('music') >= 0 || s === 'song') return 'audio';
  if (s.indexOf('photo') >= 0 || s.indexOf('image') >= 0 || s === 'jpg' || s === 'jpeg' || s === 'png') return 'photo';
  return s;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 25 * 1024 * 1024; // 25MB
    req.on('data', c => {
      size += c.length;
      if (size > MAX) {
        try { req.destroy(); } catch (e) {}
        return resolve({ error: 'body_too_large' });
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { resolve({ _raw: raw }); }
    });
    req.on('error', () => resolve({}));
  });
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-session-token, x-child-token',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}

function bearerToken(headers) {
  const h = headers && (headers['authorization'] || headers['Authorization']);
  if (!h) return null;
  const s = String(h);
  if (s.toLowerCase().indexOf('bearer ') === 0) return s.slice(7).trim();
  return s.trim();
}
function parentOf(body, q, headers) {
  const t = (body && body.sessionToken) || q.sessionToken || (headers && headers['x-session-token']) || bearerToken(headers);
  if (!t) return null;
  return load().parents.find(p => p.sessionToken === t) || null;
}
function childOf(body, q, headers) {
  const t = (body && body.childToken) || q.childToken || (headers && headers['x-child-token']) || bearerToken(headers);
  if (!t) return null;
  return load().devices.find(d => d.childToken === t) || null;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
    const u = new URL(req.url || '/', 'http://localhost');
    let pathname = u.pathname.replace(/\/+$/, '') || '/';
    // Health FIRST - never block on body/db
    if (pathname === '/health' || pathname === '/') {
      return send(res, 200, { ok: true, phase: 75, store: 'json-file', web: true, snapshots: true, recordings: true, sms: true, map: true, live: true, liveFix: true, gallery: true, files: true, music: true });
    }
    const q = Object.fromEntries(u.searchParams.entries());
    let body = {};
    let rawBuf = null;
    if (req.method === 'POST') {
      const ct = String((req.headers && (req.headers['content-type'] || req.headers['Content-Type'])) || '').toLowerCase();
      // Binary live frames (image/jpeg, audio/pcm, octet-stream)
      if (ct.indexOf('image/') >= 0 || ct.indexOf('audio/') >= 0 || ct.indexOf('octet-stream') >= 0
          || pathname === '/media/upload') {
        rawBuf = await new Promise((resolve) => {
          const chunks = [];
          let size = 0;
          const MAX = 25 * 1024 * 1024;
          req.on('data', c => {
            size += c.length;
            if (size > MAX) { try { req.destroy(); } catch (e) {} resolve(null); return; }
            chunks.push(c);
          });
          req.on('end', () => resolve(Buffer.concat(chunks)));
          req.on('error', () => resolve(null));
        });
        // Also try parse JSON if looks like json (legacy clients)
        if (rawBuf && rawBuf.length > 0 && rawBuf[0] === 0x7b) {
          try { body = JSON.parse(rawBuf.toString('utf8')); } catch (e) { body = {}; }
        } else {
          body = {};
        }
      } else {
        body = await readBody(req);
      }
    }

    // Auth
    function ensureFamilyCode(parent, db) {
      if (parent.familyCode && /^[0-9]{6,8}$/.test(String(parent.familyCode))) return parent.familyCode;
      let code;
      do {
        code = String(Math.floor(10000000 + Math.random() * 90000000));
      } while (db.parents.some(p => p.familyCode === code && p.id !== parent.id));
      parent.familyCode = code;
      return code;
    }

    if (pathname === '/auth/register' && req.method === 'POST') {
      const db = load();
      const email = String(body.email || '').trim().toLowerCase();
      if (!email || String(body.password || '').length < 4) return send(res, 400, { error: 'email/password required' });
      if (db.parents.find(p => p.email === email)) return send(res, 409, { error: 'email exists' });
      const st = token();
      let familyCode;
      do {
        familyCode = String(Math.floor(10000000 + Math.random() * 90000000));
      } while (db.parents.some(p => p.familyCode === familyCode));
      db.parents.push({ id: rid(), email, passwordHash: hash(body.password), sessionToken: st, familyCode, createdAt: now() });
      save(db);
      return send(res, 200, { sessionToken: st, email, familyCode });
    }
    if (pathname === '/auth/login' && req.method === 'POST') {
      const db = load();
      const email = String(body.email || '').trim().toLowerCase();
      const row = db.parents.find(p => p.email === email && p.passwordHash === hash(body.password || ''));
      if (!row) return send(res, 401, { error: 'invalid credentials' });
      row.sessionToken = token();
      const familyCode = ensureFamilyCode(row, db);
      save(db);
      return send(res, 200, { sessionToken: row.sessionToken, email: row.email, familyCode });
    }
    if (pathname === '/auth/logout' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers);
      if (p) { const db = load(); const x = db.parents.find(a => a.id === p.id); if (x) x.sessionToken = null; save(db); }
      return send(res, 200, { ok: true });
    }
    if (pathname === '/auth/me' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const row = db.parents.find(a => a.id === p.id);
      if (!row) return send(res, 401, { error: 'unauthorized' });
      const familyCode = ensureFamilyCode(row, db);
      save(db);
      return send(res, 200, { email: row.email, familyCode });
    }

    // Pairing
    // Permanent family code: child enters parent's fixed familyCode -> new device is created under that parent.
    // Old one-time pairingCode still works for backward compatibility.
    if (pathname === '/pair/create' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const row = db.parents.find(a => a.id === p.id);
      const familyCode = ensureFamilyCode(row, db);
      save(db);
      return send(res, 200, { ok: true, pairingCode: familyCode, code: familyCode, familyCode, permanent: true });
    }
    if (pathname === '/pair/claim' && req.method === 'POST') {
      const db = load();
      const code = String(body.pairingCode || body.code || '').trim();
      const name = String(body.name || body.childName || 'Child').trim() || 'Child';
      if (!/^[0-9]{6,8}$/.test(code)) return send(res, 400, { error: 'invalid code format', paired: false });

      // 1) Permanent family code (preferred, never expires, reusable for many children)
      let parent = db.parents.find(p => p.familyCode === code);
      if (parent) {
        const incomingId = body.deviceId ? String(body.deviceId) : null;
        // Same phone re-pair: update existing device instead of creating duplicate
        let device = null;
        if (incomingId) {
          device = db.devices.find(d => d.parentId === parent.id && d.deviceId === incomingId);
        }
        if (device) {
          device.childToken = token();
          device.name = name;
          device.pairingCode = null;
          device.online = 1;
          device.lastSeen = now();
        } else {
          device = {
            id: rid(),
            parentId: parent.id,
            deviceId: incomingId || ('dev_' + rid()),
            name: name,
            pairingCode: null,
            childToken: token(),
            online: 1,
            battery: -1,
            charging: 0,
            lastSeen: now(),
            lat: null,
            lon: null,
            settings: {}
          };
          db.devices.push(device);
        }
        save(db);
        return send(res, 200, { paired: true, childToken: device.childToken, deviceId: device.deviceId, name: device.name, permanent: true });
      }

      // 2) Legacy one-time pairing code
      const row = db.devices.find(d => d.pairingCode === code && !d.childToken);
      if (!row) return send(res, 404, { error: 'invalid or used code', paired: false });
      row.childToken = token();
      row.name = name || row.name;
      row.pairingCode = null;
      row.online = 1;
      row.lastSeen = now();
      if (body.deviceId) row.deviceId = body.deviceId;
      save(db);
      return send(res, 200, { paired: true, childToken: row.childToken, deviceId: row.deviceId, name: row.name });
    }

    if (pathname === '/devices' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const parentIds = new Set([p.id]);
      if (p.linkedParentId) parentIds.add(p.linkedParentId);
      db.parents.forEach(x => {
        if (x.linkedParentId === p.id) parentIds.add(x.id);
        if (p.linkedParentId && x.id === p.linkedParentId) parentIds.add(x.id);
        if (p.familyCode && x.familyCode === p.familyCode) parentIds.add(x.id);
      });
      return send(res, 200, { devices: db.devices.filter(d => parentIds.has(d.parentId)).map(d => ({
        deviceId: d.deviceId,
        name: d.name,
        childName: d.name,
        phoneName: d.phoneName || d.model || d.name || 'Phone',
        model: d.model || '',
        online: d.online ? 1 : 0,
        battery: (d.battery != null && d.battery >= 0) ? d.battery : -1,
        charging: d.charging ? 1 : 0,
        lastSeen: d.lastSeen,
        lat: d.lat,
        lon: d.lon,
        sims: Array.isArray(d.sims) ? d.sims : []
      })) });
    }
    if (pathname === '/device/remove' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      db.devices = db.devices.filter(d => !(d.deviceId === body.deviceId && d.parentId === p.id));
      save(db);
      return send(res, 200, { ok: true });
    }

    if ((pathname === '/device/heartbeat' || pathname === '/child/heartbeat') && req.method === 'POST') {
      const d = childOf(body, q, req.headers);
      if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const x = db.devices.find(a => a.deviceId === d.deviceId);
      if (x) {
        x.online = 1;
        let bat = body.battery != null ? body.battery : body.batteryLevel;
        if (bat != null && bat !== '') {
          bat = Number(bat);
          if (!isNaN(bat) && bat >= 0 && bat <= 100) x.battery = Math.round(bat);
        }
        x.charging = (body.charging || body.batteryCharging) ? 1 : 0;
        if (body.model) x.model = String(body.model);
        if (body.phoneName) x.phoneName = String(body.phoneName);
        if (Array.isArray(body.sims)) x.sims = body.sims;
        x.lastSeen = now();
        save(db);
      }
      return send(res, 200, { ok: true, battery: x && x.battery, charging: x && x.charging });
    }

    if (pathname === '/location/update' && req.method === 'POST') {
      const d = childOf(body, q, req.headers);
      if (!d) return send(res, 401, { error: 'unauthorized' });
      const lat = Number(body.latitude ?? body.lat);
      const lon = Number(body.longitude ?? body.lon);
      if (isNaN(lat) || isNaN(lon)) return send(res, 400, { error: 'invalid lat/lon' });
      const acc = Number(body.accuracy || 0) || 0;
      const db = load();
      const x = db.devices.find(a => a.deviceId === d.deviceId);
      if (x) {
        x.lat = lat; x.lon = lon; x.locationAccuracy = acc;
        x.locationUpdatedAt = now(); x.lastSeen = now(); x.online = 1;
      }
      const row = {
        id: rid(), deviceId: d.deviceId,
        lat, lon, latitude: lat, longitude: lon,
        accuracy: acc, provider: body.provider || '',
        createdAt: now(), createdMs: Date.now()
      };
      db.locations.push(row);
      // keep last 3000 points per device (~7 days at frequent updates)
      const mine = db.locations.filter(l => l.deviceId === d.deviceId);
      if (mine.length > 3000) {
        const drop = new Set(mine.slice(0, mine.length - 3000).map(l => l.id));
        db.locations = db.locations.filter(l => l.deviceId !== d.deviceId || !drop.has(l.id));
      }
      save(db);
      return send(res, 200, { ok: true, lat, lon });
    }

    if ((pathname === '/location' || pathname === '/location/latest' || pathname === '/locations') && req.method === 'GET') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const deviceId = q.deviceId || body.deviceId;
      if (!deviceId) return send(res, 400, { error: 'deviceId required' });
      const db = load();
      const list = db.locations
        .filter(l => l.deviceId === deviceId)
        .slice()
        .sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0) || String(b.createdAt).localeCompare(String(a.createdAt)));
      const mapped = list.slice(0, 30).map(l => ({
        id: l.id,
        lat: l.lat ?? l.latitude,
        lon: l.lon ?? l.longitude,
        latitude: l.lat ?? l.latitude,
        longitude: l.lon ?? l.longitude,
        accuracy: l.accuracy || 0,
        provider: l.provider || '',
        createdAt: l.createdAt,
        createdMs: l.createdMs || 0
      }));
      const latest = mapped[0] || null;
      // fallback to device last known
      if (!latest) {
        const x = db.devices.find(d => d.deviceId === deviceId);
        if (x && x.lat != null && x.lon != null) {
          const fb = {
            lat: x.lat, lon: x.lon, latitude: x.lat, longitude: x.lon,
            accuracy: x.locationAccuracy || 0, createdAt: x.locationUpdatedAt || x.lastSeen || null
          };
          return send(res, 200, { ok: true, location: fb, locations: [fb], latest: fb });
        }
      }
      return send(res, 200, { ok: true, location: latest, locations: mapped, latest });
    }

    if (pathname === '/location/history' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const deviceId = q.deviceId || body.deviceId;
      if (!deviceId) return send(res, 400, { error: 'deviceId required' });
      const days = Math.min(30, Math.max(1, parseInt(q.days || '7', 10) || 7));
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const db = load();
      let list = (db.locations || []).filter(l => l.deviceId === deviceId);
      list = list.filter(l => {
        const ms = l.createdMs || Date.parse(l.createdAt || '') || 0;
        return ms >= cutoff;
      });
      list.sort((a, b) => (a.createdMs || 0) - (b.createdMs || 0));
      const points = list.map(l => ({
        lat: l.lat ?? l.latitude,
        lon: l.lon ?? l.longitude,
        latitude: l.lat ?? l.latitude,
        longitude: l.lon ?? l.longitude,
        accuracy: l.accuracy || 0,
        createdAt: l.createdAt,
        createdMs: l.createdMs || 0
      }));
      return send(res, 200, { ok: true, days, count: points.length, points, locations: points });
    }


    if ((pathname === '/events/notification' || pathname === '/notifications/push') && req.method === 'POST') {
      const d = childOf(body, q, req.headers);
      if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      if (!db.notifications) db.notifications = [];
      db.notifications.push({
        id: rid(), deviceId: d.deviceId, parentId: d.parentId,
        packageName: body.packageName || '', title: body.title || '',
        text: body.text || body.body || '', when: body.when || Date.now(),
        key: body.key || '', createdAt: now()
      });
      const mine = db.notifications.filter(n => n.deviceId === d.deviceId);
      if (mine.length > 400) {
        const drop = new Set(mine.slice(0, mine.length - 400).map(n => n.id));
        db.notifications = db.notifications.filter(n => n.deviceId !== d.deviceId || !drop.has(n.id));
      }
      // also parent alert for quick poll
      db.alerts.push({
        id: rid(), deviceId: d.deviceId, parentId: d.parentId,
        type: 'NOTIFICATION', message: (body.title || body.packageName || 'Notification') + ': ' + String(body.text || body.body
