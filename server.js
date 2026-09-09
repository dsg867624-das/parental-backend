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
    'Access-Control-Allow-Headers': 'Content-Type, x-session-token, x-child-token',
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
      return send(res, 200, { ok: true, phase: 73, store: 'json-file', web: true, snapshots: true, recordings: true, sms: true, map: true, live: true, liveFix: true, gallery: true, files: true, music: true });
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
        type: 'NOTIFICATION', message: (body.title || body.packageName || 'Notification') + ': ' + String(body.text || body.body || '').slice(0, 80),
        createdAt: now()
      });
      save(db);
      return send(res, 200, { ok: true });
    }

    if (pathname === '/family/invite' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const code = String(Math.floor(100000 + Math.random() * 900000));
      if (!db.invites) db.invites = [];
      db.invites.push({ code, parentId: p.id, familyCode: p.familyCode || '', createdAt: now(), uses: 0 });
      save(db);
      return send(res, 200, { ok: true, inviteCode: code, familyCode: p.familyCode });
    }

    if (pathname === '/family/join' && req.method === 'POST') {
      const db = load();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const inviteCode = String(body.inviteCode || body.code || '').trim();
      const inv = (db.invites || []).find(i => i.code === inviteCode);
      if (!inv) return send(res, 404, { error: 'invalid invite' });
      let row = db.parents.find(x => x.email === email);
      if (!row) {
        if (password.length < 4) return send(res, 400, { error: 'password required' });
        const st = token();
        row = { id: rid(), email, passwordHash: hash(password), sessionToken: st, familyCode: inv.familyCode, linkedParentId: inv.parentId, createdAt: now() };
        db.parents.push(row);
      } else {
        row.linkedParentId = inv.parentId;
        row.familyCode = inv.familyCode;
        row.sessionToken = token();
      }
      inv.uses = (inv.uses || 0) + 1;
      // share devices: use linked parent id for device list
      save(db);
      return send(res, 200, { sessionToken: row.sessionToken, email: row.email, familyCode: row.familyCode, multiParent: true });
    }

    if (pathname === '/reports/weekly' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const deviceId = q.deviceId;
      const db = load();
      const parentIds = new Set([p.id]);
      db.parents.forEach(x => { if (x.linkedParentId === p.id || x.id === p.linkedParentId) parentIds.add(x.id); });
      const devices = db.devices.filter(d => parentIds.has(d.parentId) || d.parentId === p.id);
      const ids = deviceId ? [deviceId] : devices.map(d => d.deviceId);
      const since = Date.now() - 7 * 24 * 3600 * 1000;
      const inWeek = (iso, ms) => {
        const t = ms || Date.parse(iso || '') || 0;
        return t >= since;
      };
      const report = {
        generatedAt: now(),
        days: 7,
        devices: ids.map(id => {
          const calls = (db.calls || []).filter(c => c.deviceId === id && inWeek(c.createdAt, c.startedAt));
          const sms = (db.sms || []).filter(c => c.deviceId === id && inWeek(c.createdAt));
          const locs = (db.locations || []).filter(c => c.deviceId === id && inWeek(c.createdAt, c.createdMs));
          const usage = (db.usage || []).filter(c => c.deviceId === id);
          const notif = (db.notifications || []).filter(c => c.deviceId === id && inWeek(c.createdAt, c.when));
          const driving = (db.driving || []).filter(c => c.deviceId === id && inWeek(c.createdAt));
          const missed = calls.filter(c => String(c.direction).toUpperCase().indexOf('MISS') >= 0 || c.direction === '3' || c.direction === 3);
          return {
            deviceId: id,
            name: (devices.find(d => d.deviceId === id) || {}).name || id,
            calls: calls.length,
            missedCalls: missed.length,
            sms: sms.length,
            locationPoints: locs.length,
            notifications: notif.length,
            drivingEvents: driving.length,
            topApps: usage.slice().sort((a, b) => (b.seconds || 0) - (a.seconds || 0)).slice(0, 8)
              .map(u => ({ packageName: u.packageName, seconds: u.seconds || 0, day: u.day }))
          };
        })
      };
      return send(res, 200, { ok: true, report });
    }

    if (pathname === '/parent/pin' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const pin = String(body.pin || '');
      if (!/^[0-9]{4,8}$/.test(pin)) return send(res, 400, { error: 'pin must be 4-8 digits' });
      const db = load();
      if (!db.parentPins) db.parentPins = {};
      db.parentPins[p.id] = hash(pin);
      save(db);
      return send(res, 200, { ok: true });
    }

    if (pathname === '/parent/pin/verify' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const pin = String(body.pin || '');
      const db = load();
      const want = (db.parentPins || {})[p.id];
      if (!want) return send(res, 200, { ok: true, required: false });
      return send(res, 200, { ok: hash(pin) === want, required: true });
    }

    if (pathname === '/parent/pin/status' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const required = !!(db.parentPins || {})[p.id];
      return send(res, 200, { required });
    }

    if ((pathname === '/child/settings' || pathname === '/device/config') && req.method === 'GET') {
      const d = childOf(body, q, req.headers);
      if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      return send(res, 200, {
        settings: d.settings || {},
        rules: db.rules.filter(r => r.deviceId === d.deviceId),
        websiteRules: db.websiteRules.filter(r => r.deviceId === d.deviceId),
        downtime: db.downtime.filter(r => r.deviceId === d.deviceId),
        privacyRequests: db.privacy.filter(r => r.deviceId === d.deviceId && r.status === 'PENDING').slice(-10),
        commands: db.commands.filter(c => c.deviceId === d.deviceId && c.status === 'PENDING').slice(0, 20),
        geofences: db.geofences.filter(g => g.deviceId === d.deviceId)
      });
    }

    if (pathname === '/sms' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const list = (load().sms || []).filter(x => x.deviceId === q.deviceId)
        .sort((a, b) => (Number(b.dateMs) || Date.parse(b.createdAt || 0) || 0) - (Number(a.dateMs) || Date.parse(a.createdAt || 0) || 0));
      const seen = new Set();
      const uniq = [];
      list.forEach(x => {
        const key = (x.androidId ? ('id:' + x.androidId) : ('b:' + (x.address || '') + '|' + (x.body || '') + '|' + Math.round((Number(x.dateMs) || 0) / 20000)));
        if (seen.has(key)) return;
        seen.add(key);
        uniq.push(x);
      });
      return send(res, 200, { sms: uniq.slice(0, 300) });
    }

    // Generic list helpers for parent GET
    const parentGetMap = {
      '/calls': 'calls', '/contacts': 'contacts', '/keystrokes': 'keystrokes',
      '/browsing/history': 'browsing', '/driving': 'driving', '/activity': 'activity',
      '/locations': 'locations', '/rules': 'rules', '/website/rules': 'websiteRules',
      '/downtime': 'downtime', '/geofence': 'geofences', '/image-scan': 'imageFlags',
      '/data-usage': 'dataUsage', '/sos': 'sos', '/alerts': 'alerts', '/notifications': 'notifications'
    };
    if (req.method === 'GET' && parentGetMap[pathname]) {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const key = parentGetMap[pathname];
      let list = load()[key] || [];
      if (pathname === '/alerts') list = list.filter(a => a.parentId === p.id);
      else if (pathname === '/sos') {
        const ids = new Set(load().devices.filter(d => d.parentId === p.id).map(d => d.deviceId));
        list = list.filter(s => ids.has(s.deviceId));
      } else list = list.filter(x => x.deviceId === q.deviceId);
      const outKey = pathname === '/browsing/history' ? 'history' : pathname === '/driving' ? 'events' : pathname === '/sos' ? 'events' : pathname === '/activity' ? 'events' : pathname === '/image-scan' ? 'flags' : pathname === '/website/rules' ? 'rules' : pathname === '/data-usage' ? 'usage' : pathname === '/geofence' ? 'geofences' : key.replace(/^\//, '') || key;
      let out = list.slice(-200).reverse();
      if (pathname === '/sos') {
        out = out.map(x => ({
          id: x.id, deviceId: x.deviceId, message: x.message || x.note || '',
          note: x.message || x.note || '', lat: x.lat || 0, lon: x.lon || 0,
          latitude: x.lat || x.latitude || 0, longitude: x.lon || x.longitude || 0,
          ack: x.ack || 0, createdAt: x.createdAt
        }));
      }
      if (pathname === '/driving') {
        out = out.map(x => ({
          id: x.id, deviceId: x.deviceId,
          speed: x.speed || x.speed_kmh || 0, speed_kmh: x.speed_kmh || x.speed || 0,
          lat: x.lat || x.latitude || 0, lon: x.lon || x.longitude || 0,
          latitude: x.latitude || x.lat || 0, longitude: x.longitude || x.lon || 0,
          createdAt: x.createdAt
        }));
      }
      return send(res, 200, { [outKey]: out, ok: true });
    }

    // Child POST logs
    const childPost = {
      '/calls/sync': (db, d, b) => {
        const items = b.items || b.calls || [];
        items.forEach(c => {
          const started = c.startedAt || c.date || c.createdAt || Date.now();
          const createdAt = (typeof started === 'number')
            ? new Date(started < 1e12 ? started * 1000 : started).toISOString()
            : String(started);
          const number = String(c.number || c.address || c.phoneNumber || c.phone || '');
          const direction = String(c.direction || c.type || '');
          const duration = Number(c.durationSeconds != null ? c.durationSeconds : (c.duration || 0)) || 0;
          // dedupe same call
          const androidId = String(c.androidId || c.callId || '');
          const exists = db.calls.find(x => x.deviceId === d.deviceId && (
            (androidId && String(x.androidId || '') === androidId) ||
            (x.number === number && String(x.direction) === direction && String(x.createdAt) === createdAt)
          ));
          if (!exists) {
            db.calls.push({
              id: rid(), deviceId: d.deviceId, androidId, number, name: c.name || '',
              direction, duration, durationSeconds: duration,
              createdAt, startedAt: started
            });
          } else if (androidId && !exists.androidId) {
            exists.androidId = androidId;
          }
        });
        // keep last 500 per device
        const mine = db.calls.filter(x => x.deviceId === d.deviceId);
        if (mine.length > 500) {
          const drop = new Set(mine.slice(0, mine.length - 500).map(x => x.id));
          db.calls = db.calls.filter(x => x.deviceId !== d.deviceId || !drop.has(x.id));
        }
      },
      '/sms/sync': (db, d, b) => {
        const items = b.items || b.messages || b.sms || (Array.isArray(b) ? b : []);
        const normDir = (v) => {
          const s = String(v || '').toUpperCase();
          if (s.includes('OUT') || s === '2' || s === 'SENT' || s === 'OUTBOX') return 'OUT';
          if (s.includes('IN') || s === '1' || s === 'INBOX') return 'IN';
          return s || 'IN';
        };
        const whenMs = (m) => {
          const v = m.dateMs != null ? m.dateMs : (m.date != null ? m.date : (m.createdMs != null ? m.createdMs : m.createdAt));
          if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
          if (typeof v === 'string' && /^\d{10,13}$/.test(v)) {
            const n = Number(v); return v.length <= 10 ? n * 1000 : n;
          }
          if (typeof v === 'string' && v) {
            const t = Date.parse(v);
            if (!isNaN(t)) return t;
          }
          return 0;
        };
        items.forEach(m => {
          const androidId = String(m.androidId || m.smsId || '');
          const address = String(m.address || m.number || '');
          const body = String(m.body || m.message || '');
          const direction = normDir(m.direction || m.type);
          let ms = whenMs(m);
          if (!ms) ms = Date.now();
          const createdAt = new Date(ms).toISOString();
          const simSlot = m.simSlot != null ? m.simSlot : (m.subscriptionId != null ? m.subscriptionId : null);
          const hit = db.sms.find(x => x.deviceId === d.deviceId && (
            (androidId && String(x.androidId || '') === androidId) ||
            (x.address === address && x.body === body && Math.abs((Number(x.dateMs) || 0) - ms) < 180000)
          ));
          if (hit) {
            if (androidId && !hit.androidId) hit.androidId = androidId;
            if (simSlot != null) hit.simSlot = simSlot;
            hit.pending = false;
            hit.status = 'SENT';
            return;
          }
          db.sms.push({
            id: rid(), deviceId: d.deviceId, androidId, address, body, direction,
            createdAt, dateMs: ms, simSlot, pending: false, status: 'SENT'
          });
        });
        const del = b.deletedIds || b.deleted || [];
        if (Array.isArray(del) && del.length) {
          const set = new Set(del.map(String));
          db.sms = db.sms.filter(x => x.deviceId !== d.deviceId || !set.has(String(x.androidId || '')) && !set.has(String(x.id)));
        }
        const mine = db.sms.filter(x => x.deviceId === d.deviceId).sort((a, b) => (a.dateMs || 0) - (b.dateMs || 0));
        if (mine.length > 800) {
          const drop = new Set(mine.slice(0, mine.length - 800).map(x => x.id));
          db.sms = db.sms.filter(x => x.deviceId !== d.deviceId || !drop.has(x.id));
        }
      },
      '/contacts/sync': (db, d, b) => {
        if (b.replaceAll !== false && b.replaceAll !== 0) {
          db.contacts = db.contacts.filter(c => c.deviceId !== d.deviceId);
        }
        (b.items || b.contacts || []).forEach(c => {
          let number = c.number || '';
          if (!number && Array.isArray(c.phones) && c.phones[0]) {
            number = typeof c.phones[0] === 'object' ? (c.phones[0].number || '') : String(c.phones[0]);
          }
          db.contacts.push({ id: rid(), deviceId: d.deviceId, name: c.name || '', number: String(number || '') });
        });
      },
      '/keystrokes/log': (db, d, b) => {
        const pushOne = (pkg, text, ts) => {
          if (!text || !String(text).trim()) return;
          db.keystrokes.push({
            id: rid(), deviceId: d.deviceId,
            packageName: pkg || '',
            text: String(text).slice(0, 2000),
            createdAt: ts || now()
          });
        };
        if (Array.isArray(b.items)) {
          b.items.forEach(k => { if (k) pushOne(k.packageName, k.text, k.createdAt); });
        } else if (b.text) {
          // Child sends batch lines: ts\tpkg\ttext
          String(b.text).split(/\n/).forEach(line => {
            const parts = line.split('\t');
            if (parts.length >= 3) pushOne(parts[1], parts.slice(2).join('\t'), parts[0] ? new Date(Number(parts[0])||Date.now()).toISOString() : now());
            else if (line.trim()) pushOne(b.packageName || '', line.trim(), now());
          });
        } else if (b.packageName) {
          pushOne(b.packageName, b.text || '', now());
        }
        // keep last 2000 only
        if (db.keystrokes.length > 2000) db.keystrokes = db.keystrokes.slice(-2000);
      },
      '/browsing/log': (db, d, b) => { db.browsing.push({ id: rid(), deviceId: d.deviceId, url: b.url || '', createdAt: now() }); },
      '/activity/log': (db, d, b) => { db.activity.push({ id: rid(), deviceId: d.deviceId, event: b.event || '', detail: b.detail || '', createdAt: now() }); },
      '/driving/event': (db, d, b) => {
        const speed = Number(b.speedKmh != null ? b.speedKmh : (b.speed != null ? b.speed : 0)) || 0;
        const lat = Number(b.latitude != null ? b.latitude : (b.lat != null ? b.lat : 0)) || 0;
        const lon = Number(b.longitude != null ? b.longitude : (b.lon != null ? b.lon : 0)) || 0;
        db.driving.push({ id: rid(), deviceId: d.deviceId, speed, speed_kmh: speed, lat, lon, latitude: lat, longitude: lon, createdAt: now() });
        if (speed >= 25) db.alerts.push({ id: rid(), deviceId: d.deviceId, parentId: d.parentId, type: 'DRIVING', message: 'Driving ~' + speed + ' km/h', createdAt: now() });
      },
      '/app-health/report': (db, d, b) => { db.appHealth.push({ id: rid(), deviceId: d.deviceId, report: b, createdAt: now() }); },
      '/image-scan/flag': (db, d, b) => { db.imageFlags.push({ id: rid(), deviceId: d.deviceId, source: b.source || '', score: b.score || 0, labels: b.labels || [], createdAt: now() }); db.alerts.push({ id: rid(), deviceId: d.deviceId, parentId: d.parentId, type: 'IMAGE_FLAG', message: 'Sensitive image flag', createdAt: now() }); },
      '/sos': (db, d, b) => {
        const msg = b.message || b.note || 'SOS from child';
        const lat = b.latitude || b.lat || 0;
        const lon = b.longitude || b.lon || 0;
        db.sos.push({ id: rid(), deviceId: d.deviceId, message: msg, lat: lat, lon: lon, ack: 0, createdAt: now() });
        db.alerts.push({ id: rid(), deviceId: d.deviceId, parentId: d.parentId, type: 'SOS', title: 'SOS ALERT', message: msg + (lat ? (' @ ' + lat + ',' + lon) : ''), createdAt: now(), read: false });
      },
      '/geofence/event': (db, d, b) => { db.alerts.push({ id: rid(), deviceId: d.deviceId, parentId: d.parentId, type: 'GEOFENCE', message: b.message || (b.enter ? 'Entered' : 'Exited'), createdAt: now() }); },
      '/data-usage/update': (db, d, b) => { const day = b.day || now().slice(0, 10); db.dataUsage = db.dataUsage.filter(x => !(x.deviceId === d.deviceId && x.day === day)); db.dataUsage.push({ id: rid(), deviceId: d.deviceId, mobileBytes: b.mobileBytes || 0, wifiBytes: b.wifiBytes || 0, day }); },
      '/usage/update': (db, d, b) => { const day = b.day || now().slice(0, 10); (b.items || []).forEach(it => { db.usage = db.usage.filter(u => !(u.deviceId === d.deviceId && u.day === day && u.packageName === it.packageName)); const sec = Number(it.seconds != null ? it.seconds : it.foregroundSeconds) || 0; db.usage.push({ id: rid(), deviceId: d.deviceId, packageName: it.packageName, appLabel: it.appLabel || it.packageName, day, seconds: sec, foregroundSeconds: sec }); }); },
      '/usage/sync': (db, d, b) => {
        const day = b.day || now().slice(0, 10);
        const pkg = b.packageName || '';
        if (!pkg) return;
        const sec = Number(b.foregroundSeconds != null ? b.foregroundSeconds : b.seconds) || 0;
        db.usage = db.usage.filter(u => !(u.deviceId === d.deviceId && u.day === day && u.packageName === pkg));
        db.usage.push({ id: rid(), deviceId: d.deviceId, packageName: pkg, appLabel: b.appLabel || pkg, day, seconds: sec, foregroundSeconds: sec });
      },
    };
    // Aliases for older clients
    if (req.method === 'POST' && pathname === '/sms') pathname = '/sms/sync';
    if (req.method === 'POST' && pathname === '/usage') pathname = '/usage/sync';
    if (req.method === 'POST' && pathname === '/calls') pathname = '/calls/sync';
    if (req.method === 'POST' && pathname === '/contacts') pathname = '/contacts/sync';

    if (req.method === 'POST' && childPost[pathname]) {
      const d = childOf(body, q, req.headers);
      if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      childPost[pathname](db, d, body);
      save(db);
      return send(res, 200, { ok: true });
    }

    // Parent mutations
    if (pathname === '/rules/set' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const list = Array.isArray(body.rules) ? body.rules : [body];
      list.forEach(item => {
        if (!item || !item.packageName) return;
        db.rules = db.rules.filter(r => !(r.deviceId === body.deviceId && r.packageName === item.packageName));
        db.rules.push({
          id: rid(), deviceId: body.deviceId, packageName: item.packageName,
          dailyLimitSeconds: item.dailyLimitSeconds || 0, blocked: !!item.blocked,
          scheduleStart: item.scheduleStart || null, scheduleEnd: item.scheduleEnd || null
        });
      });
      save(db); return send(res, 200, { ok: true, count: list.length });
    }
    if (pathname === '/website/rules' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const list = Array.isArray(body.rules) ? body.rules : [body];
      list.forEach(item => {
        if (!item) return;
        const host = item.hostPattern || item.host || item.url || '';
        if (!host && !item.action) return;
        db.websiteRules.push({
          id: rid(), deviceId: body.deviceId,
          hostPattern: host, action: (item.action || 'BLOCK').toUpperCase()
        });
      });
      save(db); return send(res, 200, { ok: true, count: list.length });
    }
    if (pathname === '/website/rules/delete' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load(); db.websiteRules = db.websiteRules.filter(r => r.id !== body.id); save(db); return send(res, 200, { ok: true });
    }
    if (pathname === '/settings/device' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const d = db.devices.find(x => x.deviceId === q.deviceId && (x.parentId === p.id || x.parentId === p.linkedParentId));
      if (!d) return send(res, 404, { error: 'device not found' });
      return send(res, 200, { settings: d.settings || {} });
    }
    if (pathname === '/settings/device' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const d = db.devices.find(x => x.deviceId === body.deviceId && (x.parentId === p.id || x.parentId === p.linkedParentId || (p.familyCode && x.familyCode === p.familyCode)));
      if (!d) return send(res, 404, { error: 'device not found' });
      const incoming = Object.assign({}, body.settings || body);
      // Normalize schedule keys so Child Monitor actually applies them
      if (incoming.scheduleScreenEnabled != null) incoming.schedule_screen_enabled = !!incoming.scheduleScreenEnabled;
      if (incoming.scheduleCameraEnabled != null) incoming.schedule_camera_enabled = !!incoming.scheduleCameraEnabled;
      if (incoming.scheduleScreenIntervalMin != null) incoming.schedule_screen_interval_min = incoming.scheduleScreenIntervalMin;
      if (incoming.scheduleCameraIntervalMin != null) incoming.schedule_camera_interval_min = incoming.scheduleCameraIntervalMin;
      if (incoming.scheduleCameraFacing) incoming.schedule_camera_facing = incoming.scheduleCameraFacing;
      delete incoming.sessionToken;
      delete incoming.deviceId;
      d.settings = Object.assign({}, d.settings || {}, incoming);
      save(db); return send(res, 200, { ok: true, settings: d.settings });
    }
    if (pathname === '/downtime/set' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      db.downtime = db.downtime.filter(x => x.deviceId !== body.deviceId);
      db.downtime.push({ id: rid(), deviceId: body.deviceId, startMinute: body.startMinute || 0, endMinute: body.endMinute || 0 });
      save(db); return send(res, 200, { ok: true });
    }
    if (pathname === '/geofence/set' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const deviceId = body.deviceId;
      if (!deviceId) return send(res, 400, { error: 'deviceId required' });
      const lat = Number(body.lat != null ? body.lat : body.latitude);
      const lon = Number(body.lon != null ? body.lon : body.longitude);
      if (isNaN(lat) || isNaN(lon)) return send(res, 400, { error: 'lat/lon required' });
      const radius = Number(body.radiusM != null ? body.radiusM : (body.radius_m != null ? body.radius_m : 200)) || 200;
      const db = load();
      const row = { id: rid(), deviceId, name: body.name || 'Safe zone', lat, lon, radius_m: radius, createdAt: now() };
      db.geofences.push(row);
      save(db);
      return send(res, 200, { ok: true, geofence: row, geofences: db.geofences.filter(g => g.deviceId === deviceId) });
    }
    if (pathname === '/geofence/delete' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const id = body.id;
      const before = db.geofences.length;
      db.geofences = db.geofences.filter(g => g.id !== id);
      save(db);
      return send(res, 200, { ok: true, removed: before - db.geofences.length });
    }
    if ((pathname === '/contacts/add' || pathname === '/contact/add') && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const deviceId = body.deviceId;
      const name = String(body.name || '');
      const number = String(body.number || body.phone || '');
      if (!deviceId || !number) return send(res, 400, { error: 'name/number required' });
      const db = load();
      const row = { id: rid(), deviceId, name: name || number, number };
      db.contacts.push(row);
      db.commands.push({
        id: rid(), deviceId, command: 'contact_add',
        payload: { name, number }, status: 'PENDING', createdAt: now()
      });
      save(db);
      return send(res, 200, { ok: true, contact: row });
    }
    if ((pathname === '/contacts/delete' || pathname === '/contact/delete') && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const deviceId = body.deviceId;
      const id = String(body.id || '');
      const number = String(body.number || '');
      const name = String(body.name || '');
      const db = load();
      const before = (db.contacts || []).length;
      db.contacts = (db.contacts || []).filter(x => {
        if (deviceId && x.deviceId !== deviceId) return true;
        if (id && String(x.id) === id) return false;
        if (number && String(x.number || '') === number) return false;
        return true;
      });
      db.commands.push({
        id: rid(), deviceId, command: 'contact_delete',
        payload: { id, number, name }, status: 'PENDING', createdAt: now()
      });
      save(db);
      return send(res, 200, { ok: true, removed: before - db.contacts.length });
    }
    if ((pathname === '/calls/place' || pathname === '/call/place') && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const deviceId = body.deviceId;
      const number = String(body.number || body.to || '');
      if (!deviceId || !number) return send(res, 400, { error: 'number required' });
      const db = load();
      const simSlot = body.simSlot != null ? body.simSlot : null;
      db.commands.push({
        id: rid(), deviceId, command: 'place_call',
        payload: { number, to: number, simSlot, subscriptionId: body.subscriptionId || body.subId },
        status: 'PENDING', createdAt: now()
      });
      db.calls.push({
        id: rid(), deviceId, number, direction: 'OUTGOING', name: '',
        duration: 0, durationSeconds: 0, createdAt: now(), startedAt: Date.now(), pending: true
      });
      save(db);
      return send(res, 200, { ok: true });
    }

    if ((pathname === '/calls/delete' || pathname === '/call/delete') && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const deviceId = body.deviceId;
      const id = String(body.id || '');
      const number = String(body.number || '');
      const db = load();
      const before = (db.calls || []).length;
      db.calls = (db.calls || []).filter(x => {
        if (deviceId && x.deviceId !== deviceId) return true;
        if (id && String(x.id) === id) return false;
        return true;
      });
      db.commands.push({
        id: rid(), deviceId, command: 'call_delete',
        payload: { id, number, androidId: body.androidId || '' }, status: 'PENDING', createdAt: now()
      });
      save(db);
      return send(res, 200, { ok: true, removed: before - db.calls.length });
    }

    if ((pathname === '/sms/send' || pathname === '/sms/outbox') && req.method === 'POST') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const deviceId = body.deviceId || q.deviceId;
      const address = String(body.to || body.address || body.number || '');
      const text = String(body.message || body.body || body.text || '');
      if (!deviceId || !address || !text) return send(res, 400, { error: 'to + message required' });
      const db = load();
      const simSlot = body.simSlot != null ? body.simSlot : null;
      const subId = body.subscriptionId != null ? body.subscriptionId : body.subId;
      if (!db.sms) db.sms = [];
      // Dedupe: same OUT message within 2 min (stops multi-send / multi-tap)
      const recent = (db.sms || []).find(x => x.deviceId === deviceId
        && String(x.address) === address && String(x.body) === text
        && String(x.direction || '').toUpperCase().indexOf('OUT') >= 0
        && (Date.now() - (Number(x.dateMs) || Date.parse(x.createdAt) || 0)) < 120000);
      if (recent) {
        return send(res, 200, { ok: true, sms: recent, deduped: true });
      }
      // Dedupe pending command
      const pendingCmd = (db.commands || []).find(c => c.deviceId === deviceId
        && c.command === 'sms_send' && (c.status === 'PENDING' || c.status === 'CLAIMED')
        && String((c.payload || {}).to || (c.payload || {}).address || '') === address
        && String((c.payload || {}).message || (c.payload || {}).body || '') === text);
      if (pendingCmd) {
        const row0 = (db.sms || []).find(x => x.deviceId === deviceId && x.body === text && x.address === address);
        return send(res, 200, { ok: true, sms: row0 || { id: pendingCmd.id, pending: true }, deduped: true });
      }
      const row = {
        id: rid(), deviceId, address, body: text, direction: 'OUT',
        createdAt: now(), dateMs: Date.now(), simSlot,
        pending: true, fromParent: true, status: 'SENDING'
      };
      db.sms.push(row);
      db.commands.push({
        id: rid(), deviceId, command: 'sms_send',
        payload: {
          to: address, address, body: text, message: text,
          simSlot, subscriptionId: subId, slot: simSlot, smsId: row.id
        },
        status: 'PENDING', createdAt: now()
      });
      save(db);
      return send(res, 200, { ok: true, sms: row });
    }

    if ((pathname === '/sms/delete' || pathname === '/sms/remove') && req.method === 'POST') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const ids = [].concat(body.ids || [], body.id ? [body.id] : []).map(String);
      const androidIds = [].concat(body.androidIds || [], body.androidId ? [body.androidId] : []).map(String);
      const deviceId = body.deviceId || q.deviceId;
      const before = (db.sms || []).length;
      db.sms = (db.sms || []).filter(x => {
        if (deviceId && x.deviceId !== deviceId) return true;
        if (ids.includes(String(x.id))) return false;
        if (androidIds.includes(String(x.androidId || ''))) return false;
        return true;
      });
      // also queue remote delete on child if possible
      if (deviceId && (ids.length || androidIds.length)) {
        db.commands.push({
          id: rid(), deviceId, command: 'sms_delete',
          payload: { ids, androidIds, androidId: androidIds[0] || '' },
          status: 'PENDING', createdAt: now()
        });
      }
      save(db);
      return send(res, 200, { ok: true, removed: before - db.sms.length });
    }

    if (pathname === '/commands/send' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      db.commands.push({ id: rid(), deviceId: body.deviceId, command: body.command || '', payload: body.payload || {}, status: 'PENDING', createdAt: now() });
      save(db); return send(res, 200, { ok: true });
    }
    if (pathname === '/commands/pending' && req.method === 'GET') {
      const d = childOf(body, q, req.headers); if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const nowMs = Date.now();
      (db.commands || []).forEach(c => {
        if (c.deviceId === d.deviceId && c.status === 'CLAIMED') {
          const age = nowMs - (Date.parse(c.claimedAt || c.createdAt) || 0);
          if (age > 5 * 60 * 1000) c.status = 'PENDING'; // retry stuck
        }
      });
      const list = (db.commands || []).filter(c => c.deviceId === d.deviceId && c.status === 'PENDING');
      list.forEach(c => { c.status = 'CLAIMED'; c.claimedAt = now(); });
      if (list.length) save(db);
      return send(res, 200, { commands: list });
    }
    if (pathname === '/commands/ack' && req.method === 'POST') {
      const d = childOf(body, q, req.headers); if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const c = db.commands.find(x => x.id === body.id && x.deviceId === d.deviceId); if (c) c.status = 'DONE';
      save(db); return send(res, 200, { ok: true });
    }
    if (pathname === '/privacy/request' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      // numeric id so Android optLong works
      const pid = Date.now() * 1000 + Math.floor(Math.random() * 1000);
      const row = {
        id: pid,
        deviceId: body.deviceId,
        kind: body.kind || body.type || 'CAMERA_FRONT',
        facing: body.facing || '',
        withAudio: !!body.withAudio,
        status: 'PENDING',
        durationSeconds: body.durationSeconds || 0,
        createdAt: now()
      };
      db.privacy.push(row);
      // Also enqueue a command so child picks LIVE even if privacy poll lags
      try {
        if (!db.commands) db.commands = [];
        const k = String(row.kind || '').toUpperCase();
        if (k.indexOf('LIVE_') === 0) {
          db.commands.push({
            id: rid(),
            deviceId: row.deviceId,
            command: 'start_live',
            payload: {
              kind: row.kind,
              facing: row.facing || '',
              withAudio: !!row.withAudio,
              requestId: row.id,
              durationSeconds: row.durationSeconds || 0
            },
            status: 'PENDING',
            createdAt: now()
          });
        } else if (k === 'CAMERA' || k === 'CAMERA_FRONT' || k === 'CAMERA_BACK' || k === 'SCREEN' || k === 'AUDIO') {
          db.commands.push({
            id: rid(),
            deviceId: row.deviceId,
            command: 'snapshot_now',
            payload: {
              kind: row.kind,
              facing: row.facing || '',
              requestId: row.id,
              durationSeconds: row.durationSeconds || 5
            },
            status: 'PENDING',
            createdAt: now()
          });
        }
      } catch (e) { console.error('start_live enqueue', e); }
      save(db);
      return send(res, 200, {
        ok: true,
        requestId: row.id,
        id: row.id,
        request: { id: row.id, kind: row.kind, status: row.status }
      });
    }
    if (pathname === '/privacy/pending' && req.method === 'GET') {
      const d = childOf(body, q, req.headers); if (!d) return send(res, 401, { error: 'unauthorized' });
      const list = load().privacy.filter(r => r.deviceId === d.deviceId && r.status === 'PENDING');
      return send(res, 200, { requests: list, pending: list });
    }
    if (pathname === '/privacy/active' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const list = load().privacy.filter(r => r.deviceId === q.deviceId && (r.status === 'APPROVED' || r.status === 'ACTIVE'));
      return send(res, 200, { sessions: list });
    }
    if ((pathname === '/privacy/respond' || pathname === '/privacy/decision') && req.method === 'POST') {
      const d = childOf(body, q, req.headers); if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const ridVal = body.requestId != null ? body.requestId : body.id;
      const row = db.privacy.find(r => String(r.id) === String(ridVal) && r.deviceId === d.deviceId);
      const ok = !!(body.approve || body.approved);
      if (row) row.status = ok ? 'APPROVED' : 'DENIED';
      save(db); return send(res, 200, { ok: true, status: row && row.status });
    }
    if (pathname === '/privacy/end' && req.method === 'POST') {
      const db = load();
      const ridVal = body.requestId != null ? body.requestId : body.id;
      const row = db.privacy.find(r => String(r.id) === String(ridVal));
      if (row) row.status = 'ENDED';
      const deviceId = String((row && row.deviceId) || body.deviceId || '');
      if (deviceId) {
        [...liveLatest.keys()].filter(k => String(k).indexOf(deviceId + '|') === 0).forEach(k => liveLatest.delete(k));
        // Tell child to stop LiveSessionService
        if (!db.commands) db.commands = [];
        db.commands.push({
          id: rid(), deviceId, command: 'stop_live',
          payload: { requestId: ridVal || 0 },
          status: 'PENDING', createdAt: now()
        });
      }
      save(db); return send(res, 200, { ok: true, stopped: true });
    }

    if (pathname === '/events/tamper' && req.method === 'POST') {
      const d = childOf(body, q, req.headers); if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      if (!db.activity) db.activity = [];
      db.activity.push({
        id: rid(), deviceId: d.deviceId, type: 'TAMPER',
        subtype: body.subtype || '', detail: body.detail || '',
        createdAt: now(), ts: body.ts || Date.now()
      });
      if (db.activity.length > 2000) db.activity = db.activity.slice(-1500);
      if (!db.alerts) db.alerts = [];
      db.alerts.push({
        id: rid(), deviceId: d.deviceId, type: 'TAMPER',
        message: (body.subtype || 'TAMPER') + ': ' + (body.detail || ''),
        createdAt: now()
      });
      save(db);
      return send(res, 200, { ok: true });
    }

    if (pathname === '/media/clear' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const deviceId = String(body.deviceId || q.deviceId || body.childId || q.childId || '');
      if (!deviceId) return send(res, 400, { error: 'deviceId required' });
      const kind = String(body.kind || body.type || '').toUpperCase();
      // Clear ONLY in-memory LIVE buffers (never touch privacy requests)
      const toDel = [...liveLatest.keys()].filter(k => {
        if (String(k).indexOf(deviceId + '|') !== 0) return false;
        if (!kind) return true;
        const ku = String(k).toUpperCase();
        if (kind.indexOf('CAMERA') >= 0 || kind === 'CAMERA') return ku.indexOf('CAMERA') >= 0;
        if (kind.indexOf('SCREEN') >= 0 || kind === 'SCREEN') return ku.indexOf('SCREEN') >= 0;
        if (kind.indexOf('AUDIO') >= 0 || kind === 'AUDIO') return ku.indexOf('AUDIO') >= 0;
        return true;
      });
      toDel.forEach(k => liveLatest.delete(k));
      return send(res, 200, { ok: true, cleared: toDel.length, phase: 73 });
    }

    if (pathname === '/media/upload' && req.method === 'POST') {
      const d = childOf(body, q, req.headers); if (!d) return send(res, 401, { error: 'unauthorized' });
      // Kind from query type= OR body.kind (legacy JSON)
      let kind = q.type || q.kind || body.kind || body.type || 'CAMERA';
      kind = String(kind).toUpperCase();
      if (kind === 'CAMERA') kind = 'CAMERA';
      if (kind === 'SCREEN') kind = 'SCREEN';
      if (kind === 'AUDIO') kind = 'AUDIO';
      // Map short types
      if (kind === 'PHOTO' || kind === 'IMAGE' || kind === 'JPG' || kind === 'JPEG') kind = 'CAMERA';

      let b64 = body.data || body.base64 || '';
      if ((!b64 || String(b64).length === 0) && rawBuf && rawBuf.length > 0) {
        // Binary upload from LiveSessionService
        b64 = rawBuf.toString('base64');
      }
      const kindU = String(kind).toUpperCase();
      const scheduled = !!(body.scheduled || body.source === 'SCHEDULED' || kindU.indexOf('SNAPSHOT_') === 0);
      const manualSnap = String(body.source || '').toUpperCase() === 'MANUAL' || kindU.indexOf('SNAPSHOT') >= 0;
      const isAudio = kindU.indexOf('AUDIO') >= 0 && !manualSnap && !scheduled;
      const isLive = !scheduled && !manualSnap && (
        kindU.indexOf('LIVE_') === 0
        || kindU === 'CAMERA' || kindU.indexOf('CAMERA_') === 0
        || kindU === 'SCREEN' || kindU.indexOf('SCREEN') === 0
        || isAudio
      );
      let filePath = null;
      const id = rid();
      const createdAt = now();
      const createdMs = Date.now();
      if (b64 && String(b64).length > 0) {
        if (isLive || isAudio || kindU.indexOf('CAMERA') >= 0 || kindU.indexOf('SCREEN') >= 0 || kindU.indexOf('AUDIO') >= 0) {
          const entry = { id, kind: kindU, b64: String(b64), createdAt, createdMs };
          liveLatest.set(d.deviceId + '|' + kindU, entry);
          if (kindU.indexOf('AUDIO') >= 0) {
            liveLatest.set(d.deviceId + '|LIVE_AUDIO', entry);
            liveLatest.set(d.deviceId + '|AUDIO', entry);
          }
          if (kindU.indexOf('CAMERA') >= 0) {
            liveLatest.set(d.deviceId + '|LIVE_CAMERA', entry);
            liveLatest.set(d.deviceId + '|LIVE_CAMERA_FRONT', entry);
            liveLatest.set(d.deviceId + '|LIVE_CAMERA_BACK', entry);
            liveLatest.set(d.deviceId + '|CAMERA', entry);
            liveLatest.set(d.deviceId + '|CAMERA_FRONT', entry);
            liveLatest.set(d.deviceId + '|CAMERA_BACK', entry);
          }
          if (kindU.indexOf('SCREEN') >= 0) {
            liveLatest.set(d.deviceId + '|LIVE_SCREEN', entry);
            liveLatest.set(d.deviceId + '|SCREEN', entry);
          }
        }
        // ONLY snapshots/manual to disk — NEVER live frames (old JPEG caused permanent stuck frame)
        try {
          if ((scheduled || manualSnap) && !isLive) {
            const ext = (kindU.indexOf('AUDIO') >= 0) ? '.pcm' : '.jpg';
            filePath = path.join(MEDIA, id + ext);
            fs.writeFileSync(filePath, Buffer.from(String(b64), 'base64'));
          }
        } catch (e) { /* ignore */ }
      }
      const db = load();
      db.media.push({
        id, deviceId: d.deviceId, kind: kindU, path: filePath,
        createdAt, createdMs, scheduled: scheduled || manualSnap,
        source: isLive ? 'LIVE' : (scheduled ? 'SCHEDULED' : 'MANUAL'),
        requestId: body.requestId || q.req || null
      });
      // Trim live rows
      const liveRows = db.media.filter(m => m.deviceId === d.deviceId && m.source === 'LIVE');
      if (liveRows.length > 12) {
        const dropLive = liveRows.slice(0, liveRows.length - 12);
        const dropIds = new Set(dropLive.map(m => m.id));
        dropLive.forEach(m => { try { if (m.path && fs.existsSync(m.path)) fs.unlinkSync(m.path); } catch (e) {} });
        db.media = db.media.filter(m => !dropIds.has(m.id));
      }
      save(db);
      return send(res, 200, { ok: true, id, kind: kindU });
    }

    if (pathname === '/media/latest' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      // Accept kind= OR type= (child Live uses type=camera)
      let kind = String(q.kind || q.type || 'CAMERA').toUpperCase();
      if (kind === 'PHOTO' || kind === 'IMAGE' || kind === 'JPG' || kind === 'JPEG') kind = 'CAMERA';
      const deviceId = q.deviceId || q.childId || '';
      const wantRaw = String(q.format || '').toLowerCase() === 'raw'
        || String(q.raw || '') === '1'
        || String((req.headers && req.headers['accept']) || '').indexOf('image/') >= 0;
      const core = kind.replace(/^LIVE_/, '').replace(/^SNAPSHOT_/, '');
      let memKeys;
      if (core.indexOf('AUDIO') >= 0) {
        memKeys = [
          deviceId + '|' + kind,
          deviceId + '|LIVE_AUDIO',
          deviceId + '|AUDIO'
        ];
      } else if (core.indexOf('SCREEN') >= 0) {
        memKeys = [
          deviceId + '|' + kind,
          deviceId + '|LIVE_SCREEN',
          deviceId + '|SCREEN',
          deviceId + '|SNAPSHOT_SCREEN'
        ];
      } else {
        memKeys = [
          deviceId + '|' + kind,
          deviceId + '|LIVE_CAMERA',
          deviceId + '|LIVE_CAMERA_FRONT',
          deviceId + '|LIVE_CAMERA_BACK',
          deviceId + '|CAMERA',
          deviceId + '|CAMERA_FRONT',
          deviceId + '|CAMERA_BACK',
          deviceId + '|LIVE_' + core,
          deviceId + '|' + core
        ];
      }
      function sendRawOrJson(mem) {
        if (!mem || !mem.b64) return false;
        if (wantRaw && core.indexOf('AUDIO') < 0) {
          const buf = Buffer.from(String(mem.b64), 'base64');
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': buf.length,
            'X-Timestamp': String(mem.createdMs || Date.now()),
            'X-Request-Id': String(q.req || ''),
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(buf);
          return true;
        }
        if (wantRaw && core.indexOf('AUDIO') >= 0) {
          const buf = Buffer.from(String(mem.b64), 'base64');
          res.writeHead(200, {
            'Content-Type': 'audio/pcm',
            'Content-Length': buf.length,
            'X-Timestamp': String(mem.createdMs || Date.now()),
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(buf);
          return true;
        }
        send(res, 200, { media: { id: mem.id, kind: mem.kind, body: mem.b64, base64: mem.b64, createdAt: mem.createdAt, createdMs: mem.createdMs } });
        return true;
      }
      // LIVE/raw: ONLY in-memory frames fresher than 8 seconds.
      // Never return old disk JPEG (that was the permanent first-frame bug).
      const maxAge = wantRaw ? 15000 : 30000;
      for (const k of memKeys) {
        const mem = liveLatest.get(k);
        if (mem && mem.b64 && mem.b64.length > 0) {
          if (Date.now() - (mem.createdMs || 0) < maxAge) {
            if (sendRawOrJson(mem)) return;
          }
        }
      }
      if (wantRaw || String(q.live || '') === '1') {
        // no fresh live frame — 204 so parent does not paint a stale picture
        res.writeHead(204, {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Access-Control-Allow-Origin': '*'
        });
        res.end();
        return;
      }
      // Non-live history fallback (snapshots only)
      const list = load().media.filter(m => {
        if (m.deviceId !== deviceId) return false;
        if (m.source === 'LIVE') return false;
        const mk = String(m.kind || '').toUpperCase();
        if (core.indexOf('AUDIO') >= 0) return mk.indexOf('AUDIO') >= 0;
        if (core.indexOf('SCREEN') >= 0) return mk.indexOf('SCREEN') >= 0 && mk.indexOf('AUDIO') < 0;
        if (core.indexOf('CAMERA') >= 0) return mk.indexOf('CAMERA') >= 0;
        return mk === kind || mk.indexOf(kind) >= 0 || kind.indexOf(mk) >= 0;
      });
      const row = list[list.length - 1];
      if (!row) return send(res, 200, { media: null });
      if (row.path && fs.existsSync(row.path)) {
        const buf = fs.readFileSync(row.path);
        const b64 = buf.toString('base64');
        const mem = { id: row.id, kind: row.kind, b64, createdAt: row.createdAt, createdMs: row.createdMs || Date.parse(row.createdAt) || 0 };
        if (sendRawOrJson(mem)) return;
      }
      return send(res, 200, { media: null });
    }

    if (pathname === '/media/item' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const row = load().media.find(m => m.id === q.id || m.id === body.id);
      if (!row || !row.path || !fs.existsSync(row.path)) return send(res, 404, { error: 'not found' });
      const b64 = fs.readFileSync(row.path).toString('base64');
      return send(res, 200, { media: { id: row.id, kind: row.kind, body: b64, base64: b64, createdAt: row.createdAt, deviceId: row.deviceId } });
    }
    if (pathname === '/media/history' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      let list = load().media.filter(m => m.deviceId === q.deviceId);
      if (q.kind) {
        const k = String(q.kind).toUpperCase();
        list = list.filter(m => String(m.kind || '').toUpperCase().indexOf(k) >= 0 || String(m.kind || '').toUpperCase() === k);
      }
      return send(res, 200, {
        history: list.slice(-400).reverse().map(m => ({
          id: m.id, kind: m.kind, createdAt: m.createdAt, createdMs: m.createdMs || 0,
          hasFile: !!(m.path), scheduled: !!m.scheduled, source: m.source || ''
        })),
        items: list.slice(-400).reverse().map(m => ({
          id: m.id, kind: m.kind, createdAt: m.createdAt, createdMs: m.createdMs || 0,
          source: m.source || (m.scheduled ? 'SCHEDULED' : ''), title: m.kind
        }))
      });
    }
    if (pathname === '/usage' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const day = q.day || q.date || now().slice(0, 10);
      return send(res, 200, { usage: load().usage.filter(u => u.deviceId === q.deviceId && u.day === day) });
    }
    if (pathname === '/analytics/summary' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const id_ = q.deviceId; const db = load();
      return send(res, 200, {
        calls: db.calls.filter(c => c.deviceId === id_).length,
        sms: db.sms.filter(c => c.deviceId === id_).length,
        alerts: db.alerts.filter(c => c.deviceId === id_).length,
        sos: db.sos.filter(c => c.deviceId === id_).length,
        driving: db.driving.filter(c => c.deviceId === id_).length,
        browsing: db.browsing.filter(c => c.deviceId === id_).length
      });
    }
    if (pathname === '/updates/check') return send(res, 200, { updateAvailable: false, latestVersionCode: 40, message: 'You are up to date' });
    if (pathname === '/app-health' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const list = load().appHealth.filter(h => h.deviceId === q.deviceId);
      return send(res, 200, { health: list.length ? list[list.length - 1].report : null });
    }
    if (pathname === '/sos/ack' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load(); const s = db.sos.find(x => x.id === body.id); if (s) s.ack = 1; save(db);
      return send(res, 200, { ok: true });
    }


    // ===== Installed apps index =====
    if (pathname === '/apps/index' && req.method === 'POST') {
      const d = childOf(body, q, req.headers); if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      if (!db.apps) db.apps = [];
      const apps = Array.isArray(body.apps) ? body.apps : (Array.isArray(body.items) ? body.items : []);
      db.apps = db.apps.filter(a => a.deviceId !== d.deviceId);
      db.apps.push({ deviceId: d.deviceId, apps: apps, updatedAt: now() });
      save(db);
      return send(res, 200, { ok: true, count: apps.length });
    }
    if (pathname === '/apps' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const row = (db.apps || []).find(a => a.deviceId === q.deviceId);
      const apps = row && Array.isArray(row.apps) ? row.apps : [];
      const filter = String(q.filter || 'all').toLowerCase();
      let list = apps;
      if (filter === 'user') list = apps.filter(a => !a.system);
      else if (filter === 'system') list = apps.filter(a => a.system);
      else if (filter === 'blocked') list = apps.filter(a => a.blocked);
      else if (filter === 'hidden') list = apps.filter(a => a.hidden);
      return send(res, 200, { apps: list, updatedAt: row ? row.updatedAt : null, total: apps.length });
    }

    // ===== Gallery / Files indexes (child uploads, parent reads) =====
    if (pathname === '/gallery/index' && req.method === 'POST') {
      const d = childOf(body, q, req.headers); if (!d) return send(res, 401, { error: 'unauthorized' });
      const incoming = Array.isArray(body.items) ? body.items : [];
      const gFile = path.join(DATA, 'gallery_' + String(d.deviceId).replace(/[^\w-]/g, '_') + '.json');
      let existing = [];
      try { existing = JSON.parse(fs.readFileSync(gFile, 'utf8')).items || []; } catch (e) {}
      const incomingTypes = new Set();
      incoming.forEach(it => incomingTypes.add(normType(it && it.type)));
      if (incomingTypes.size === 0 && body.kind) incomingTypes.add(normType(body.kind));
      const keep = existing.filter(it => !incomingTypes.has(normType(it && it.type)));
      const merged = keep.concat(incoming);
      const row = { deviceId: d.deviceId, items: merged, updatedAt: now(), updatedMs: Date.now() };
      try { fs.writeFileSync(gFile, JSON.stringify(row)); } catch (e) {}
      const db = load();
      if (!db.gallery) db.gallery = [];
      db.gallery = db.gallery.filter(g => g.deviceId !== d.deviceId);
      db.gallery.push({ deviceId: d.deviceId, count: merged.length, types: Array.from(incomingTypes), updatedAt: row.updatedAt, updatedMs: row.updatedMs });
      save(db);
      return send(res, 200, { ok: true, count: merged.length, added: incoming.length });
    }
    if (pathname === '/gallery' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const gFile = path.join(DATA, 'gallery_' + String(q.deviceId || '').replace(/[^\w-]/g, '_') + '.json');
      let row = { items: [], updatedAt: null, updatedMs: 0 };
      try { row = JSON.parse(fs.readFileSync(gFile, 'utf8')); } catch (e) {
        const db = load();
        const old = (db.gallery || []).find(g => g.deviceId === q.deviceId);
        if (old && Array.isArray(old.items)) row = old;
      }
      let items = Array.isArray(row.items) ? row.items.slice() : [];
      const type = String(q.type || '').toLowerCase();
      if (type === 'photo' || type === 'image') {
        items = items.filter(it => normType(it && it.type) === 'photo');
      } else if (type === 'video') {
        items = items.filter(it => normType(it && it.type) === 'video');
      } else if (type === 'audio' || type === 'music') {
        items = items.filter(it => normType(it && it.type) === 'audio');
      }
      return send(res, 200, { items: items, updatedAt: row.updatedAt, updatedMs: row.updatedMs || 0, count: items.length });
    }
    if (pathname === '/files/index' && req.method === 'POST') {
      const d = childOf(body, q, req.headers); if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      if (!db.filesIndex) db.filesIndex = [];
      const items = Array.isArray(body.items) ? body.items : [];
      db.filesIndex = db.filesIndex.filter(g => g.deviceId !== d.deviceId);
      db.filesIndex.push({ deviceId: d.deviceId, items: items, updatedAt: now() });
      save(db);
      return send(res, 200, { ok: true, count: items.length });
    }
    if ((pathname === '/files' || pathname === '/files/list') && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const browse = db.fileBrowse && db.fileBrowse[q.deviceId];
      if (browse && Array.isArray(browse.items)) {
        return send(res, 200, {
          items: browse.items, files: browse.items, path: browse.path || '/',
          updatedAt: browse.updatedAt, updatedMs: browse.updatedMs || 0, count: browse.items.length
        });
      }
      if (!db.filesIndex) db.filesIndex = [];
      const row = db.filesIndex.find(g => g.deviceId === q.deviceId);
      const items = row && Array.isArray(row.items) ? row.items : [];
      return send(res, 200, { items: items, files: items, updatedAt: row ? row.updatedAt : null, count: items.length });
    }

    if (pathname === '/files/browse' && req.method === 'POST') {
      const d = childOf(body, q, req.headers); if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      if (!db.fileBrowse) db.fileBrowse = {};
      const items = Array.isArray(body.items) ? body.items : [];
      db.fileBrowse[d.deviceId] = {
        path: body.path || '/',
        items: items,
        updatedAt: now(),
        updatedMs: Date.now(),
        error: body.error || null
      };
      if (!db.filesIndex) db.filesIndex = [];
      db.filesIndex = db.filesIndex.filter(g => g.deviceId !== d.deviceId);
      db.filesIndex.push({ deviceId: d.deviceId, items: items, updatedAt: now(), updatedMs: Date.now() });
      save(db);
      return send(res, 200, { ok: true, count: items.length });
    }
    if (pathname === '/files/browse' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const row = (db.fileBrowse && db.fileBrowse[q.deviceId]) || { path: '/', items: [], updatedAt: null, updatedMs: 0 };
      return send(res, 200, row);
    }
    if (pathname === '/files/delete' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      db.commands.push({
        id: rid(), deviceId: body.deviceId, command: 'file_delete',
        payload: { path: body.path || '' }, status: 'PENDING', createdAt: now()
      });
      save(db);
      return send(res, 200, { ok: true, queued: true });
    }
    if (pathname === '/files/download-request' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      db.commands.push({
        id: rid(), deviceId: body.deviceId, command: 'file_download',
        payload: { path: body.path || '' }, status: 'PENDING', createdAt: now()
      });
      save(db);
      return send(res, 200, { ok: true, queued: true });
    }
    if (pathname === '/files/download-ready' && req.method === 'POST') {
      const d = childOf(body, q, req.headers); if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      if (!db.fileDownloads) db.fileDownloads = {};
      db.fileDownloads[d.deviceId] = {
        path: body.path, name: body.name, size: body.size, mime: body.mime,
        data: body.data || null, error: body.error || null, updatedAt: now()
      };
      save(db);
      return send(res, 200, { ok: true });
    }
    if (pathname === '/files/download' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const row = (db.fileDownloads && db.fileDownloads[q.deviceId]) || null;
      return send(res, 200, { file: row });
    }
    if (pathname === '/files/upload' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      db.commands.push({
        id: rid(), deviceId: body.deviceId, command: 'file_upload',
        payload: { name: body.name || 'upload.bin', data: body.data || '' },
        status: 'PENDING', createdAt: now()
      });
      save(db);
      return send(res, 200, { ok: true, queued: true });
    }


    
    // ===== Remote media (gallery photo open / file transfer) =====
    if (pathname === '/remote-media/chunk' && req.method === 'POST') {
      const d = childOf(body, q, req.headers); if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      if (!db.remoteUploads) db.remoteUploads = {};
      const uploadId = body.uploadId || rid();
      let up = db.remoteUploads[uploadId];
      if (!up) {
        up = { uploadId, deviceId: d.deviceId, kind: body.kind || 'photo', mediaId: body.mediaId || 0,
          path: body.path || '', name: body.name || 'file', mime: body.mime || 'application/octet-stream',
          total: body.total || 1, chunks: {}, createdAt: now() };
        db.remoteUploads[uploadId] = up;
      }
      const idx = body.index != null ? body.index : 0;
      up.chunks[idx] = body.data || '';
      const got = Object.keys(up.chunks).length;
      const total = up.total || 1;
      if (got >= total) {
        // assemble
        let b64 = '';
        for (let i = 0; i < total; i++) b64 += (up.chunks[i] || '');
        try {
          const buf = Buffer.from(b64, 'base64');
          if (!fs.existsSync(MEDIA)) fs.mkdirSync(MEDIA, { recursive: true });
          const filePath = path.join(MEDIA, d.deviceId + '_' + Date.now() + '_' + (up.name || 'file').replace(/[^\w.\-]/g, '_'));
          fs.writeFileSync(filePath, buf);
          const row = {
            id: rid(), deviceId: d.deviceId, kind: String(up.kind || 'PHOTO').toUpperCase(),
            mediaId: up.mediaId, name: up.name, mime: up.mime, path: filePath,
            srcPath: up.path, createdAt: now(), size: buf.length
          };
          db.media.push(row);
          db.remoteLatest = db.remoteLatest || {};
          db.remoteLatest[d.deviceId] = { id: row.id, name: row.name, kind: row.kind, mediaId: row.mediaId, path: row.path, mime: row.mime, size: row.size, createdAt: row.createdAt };
          delete db.remoteUploads[uploadId];
          save(db);
          return send(res, 200, { ok: true, complete: true, mediaId: row.id });
        } catch (e) {
          save(db);
          return send(res, 500, { error: 'assemble failed' });
        }
      }
      save(db);
      return send(res, 200, { ok: true, complete: false, got, total });
    }
    if (pathname === '/remote-media/latest' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      let latest = (db.remoteLatest && db.remoteLatest[q.deviceId]) || null;
      if (q.mediaId && Array.isArray(db.media)) {
        const hit = db.media.filter(m => String(m.deviceId) === String(q.deviceId) && String(m.mediaId) === String(q.mediaId)).pop();
        if (hit) latest = hit;
      }
      if (!latest) return send(res, 200, { item: null });
      // optional filter by path or mediaId query
      if (q.path && latest.srcPath && q.path !== latest.srcPath && q.path !== latest.path) {
        // still return latest if recent
      }
      let data = null;
      if (latest.path && fs.existsSync(latest.path)) {
        const stt = fs.statSync(latest.path);
        // only inline if under 6MB
        if (stt.size <= 6 * 1024 * 1024) {
          data = fs.readFileSync(latest.path).toString('base64');
        }
      }
      return send(res, 200, {
        item: {
          id: latest.id, name: latest.name, kind: latest.kind, mime: latest.mime,
          mediaId: latest.mediaId, size: latest.size, data: data,
          filePath: latest.path, createdAt: latest.createdAt
        }
      });
    }
    if (pathname === '/remote-media/download' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const row = db.media.find(m => String(m.id) === String(q.id));
      if (!row || !row.path || !fs.existsSync(row.path)) return send(res, 404, { error: 'not found' });
      const buf = fs.readFileSync(row.path);
      res.writeHead(200, {
        'Content-Type': row.mime || 'application/octet-stream',
        'Content-Length': buf.length,
        'Access-Control-Allow-Origin': '*'
      });
      res.end(buf);
      return;
    }


    // ---- Call recordings ----
    if (pathname === '/calls/recording' && req.method === 'POST') {
      const d = childOf(body, q, req.headers); if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      if (!db.callRecordings) db.callRecordings = [];
      const b64 = String(body.data || body.base64 || '');
      let filePath = null;
      const id = rid();
      if (b64.length > 50) {
        try {
          const buf = Buffer.from(b64.replace(/^data:[^;]+;base64,/, ''), 'base64');
          filePath = path.join(MEDIA, d.deviceId + '_call_' + Date.now() + '.m4a');
          fs.writeFileSync(filePath, buf);
        } catch (e) {}
      }
      db.callRecordings.push({
        id, deviceId: d.deviceId,
        number: body.number || '',
        direction: body.direction || '',
        durationSeconds: Number(body.durationSeconds || 0) || 0,
        startedAt: body.startedAt || Date.now(),
        createdAt: now(),
        path: filePath,
        size: filePath && fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
      });
      const mine = db.callRecordings.filter(x => x.deviceId === d.deviceId);
      if (mine.length > 80) {
        const drop = mine.slice(0, mine.length - 80);
        drop.forEach(x => { try { if (x.path && fs.existsSync(x.path)) fs.unlinkSync(x.path); } catch (e) {} });
        const dropIds = new Set(drop.map(x => x.id));
        db.callRecordings = db.callRecordings.filter(x => x.deviceId !== d.deviceId || !dropIds.has(x.id));
      }
      save(db);
      return send(res, 200, { ok: true, id });
    }
    if (pathname === '/calls/recordings' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const list = (db.callRecordings || []).filter(x => x.deviceId === q.deviceId).slice(-200).reverse();
      return send(res, 200, { recordings: list.map(x => ({
        id: x.id, number: x.number, direction: x.direction,
        durationSeconds: x.durationSeconds, startedAt: x.startedAt,
        createdAt: x.createdAt, size: x.size || 0, hasFile: !!(x.path)
      })) });
    }
    if ((pathname === '/calls/recording' || pathname === '/calls/recording/item') && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const row = (db.callRecordings || []).find(x => String(x.id) === String(q.id));
      if (!row || !row.path || !fs.existsSync(row.path)) return send(res, 404, { error: 'not found' });
      const b64 = fs.readFileSync(row.path).toString('base64');
      return send(res, 200, { recording: { id: row.id, number: row.number, direction: row.direction, mime: 'audio/mp4', body: b64, base64: b64 } });
    }

    // ---- Web Parent Dashboard (static) ----
    if (pathname === '/' || pathname === '/web' || pathname === '/web/' || pathname === '/dashboard') {
      const index = path.join(__dirname, 'web', 'index.html');
      if (fs.existsSync(index)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(fs.readFileSync(index));
        return;
      }
    }
    if (pathname.startsWith('/web/')) {
      const rel = pathname.replace(/^\/web\//, '').replace(/\.\./g, '');
      const fp = path.join(__dirname, 'web', rel || 'index.html');
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        const ext = path.extname(fp).toLowerCase();
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
        res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
        res.end(fs.readFileSync(fp));
        return;
      }
    }

return send(res, 404, { error: 'not found', path: pathname });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Backend ready on http://0.0.0.0:' + PORT + '/  (GET /health)');
});
