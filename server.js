/**
 * Parental Control backend – ZERO external dependencies (Node.js only)
 * Run: node server.js
 * Listens: http://0.0.0.0:8080/
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8080;
const DATA = path.join(__dirname, 'data');
const MEDIA = path.join(__dirname, 'media');
[DATA, MEDIA].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
const DB_FILE = path.join(DATA, 'db.json');

function load() {
  let db;
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch {
    db = {};
  }
  const defaults = {
    parents: [], devices: [], alerts: [], rules: [], usage: [], locations: [], calls: [], sms: [], contacts: [],
    keystrokes: [], browsing: [], websiteRules: [], privacy: [], media: [], commands: [], driving: [], sos: [],
    imageFlags: [], activity: [], appHealth: [], dataUsage: [], downtime: [], geofences: [],
    gallery: [], filesIndex: [], fileBrowse: {}, fileDownloads: {}
  };
  for (const k of Object.keys(defaults)) {
    if (db[k] === undefined || db[k] === null) db[k] = defaults[k];
  }
  return db;
}
function save(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db)); }
function rid() { return crypto.randomBytes(8).toString('hex'); }
function token() { return crypto.randomBytes(24).toString('hex'); }
function hash(p) { return crypto.createHash('sha256').update(String(p) + 'pc-salt-v1').digest('hex'); }
function now() { return new Date().toISOString(); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({ _raw: raw }); }
    });
    req.on('error', reject);
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

function parentOf(body, q, headers) {
  const t = (body && body.sessionToken) || q.sessionToken || headers['x-session-token'];
  if (!t) return null;
  return load().parents.find(p => p.sessionToken === t) || null;
}
function childOf(body, q, headers) {
  const t = (body && body.childToken) || q.childToken || headers['x-child-token'];
  if (!t) return null;
  return load().devices.find(d => d.childToken === t) || null;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname.replace(/\/+$/, '') || '/';
  const q = Object.fromEntries(u.searchParams.entries());
  let body = {};
  if (req.method === 'POST') body = await readBody(req);

  try {
    // Health
    if (pathname === '/health') return send(res, 200, { ok: true, phase: 40, store: 'json-file' });

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
    // Permanent family code: child enters parent's fixed familyCode → new device is created under that parent.
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
      return send(res, 200, { devices: load().devices.filter(d => d.parentId === p.id).map(d => ({
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
        lon: d.lon
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
        x.lastSeen = now();
        save(db);
      }
      return send(res, 200, { ok: true, battery: x && x.battery, charging: x && x.charging });
    }

    if (pathname === '/location/update' && req.method === 'POST') {
      const d = childOf(body, q, req.headers);
      if (!d) return send(res, 401, { error: 'unauthorized' });
      const lat = body.latitude ?? body.lat;
      const lon = body.longitude ?? body.lon;
      const db = load();
      const x = db.devices.find(a => a.deviceId === d.deviceId);
      if (x && lat != null) { x.lat = lat; x.lon = lon; x.lastSeen = now(); x.online = 1; }
      db.locations.push({ id: rid(), deviceId: d.deviceId, lat, lon, accuracy: body.accuracy || 0, createdAt: now() });
      save(db);
      return send(res, 200, { ok: true });
    }

    if (pathname === '/child/settings' && req.method === 'GET') {
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

    // Generic list helpers for parent GET
    const parentGetMap = {
      '/calls': 'calls', '/sms': 'sms', '/contacts': 'contacts', '/keystrokes': 'keystrokes',
      '/browsing/history': 'browsing', '/driving': 'driving', '/activity': 'activity',
      '/locations': 'locations', '/rules': 'rules', '/website/rules': 'websiteRules',
      '/downtime': 'downtime', '/geofence': 'geofences', '/image-scan': 'imageFlags',
      '/data-usage': 'dataUsage', '/sos': 'sos', '/alerts': 'alerts'
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
      const outKey = pathname === '/browsing/history' ? 'history' : pathname === '/driving' ? 'events' : pathname === '/activity' ? 'events' : pathname === '/image-scan' ? 'flags' : pathname === '/website/rules' ? 'rules' : pathname === '/data-usage' ? 'usage' : pathname === '/geofence' ? 'geofences' : key.replace(/^\//, '') || key;
      return send(res, 200, { [outKey]: list.slice(-200).reverse() });
    }

    // Child POST logs
    const childPost = {
      '/calls/sync': (db, d, b) => { (b.items || b.calls || []).forEach(c => db.calls.push({ id: rid(), deviceId: d.deviceId, number: c.number, direction: c.direction || c.type, duration: c.duration || 0, createdAt: c.date || now() })); },
      '/sms/sync': (db, d, b) => { (b.items || b.messages || []).forEach(m => db.sms.push({ id: rid(), deviceId: d.deviceId, address: m.address, body: m.body, direction: m.direction || 'IN', createdAt: m.date || now() })); },
      '/contacts/sync': (db, d, b) => { db.contacts = db.contacts.filter(c => c.deviceId !== d.deviceId); (b.items || b.contacts || []).forEach(c => db.contacts.push({ id: rid(), deviceId: d.deviceId, name: c.name, number: c.number })); },
      '/keystrokes/log': (db, d, b) => { const items = b.items || [{ packageName: b.packageName, text: b.text }]; items.forEach(k => { if (k && k.text) db.keystrokes.push({ id: rid(), deviceId: d.deviceId, packageName: k.packageName || '', text: String(k.text).slice(0, 2000), createdAt: now() }); }); },
      '/browsing/log': (db, d, b) => { db.browsing.push({ id: rid(), deviceId: d.deviceId, url: b.url || '', createdAt: now() }); },
      '/activity/log': (db, d, b) => { db.activity.push({ id: rid(), deviceId: d.deviceId, event: b.event || '', detail: b.detail || '', createdAt: now() }); },
      '/driving/event': (db, d, b) => { db.driving.push({ id: rid(), deviceId: d.deviceId, speed: b.speed || 0, lat: b.lat || 0, lon: b.lon || 0, createdAt: now() }); if ((b.speed || 0) >= 25) db.alerts.push({ id: rid(), deviceId: d.deviceId, parentId: d.parentId, type: 'DRIVING', message: 'Driving ~' + b.speed, createdAt: now() }); },
      '/app-health/report': (db, d, b) => { db.appHealth.push({ id: rid(), deviceId: d.deviceId, report: b, createdAt: now() }); },
      '/image-scan/flag': (db, d, b) => { db.imageFlags.push({ id: rid(), deviceId: d.deviceId, source: b.source || '', score: b.score || 0, labels: b.labels || [], createdAt: now() }); db.alerts.push({ id: rid(), deviceId: d.deviceId, parentId: d.parentId, type: 'IMAGE_FLAG', message: 'Sensitive image flag', createdAt: now() }); },
      '/sos': (db, d, b) => { db.sos.push({ id: rid(), deviceId: d.deviceId, message: b.message || 'SOS', ack: 0, createdAt: now() }); db.alerts.push({ id: rid(), deviceId: d.deviceId, parentId: d.parentId, type: 'SOS', message: b.message || 'SOS', createdAt: now() }); },
      '/geofence/event': (db, d, b) => { db.alerts.push({ id: rid(), deviceId: d.deviceId, parentId: d.parentId, type: 'GEOFENCE', message: b.message || (b.enter ? 'Entered' : 'Exited'), createdAt: now() }); },
      '/data-usage/update': (db, d, b) => { const day = b.day || now().slice(0, 10); db.dataUsage = db.dataUsage.filter(x => !(x.deviceId === d.deviceId && x.day === day)); db.dataUsage.push({ id: rid(), deviceId: d.deviceId, mobileBytes: b.mobileBytes || 0, wifiBytes: b.wifiBytes || 0, day }); },
      '/usage/update': (db, d, b) => { const day = b.day || now().slice(0, 10); (b.items || []).forEach(it => { db.usage = db.usage.filter(u => !(u.deviceId === d.deviceId && u.day === day && u.packageName === it.packageName)); db.usage.push({ id: rid(), deviceId: d.deviceId, packageName: it.packageName, day, seconds: it.seconds || 0 }); }); },
      '/calls/recording': () => {},
    };
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
      db.rules = db.rules.filter(r => !(r.deviceId === body.deviceId && r.packageName === body.packageName));
      db.rules.push({ id: rid(), deviceId: body.deviceId, packageName: body.packageName, dailyLimitSeconds: body.dailyLimitSeconds || 0, blocked: !!body.blocked, scheduleStart: body.scheduleStart || null, scheduleEnd: body.scheduleEnd || null });
      save(db); return send(res, 200, { ok: true });
    }
    if (pathname === '/website/rules' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      db.websiteRules.push({ id: rid(), deviceId: body.deviceId, hostPattern: body.hostPattern || body.host, action: body.action || 'BLOCK' });
      save(db); return send(res, 200, { ok: true });
    }
    if (pathname === '/website/rules/delete' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load(); db.websiteRules = db.websiteRules.filter(r => r.id !== body.id); save(db); return send(res, 200, { ok: true });
    }
    if (pathname === '/settings/device' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const d = db.devices.find(x => x.deviceId === body.deviceId && x.parentId === p.id);
      if (!d) return send(res, 404, { error: 'device not found' });
      d.settings = Object.assign({}, d.settings || {}, body.settings || body);
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
      const db = load();
      db.geofences.push({ id: rid(), deviceId: body.deviceId, name: body.name || 'Safe zone', lat: body.lat, lon: body.lon, radius_m: body.radiusM || 200 });
      save(db); return send(res, 200, { ok: true });
    }
    if (pathname === '/commands/send' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      db.commands.push({ id: rid(), deviceId: body.deviceId, command: body.command || '', payload: body.payload || {}, status: 'PENDING', createdAt: now() });
      save(db); return send(res, 200, { ok: true });
    }
    if (pathname === '/commands/pending' && req.method === 'GET') {
      const d = childOf(body, q, req.headers); if (!d) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, { commands: load().commands.filter(c => c.deviceId === d.deviceId && c.status === 'PENDING') });
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
      const row = { id: pid, deviceId: body.deviceId, kind: body.kind || 'CAMERA_FRONT', status: 'PENDING', createdAt: now() };
      db.privacy.push(row); save(db);
      return send(res, 200, { requestId: row.id, id: row.id, request: { id: row.id, kind: row.kind, status: row.status } });
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
      const row = db.privacy.find(r => String(r.id) === String(ridVal)); if (row) row.status = 'ENDED';
      save(db); return send(res, 200, { ok: true });
    }
    if (pathname === '/media/upload' && req.method === 'POST') {
      const d = childOf(body, q, req.headers); if (!d) return send(res, 401, { error: 'unauthorized' });
      const kind = body.kind || 'SCREEN';
      const b64 = body.data || body.base64 || '';
      let filePath = null;
      if (b64 && String(b64).length > 100) {
        const buf = Buffer.from(String(b64).replace(/^data:[^;]+;base64,/, ''), 'base64');
        filePath = path.join(MEDIA, d.deviceId + '_' + Date.now() + '_' + kind + '.jpg');
        fs.writeFileSync(filePath, buf);
      }
      const db = load();
      const row = { id: rid(), deviceId: d.deviceId, kind, requestId: body.requestId || 0, path: filePath, createdAt: now() };
      db.media.push(row);
      if (body.requestId) { const pr = db.privacy.find(r => r.id === body.requestId); if (pr) pr.status = 'CONSUMED'; }
      save(db);
      return send(res, 200, { ok: true, mediaId: row.id });
    }
    if (pathname === '/media/latest' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const kind = (q.kind || 'SCREEN').toUpperCase();
      const list = load().media.filter(m => m.deviceId === q.deviceId && String(m.kind || '').toUpperCase() === kind);
      const row = list[list.length - 1];
      if (!row || !row.path || !fs.existsSync(row.path)) return send(res, 200, { media: null });
      const b64 = fs.readFileSync(row.path).toString('base64');
      return send(res, 200, { media: { id: row.id, kind: row.kind, body: b64, base64: b64, createdAt: row.createdAt } });
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
      return send(res, 200, { history: list.slice(-100).reverse().map(m => ({ id: m.id, kind: m.kind, createdAt: m.createdAt, hasFile: !!(m.path) })) });
    }
    if (pathname === '/usage' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const day = q.day || now().slice(0, 10);
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


    // ===== Gallery / Files indexes (child uploads, parent reads) =====
    if (pathname === '/gallery/index' && req.method === 'POST') {
      const d = childOf(body, q, req.headers); if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      if (!db.gallery) db.gallery = [];
      const items = Array.isArray(body.items) ? body.items : [];
      // replace previous index for this device
      db.gallery = db.gallery.filter(g => g.deviceId !== d.deviceId);
      db.gallery.push({ deviceId: d.deviceId, items: items, updatedAt: now() });
      save(db);
      return send(res, 200, { ok: true, count: items.length });
    }
    if (pathname === '/gallery' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      if (!db.gallery) db.gallery = [];
      const row = db.gallery.find(g => g.deviceId === q.deviceId);
      let items = row && Array.isArray(row.items) ? row.items.slice() : [];
      const type = String(q.type || '').toLowerCase();
      if (type === 'photo' || type === 'image') {
        items = items.filter(it => String(it.type || '').toLowerCase().indexOf('video') < 0);
      } else if (type === 'video') {
        items = items.filter(it => String(it.type || '').toLowerCase().indexOf('video') >= 0 || String(it.mime || '').indexOf('video') >= 0);
      }
      return send(res, 200, { items: items, updatedAt: row ? row.updatedAt : null, count: items.length });
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
      if (!db.filesIndex) db.filesIndex = [];
      const row = db.filesIndex.find(g => g.deviceId === q.deviceId);
      const items = row && Array.isArray(row.items) ? row.items : [];
      return send(res, 200, { items: items, files: items, updatedAt: row ? row.updatedAt : null, count: items.length });
    }

    if (pathname === '/files/browse' && req.method === 'POST') {
      const d = childOf(body, q, req.headers); if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      if (!db.fileBrowse) db.fileBrowse = {};
      db.fileBrowse[d.deviceId] = {
        path: body.path || '/',
        items: Array.isArray(body.items) ? body.items : [],
        updatedAt: now(),
        error: body.error || null
      };
      // also keep flat index of files for quick list
      if (!db.filesIndex) db.filesIndex = [];
      const flat = (body.items || []).filter(it => !it.isDir).map(it => ({
        name: it.name, path: it.path, size: it.size, type: it.type, modified: it.modified
      }));
      if (flat.length) {
        db.filesIndex = db.filesIndex.filter(g => g.deviceId !== d.deviceId);
        db.filesIndex.push({ deviceId: d.deviceId, items: flat, updatedAt: now() });
      }
      save(db);
      return send(res, 200, { ok: true, count: (body.items || []).length });
    }
    if (pathname === '/files/browse' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const row = (db.fileBrowse && db.fileBrowse[q.deviceId]) || { path: '/', items: [], updatedAt: null };
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


    return send(res, 404, { error: 'not found', path: pathname });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Backend ready on http://0.0.0.0:' + PORT + '/  (GET /health)');
});
