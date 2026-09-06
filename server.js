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
    gallery: [], filesIndex: [], fileBrowse: {}, fileDownloads: {}, remoteUploads: {}, remoteLatest: {}, notifications: [], invites: [], reports: [], parentPins: {}
  };
  for (const k of Object.keys(defaults)) {
    if (db[k] === undefined || db[k] === null) db[k] = defaults[k];
  }
  return db;
}
function save(db) {
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e2) { console.error('save failed', e2); }
  }
}
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
      // keep last 60 points per device
      const mine = db.locations.filter(l => l.deviceId === d.deviceId);
      if (mine.length > 60) {
        const drop = new Set(mine.slice(0, mine.length - 60).map(l => l.id));
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
      const outKey = pathname === '/browsing/history' ? 'history' : pathname === '/driving' ? 'events' : pathname === '/activity' ? 'events' : pathname === '/image-scan' ? 'flags' : pathname === '/website/rules' ? 'rules' : pathname === '/data-usage' ? 'usage' : pathname === '/geofence' ? 'geofences' : key.replace(/^\//, '') || key;
      return send(res, 200, { [outKey]: list.slice(-200).reverse() });
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
          const number = String(c.number || '');
          const direction = String(c.direction || c.type || '');
          const duration = Number(c.durationSeconds != null ? c.durationSeconds : (c.duration || 0)) || 0;
          // dedupe same call
          const exists = db.calls.some(x => x.deviceId === d.deviceId && x.number === number && String(x.direction) === direction && String(x.createdAt) === createdAt);
          if (!exists) {
            db.calls.push({
              id: rid(), deviceId: d.deviceId, number, name: c.name || '',
              direction, duration, durationSeconds: duration,
              createdAt, startedAt: started
            });
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
        const items = b.items || b.messages || b.sms || [];
        items.forEach(m => {
          const when = m.date || m.createdAt || Date.now();
          const createdAt = (typeof when === 'number')
            ? new Date(when < 1e12 ? when * 1000 : when).toISOString()
            : String(when);
          const address = String(m.address || m.number || '');
          const body = String(m.body || m.message || '');
          const direction = String(m.direction || m.type || 'IN');
          const exists = db.sms.some(x => x.deviceId === d.deviceId && x.address === address && x.body === body && String(x.createdAt) === createdAt);
          if (!exists) {
            db.sms.push({ id: rid(), deviceId: d.deviceId, address, body, direction, createdAt });
          }
        });
        const mine = db.sms.filter(x => x.deviceId === d.deviceId);
        if (mine.length > 800) {
          const drop = new Set(mine.slice(0, mine.length - 800).map(x => x.id));
          db.sms = db.sms.filter(x => x.deviceId !== d.deviceId || !drop.has(x.id));
        }
      },
      '/contacts/sync': (db, d, b) => {
        db.contacts = db.contacts.filter(c => c.deviceId !== d.deviceId);
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
      '/driving/event': (db, d, b) => { db.driving.push({ id: rid(), deviceId: d.deviceId, speed: b.speed || 0, lat: b.lat || 0, lon: b.lon || 0, createdAt: now() }); if ((b.speed || 0) >= 25) db.alerts.push({ id: rid(), deviceId: d.deviceId, parentId: d.parentId, type: 'DRIVING', message: 'Driving ~' + b.speed, createdAt: now() }); },
      '/app-health/report': (db, d, b) => { db.appHealth.push({ id: rid(), deviceId: d.deviceId, report: b, createdAt: now() }); },
      '/image-scan/flag': (db, d, b) => { db.imageFlags.push({ id: rid(), deviceId: d.deviceId, source: b.source || '', score: b.score || 0, labels: b.labels || [], createdAt: now() }); db.alerts.push({ id: rid(), deviceId: d.deviceId, parentId: d.parentId, type: 'IMAGE_FLAG', message: 'Sensitive image flag', createdAt: now() }); },
      '/sos': (db, d, b) => { const msg = b.message || b.note || 'SOS from child'; const lat = b.latitude || b.lat || 0; const lon = b.longitude || b.lon || 0; db.sos.push({ id: rid(), deviceId: d.deviceId, message: msg, lat, lon, ack: 0, createdAt: now() }); db.alerts.push({ id: rid(), deviceId: d.deviceId, parentId: d.parentId, type: 'SOS', title: 'SOS ALERT', message: msg + (lat ? (' @ ' + lat + ',' + lon) : ''), createdAt: now(), read: false }); }); db.alerts.push({ id: rid(), deviceId: d.deviceId, parentId: d.parentId, type: 'SOS', title: 'SOS ALERT', message: msg + (lat ? (' @ ' + lat + ',' + lon) : ''), createdAt: now(), read: false }); },
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
      const row = {
        id: pid,
        deviceId: body.deviceId,
        kind: body.kind || 'CAMERA_FRONT',
        status: 'PENDING',
        durationSeconds: body.durationSeconds || 0,
        createdAt: now()
      };
      db.privacy.push(row); save(db);
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
        const ext = (String(kind).toUpperCase().indexOf('AUDIO') >= 0) ? '.m4a' : '.jpg';
        filePath = path.join(MEDIA, d.deviceId + '_' + Date.now() + '_' + kind + ext);
        fs.writeFileSync(filePath, buf);
      }
      const db = load();
      const row = { id: rid(), deviceId: d.deviceId, kind, requestId: body.requestId || 0, path: filePath, createdAt: now(), createdMs: Date.now() };
      db.media.push(row);
      // LIVE sessions must stay APPROVED so Parent can keep polling frames
      if (body.requestId) {
        const pr = db.privacy.find(r => String(r.id) === String(body.requestId));
        if (pr) {
          const k = String(kind || '');
          if (k.indexOf('LIVE_') === 0) {
            pr.status = 'APPROVED';
            pr.lastFrameAt = now();
          } else {
            pr.status = 'CONSUMED';
          }
        }
      }
      // keep last 40 media rows per device to avoid huge db
      const byDev = db.media.filter(m => m.deviceId === d.deviceId);
      if (byDev.length > 40) {
        const drop = byDev.slice(0, byDev.length - 40);
        db.media = db.media.filter(m => m.deviceId !== d.deviceId || !drop.find(x => x.id === m.id));
      }
      save(db);
      return send(res, 200, { ok: true, mediaId: row.id });
    }
    if (pathname === '/media/latest' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const kind = (q.kind || 'SCREEN').toUpperCase();
      const list = load().media.filter(m => {
        if (m.deviceId !== q.deviceId) return false;
        const mk = String(m.kind || '').toUpperCase();
        return mk === kind || mk.indexOf(kind) >= 0 || kind.indexOf(mk) >= 0
          || (kind.indexOf('CAMERA') >= 0 && mk.indexOf('CAMERA') >= 0)
          || (kind.indexOf('SCREEN') >= 0 && mk.indexOf('SCREEN') >= 0)
          || (kind.indexOf('AUDIO') >= 0 && mk.indexOf('AUDIO') >= 0);
      });
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
      const latest = (db.remoteLatest && db.remoteLatest[q.deviceId]) || null;
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
