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
// Optional strongest online LLM (OpenAI-compatible). Set AI_API_KEY + AI_API_URL.
// Example: AI_API_URL=https://api.openai.com/v1/chat/completions  AI_API_KEY=sk-...
// Or xAI: AI_API_URL=https://api.x.ai/v1/chat/completions
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_API_URL = process.env.AI_API_URL || '';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';

const webrtcSignals = Object.create(null);
function webrtcAliasTokens(token) {
  const keys = [];
  const t = String(token || '');
  if (!t) return keys;
  keys.push(t);
  try {
    const db = load();
    const d = (db.devices || []).find(x =>
      (x.deviceId && String(x.deviceId) === t) ||
      (x.childToken && String(x.childToken) === t) ||
      (x.token && String(x.token) === t)
    );
    if (d) {
      if (d.deviceId && keys.indexOf(String(d.deviceId)) < 0) keys.push(String(d.deviceId));
      if (d.childToken && keys.indexOf(String(d.childToken)) < 0) keys.push(String(d.childToken));
    }
  } catch (e) {}
  return keys;
}
function pushWebRtcSignal(token, signal) {
  if (!token || signal == null) return;
  const payload = typeof signal === 'object' ? Object.assign({ ts: Date.now() }, signal) : { ts: Date.now(), raw: signal };
  const keys = webrtcAliasTokens(token);
  for (const t of keys) {
    if (!webrtcSignals[t]) webrtcSignals[t] = [];
    webrtcSignals[t].push(payload);
    if (webrtcSignals[t].length > 50) webrtcSignals[t] = webrtcSignals[t].slice(-50);
  }
}
function drainWebRtcSignals(token) {
  const keys = webrtcAliasTokens(token);
  const out = [];
  for (const t of keys) {
    const arr = webrtcSignals[t] || [];
    webrtcSignals[t] = [];
    for (const s of arr) out.push(s);
  }
  return out;
}


function localStrongClassify(text) {
  const t = String(text || '');
  const low = t.toLowerCase();
  const hits = [];
  const rules = [
    { id: 'LOVE', risk: 70, re: /(i love you|love you|miss you|pyar|mohabbat|bhalobashi|saranghae|사랑|ভালোবাসি|प्यार)/i },
    { id: 'MEET', risk: 75, re: /(meet me|let'?s meet|aa jao|milte|come over|밀나|দেখা)/i },
    { id: 'LOCATION', risk: 65, re: /(where are you|where are you going|kahan|kidhar|location|address|কোথায়|어디)/i },
    { id: 'IDENTITY', risk: 40, re: /(who are you|who is this|tum kaun|kaun ho|তুমি কে|누구)/i },
    { id: 'SECRECY', risk: 80, re: /(don'?t tell|delete this|keep secret|mat batana|kisi ko mat|গোপন)/i },
    { id: 'THREAT', risk: 90, re: /(kill|suicide|self harm|threaten|marunga)/i },
    { id: 'SEXUAL', risk: 85, re: /(nudes?|sext|porn|onlyfans|\bsex\b)/i },
    { id: 'DRUGS', risk: 85, re: /(weed|cocaine|ganja|drugs?)/i },
    { id: 'WELLBEING', risk: 15, re: /(how are you|i'?m fine|kaise ho|kemon acho)/i },
    { id: 'FLIRT', risk: 35, re: /(cute|handsome|beautiful|sweetheart)/i }
  ];
  for (const r of rules) {
    if (r.re.test(t) || r.re.test(low)) hits.push({ intent: r.id, risk: r.risk });
  }
  let risk = 0;
  const intents = [];
  for (const h of hits) {
    intents.push(h.intent);
    if (h.risk > risk) risk = h.risk;
  }
  const style = [];
  if (/(please|pls|plz)/i.test(t)) style.push('polite');
  if (/(lol|haha|😂|🤣)/i.test(t)) style.push('playful');
  if (/(urgent|now|jaldi|abhi)/i.test(t)) style.push('urgent');
  if (/(secret|gopan|raaz)/i.test(t)) style.push('secretive');
  if (t.length > 120) style.push('long_message');
  if (/[\u0900-\u097F]/.test(t)) style.push('hindi_script');
  if (/[\u0980-\u09FF]/.test(t)) style.push('bengali_script');
  if (/[\uAC00-\uD7AF]/.test(t)) style.push('korean_script');
  return {
    intents: intents.length ? intents : ['GENERAL_CHAT'],
    risk: intents.length ? risk : 5,
    style,
    summary: intents.length
      ? ('Detected: ' + intents.join(', ') + (style.length ? (' | style: ' + style.join(',')) : ''))
      : 'Casual chat',
    engine: 'local-strong'
  };
}

async function llmAnalyze(text, meta) {
  if (!AI_API_KEY || !AI_API_URL) return null;
  const system = `You are a parental-control conversation analyst. Analyze the child's message for safety.
Return STRICT JSON only:
{"intents":["LOVE|MEET|LOCATION|IDENTITY|SECRECY|THREAT|SEXUAL|DRUGS|BULLYING|WELLBEING|FLIRT|GENERAL_CHAT"],"risk":0-100,"style":["string"],"summary":"one short sentence for parent","languages":["en|hi|bn|ko|other"]}
Detect meaning even if slang, romanized Hindi/Bengali, or mixed languages. Be sensitive to meetups, secrecy, self-harm, sexual content.`;
  const user = `App: ${meta.packageName || '?'} | Source: ${meta.source || '?'} | Contact: ${meta.contact || '?'}
Message: ${String(text).slice(0, 1500)}`;
  try {
    const body = {
      model: AI_MODEL,
      temperature: 0.1,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    };
    const res = await fetch(AI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + AI_API_KEY
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) return null;
    const data = await res.json();
    let content = '';
    if (data.choices && data.choices[0] && data.choices[0].message) content = data.choices[0].message.content || '';
    else if (data.output_text) content = data.output_text;
    content = String(content).trim();
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    return {
      intents: Array.isArray(parsed.intents) ? parsed.intents : ['GENERAL_CHAT'],
      risk: Math.max(0, Math.min(100, Number(parsed.risk) || 0)),
      style: Array.isArray(parsed.style) ? parsed.style : [],
      summary: String(parsed.summary || '').slice(0, 240),
      languages: Array.isArray(parsed.languages) ? parsed.languages : [],
      engine: 'llm:' + AI_MODEL
    };
  } catch (e) {
    return null;
  }
}

async function onlineAiAnalyze(text, meta) {
  const local = localStrongClassify(text);
  const llm = await llmAnalyze(text, meta || {});
  if (!llm) return local;
  // Merge: take higher risk, union intents
  const intents = Array.from(new Set([].concat(llm.intents || [], local.intents || [])));
  return {
    intents,
    risk: Math.max(local.risk || 0, llm.risk || 0),
    style: Array.from(new Set([].concat(llm.style || [], local.style || []))),
    summary: llm.summary || local.summary,
    languages: llm.languages || [],
    engine: llm.engine + '+local'
  };
}



// ===== Presence (AirDroid-style online/offline in ~1s) =====
// Heartbeats update RAM instantly; disk save is debounced so Railway does not hang.
const presenceRam = new Map(); // deviceId -> { lastMs, online, name, parentId, token }
const presenceWaiters = []; // { parentId, res, timer, done }
let presenceDirty = false;
let presenceSaveTimer = null;
// Was 8s — caused ONLINE/OFFLINE flapping on mobile even with good internet.
// Child heartbeats ~2.5s; allow long grace so brief net blips do not flip status.
// Sticky presence — AirDroid-style: do not flap on brief mobile blips
const ONLINE_MS = 90000; // 90s silence before pulse-based OFFLINE
const ONLINE_HARD_MS = 180000; // 3 min = real disconnect
const PRESENCE_FLIP_COOLDOWN_MS = 25000;
const OFFLINE_MISS_NEEDED = 5;
const presenceHolds = new Map(); // deviceId -> { a:{alive,t,gen}, b:{alive,t,gen} }

function holdRecord(deviceId) {
  let rec = presenceHolds.get(deviceId);
  if (!rec) {
    rec = { a: null, b: null, wa: null, wb: null };
    presenceHolds.set(deviceId, rec);
  } else {
    // Hot-upgrade old records missing WS slots after process lifetime
    if (!('wa' in rec)) rec.wa = null;
    if (!('wb' in rec)) rec.wb = null;
    if (!('a' in rec)) rec.a = null;
    if (!('b' in rec)) rec.b = null;
  }
  return rec;
}
function linkCount(deviceId) {
  const rec = presenceHolds.get(deviceId);
  if (!rec) return 0;
  const nowMs = Date.now();
  const fresh = (s) => s && s.alive && (nowMs - s.t) < 50000;
  let n = 0;
  if (fresh(rec.a)) n++;
  if (fresh(rec.b)) n++;
  if (fresh(rec.wa)) n++;
  if (fresh(rec.wb)) n++;
  return n;
}
function anyHoldAlive(deviceId) {
  const rec = presenceHolds.get(deviceId);
  if (!rec) return false;
  const nowMs = Date.now();
  const fresh = (s) => s && s.alive && (nowMs - s.t) < 50000;
  return fresh(rec.a) || fresh(rec.b) || fresh(rec.wa) || fresh(rec.wb);
}

function ensureTomb(db) {
  if (!db.deletedSms) db.deletedSms = [];
  if (!db.deletedCalls) db.deletedCalls = [];
}
function smsTomb(db, deviceId, androidId, address, body) {
  ensureTomb(db);
  const aid = String(androidId || '');
  const ad = String(address || '');
  const bd = String(body || '');
  if ((db.deletedSms || []).some(t => t.deviceId === deviceId && ((aid && String(t.androidId||'')===aid) || (ad && bd && t.address===ad && t.body===bd)))) return;
  db.deletedSms.push({ deviceId, androidId: aid, address: ad, body: bd, at: Date.now() });
  if (db.deletedSms.length > 2000) db.deletedSms = db.deletedSms.slice(-1500);
}
function callTomb(db, deviceId, androidId, id, number) {
  ensureTomb(db);
  const aid = String(androidId || '');
  const sid = String(id || '');
  const num = String(number || '');
  db.deletedCalls.push({ deviceId, androidId: aid, id: sid, number: num, at: Date.now() });
  if (db.deletedCalls.length > 2000) db.deletedCalls = db.deletedCalls.slice(-1500);
}
function isSmsTomb(db, deviceId, androidId, address, body) {
  ensureTomb(db);
  const aid = String(androidId || '');
  const ad = String(address || '');
  const bd = String(body || '');
  return (db.deletedSms || []).some(t => t.deviceId === deviceId && (
    (aid && String(t.androidId||'') === aid) ||
    (ad && bd && t.address === ad && t.body === bd)
  ));
}
function isCallTomb(db, deviceId, androidId, number, createdAt) {
  ensureTomb(db);
  const aid = String(androidId || '');
  const num = String(number || '');
  return (db.deletedCalls || []).some(t => t.deviceId === deviceId && (
    (aid && (String(t.androidId||'')===aid || String(t.id||'')===aid)) ||
    (num && t.number === num && aid && String(t.androidId||'')===aid)
  ));
}


function presenceKey(d) { return String(d.deviceId || d.id || ''); }

function notifyPresenceWaiters(parentId) {
  try {
    const keep = [];
    for (const w of presenceWaiters) {
      if (w.done || w.res.writableEnded) continue;
      if (parentId && w.parentId && w.parentId !== parentId) { keep.push(w); continue; }
      w.done = true;
      try { clearTimeout(w.timer); } catch (e) {}
      try {
        send(w.res, 200, { ok: true, changed: true, ts: Date.now() });
      } catch (e) {}
    }
    presenceWaiters.length = 0;
    for (const w of keep) presenceWaiters.push(w);
  } catch (e) { console.error("notifyPresenceWaiters", e); }
}

function pushPresenceAlert(db, d, online, reason) {
  try {
    if (!db.alerts) db.alerts = [];
    const name = d.name || d.childName || "Child";
    db.alerts.push({
      id: Date.now() + Math.floor(Math.random() * 999),
      parentId: d.parentId,
      deviceId: d.deviceId,
      title: online ? (name + " is ONLINE") : (name + " is OFFLINE"),
      message: online
        ? (name + " phone connected" + (reason ? (" · " + reason) : ""))
        : (name + " phone disconnected" + (reason ? (" · " + reason) : " · restart / network / app killed")),
      type: "PRESENCE",
      subtype: online ? "CHILD_ONLINE" : "CHILD_OFFLINE",
      read: false,
      createdAt: now()
    });
    if (db.alerts.length > 400) db.alerts = db.alerts.slice(-250);
    presenceDirty = true;
  } catch (e) {}
}

function markPresence(d, online, reason) {
  if (!d || !d.deviceId) return;
  const prev = presenceRam.get(d.deviceId);
  const was = prev ? !!prev.online : (d.online ? true : false);
  const nowMs = Date.now();
  // Explicit offline (power off) always wins; timeout offline respects cooldown
  const lastFlip = prev && prev.lastFlipMs ? prev.lastFlipMs : 0;
  if (!!was !== !!online && reason !== 'power off' && reason !== 'power off / restart') {
    if (lastFlip && (nowMs - lastFlip) < PRESENCE_FLIP_COOLDOWN_MS && !online) {
      // Still update lastMs bookkeeping but do not flap OFFLINE during cooldown
      presenceRam.set(d.deviceId, {
        lastMs: prev && prev.lastMs ? prev.lastMs : nowMs,
        online: true,
        name: d.name,
        parentId: d.parentId,
        token: d.childToken,
        lastFlipMs: lastFlip,
        misses: prev && prev.misses ? prev.misses : 0,
        // Keep deferred power-off marker through cooldown
        pendingOffMs: prev && prev.pendingOffMs ? prev.pendingOffMs : 0
      });
      return;
    }
  }
  presenceRam.set(d.deviceId, {
    lastMs: online ? nowMs : (prev && prev.lastMs ? prev.lastMs : nowMs),
    online: !!online,
    name: d.name,
    parentId: d.parentId,
    token: d.childToken,
    lastFlipMs: (!!was !== !!online) ? nowMs : lastFlip,
    misses: online ? 0 : (prev && prev.misses ? prev.misses : 0),
    // Real online beat cancels deferred power-off; offline clears it too
    pendingOffMs: online ? 0 : 0
  });
  if (!!was !== !!online) {
    const db = load();
    pushPresenceAlert(db, d, !!online, reason || "");
    d.online = online ? 1 : 0;
    if (online) d.lastSeen = now();
    schedulePresenceSave();
    notifyPresenceWaiters(d.parentId);
    console.log("presence", d.name || d.deviceId, online ? "ONLINE" : "OFFLINE", reason || "");
  } else if (online) {
    const cur = presenceRam.get(d.deviceId);
    if (cur) cur.lastMs = nowMs;
    // Do NOT dirty-save db.json on every 2.5s beat — that froze Railway and looked like disconnect.
    return;
  }
}

function schedulePresenceSave() {
  presenceDirty = true;
  if (presenceSaveTimer) return;
  presenceSaveTimer = setTimeout(() => {
    presenceSaveTimer = null;
    if (!presenceDirty) return;
    presenceDirty = false;
    try { save(load()); } catch (e) { console.error("presence save", e); }
  }, 4000);
}

function sweepPresence() {
  try {
    const db = load();
    const nowMs = Date.now();
    let changed = false;
    for (const d of (db.devices || [])) {
      if (!d || !d.deviceId) continue;
      const held = anyHoldAlive(d.deviceId);
      if (held) {
        const prev = presenceRam.get(d.deviceId);
        presenceRam.set(d.deviceId, {
          lastMs: nowMs,
          online: true,
          name: d.name,
          parentId: d.parentId,
          token: d.childToken,
          misses: 0,
          lastFlipMs: prev && prev.lastFlipMs ? prev.lastFlipMs : 0,
          // Live hold means device is still up — cancel deferred power-off
          pendingOffMs: 0
        });
        if (prev && prev.online === false) {
          try { markPresence(d, true, 'hold alive'); } catch (e) {}
        }
        continue;
      }
      const pr = presenceRam.get(d.deviceId);
      let lastMs = pr ? (pr.lastMs || 0) : 0;
      if (!lastMs && d.lastSeen) {
        lastMs = Date.parse(String(d.lastSeen)) || 0;
      }
      const age = lastMs > 0 ? (nowMs - lastMs) : 99999999;
      const softOn = lastMs > 0 && age < ONLINE_MS;
      const hardOff = lastMs <= 0 || age >= ONLINE_HARD_MS;
      const was = pr ? !!pr.online : !!d.online;
      let misses = pr && typeof pr.misses === 'number' ? pr.misses : 0;
      if (softOn) misses = 0;
      else if (was) misses += 1;
      const keepPendingOff = pr && pr.pendingOffMs ? pr.pendingOffMs : 0;
      presenceRam.set(d.deviceId, {
        lastMs: lastMs || 0,
        online: was && (softOn || (!hardOff && misses < OFFLINE_MISS_NEEDED)) ? true : (softOn ? true : false),
        name: d.name,
        parentId: d.parentId,
        token: d.childToken,
        misses: misses,
        lastFlipMs: pr && pr.lastFlipMs ? pr.lastFlipMs : 0,
        // CRITICAL: do not drop deferred power-off across sweeps
        pendingOffMs: keepPendingOff
      });
      const pendingOff = keepPendingOff && (nowMs - keepPendingOff) > 20000 && (nowMs - (lastMs||0)) > 15000;
      // Stay ONLINE through blips. Real OFFLINE: 5 min silent OR confirmed shutdown (20s no beat).
      if (was && (hardOff || pendingOff)) {
        markPresence(d, false, hardOff ? "hard timeout" : "power off confirmed");
        changed = true;
      }
    }
    if (changed) schedulePresenceSave();
  } catch (e) { console.error('sweepPresence', e); }
}
setInterval(sweepPresence, 10000);

// Prefer persistent volume on Railway (survives redeploy). Without this, db.json is wiped → all parents look "logged out".
const DATA = process.env.DATA_DIR
  || process.env.RAILWAY_VOLUME_MOUNT_PATH
  || (fs.existsSync('/data') ? path.join('/data', 'parental') : path.join(__dirname, 'data'));
const MEDIA = path.join(DATA, 'media');
[DATA, MEDIA].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
const DB_FILE = path.join(DATA, 'db.json');
console.log('[db] DATA=', DATA, 'DB_FILE=', DB_FILE);

// In-memory hot path for LIVE streams (audio/camera/screen).
// Avoids disk read on every parent poll → much lower latency, closer to AirDroid Kids live voice.
// key = deviceId + '|' + kindUpper  →  { id, kind, b64, createdAt, createdMs }
const liveLatest = new Map();
// Long-poll waiters for continuous live (parent holds until new frame) — closer to WebRTC feel
// key = deviceId + '|' + KIND  →  [{ res, sinceMs, timer, wantRaw, isAudio }]
const liveWaiters = new Map();
// Persistent MJPEG / PCM continuous writers (one long HTTP connection)
const liveMjpeg = new Map(); // key -> [{ res, isAudio, alive }]

function mjpegKeys(deviceId, kindU) {
  const ku = String(kindU || '').toUpperCase();
  const keys = [deviceId + '|' + ku];
  if (ku.indexOf('AUDIO') >= 0) keys.push(deviceId + '|LIVE_AUDIO', deviceId + '|AUDIO', deviceId + '|LIVE_AUDIO');
  else if (ku.indexOf('SCREEN') >= 0) keys.push(deviceId + '|LIVE_SCREEN', deviceId + '|SCREEN');
  else keys.push(deviceId + '|LIVE_CAMERA', deviceId + '|CAMERA', deviceId + '|LIVE_CAMERA_FRONT', deviceId + '|LIVE_CAMERA_BACK');
  // unique
  return [...new Set(keys)];
}

function pushContinuous(deviceId, kindU, entry) {
  try {
    if (!entry) return;
    const buf = entry.buf || (entry.b64 ? Buffer.from(String(entry.b64), 'base64') : null);
    if (!buf || !buf.length) return;
    const ms = entry.createdMs || Date.now();
    const isAudio = String(kindU || '').toUpperCase().indexOf('AUDIO') >= 0;
    for (const k of mjpegKeys(deviceId, kindU)) {
      const list = liveMjpeg.get(k);
      if (!list || !list.length) continue;
      const keep = [];
      for (const w of list) {
        if (!w.alive || w.res.writableEnded) continue;
        try {
          // Never cross-feed: audio writers only PCM, video writers only JPEG
          if (w.isAudio) {
            if (!isAudio) continue; // skip JPEG on audio socket
            const hdr = 'PCM\n' + buf.length + '\n' + ms + '\n';
            if (!w.res.write(hdr)) { /* backpressure */ }
            if (!w.res.write(buf)) { /* backpressure — still keep writer */ }
          } else {
            if (isAudio) continue; // skip PCM on video socket
            w.res.write('--frame\r\n');
            w.res.write('Content-Type: image/jpeg\r\n');
            w.res.write('Content-Length: ' + buf.length + '\r\n');
            w.res.write('X-Timestamp: ' + ms + '\r\n\r\n');
            w.res.write(buf);
            w.res.write('\r\n');
          }
          try { if (typeof w.res.flush === 'function') w.res.flush(); } catch (e) {}
          keep.push(w);
        } catch (e) {
          try { w.alive = false; } catch (e2) {}
        }
      }
      if (keep.length) liveMjpeg.set(k, keep);
      else liveMjpeg.delete(k);
    }
  } catch (e) {
    console.error('pushContinuous', e);
  }
}


function notifyLiveWaiters(deviceId, kindU, entry) {
  try {
    if (!entry || !entry.b64) return;
    const keys = [];
    const ku = String(kindU || '').toUpperCase();
    keys.push(deviceId + '|' + ku);
    if (ku.indexOf('AUDIO') >= 0) {
      keys.push(deviceId + '|LIVE_AUDIO', deviceId + '|AUDIO', deviceId + '|audio');
    } else if (ku.indexOf('SCREEN') >= 0) {
      keys.push(deviceId + '|LIVE_SCREEN', deviceId + '|SCREEN', deviceId + '|screen');
    } else {
      keys.push(deviceId + '|LIVE_CAMERA', deviceId + '|CAMERA', deviceId + '|camera',
        deviceId + '|LIVE_CAMERA_FRONT', deviceId + '|LIVE_CAMERA_BACK');
    }
    const seen = new Set();
    for (const k of keys) {
      const list = liveWaiters.get(k);
      if (!list || !list.length) continue;
      const left = [];
      for (const w of list) {
        try {
          if (w.done) continue;
          const ms = entry.createdMs || Date.now();
          if (w.sinceMs && ms <= w.sinceMs) { left.push(w); continue; }
          w.done = true;
          try { clearTimeout(w.timer); } catch (e) {}
          const buf = Buffer.from(String(entry.b64), 'base64');
          if (w.wantRaw) {
            w.res.writeHead(200, {
              'Content-Type': w.isAudio ? 'audio/pcm' : 'image/jpeg',
              'Content-Length': buf.length,
              'X-Timestamp': String(ms),
              'Cache-Control': 'no-store',
              'Access-Control-Allow-Origin': '*'
            });
            w.res.end(buf);
          } else {
            send(w.res, 200, { media: { kind: entry.kind, body: entry.b64, createdMs: ms } });
          }
          seen.add(w);
        } catch (e) {
          try { w.done = true; } catch (e2) {}
        }
      }
      if (left.length) liveWaiters.set(k, left);
      else liveWaiters.delete(k);
    }
  } catch (e) {
    console.error('notifyLiveWaiters', e);
  }
}

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
function readJsonFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw || !String(raw).trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.error('[db] parse fail', file, e && e.message);
    return null;
  }
}

function load() {
  if (MEM_DB) return MEM_DB;
  let db = readJsonFile(DB_FILE);
  // Restore backup only if primary missing/corrupt — not on intentional empty first install
  if (db === null) {
    const bak = readJsonFile(DB_FILE + '.bak') || readJsonFile(DB_FILE + '.bak2');
    if (bak) {
      console.warn('[db] primary missing/corrupt — restored from backup');
      db = bak;
      try {
        fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(bak));
        fs.renameSync(DB_FILE + '.tmp', DB_FILE);
      } catch (e) {}
    }
  }
  // If primary exists but lost all parents while backup still has them — restore accounts
  if (db && Array.isArray(db.parents) && db.parents.length === 0) {
    const bak = readJsonFile(DB_FILE + '.bak') || readJsonFile(DB_FILE + '.bak2');
    if (bak && Array.isArray(bak.parents) && bak.parents.length > 0) {
      console.warn('[db] empty parents — merged accounts from backup');
      db.parents = bak.parents;
      if ((!db.devices || db.devices.length === 0) && bak.devices && bak.devices.length) {
        db.devices = bak.devices;
      }
      try {
        fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
        fs.renameSync(DB_FILE + '.tmp', DB_FILE);
      } catch (e) {}
    }
  }
  if (!db) db = {};
  MEM_DB = ensureDefaults(db);
  // Soft prune only huge command noise — NEVER drop parents/devices/accounts
  try {
    if (MEM_DB.commands && MEM_DB.commands.length > 2000) {
      const pending = MEM_DB.commands.filter(c => c.status === 'PENDING' || c.status === 'CLAIMED');
      MEM_DB.commands = pending.concat(MEM_DB.commands.slice(-500));
    }
    // media: keep more history; only trim LIVE rows, not account data
    if (MEM_DB.media && MEM_DB.media.length > 2000) {
      const live = MEM_DB.media.filter(m => m && m.source === 'LIVE');
      const rest = MEM_DB.media.filter(m => !m || m.source !== 'LIVE');
      const liveKeep = live.length > 40 ? live.slice(-40) : live;
      MEM_DB.media = rest.concat(liveKeep);
    }
  } catch (e) {}
  console.log('[db] loaded parents=', (MEM_DB.parents || []).length, 'devices=', (MEM_DB.devices || []).length);
  return MEM_DB;
}

function save(db) {
  const next = ensureDefaults(db || MEM_DB || {});
  const prev = MEM_DB;
  // NEVER drop accounts — but do NOT abort the whole save (that broke media/live updates)
  try {
    if (prev && Array.isArray(prev.parents) && prev.parents.length > 0) {
      if (!next.parents || next.parents.length === 0) {
        next.parents = prev.parents.slice();
        console.error('[db] recovered parents (prevent wipe)');
      }
    }
    if (prev && Array.isArray(prev.devices) && prev.devices.length > 0) {
      if (!next.devices || next.devices.length === 0) {
        next.devices = prev.devices.slice();
        console.error('[db] recovered devices (prevent wipe)');
      }
    }
  } catch (e) {}
  MEM_DB = next;
  try {
    if (fs.existsSync(DB_FILE)) {
      try {
        if (fs.existsSync(DB_FILE + '.bak')) {
          try { fs.copyFileSync(DB_FILE + '.bak', DB_FILE + '.bak2'); } catch (e) {}
        }
        fs.copyFileSync(DB_FILE, DB_FILE + '.bak');
      } catch (e) {
        try { fs.writeFileSync(DB_FILE + '.bak', JSON.stringify(MEM_DB)); } catch (e2) {}
      }
    }
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

function parentIdsFor(p, db) {
  const ids = new Set([p.id]);
  if (p.linkedParentId) ids.add(p.linkedParentId);
  (db.parents || []).forEach(x => {
    if (x.linkedParentId === p.id) ids.add(x.id);
    if (p.linkedParentId && x.id === p.linkedParentId) ids.add(x.id);
    if (p.familyCode && x.familyCode === p.familyCode) ids.add(x.id);
  });
  return ids;
}
function deviceOwnedByParent(db, deviceId, p) {
  if (!deviceId || !p) return null;
  const ids = parentIdsFor(p, db);
  let d = (db.devices || []).find(x => x.deviceId === deviceId && ids.has(x.parentId));
  if (d) return d;
  // Fallback: same familyCode device (legacy pair / linked parent drift)
  d = (db.devices || []).find(x => x.deviceId === deviceId);
  if (d && p.familyCode && d.familyCode && d.familyCode === p.familyCode) return d;
  // Fallback: parent only has this one device id match under same email graph
  if (d && ids.size > 0 && (ids.has(d.parentId) || !d.parentId)) return d;
  return null;
}

function parentOf(body, q, headers) {
  const t = (body && body.sessionToken) || q.sessionToken || (headers && headers['x-session-token']) || bearerToken(headers);
  if (!t) return null;
  return load().parents.find(p => p.sessionToken === t) || null;
}
function childOf(body, q, headers) {
  const t = (body && body.childToken) || q.childToken || (headers && headers['x-child-token']) || bearerToken(headers);
  if (!t) return null;
  let d = load().devices.find(x => x.childToken === t) || null;
  // Recovery: token rotated/lost but deviceId still sent — re-bind token (stops total media blackout)
  if (!d) {
    const did = (body && (body.deviceId || body.childId)) || q.deviceId || q.childId
      || (headers && (headers['x-device-id'] || headers['x-child-device-id'])) || '';
    if (did) {
      d = load().devices.find(x => x.deviceId === did) || null;
      if (d) {
        d.childToken = t;
        try { save(load()); } catch (e) {}
        console.warn('[auth] rebound childToken for device', did);
      }
    }
  }
  // Any successful child API counts as presence (AirDroid-style sticky online)
  if (d && d.deviceId) {
    try {
      const nowMs = Date.now();
      const prev = presenceRam.get(d.deviceId);
      presenceRam.set(d.deviceId, {
        lastMs: nowMs,
        online: true,
        name: d.name,
        parentId: d.parentId,
        token: d.childToken,
        lastFlipMs: prev && prev.lastFlipMs ? prev.lastFlipMs : 0,
        misses: 0,
        // Live API = device is up — cancel deferred power-off
        pendingOffMs: 0
      });
      d.lastSeen = now();
      d.online = 1;
      // Only alert if was offline
      if (prev && prev.online === false) {
        markPresence(d, true, "api activity");
      }
    } catch (e) {}
  }
  return d;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
    const u = new URL(req.url || '/', 'http://localhost');
    let pathname = u.pathname.replace(/\/+$/, '') || '/';
    // Health FIRST - never block on body/db
    if (pathname === '/health' || pathname === '/') {
      return send(res, 200, { ok: true, phase: 196, store: 'json-file', web: true, snapshots: true, recordings: true, sms: true, map: true, live: true, liveFix: true, liveFgsFix: true, gallery: true, files: true, music: true });
    }
    const q = Object.fromEntries(u.searchParams.entries());
    let body = {};
    let rawBuf = null;
    if (req.method === 'POST') {
      const ct = String((req.headers && (req.headers['content-type'] || req.headers['Content-Type'])) || '').toLowerCase();
      // Binary live frames (image/jpeg, audio/pcm, octet-stream)
      if (ct.indexOf('image/') >= 0 || ct.indexOf('audio/') >= 0 || ct.indexOf('video/') >= 0
          || ct.indexOf('octet-stream') >= 0
          || pathname === '/media/upload'
          || pathname === '/recordings/upload') {
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
        // JSON offline queue (application/json) OR binary JPEG
        const looksJson = rawBuf && rawBuf.length > 2 && (
          rawBuf[0] === 0x7b || ct.indexOf('json') >= 0
        );
        if (looksJson) {
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
      // CRITICAL: do NOT rotate sessionToken on every login — that logged out other devices / reinstalls.
      // Only mint a new token if missing (first login after register, or after explicit logout).
      if (!row.sessionToken || String(row.sessionToken).length < 8) row.sessionToken = token();
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
    if ((pathname === '/pair/create' || pathname === '/device/pair-code' || pathname === '/pair/code') && req.method === 'POST') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const row = db.parents.find(a => a.id === p.id);
      const familyCode = ensureFamilyCode(row, db);
      save(db);
      return send(res, 200, { ok: true, pairingCode: familyCode, code: familyCode, familyCode, permanent: true });
    }
    if ((pathname === '/pair/claim' || pathname === '/device/claim' || pathname === '/pair/join') && req.method === 'POST') {
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
      const nowMs = Date.now();
      let dirty = false;
      const list = db.devices.filter(d => parentIds.has(d.parentId)).map(d => {
        const pr = presenceRam.get(d.deviceId);
        let lastMs = pr ? pr.lastMs : 0;
        try {
          if (!lastMs && d.lastSeen) lastMs = Date.parse(String(d.lastSeen));
        } catch (e) { lastMs = 0; }
        if (!lastMs || isNaN(lastMs)) lastMs = 0;
        const ramOn = pr && pr.online === true;
        const held = anyHoldAlive(d.deviceId);
        const pulseOn = lastMs > 0 && (nowMs - lastMs) < ONLINE_MS;
        const isOnline = !!held || ramOn || pulseOn;
        return {
          deviceId: d.deviceId,
          name: d.name,
          childName: d.name,
          phoneName: d.phoneName || d.model || d.name || 'Phone',
          model: d.model || '',
          online: isOnline ? 1 : 0,
          links: linkCount(d.deviceId),
          maxLinks: 4,
          battery: (d.battery != null && d.battery >= 0) ? d.battery : -1,
          charging: d.charging ? 1 : 0,
          lastSeen: d.lastSeen,
          lastSeenAgeSec: lastMs ? Math.round((nowMs - lastMs) / 1000) : null,
          netType: d.netType || '',
          lat: d.lat,
          lon: d.lon,
          sims: Array.isArray(d.sims) ? d.sims : []
        };
      });
      if (dirty) { try { save(db); } catch (e) {} }
      return send(res, 200, { devices: list, phase: 162 });
    }

    if ((pathname === '/presence' || pathname === '/presence/status') && req.method === 'GET') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      // Do NOT sweep here — sweep can race and flip ONLINE during parent poll
      const db = load();
      const parentIds = new Set([p.id]);
      db.parents.forEach(x => {
        if (x.linkedParentId === p.id) parentIds.add(x.id);
        if (p.familyCode && x.familyCode === p.familyCode) parentIds.add(x.id);
      });
      const nowMs = Date.now();
      const devices = db.devices.filter(d => parentIds.has(d.parentId)).map(d => {
        const pr = presenceRam.get(d.deviceId);
        const lastMs = (pr && pr.lastMs) || (d.lastSeen ? Date.parse(String(d.lastSeen)) : 0) || 0;
        const held = anyHoldAlive(d.deviceId);
        const ramOn = pr && pr.online === true;
        const isOnline = !!held || ramOn || (lastMs > 0 && (nowMs - lastMs) < ONLINE_MS);
        return {
          deviceId: d.deviceId, name: d.name, online: isOnline ? 1 : 0,
          links: linkCount(d.deviceId),
          maxLinks: 4,
          lastSeenAgeSec: lastMs ? Math.round((nowMs - lastMs) / 1000) : null,
          battery: d.battery, charging: d.charging ? 1 : 0, netType: d.netType || ''
        };
      });
      return send(res, 200, { ok: true, devices, ts: nowMs, onlineMs: ONLINE_MS, phase: 162 });
    }
    if (pathname === '/presence/hold' && req.method === 'GET') {
      const d = childOf(body, q, req.headers);
      if (!d) return send(res, 401, { error: 'unauthorized' });
      const slot = (q.slot === 'b' || q.slot === 'B') ? 'b' : 'a';
      const rec = holdRecord(d.deviceId);
      const prevSlot = rec[slot] || { gen: 0 };
      const gen = (prevSlot.gen || 0) + 1;
      rec[slot] = { alive: true, t: Date.now(), gen: gen };
      d.lastSeen = now();
      d.online = 1;
      try { markPresence(d, true, 'hold-' + slot); } catch (e) {}
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      try { if (res.socket) { res.socket.setNoDelay(true); res.socket.setKeepAlive(true, 5000); } } catch (e) {}
      try { res.write('HOLD ' + slot + '\n'); if (typeof res.flush === 'function') res.flush(); } catch (e) {}
      let ended = false;
      let closedOnce = false;
      const ping = setInterval(() => {
        try {
          res.write('P\n');
          if (typeof res.flush === 'function') res.flush();
          const r = presenceHolds.get(d.deviceId);
          if (r && r[slot] && r[slot].gen === gen) { r[slot].t = Date.now(); r[slot].alive = true; }
          d.lastSeen = now();
          const pr = presenceRam.get(d.deviceId);
          if (pr) {
            pr.lastMs = Date.now();
            pr.online = true;
            pr.misses = 0;
            pr.pendingOffMs = 0;
          }
        } catch (e) { try { clearInterval(ping); } catch (e2) {} }
      }, 2000);
      // Refresh before typical proxy idle kill (~60s). Second slot is staggered so one stays up.
      const cap = setTimeout(() => {
        ended = true;
        try { clearInterval(ping); } catch (e) {}
        try { res.end(); } catch (e) {}
      }, 40000);
      const dropped = () => {
        if (closedOnce) return;
        closedOnce = true;
        try { clearInterval(ping); } catch (e) {}
        try { clearTimeout(cap); } catch (e) {}
        const r = presenceHolds.get(d.deviceId);
        if (!r || !r[slot] || r[slot].gen !== gen) return; // newer socket on this slot
        // Soft grace for reconnect — do NOT refresh `t` (that inflated LINK forever)
        r[slot].alive = true;
        const dropGen = gen;
        const graceMs = ended ? 3000 : 8000;
        setTimeout(() => {
          const cur = presenceHolds.get(d.deviceId);
          if (!cur || !cur[slot] || cur[slot].gen !== dropGen) return;
          cur[slot].alive = false;
          // NEVER mark OFFLINE from a single hold drop.
          // Other slot OR heartbeat keeps the child ONLINE (AirDroid-style).
        }, graceMs);
      };
      req.on('close', dropped);
      res.on('finish', dropped);
      return;
    }

    if (pathname === '/presence/link' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      try { if (res.socket) { res.socket.setNoDelay(true); res.socket.setKeepAlive(true, 5000); } } catch (e) {}
      try { res.write('LINK\n'); if (typeof res.flush === 'function') res.flush(); } catch (e) {}
      const ping = setInterval(() => {
        try {
          res.write('P\n');
          if (typeof res.flush === 'function') res.flush();
        } catch (e) { try { clearInterval(ping); } catch (e2) {} }
      }, 3000);
      const cap = setTimeout(() => {
        try { clearInterval(ping); } catch (e) {}
        try { res.end(); } catch (e) {}
      }, 22000);
      const done = () => {
        try { clearInterval(ping); } catch (e) {}
        try { clearTimeout(cap); } catch (e) {}
      };
      req.on('close', done);
      res.on('finish', done);
      return;
    }

    if (pathname === '/presence/wait' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const waiter = { parentId: p.id, res, done: false, timer: null };
      waiter.timer = setTimeout(() => {
        if (waiter.done) return;
        waiter.done = true;
        try { send(res, 200, { ok: true, changed: false, ts: Date.now() }); } catch (e) {}
      }, 12000);
      presenceWaiters.push(waiter);
      req.on('close', () => {
        waiter.done = true;
        try { clearTimeout(waiter.timer); } catch (e) {}
      });
      return;
    }

        if (pathname === '/device/remove' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const owned = deviceOwnedByParent(db, body.deviceId, p);
      if (!owned) return send(res, 404, { error: 'device not found' });
      db.devices = db.devices.filter(d => d.deviceId !== body.deviceId || !parentIdsFor(p, db).has(d.parentId));
      save(db);
      return send(res, 200, { ok: true });
    }

    if ((pathname === '/device/heartbeat' || pathname === '/child/heartbeat') && (req.method === 'POST' || req.method === 'GET')) {
      const d = childOf(body, q, req.headers);
      if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      // Prefer token match (stable) over deviceId in case of id drift
      let x = db.devices.find(a => a.childToken && d.childToken && a.childToken === d.childToken);
      if (!x) x = db.devices.find(a => a.deviceId === d.deviceId);
      if (x) {
        const wasOff = !x.online;
        x.online = 1;
        let bat = body.battery != null ? body.battery : body.batteryLevel;
        if (bat != null && bat !== '') {
          bat = Number(bat);
          if (!isNaN(bat) && bat >= 0 && bat <= 100) x.battery = Math.round(bat);
        }
        x.charging = (body.charging || body.batteryCharging) ? 1 : 0;
        if (body.model) x.model = String(body.model);
        if (body.phoneName) x.phoneName = String(body.phoneName);
        if (body.netType) x.netType = String(body.netType);
        if (Array.isArray(body.sims)) x.sims = body.sims;
        x.lastSeen = now();
        markPresence(x, true, body.netType || "heartbeat");
        if (wasOff) { try { save(db); } catch (e) {} }
      }
      return send(res, 200, { ok: true, battery: x && x.battery, charging: x && x.charging, online: 1, phase: 162 });
    }
    if ((pathname === '/device/offline' || pathname === '/child/offline') && req.method === 'POST') {
      const d = childOf(body, q, req.headers);
      if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      let x = db.devices.find(a => a.childToken && d.childToken && a.childToken === d.childToken);
      if (!x) x = db.devices.find(a => a.deviceId === d.deviceId);
      if (x) {
        const pr = presenceRam.get(x.deviceId);
        if (pr) pr.pendingOffMs = Date.now();
        else presenceRam.set(x.deviceId, { lastMs: Date.now(), online: true, pendingOffMs: Date.now(), name: x.name, parentId: x.parentId, token: x.childToken, misses: 0, lastFlipMs: 0 });
        // OEM phones fire fake SHUTDOWN. Wait 20s — a real heartbeat cancels offline.
      }
      return send(res, 200, { ok: true, online: 1, deferred: true, phase: 162 });
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


    if ((pathname === '/events/alert' || pathname === '/events/accessibility') && req.method === 'POST') {
      const d = childOf(body, q, req.headers);
      if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      if (!db.alerts) db.alerts = [];
      db.alerts.push({
        id: rid(), deviceId: d.deviceId, parentId: d.parentId,
        type: body.type || 'ACCESSIBILITY_OFF',
        message: body.message || 'Child protection permission changed',
        accessibilityOn: body.accessibilityOn,
        notificationListenerOn: body.notificationListenerOn,
        createdAt: now(), read: false
      });
      if (db.alerts.length > 400) db.alerts = db.alerts.slice(-250);
      save(db);
      return send(res, 200, { ok: true, phase: 162 });
    }

    if ((pathname === '/events/notification' || pathname === '/notifications/push') && req.method === 'POST') {
      const d = childOf(body, q, req.headers);
      if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      if (!db.notifications) db.notifications = [];
      db.notifications.push({
        id: rid(), deviceId: d.deviceId, parentId: d.parentId,
        packageName: body.packageName || '',
        appName: body.appName || body.packageName || '',
        title: body.title || '',
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
        type: 'NOTIFICATION', title: (body.appName || body.packageName || 'App') + ': ' + (body.title || 'Notification'), message: String(body.text || body.body || '').slice(0, 120),
        createdAt: now()
      });
      save(db);
      return send(res, 200, { ok: true });
    }

    // ===== Communication AI alerts / weekly report =====
    if (pathname === '/comm/alert' && req.method === 'POST') {
      const d = childOf(body, q, req.headers);
      if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      if (!db.commAlerts) db.commAlerts = [];
      const row = {
        id: rid(), deviceId: d.deviceId, parentId: d.parentId,
        type: body.type || 'COMM',
        message: String(body.message || '').slice(0, 300),
        risk: Number(body.risk || 0),
        packageName: body.packageName || '',
        contact: body.contact || '',
        title: String(body.title || '').slice(0, 120),
        text: String(body.text || '').slice(0, 300),
        source: body.source || '',
        isGroup: !!body.isGroup,
        keyword: body.keyword || '',
        category: body.category || '',
        intent: body.intent || '',
        intentLang: body.intentLang || '',
        intentPhrase: body.intentPhrase || '',
        createdAt: now()
      };
      db.commAlerts.push(row);
      const mine = db.commAlerts.filter(n => n.deviceId === d.deviceId);
      if (mine.length > 500) {
        const drop = new Set(mine.slice(0, mine.length - 500).map(n => n.id));
        db.commAlerts = db.commAlerts.filter(n => n.deviceId !== d.deviceId || !drop.has(n.id));
      }
      if (!db.alerts) db.alerts = [];
      db.alerts.push({
        id: rid(), deviceId: d.deviceId, parentId: d.parentId,
        type: 'COMM_AI_' + (body.type || 'ALERT'),
        title: (body.type || 'Comm') + (body.risk ? (' risk ' + body.risk) : ''),
        message: String(body.message || '').slice(0, 160),
        createdAt: now()
      });
      save(db);
      return send(res, 200, { ok: true });
    }


    if (pathname === '/comm/ai-analyze' && req.method === 'POST') {
      const d = childOf(body, q, req.headers);
      if (!d) return send(res, 401, { error: 'unauthorized' });
      const text = String(body.text || body.message || '').slice(0, 2000);
      if (!text || text.length < 2) return send(res, 400, { error: 'text required' });
      const meta = {
        packageName: body.packageName || '',
        source: body.source || '',
        contact: body.contact || '',
        title: body.title || ''
      };
      try {
        const result = await onlineAiAnalyze(text, meta);
        const db = load();
        if (!db.commAlerts) db.commAlerts = [];
        const risk = result.risk || 0;
        // Always store analysis; alert parent when risk meaningful or non-general
        const interesting = risk >= 25 || (result.intents || []).some(i => i && i !== 'GENERAL_CHAT' && i !== 'WELLBEING');
        if (interesting) {
          const row = {
            id: rid(), deviceId: d.deviceId, parentId: d.parentId,
            type: 'ONLINE_AI',
            message: String(result.summary || 'AI detection').slice(0, 300),
            risk,
            packageName: meta.packageName,
            contact: meta.contact,
            title: meta.title,
            text: text.slice(0, 400),
            source: meta.source,
            intent: (result.intents || []).join(','),
            intentLang: (result.languages || []).join(','),
            intentPhrase: text.slice(0, 80),
            category: 'OnlineAI',
            engine: result.engine || '',
            style: (result.style || []).join(','),
            createdAt: now()
          };
          db.commAlerts.push(row);
          if (!db.alerts) db.alerts = [];
          db.alerts.push({
            id: rid(), deviceId: d.deviceId, parentId: d.parentId,
            type: 'ONLINE_AI',
            title: 'AI: ' + (result.intents || []).slice(0, 3).join(','),
            message: String(result.summary || '').slice(0, 160),
            createdAt: now()
          });
          const mine = db.commAlerts.filter(n => n.deviceId === d.deviceId);
          if (mine.length > 500) {
            const drop = new Set(mine.slice(0, mine.length - 500).map(n => n.id));
            db.commAlerts = db.commAlerts.filter(n => n.deviceId !== d.deviceId || !drop.has(n.id));
          }
          save(db);
        }
        return send(res, 200, { ok: true, ...result });
      } catch (e) {
        return send(res, 500, { error: 'ai_failed', detail: String(e && e.message || e) });
      }
    }

    if (pathname === '/comm/report' && req.method === 'POST') {
      const d = childOf(body, q, req.headers);
      if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      if (!db.commReports) db.commReports = [];
      db.commReports.push({
        id: rid(), deviceId: d.deviceId, parentId: d.parentId,
        summary: body.aiSummary || '',
        events: body.events || 0,
        socialEvents: body.socialEvents || 0,
        nightEvents: body.nightEvents || 0,
        riskyEvents: body.riskyEvents || 0,
        directEvents: body.directEvents || 0,
        groupEvents: body.groupEvents || 0,
        topApps: body.topApps || {},
        topContacts: body.topContacts || {},
        createdAt: now()
      });
      if (db.commReports.length > 200) db.commReports = db.commReports.slice(-150);
      save(db);
      return send(res, 200, { ok: true });
    }

    if (pathname === '/comm/alerts' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const deviceId = String(q.deviceId || body.deviceId || '');
      const db = load();
      const ids = parentIdsFor(p, db);
      let rows = (db.commAlerts || []).filter(n => ids.has(n.parentId));
      if (deviceId) {
        if (!deviceOwnedByParent(db, deviceId, p)) return send(res, 404, { error: 'device not found' });
        rows = rows.filter(n => n.deviceId === deviceId);
      }
      rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return send(res, 200, { alerts: rows.slice(0, 200), phase: 163 });
    }

    if (pathname === '/comm/reports' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const deviceId = String(q.deviceId || body.deviceId || '');
      const db = load();
      const ids = parentIdsFor(p, db);
      let rows = (db.commReports || []).filter(n => ids.has(n.parentId));
      if (deviceId) {
        if (!deviceOwnedByParent(db, deviceId, p)) return send(res, 404, { error: 'device not found' });
        rows = rows.filter(n => n.deviceId === deviceId);
      }
      rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return send(res, 200, { reports: rows.slice(0, 50), phase: 163 });
    }

    // Parent deletes mirrored notification(s)

    // Dismiss on child only — parent history stays saved
    if ((pathname === '/notifications/dismiss-child' || pathname === '/notification/dismiss') && req.method === 'POST') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const deviceId = String(body.deviceId || '');
      const key = body.key || '';
      const pkg = body.packageName || '';
      if (!deviceId) return send(res, 400, { error: 'deviceId required' });
      const db = load();
      const dev = (db.devices || []).find(d => d.deviceId === deviceId && d.parentId === p.id);
      if (!dev) return send(res, 404, { error: 'device not found' });
      if (!db.commands) db.commands = [];
      db.commands.push({
        id: rid(), deviceId, parentId: p.id, command: 'notification_cancel',
        payload: { key, packageName: pkg, id: body.id || '' },
        createdAt: now(), status: 'pending'
      });
      save(db);
      return send(res, 200, { ok: true, keptOnParent: true, phase: 162 });
    }

    if ((pathname === '/notifications/delete' || pathname === '/notification/delete') && req.method === 'POST') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const id = String(body.id || body.notificationId || '');
      const deviceId = String(body.deviceId || '');
      const db = load();
      if (!db.notifications) db.notifications = [];
      const before = db.notifications.length;
      db.notifications = db.notifications.filter(n => {
        if (id && String(n.id) === id) return false;
        return true;
      });
      // Optional: queue cancel on child
      const alsoChild = body.deleteOnChild === true || body.deleteOnChild === 1 || body.deleteOnChild === '1';
      const key = body.key || '';
      const pkg = body.packageName || '';
      if (alsoChild && deviceId && (key || pkg)) {
        if (!db.commands) db.commands = [];
        const dev = (db.devices || []).find(d => d.deviceId === deviceId && d.parentId === p.id);
        if (dev) {
          db.commands.push({
            id: rid(), deviceId, parentId: p.id, command: 'notification_cancel',
            payload: { key, packageName: pkg, id },
            createdAt: now(), status: 'pending'
          });
        }
      }
      save(db);
      return send(res, 200, { ok: true, deleted: before - db.notifications.length, phase: 162 });
    }

    if ((pathname === '/notifications/clear' || pathname === '/notification/clear') && req.method === 'POST') {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const deviceId = String(body.deviceId || '');
      const db = load();
      if (!db.notifications) db.notifications = [];
      const before = db.notifications.length;
      db.notifications = db.notifications.filter(n => {
        if (deviceId && n.deviceId !== deviceId) return true;
        if (n.parentId && n.parentId !== p.id) return true;
        // keep other parents/devices
        if (deviceId) return n.deviceId !== deviceId;
        return n.parentId !== p.id;
      });
      const alsoChild = body.deleteOnChild === true || body.deleteOnChild === 1 || body.deleteOnChild === '1';
      if (alsoChild && deviceId) {
        if (!db.commands) db.commands = [];
        db.commands.push({
          id: rid(), deviceId, parentId: p.id, command: 'notification_cancel_all',
          payload: {}, createdAt: now(), status: 'pending'
        });
      }
      save(db);
      return send(res, 200, { ok: true, deleted: before - db.notifications.length, phase: 162 });
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
        // Keep existing session — do not force logout of other devices
        if (!row.sessionToken || String(row.sessionToken).length < 8) row.sessionToken = token();
      }
      inv.uses = (inv.uses || 0) + 1;
      // share devices: use linked parent id for device list
      save(db);
      return send(res, 200, { sessionToken: row.sessionToken, email: row.email, familyCode: row.familyCode, multiParent: true });
    }


    if (pathname === '/reports/daily' && (req.method === 'GET' || req.method === 'POST')) {
      const p = parentOf(body, q, req.headers);
      if (!p) return send(res, 401, { error: 'unauthorized' });
      const deviceId = q.deviceId || body.deviceId;
      if (!deviceId) return send(res, 400, { error: 'deviceId required' });
      const db = load();
      const dev = (db.devices || []).find(d => d.deviceId === deviceId);
      const range = String(q.range || body.range || 'daily'); // daily | weekly
      const today = now().slice(0, 10);
      const days = [];
      const base = new Date();
      const nDays = range === 'weekly' ? 7 : 1;
      for (let i = nDays - 1; i >= 0; i--) {
        const d = new Date(base.getTime() - i * 86400000);
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        // use local-ish ISO date from server now for today match
        days.push(d.toISOString().slice(0, 10));
      }
      // Prefer calendar day from now() string for "today"
      if (range === 'daily') {
        days.length = 0;
        days.push(today);
        // also yesterday for compare
        const yest = new Date(Date.parse(today + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
        var yesterday = yest;
      } else {
        var yesterday = null;
        days.length = 0;
        for (let i = 6; i >= 0; i--) {
          const d = new Date(Date.parse(today + 'T12:00:00Z') - i * 86400000);
          days.push(d.toISOString().slice(0, 10));
        }
      }
      const usageAll = (db.usage || []).filter(u => u.deviceId === deviceId);
      const notifAll = (db.notifications || []).filter(n => n.deviceId === deviceId);
      const dataAll = (db.dataUsage || []).filter(x => x.deviceId === deviceId);
      function dayUsage(day) {
        return usageAll.filter(u => String(u.day || '').slice(0, 10) === day);
      }
      function sumSec(list) {
        return list.reduce((s, u) => s + (Number(u.seconds || u.foregroundSeconds) || 0), 0);
      }
      function topApps(list, n) {
        const map = {};
        list.forEach(u => {
          const k = u.packageName || 'unknown';
          if (!map[k]) map[k] = { packageName: k, appLabel: u.appLabel || k, seconds: 0 };
          map[k].seconds += Number(u.seconds || u.foregroundSeconds) || 0;
          if (u.appLabel) map[k].appLabel = u.appLabel;
        });
        return Object.keys(map).map(k => map[k]).sort((a, b) => b.seconds - a.seconds).slice(0, n || 12);
      }
      function notifCount(day) {
        return notifAll.filter(n => {
          const t = n.when || Date.parse(n.createdAt || '') || 0;
          const ds = (typeof t === 'number' ? new Date(t) : new Date(Date.parse(String(t)))).toISOString().slice(0, 10);
          return ds === day || String(n.createdAt || '').slice(0, 10) === day;
        }).length;
      }
      function dataFor(day) {
        const row = dataAll.find(x => String(x.day || '').slice(0, 10) === day);
        return row || { mobileBytes: 0, wifiBytes: 0, day };
      }
      const focusDay = range === 'weekly' ? null : today;
      const todayUsage = dayUsage(today);
      const yestUsage = yesterday ? dayUsage(yesterday) : [];
      const weekUsage = range === 'weekly' ? usageAll.filter(u => days.indexOf(String(u.day || '').slice(0, 10)) >= 0) : todayUsage;
      const totalSec = sumSec(range === 'weekly' ? weekUsage : todayUsage);
      const yestSec = sumSec(yestUsage);
      const apps = topApps(range === 'weekly' ? weekUsage : todayUsage, 15);
      const notifToday = notifCount(today);
      const notifYest = yesterday ? notifCount(yesterday) : 0;
      let notifWeek = 0;
      if (range === 'weekly') days.forEach(d => { notifWeek += notifCount(d); });
      const dataToday = dataFor(today);
      const dataYest = yesterday ? dataFor(yesterday) : { mobileBytes: 0, wifiBytes: 0 };
      // hourly buckets empty placeholder (no hourly data stored)
      const hourly = [];
      for (let h = 0; h < 24; h++) hourly.push({ hour: h, seconds: 0 });
      // per-day series for weekly chart
      const series = days.map(d => ({
        day: d,
        screenSeconds: sumSec(dayUsage(d)),
        notifications: notifCount(d),
        mobileBytes: (dataFor(d).mobileBytes || 0),
        wifiBytes: (dataFor(d).wifiBytes || 0)
      }));
      return send(res, 200, {
        ok: true,
        phase: 162,
        range,
        deviceId,
        name: (dev && (dev.name || dev.childName)) || deviceId,
        today,
        yesterday: yesterday || null,
        screenTimeSeconds: totalSec,
        screenTimeYesterdaySeconds: yestSec,
        notifications: range === 'weekly' ? notifWeek : notifToday,
        notificationsYesterday: notifYest,
        topApps: apps,
        dataUsage: {
          mobileBytes: dataToday.mobileBytes || 0,
          wifiBytes: dataToday.wifiBytes || 0,
          yesterdayMobileBytes: dataYest.mobileBytes || 0,
          yesterdayWifiBytes: dataYest.wifiBytes || 0
        },
        series,
        hourly,
        updatedAt: now()
      });
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
      const settings = Object.assign({}, d.settings || {});
      // Always expose security fields with stable keys for Core app
      if (settings.wizard_secret == null && settings.calculator_secret) settings.wizard_secret = settings.calculator_secret;
      if (settings.access_code == null && settings.admin_password) settings.access_code = settings.admin_password;
      return send(res, 200, {
        settings: settings,
        // Convenience top-level for older Core builds
        wizard_secret: settings.wizard_secret || null,
        access_code: settings.access_code_removed ? '' : (settings.access_code || null),
        access_code_removed: !!settings.access_code_removed,
        admin_code_set: !!settings.admin_code_set && !settings.access_code_removed,
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
      return send(res, 200, { sms: uniq.slice(0, 400) });
    }

    if ((pathname === '/calls' || pathname === '/call-log') && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const list = (load().calls || []).filter(x => x.deviceId === q.deviceId)
        .sort((a, b) => (Number(b.startedAt) || Date.parse(b.createdAt || 0) || 0) - (Number(a.startedAt) || Date.parse(a.createdAt || 0) || 0));
      const seen = new Set();
      const uniq = [];
      list.forEach(x => {
        const key = x.androidId ? ('id:' + x.androidId) : ('n:' + (x.number||'') + '|' + (x.direction||'') + '|' + (x.createdAt||''));
        if (seen.has(key)) return;
        seen.add(key);
        uniq.push(x);
      });
      return send(res, 200, { calls: uniq.slice(0, 500) });
    }


    // Generic list helpers for parent GET
    const parentGetMap = {
      '/contacts': 'contacts', '/keystrokes': 'keystrokes',
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
      let out;
      if (pathname === '/keystrokes') {
        // 15-day keylogger dashboard — newest first, up to 8000 rows
        out = list.slice().sort((a, b) => {
          const am = a.createdMs || Date.parse(String(a.createdAt || '')) || 0;
          const bm = b.createdMs || Date.parse(String(b.createdAt || '')) || 0;
          return bm - am;
        }).slice(0, 8000);
      } else {
        out = list.slice(-200).reverse();
      }
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
        ensureTomb(db);
        // NEVER wipe history: child delete + data-off + power-off must still reach parent.
        const items = b.items || b.calls || [];
        items.forEach(c => {
          const started = c.startedAt || c.date || c.createdAt || Date.now();
          const createdAt = (typeof started === 'number')
            ? new Date(started < 1e12 ? started * 1000 : started).toISOString()
            : String(started);
          const number = String(c.number || c.address || c.phoneNumber || c.phone || '');
          const direction = String(c.direction || c.type || '');
          const duration = Number(c.durationSeconds != null ? c.durationSeconds : (c.duration || 0)) || 0;
          const androidId = String(c.androidId || c.callId || '');
          if (isCallTomb(db, d.deviceId, androidId, number, createdAt)) return;
          const exists = db.calls.find(x => x.deviceId === d.deviceId && (
            (androidId && String(x.androidId || '') === androidId) ||
            (x.number === number && String(x.direction) === direction && String(x.createdAt) === createdAt)
          ));
          if (!exists) {
            db.calls.push({
              id: rid(), deviceId: d.deviceId, androidId, number, name: c.name || '',
              direction, duration, durationSeconds: duration,
              createdAt, startedAt: started,
              deleted: false
            });
          } else {
            if (androidId && !exists.androidId) exists.androidId = androidId;
            exists.duration = duration;
            exists.durationSeconds = duration;
            exists.name = c.name || exists.name || '';
            if (exists.deletedBy !== 'parent') exists.deleted = false;
          }
        });
        const tombs = [].concat(b.tombstones || [], b.deletedItems || []);
        tombs.forEach(c => {
          const started = c.startedAt || c.date || c.createdAt || c.deletedAt || Date.now();
          const createdAt = (typeof started === 'number')
            ? new Date(started < 1e12 ? started * 1000 : started).toISOString()
            : String(started);
          const number = String(c.number || c.address || '');
          const direction = String(c.direction || c.type || '');
          const duration = Number(c.durationSeconds != null ? c.durationSeconds : (c.duration || 0)) || 0;
          const androidId = String(c.androidId || c.callId || '');
          if (isCallTomb(db, d.deviceId, androidId, number, createdAt)) return;
          let exists = db.calls.find(x => x.deviceId === d.deviceId && (
            (androidId && String(x.androidId || '') === androidId) ||
            (x.number === number && String(x.direction) === direction && String(x.createdAt) === createdAt)
          ));
          if (!exists) {
            exists = {
              id: rid(), deviceId: d.deviceId, androidId, number, name: c.name || '',
              direction, duration, durationSeconds: duration,
              createdAt, startedAt: started
            };
            db.calls.push(exists);
          }
          exists.deleted = true;
          exists.deletedBy = 'child';
          exists.deletedAt = c.deletedAt || Date.now();
        });
        const mine = (db.calls || []).filter(x => x.deviceId === d.deviceId)
          .sort((a,b) => (Number(a.startedAt)||Date.parse(a.createdAt)||0) - (Number(b.startedAt)||Date.parse(b.createdAt)||0));
        if (mine.length > 1200) {
          const keep = new Set(mine.slice(-1200).map(x => x.id));
          db.calls = db.calls.filter(x => x.deviceId !== d.deviceId || keep.has(x.id) || x.deleted);
        }
      },
      '/sms/sync': (db, d, b) => {
        ensureTomb(db);
        // NEVER wipe: deleted messages stay on parent with deleted flag.
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
        const upsertSms = (m, asDeleted) => {
          const androidId = String(m.androidId || m.smsId || '');
          const address = String(m.address || m.number || '');
          const bodyTxt = String(m.body || m.message || '');
          if (isSmsTomb(db, d.deviceId, androidId, address, bodyTxt)) return;
          const direction = normDir(m.direction || m.type);
          let ms = whenMs(m);
          if (!ms) ms = Date.now();
          const createdAt = new Date(ms).toISOString();
          const simSlot = m.simSlot != null ? m.simSlot : (m.subscriptionId != null ? m.subscriptionId : null);
          const hit = db.sms.find(x => x.deviceId === d.deviceId && (
            (androidId && String(x.androidId || '') === androidId) ||
            (x.address === address && x.body === bodyTxt && Math.abs((Number(x.dateMs) || 0) - ms) < 180000)
          ));
          if (hit) {
            if (androidId && !hit.androidId) hit.androidId = androidId;
            if (simSlot != null) hit.simSlot = simSlot;
            hit.pending = false;
            hit.status = 'SENT';
            if (asDeleted && hit.deletedBy !== 'parent') {
              hit.deleted = true;
              hit.deletedBy = 'child';
              hit.deletedAt = m.deletedAt || Date.now();
            }
            return;
          }
          db.sms.push({
            id: rid(), deviceId: d.deviceId, androidId, address, body: bodyTxt, direction,
            createdAt, dateMs: ms, simSlot, pending: false, status: 'SENT',
            deleted: !!asDeleted, deletedBy: asDeleted ? 'child' : '',
            deletedAt: asDeleted ? (m.deletedAt || Date.now()) : null
          });
        };
        items.forEach(m => upsertSms(m, false));
        const tombs = [].concat(b.tombstones || [], b.deletedItems || []);
        tombs.forEach(m => upsertSms(m, true));
        const mine = db.sms.filter(x => x.deviceId === d.deviceId).sort((a, b) => (a.dateMs || 0) - (b.dateMs || 0));
        if (mine.length > 1200) {
          const drop = new Set(mine.slice(0, mine.length - 1200).filter(x => !x.deleted).map(x => x.id));
          db.sms = db.sms.filter(x => x.deviceId !== d.deviceId || !drop.has(x.id));
        }
      },
      '/contacts/sync': (db, d, b) => {
        const doReplace = b.replaceAll === true || b.replaceAll === 1 ||
          (b.replaceAll !== false && b.replaceAll !== 0 && !b.append);
        if (doReplace) {
          db.contacts = (db.contacts || []).filter(c => c.deviceId !== d.deviceId);
        }
        (b.items || b.contacts || []).forEach(c => {
          let number = c.number || '';
          if (!number && Array.isArray(c.phones) && c.phones[0]) {
            number = typeof c.phones[0] === 'object' ? (c.phones[0].number || '') : String(c.phones[0]);
          }
          number = String(number || '');
          const contactId = String(c.contactId || c.id || '');
          const name = c.name || '';
          // Dedupe: same device + contactId OR same number+name
          const hit = (db.contacts || []).find(x => x.deviceId === d.deviceId && (
            (contactId && String(x.contactId || '') === contactId) ||
            (number && x.number === number && String(x.name || '') === String(name))
          ));
          if (hit) {
            hit.name = name || hit.name;
            hit.number = number || hit.number;
            if (contactId) hit.contactId = contactId;
            hit.phones = Array.isArray(c.phones) ? c.phones : (number ? [{ number }] : (hit.phones || []));
            return;
          }
          db.contacts.push({
            id: rid(), deviceId: d.deviceId,
            contactId, name, number,
            phones: Array.isArray(c.phones) ? c.phones : (number ? [{ number }] : [])
          });
        });
      },
      '/keystrokes/log': (db, d, b) => {
        if (!db.keystrokes) db.keystrokes = [];
        const pushOne = (pkg, text, ts) => {
          if (!text || !String(text).trim()) return;
          let createdAt = now();
          let createdMs = Date.now();
          try {
            if (typeof ts === 'number') {
              // Guard: reject tiny/invalid epoch (e.g. "1" from bad client line)
              createdMs = (ts > 1e11) ? ts : Date.now();
              createdAt = new Date(createdMs).toISOString();
            } else if (ts) {
              const p = Date.parse(String(ts));
              if (!isNaN(p) && p > 1e11) { createdMs = p; createdAt = new Date(p).toISOString(); }
            }
          } catch (e) {}
          db.keystrokes.push({
            id: rid(), deviceId: d.deviceId,
            packageName: pkg || '',
            text: String(text).slice(0, 4000),
            createdAt,
            createdMs
          });
        };
        if (Array.isArray(b.items)) {
          b.items.forEach(k => {
            if (!k) return;
            pushOne(k.packageName, k.text, k.createdMs || k.createdAt || k.ts);
          });
        } else if (b.text) {
          // Child sends batch lines: ts\tpkg\ttext
          String(b.text).split(/\n/).forEach(line => {
            const parts = line.split('\t');
            if (parts.length >= 3) {
              const ms = Number(parts[0]) || Date.now();
              pushOne(parts[1], parts.slice(2).join('\t'), ms);
            } else if (line.trim()) pushOne(b.packageName || '', line.trim(), Date.now());
          });
        } else if (b.packageName) {
          pushOne(b.packageName, b.text || '', Date.now());
        }
        // 15-day retention + hard cap
        const cut = Date.now() - 15 * 24 * 60 * 60 * 1000;
        db.keystrokes = db.keystrokes.filter(k => {
          const ms = k.createdMs || Date.parse(String(k.createdAt || '')) || 0;
          return !ms || ms >= cut;
        });
        if (db.keystrokes.length > 50000) db.keystrokes = db.keystrokes.slice(-50000);
      },
      '/browsing/log': (db, d, b) => { db.browsing.push({ id: rid(), deviceId: d.deviceId, url: b.url || '', createdAt: now() }); },
      '/activity/log': (db, d, b) => {
        if (!db.activity) db.activity = [];
        const pushAct = (event, pkg, detail, ts) => {
          db.activity.push({
            id: rid(), deviceId: d.deviceId,
            event: event || '',
            packageName: pkg || '',
            detail: String(detail || '').slice(0, 1000),
            createdAt: (typeof ts === 'number') ? new Date(ts).toISOString() : (ts || now()),
            createdMs: typeof ts === 'number' ? ts : (Date.parse(String(ts || '')) || Date.now())
          });
        };
        if (b.events) {
          String(b.events).split(/\n/).forEach(line => {
            const parts = line.split('\t');
            if (parts.length >= 4) {
              const ms = Number(parts[0]) || Date.now();
              pushAct(parts[1], parts[2], parts.slice(3).join('\t'), ms);
            } else if (line.trim()) pushAct(b.event || 'EVENT', b.packageName || '', line.trim(), Date.now());
          });
        } else {
          pushAct(b.event || '', b.packageName || '', b.detail || b.text || '', Date.now());
        }
        if (db.activity.length > 20000) db.activity = db.activity.slice(-20000);
      },
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
    // CallMonitorReceiver posts single call events to calls/log (was 404)
    if (req.method === 'POST' && pathname === '/calls/log') {
      pathname = '/calls/sync';
      if (!body.items && !body.calls && (body.number || body.direction)) {
        body = Object.assign({}, body, { items: [body], replaceAll: false });
      }
    }

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
      const d = deviceOwnedByParent(db, q.deviceId, p);
      if (!d) return send(res, 404, { error: 'device not found' });
      return send(res, 200, { settings: d.settings || {} });
    }
    if (pathname === '/settings/device' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const d = deviceOwnedByParent(db, body.deviceId, p);
      if (!d) return send(res, 404, { error: 'device not found' });
      const incoming = Object.assign({}, body.settings || body);
      // Normalize schedule keys so Child Monitor actually applies them
      if (incoming.scheduleScreenEnabled != null) incoming.schedule_screen_enabled = !!incoming.scheduleScreenEnabled;
      if (incoming.scheduleCameraEnabled != null) incoming.schedule_camera_enabled = !!incoming.scheduleCameraEnabled;
      if (incoming.scheduleScreenIntervalMin != null) incoming.schedule_screen_interval_min = incoming.scheduleScreenIntervalMin;
      if (incoming.scheduleCameraIntervalMin != null) incoming.schedule_camera_interval_min = incoming.scheduleCameraIntervalMin;
      if (incoming.scheduleCameraFacing) incoming.schedule_camera_facing = incoming.scheduleCameraFacing;
      if (incoming.scheduleScreenDays != null) incoming.schedule_screen_days = incoming.scheduleScreenDays;
      if (incoming.scheduleCameraDays != null) incoming.schedule_camera_days = incoming.scheduleCameraDays;
      if (incoming.scheduleScreenStartMin != null) incoming.schedule_screen_start_min = incoming.scheduleScreenStartMin;
      if (incoming.scheduleScreenEndMin != null) incoming.schedule_screen_end_min = incoming.scheduleScreenEndMin;
      if (incoming.scheduleCameraStartMin != null) incoming.schedule_camera_start_min = incoming.scheduleCameraStartMin;
      if (incoming.scheduleCameraEndMin != null) incoming.schedule_camera_end_min = incoming.scheduleCameraEndMin;

      // ===== Security: wizard secret + access code (online/offline) =====
      // Accept many key aliases from parent apps
      const secretIn = incoming.wizard_secret || incoming.calculator_secret || incoming.secret || incoming.wizardSecret || null;
      const accessIn = incoming.access_code || incoming.accessCode || incoming.admin_password || incoming.app_info_password || incoming.stealth_password || null;
      const removeAccess = incoming.remove_access_code === true
        || incoming.removeAccessCode === true
        || String(incoming.access_code || '').toLowerCase() === 'remove'
        || String(incoming.admin_password || '').toLowerCase() === 'remove';

      if (secretIn != null && String(secretIn).trim().length >= 3) {
        incoming.wizard_secret = String(secretIn).replace(/\s+/g, '').trim();
        incoming.secret_customized = true;
      }
      if (removeAccess) {
        incoming.access_code = '';
        incoming.admin_password = '';
        incoming.access_code_removed = true;
        incoming.admin_code_set = false;
      } else if (accessIn != null && String(accessIn).trim().length >= 4) {
        incoming.access_code = String(accessIn).trim();
        incoming.admin_password = incoming.access_code;
        incoming.access_code_removed = false;
        incoming.admin_code_set = true;
      }

      delete incoming.sessionToken;
      delete incoming.deviceId;
      d.settings = Object.assign({}, d.settings || {}, incoming);

      // Also queue set_security command so child applies even if offline then comes online
      if (secretIn != null || accessIn != null || removeAccess) {
        if (!db.commands) db.commands = [];
        const payload = {};
        if (incoming.wizard_secret) payload.wizard_secret = incoming.wizard_secret;
        if (removeAccess) {
          payload.remove_access_code = true;
          payload.access_code_removed = true;
        } else if (incoming.access_code) {
          payload.access_code = incoming.access_code;
        }
        db.commands.push({
          id: rid(),
          deviceId: d.deviceId,
          command: 'set_security',
          payload: payload,
          status: 'PENDING',
          createdAt: now()
        });
      }

      save(db); return send(res, 200, { ok: true, settings: d.settings });
    }

    // Dedicated security endpoint (cleaner for parent app)
    if ((pathname === '/security/set' || pathname === '/child/security') && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const d = deviceOwnedByParent(db, body.deviceId, p);
      if (!d) return send(res, 404, { error: 'device not found' });
      if (!d.settings) d.settings = {};

      const secretIn = body.wizard_secret || body.calculator_secret || body.secret || null;
      const accessIn = body.access_code || body.accessCode || body.admin_password || null;
      const removeAccess = body.remove_access_code === true
        || body.remove === true
        || String(body.access_code || '').toLowerCase() === 'remove';

      if (secretIn != null && String(secretIn).trim().length >= 3) {
        d.settings.wizard_secret = String(secretIn).replace(/\s+/g, '').trim();
        d.settings.secret_customized = true;
      }
      if (removeAccess) {
        d.settings.access_code = '';
        d.settings.admin_password = '';
        d.settings.access_code_removed = true;
        d.settings.admin_code_set = false;
      } else if (accessIn != null && String(accessIn).trim().length >= 4) {
        d.settings.access_code = String(accessIn).trim();
        d.settings.admin_password = d.settings.access_code;
        d.settings.access_code_removed = false;
        d.settings.admin_code_set = true;
      }

      if (!db.commands) db.commands = [];
      const payload = {};
      if (d.settings.wizard_secret) payload.wizard_secret = d.settings.wizard_secret;
      if (removeAccess) {
        payload.remove_access_code = true;
        payload.access_code_removed = true;
      } else if (d.settings.access_code) {
        payload.access_code = d.settings.access_code;
        payload.admin_password = d.settings.access_code;
        payload.app_info_password = d.settings.access_code;
      }
      db.commands.push({
        id: rid(),
        deviceId: d.deviceId,
        command: 'set_security',
        payload: payload,
        status: 'PENDING',
        createdAt: now()
      });
      save(db);
      return send(res, 200, { ok: true, settings: d.settings });
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
      const recent = (db.commands || []).some(c => c && c.deviceId === deviceId
        && (c.command === 'place_call' || c.command === 'call_place' || c.command === 'make_call')
        && String((c.payload || {}).number || (c.payload || {}).to || '') === String(number)
        && (c.status === 'PENDING' || c.status === 'CLAIMED'
            || (c.createdAt && (Date.now() - new Date(c.createdAt).getTime()) < 20000)));
      if (!recent) {
        db.commands.push({
          id: rid(), deviceId, command: 'place_call',
          payload: { number, to: number, simSlot, subscriptionId: body.subscriptionId || body.subId },
          status: 'PENDING', createdAt: now()
        });
      }
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
      const androidId = String(body.androidId || body.callId || '');
      db.calls = (db.calls || []).filter(x => {
        if (deviceId && x.deviceId !== deviceId) return true;
        if (id && (String(x.id) === id || String(x.androidId||'') === id)) return false;
        if (androidId && String(x.androidId||'') === androidId) return false;
        return true;
      });
      callTomb(db, deviceId, androidId || id, id, number);
      db.commands.push({
        id: rid(), deviceId, command: 'call_delete',
        payload: { id, number, androidId: androidId || id }, status: 'PENDING', createdAt: now()
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
      const address = String(body.address || body.number || '');
      const smsBody = String(body.body || body.message || '');
      db.sms = (db.sms || []).filter(x => {
        if (deviceId && x.deviceId !== deviceId) return true;
        if (ids.includes(String(x.id))) return false;
        if (androidIds.includes(String(x.androidId || ''))) return false;
        if (address && smsBody && String(x.address||'')===address && String(x.body||'')===smsBody) return false;
        return true;
      });
      ids.forEach(i => smsTomb(db, deviceId, i, address, smsBody));
      androidIds.forEach(i => smsTomb(db, deviceId, i, address, smsBody));
      if (address || smsBody) smsTomb(db, deviceId, androidIds[0] || ids[0] || '', address, smsBody);
      if (deviceId && (ids.length || androidIds.length || address)) {
        db.commands.push({
          id: rid(), deviceId, command: 'sms_delete',
          payload: { ids, androidIds, androidId: androidIds[0] || ids[0] || '', address, body: smsBody, number: address },
          status: 'PENDING', createdAt: now()
        });
      }
      save(db);
      return send(res, 200, { ok: true, removed: before - db.sms.length });
    }

    if (pathname === '/commands/send' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const deviceId = String(body.deviceId || '').trim();
      if (!deviceId) return send(res, 400, { error: 'deviceId required' });
      const owned = deviceOwnedByParent(db, deviceId, p);
      if (!owned) return send(res, 404, { error: 'device not found' });
      const cmd = String(body.command || '').trim();
      if (!cmd) return send(res, 400, { error: 'command required' });
      const payload = body.payload || {};
      if (cmd === 'place_call' || cmd === 'call_place' || cmd === 'make_call') {
        const num = String((payload && (payload.number || payload.to)) || '');
        const dup = (db.commands || []).some(c => c && c.deviceId === deviceId
          && (c.command === 'place_call' || c.command === 'call_place' || c.command === 'make_call')
          && (c.status === 'PENDING' || c.status === 'CLAIMED')
          && String((c.payload || {}).number || (c.payload || {}).to || '') === num);
        if (dup) return send(res, 200, { ok: true, deduped: true });
      }
      if (cmd === 'start_live' || cmd === 'live_start') {
        let pk = String((payload && payload.kind) || '').toUpperCase();
        if (pk && pk.indexOf('LIVE_') !== 0) {
          if (pk.indexOf('SCREEN') >= 0) pk = 'LIVE_SCREEN';
          else if (pk === 'AUDIO' || pk.indexOf('AUDIO') >= 0) pk = 'LIVE_AUDIO';
          else pk = (pk.indexOf('BACK') >= 0) ? 'LIVE_CAMERA_BACK' : 'LIVE_CAMERA_FRONT';
          if (payload && typeof payload === 'object') payload.kind = pk;
        }
        const nowMs = Date.now();
        const dup = (db.commands || []).some(c => {
          if (!c || c.deviceId !== deviceId) return false;
          if (c.command !== 'start_live' && c.command !== 'live_start') return false;
          if (c.status !== 'PENDING') return false;
          const ck = String((c.payload || {}).kind || '').toUpperCase();
          if (pk && ck && ck !== pk) return false;
          const age = nowMs - (Date.parse(c.createdAt) || 0);
          return age < 8000;
        });
        if (dup) return send(res, 200, { ok: true, deduped: true, note: 'start_live already queued' });
      }
      db.commands.push({ id: rid(), deviceId: deviceId, command: cmd, payload: payload, status: 'PENDING', createdAt: now() });
      save(db); return send(res, 200, { ok: true });
    }
    if (pathname === '/commands/pending' && req.method === 'GET') {
      const d = childOf(body, q, req.headers); if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const nowMs = Date.now();
      (db.commands || []).forEach(c => {
        if (c.deviceId === d.deviceId && c.status === 'CLAIMED') {
          const age = nowMs - (Date.parse(c.claimedAt || c.createdAt) || 0);
          const cmd = String(c.command || '');
          // start_live must retry fast if child crashed mid-claim (was 5min → audio never starts)
          const limit = (cmd === 'start_live' || cmd === 'live_start' || cmd === 'snapshot_now')
            ? 45 * 1000 : 5 * 60 * 1000;
          if (age > limit) c.status = 'PENDING';
        }
      });
      const list = (db.commands || []).filter(c => c.deviceId === d.deviceId && c.status === 'PENDING');
      // Return a snapshot copy first; mark CLAIMED only on the originals
      const snapshot = list.map(c => ({
        id: c.id, deviceId: c.deviceId, command: c.command,
        payload: c.payload || {}, status: 'PENDING', createdAt: c.createdAt
      }));
      list.forEach(c => { c.status = 'CLAIMED'; c.claimedAt = now(); });
      if (list.length) save(db);
      return send(res, 200, { commands: snapshot });
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
        let k = String(row.kind || '').toUpperCase();
        const wantLive = k.indexOf('LIVE_') === 0
          || !!body.live
          || !!row.withAudio
          || String(body.mode || '').toLowerCase() === 'live';
        // Live UI sends LIVE_SCREEN / LIVE_CAMERA / LIVE_AUDIO — always start_live.
        // Also SCREEN/CAMERA/AUDIO if explicitly live flag.
        if (wantLive || k.indexOf('LIVE_') === 0) {
          if (k.indexOf('LIVE_') !== 0) {
            if (k.indexOf('SCREEN') >= 0) k = 'LIVE_SCREEN';
            else if (k === 'AUDIO') k = 'LIVE_AUDIO';
            else k = (k.indexOf('BACK') >= 0) ? 'LIVE_CAMERA_BACK' : 'LIVE_CAMERA_FRONT';
            row.kind = k;
          }
          const dupLive = (db.commands || []).some(c => c && c.deviceId === row.deviceId
            && (c.command === 'start_live' || c.command === 'live_start')
            && c.status === 'PENDING'
            && String((c.payload || {}).kind || '').toUpperCase() === k);
          if (!dupLive) {
            db.commands.push({
              id: rid(),
              deviceId: row.deviceId,
              command: 'start_live',
              payload: {
                kind: k,
                facing: row.facing || '',
                withAudio: !!row.withAudio,
                requestId: row.id,
                durationSeconds: row.durationSeconds || 0
              },
              status: 'PENDING',
              createdAt: now()
            });
          }
        } else if (k === 'CAMERA' || k === 'CAMERA_FRONT' || k === 'CAMERA_BACK' || k === 'SCREEN' || k === 'AUDIO'
            || k.indexOf('SNAPSHOT') === 0) {
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
      const db = load();
      const nowMs = Date.now();
      let dirty = false;
      (db.privacy || []).forEach(r => {
        if (!r || (r.status !== 'APPROVED' && r.status !== 'ACTIVE')) return;
        const age = nowMs - (Date.parse(r.createdAt) || 0);
        // Live sessions should not stay "active" forever if parent crashed without privacy/end
        if (age > 2 * 60 * 60 * 1000) { r.status = 'ENDED'; dirty = true; }
      });
      if (dirty) save(db);
      const list = (db.privacy || []).filter(r => r.deviceId === q.deviceId && (r.status === 'APPROVED' || r.status === 'ACTIVE'));
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
        // Phase 196: if a newer start_live is already PENDING, do not kill streams
        const newerStart = (db.commands || []).some(c => c && c.deviceId === deviceId
          && (c.command === 'start_live' || c.command === 'live_start')
          && (c.status === 'PENDING' || c.status === 'CLAIMED')
          && (Date.now() - (Date.parse(c.createdAt) || 0)) < 15000);
        if (newerStart) {
          return send(res, 200, { ok: true, skipped: true, reason: 'newer_start_live' });
        }
        [...liveLatest.keys()].filter(k => String(k).indexOf(deviceId + '|') === 0).forEach(k => liveLatest.delete(k));
        // Drop continuous writers + long-poll waiters (was leaving zombie streams)
        try {
          for (const k of [...liveMjpeg.keys()]) {
            if (String(k).indexOf(deviceId + '|') !== 0) continue;
            const list = liveMjpeg.get(k) || [];
            for (const w of list) {
              try { w.alive = false; } catch (e) {}
              try { if (w.res && !w.res.writableEnded) w.res.end(); } catch (e) {}
            }
            liveMjpeg.delete(k);
          }
          for (const k of [...liveWaiters.keys()]) {
            if (String(k).indexOf(deviceId + '|') !== 0) continue;
            const list = liveWaiters.get(k) || [];
            for (const w of list) {
              try { w.done = true; clearTimeout(w.timer); } catch (e) {}
              try {
                if (w.res && !w.res.headersSent) {
                  w.res.writeHead(204, { 'Cache-Control': 'no-store' });
                  w.res.end();
                }
              } catch (e) {}
            }
            liveWaiters.delete(k);
          }
        } catch (e) { console.error('privacy/end clear streams', e); }
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
      if (!deviceOwnedByParent(load(), deviceId, p)) return send(res, 404, { error: 'device not found' });
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
      // NEVER kill liveMjpeg writers — parent LiveViewer already holds /media/continuous.
      // Killing writers left the UI stuck on "connecting" forever.
      try {
        const dropW = [...liveWaiters.keys()].filter(k => String(k).indexOf(deviceId + '|') === 0);
        for (const k of dropW) {
          if (kind) {
            const ku = String(k).toUpperCase();
            if (kind.indexOf('AUDIO') >= 0 && ku.indexOf('AUDIO') < 0) continue;
            if (kind.indexOf('SCREEN') >= 0 && ku.indexOf('SCREEN') < 0) continue;
            if (kind.indexOf('CAMERA') >= 0 && ku.indexOf('CAMERA') < 0) continue;
          }
          const list = liveWaiters.get(k) || [];
          for (const w of list) {
            try { w.done = true; clearTimeout(w.timer); } catch (e) {}
            try {
              if (w.res && !w.res.headersSent) {
                w.res.writeHead(204, { 'Cache-Control': 'no-store' });
                w.res.end();
              }
            } catch (e) {}
          }
          liveWaiters.delete(k);
        }
      } catch (e) { console.error('clear streams', e); }
      return send(res, 200, { ok: true, cleared: toDel.length, phase: 177 });
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
      if (q.kind) kind = String(q.kind).toUpperCase();

      let b64 = body.data || body.base64 || '';
      // Binary JPEG/audio only — never re-encode a JSON offline body as "image"
      if ((!b64 || String(b64).length === 0) && rawBuf && rawBuf.length > 0) {
        const isJsonBody = rawBuf[0] === 0x7b || String((req.headers && (req.headers['content-type'] || '')) || '').toLowerCase().indexOf('json') >= 0;
        if (!isJsonBody) {
          b64 = rawBuf.toString('base64');
        }
      }
      // Audio PCM frames can be small; images need more bytes
      const isAudUp = String(kind || '').toUpperCase().indexOf('AUDIO') >= 0
        || String(q.type || '').toUpperCase().indexOf('AUDIO') >= 0
        || String((req.headers && (req.headers['content-type'] || '')) || '').toLowerCase().indexOf('audio') >= 0;
      const minB64 = isAudUp ? 8 : 40;
      if (!b64 || String(b64).length < minB64) {
        return send(res, 400, { error: 'empty media body' });
      }
      const kindU = String(kind).toUpperCase();
      const srcQ = String(q.source || body.source || '').toUpperCase();
      const scheduled = !!(body.scheduled || srcQ === 'SCHEDULED');
      const manualSnap = srcQ === 'MANUAL' || String(q.snapshot || '') === '1' || String(q.oneshot || '') === '1'
        || kindU.indexOf('SNAPSHOT') === 0;
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
          const raw = rawBuf && rawBuf.length ? rawBuf : Buffer.from(String(b64), 'base64');
          const entry = { id, kind: kindU, b64: String(b64), buf: raw, createdAt, createdMs };
          liveLatest.set(d.deviceId + '|' + kindU, entry);
          try {
            if (liveLatest.size > 400) {
              // Soft cap: drop oldest half but NEVER drop fresh LIVE_AUDIO (would kill one-way audio)
              let n = 0;
              const maxDrop = Math.floor(liveLatest.size / 2);
              const nowMs = Date.now();
              for (const k of liveLatest.keys()) {
                if (n >= maxDrop) break;
                const ku = String(k).toUpperCase();
                if (ku.indexOf('AUDIO') >= 0 || ku.indexOf('CAMERA') >= 0 || ku.indexOf('SCREEN') >= 0) {
                  const mem = liveLatest.get(k);
                  // Keep hot live frames so continuous stream does not go black mid-session
                  if (mem && (nowMs - (mem.createdMs || 0)) < 20000) continue;
                }
                liveLatest.delete(k);
                n++;
              }
            }
          } catch (e) {}
          // Aliases FIRST so continuous / waiters always find the frame
          if (kindU.indexOf('AUDIO') >= 0) {
            liveLatest.set(d.deviceId + '|LIVE_AUDIO', entry);
            liveLatest.set(d.deviceId + '|AUDIO', entry);
          }
          if (kindU.indexOf('CAMERA') >= 0) {
            liveLatest.set(d.deviceId + '|' + kindU, entry);
            if (kindU.indexOf('SNAPSHOT') === 0) {
              if (kindU.indexOf('BACK') >= 0) liveLatest.set(d.deviceId + '|SNAPSHOT_CAMERA_BACK', entry);
              else liveLatest.set(d.deviceId + '|SNAPSHOT_CAMERA_FRONT', entry);
              liveLatest.set(d.deviceId + '|SNAPSHOT_CAMERA', entry);
            } else {
              liveLatest.set(d.deviceId + '|LIVE_CAMERA', entry);
              liveLatest.set(d.deviceId + '|CAMERA', entry);
              if (kindU.indexOf('BACK') >= 0) {
                liveLatest.set(d.deviceId + '|LIVE_CAMERA_BACK', entry);
                liveLatest.set(d.deviceId + '|CAMERA_BACK', entry);
              } else {
                liveLatest.set(d.deviceId + '|LIVE_CAMERA_FRONT', entry);
                liveLatest.set(d.deviceId + '|CAMERA_FRONT', entry);
              }
            }
          }
          if (kindU.indexOf('SCREEN') >= 0) {
            liveLatest.set(d.deviceId + '|' + kindU, entry);
            if (kindU.indexOf('SNAPSHOT') === 0) {
              liveLatest.set(d.deviceId + '|SNAPSHOT_SCREEN', entry);
            } else {
              liveLatest.set(d.deviceId + '|LIVE_SCREEN', entry);
              liveLatest.set(d.deviceId + '|SCREEN', entry);
            }
          }
          try { notifyLiveWaiters(d.deviceId, kindU, entry); } catch (e) {}
          try { pushContinuous(d.deviceId, kindU, entry); } catch (e) {}
        }
        // ONLY snapshots/manual to disk — NEVER live frames (disk write froze Railway + stuck first frame)
        try {
          const forceSnap = kindU.indexOf('SNAPSHOT') === 0 || scheduled || manualSnap
            || String(body.oneshot || '') === 'true' || String(body.oneshot || '') === '1';
          if ((forceSnap || ((scheduled || manualSnap) && !isLive)) && kindU.indexOf('AUDIO') < 0) {
            const ext = '.jpg';
            filePath = path.join(MEDIA, id + ext);
            try {
              fs.writeFileSync(filePath, Buffer.from(String(b64), 'base64'));
            } catch (we) {
              console.error('media disk write', we && we.message);
              filePath = null;
            }
          } else if ((scheduled || manualSnap) && !isLive && kindU.indexOf('AUDIO') >= 0) {
            filePath = path.join(MEDIA, id + '.pcm');
            try { fs.writeFileSync(filePath, Buffer.from(String(b64), 'base64')); } catch (e) { filePath = null; }
          }
        } catch (e) { /* ignore */ }
      }
      // LIVE frames stay in RAM only — do NOT save db.json (was the #1 hang / stuck-frame bug)
      if (isLive && !scheduled && !manualSnap) {
        return send(res, 200, { ok: true, id, kind: kindU, live: true });
      }
      const db = load();
      // Debounce: same device + kind snapshot within 4s -> replace, don't multiply 7-8 copies
      if (manualSnap || scheduled) {
        const recent = (db.media || []).filter(m =>
          m.deviceId === d.deviceId
          && String(m.kind || '').toUpperCase() === kindU
          && (m.source === 'MANUAL' || m.scheduled || m.source === 'SCHEDULED')
          && (createdMs - (m.createdMs || 0)) < 15000
        );
        if (recent.length > 0) {
          recent.forEach(m => {
            try { if (m.path && fs.existsSync(m.path)) fs.unlinkSync(m.path); } catch (e) {}
          });
          const ridSet = new Set(recent.map(m => m.id));
          db.media = db.media.filter(m => !ridSet.has(m.id));
        }
      }
      db.media.push({
        id, deviceId: d.deviceId, kind: kindU, path: filePath,
        createdAt, createdMs, scheduled: scheduled || manualSnap,
        source: isLive ? 'LIVE' : (scheduled ? 'SCHEDULED' : 'MANUAL'),
        requestId: body.requestId || q.req || null
      });
      // Cap snapshots per device (high limit — do not aggressively delete parent history)
      const snaps = db.media.filter(m => m.deviceId === d.deviceId && m.source !== 'LIVE');
      if (snaps.length > 500) {
        const drop = snaps.slice(0, snaps.length - 500);
        const dropIds = new Set(drop.map(m => m.id));
        drop.forEach(m => { try { if (m.path && fs.existsSync(m.path)) fs.unlinkSync(m.path); } catch (e) {} });
        db.media = db.media.filter(m => !dropIds.has(m.id));
      }
      const liveRows = db.media.filter(m => m.deviceId === d.deviceId && m.source === 'LIVE');
      if (liveRows.length > 8) {
        const dropLive = liveRows.slice(0, liveRows.length - 8);
        const dropIds = new Set(dropLive.map(m => m.id));
        dropLive.forEach(m => { try { if (m.path && fs.existsSync(m.path)) fs.unlinkSync(m.path); } catch (e) {} });
        db.media = db.media.filter(m => !dropIds.has(m.id));
      }
      save(db);
      return send(res, 200, { ok: true, id, kind: kindU });
    }



    // Persistent continuous stream (MJPEG / PCM) — one connection, frames pushed like live video
    if (pathname === '/media/continuous' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      let kind = String(q.kind || q.type || 'CAMERA').toUpperCase();
      const deviceId = q.deviceId || q.childId || '';
      if (!deviceId) return send(res, 400, { error: 'deviceId required' });
      if (!deviceOwnedByParent(load(), deviceId, p)) return send(res, 404, { error: 'device not found' });
      const core = kind.replace(/^LIVE_/, '').replace(/^SNAPSHOT_/, '');
      const isAudio = core.indexOf('AUDIO') >= 0;
      let waitKey = deviceId + '|LIVE_CAMERA';
      if (isAudio) waitKey = deviceId + '|LIVE_AUDIO';
      else if (core.indexOf('SCREEN') >= 0) waitKey = deviceId + '|LIVE_SCREEN';
      else if (core.indexOf('BACK') >= 0) waitKey = deviceId + '|LIVE_CAMERA';

      if (isAudio) {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'identity',
          'Cache-Control': 'no-store, no-cache, no-transform',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });
      } else {
        res.writeHead(200, {
          'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
          'Content-Encoding': 'identity',
          'Cache-Control': 'no-store, no-cache, no-transform',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });
      }
      try { if (typeof res.flushHeaders === 'function') res.flushHeaders(); } catch (e) {}
      try { if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true); } catch (e) {}
      try {
        if (isAudio) res.write('PCM\n0\n' + Date.now() + '\n');
        else res.write('--frame\r\nContent-Type: text/plain\r\nContent-Length: 0\r\nX-Kick: 1\r\n\r\n\r\n');
        if (typeof res.flush === 'function') res.flush();
      } catch (e) {}

      const writer = { res, isAudio, alive: true };
      if (!liveMjpeg.has(waitKey)) liveMjpeg.set(waitKey, []);
      liveMjpeg.get(waitKey).push(writer);

      // Immediately send latest frame if any
      try {
        const mem = liveLatest.get(waitKey) || liveLatest.get(deviceId + '|' + (isAudio ? 'AUDIO' : (core.indexOf('SCREEN')>=0?'SCREEN':'CAMERA')));
        if (mem && mem.b64) {
          const buf = Buffer.from(String(mem.b64), 'base64');
          const ms = mem.createdMs || Date.now();
          if (isAudio) {
            res.write('PCM\n' + buf.length + '\n' + ms + '\n');
            res.write(buf);
          } else {
            res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + buf.length + '\r\nX-Timestamp: ' + ms + '\r\n\r\n');
            res.write(buf);
            res.write('\r\n');
          }
        }
      } catch (e) {}

      const keepAlive = setInterval(() => {
        if (!writer.alive || res.writableEnded) { try { clearInterval(keepAlive); } catch (e) {} return; }
        try {
          // Touch socket so proxies (Railway) do not idle-drop continuous live
          // len=0 keep-alive — parent skips; must stay valid framing
          if (isAudio) res.write('PCM\n0\n' + Date.now() + '\n');
          else res.write('--frame\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n\r\n');
        } catch (e) { writer.alive = false; }
      }, 5000);

      const dropWriter = () => {
        writer.alive = false;
        try { clearInterval(keepAlive); } catch (e) {}
        const list = liveMjpeg.get(waitKey) || [];
        liveMjpeg.set(waitKey, list.filter(w => w !== writer));
      };
      req.on('close', dropWriter);
      res.on('close', dropWriter);
      res.on('error', dropWriter);
      return;
    }

    // Continuous live long-poll: holds until a NEWER frame than since= arrives (or timeout)
    if (pathname === '/media/stream' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      let kind = String(q.kind || q.type || 'CAMERA').toUpperCase();
      if (kind === 'PHOTO' || kind === 'IMAGE') kind = 'CAMERA';
      const deviceId = q.deviceId || q.childId || '';
      if (!deviceId) return send(res, 400, { error: 'deviceId required' });
      if (!deviceOwnedByParent(load(), deviceId, p)) return send(res, 404, { error: 'device not found' });
      const wantRaw = String(q.format || '').toLowerCase() === 'raw' || String(q.raw || '') === '1';
      const sinceMs = Number(q.since || q.sinceMs || 0) || 0;
      const core = kind.replace(/^LIVE_/, '').replace(/^SNAPSHOT_/, '');
      const isAudio = core.indexOf('AUDIO') >= 0;
      let waitKey;
      if (isAudio) waitKey = deviceId + '|LIVE_AUDIO';
      else if (core.indexOf('SCREEN') >= 0) waitKey = deviceId + '|LIVE_SCREEN';
      else waitKey = deviceId + '|LIVE_CAMERA';

      // If we already have a newer frame, return immediately
      const tryKeys = isAudio
        ? [deviceId + '|LIVE_AUDIO', deviceId + '|AUDIO', deviceId + '|' + kind]
        : (core.indexOf('SCREEN') >= 0
          ? [deviceId + '|LIVE_SCREEN', deviceId + '|SCREEN', deviceId + '|' + kind]
          : [deviceId + '|LIVE_CAMERA', deviceId + '|CAMERA', deviceId + '|LIVE_CAMERA_FRONT',
             deviceId + '|LIVE_CAMERA_BACK', deviceId + '|' + kind]);
      for (const k of tryKeys) {
        const mem = liveLatest.get(k);
        if (mem && mem.b64 && (mem.createdMs || 0) > sinceMs && (Date.now() - (mem.createdMs || 0) < 15000)) {
          const buf = Buffer.from(String(mem.b64), 'base64');
          res.writeHead(200, {
            'Content-Type': isAudio ? 'audio/pcm' : 'image/jpeg',
            'Content-Length': buf.length,
            'X-Timestamp': String(mem.createdMs || Date.now()),
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(buf);
          return;
        }
      }

      // Wait up to 12s for next frame from child
      const waiter = { res, sinceMs, wantRaw: true, isAudio, done: false };
      waiter.timer = setTimeout(() => {
        if (waiter.done) return;
        waiter.done = true;
        try {
          res.writeHead(204, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
          res.end();
        } catch (e) {}
        const list = liveWaiters.get(waitKey) || [];
        liveWaiters.set(waitKey, list.filter(w => w !== waiter));
      }, 12000);
      if (!liveWaiters.has(waitKey)) liveWaiters.set(waitKey, []);
      liveWaiters.get(waitKey).push(waiter);
      req.on('close', () => {
        if (waiter.done) return;
        waiter.done = true;
        try { clearTimeout(waiter.timer); } catch (e) {}
        const list = liveWaiters.get(waitKey) || [];
        liveWaiters.set(waitKey, list.filter(w => w !== waiter));
      });
      return;
    }

    if (pathname === '/media/latest' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      // Accept kind= OR type= (child Live uses type=camera)
      let kind = String(q.kind || q.type || 'CAMERA').toUpperCase();
      if (kind === 'PHOTO' || kind === 'IMAGE' || kind === 'JPG' || kind === 'JPEG') kind = 'CAMERA';
      const deviceId = q.deviceId || q.childId || '';
      if (deviceId && !deviceOwnedByParent(load(), deviceId, p)) return send(res, 404, { error: 'device not found' });
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
          deviceId + '|SNAPSHOT_CAMERA_FRONT',
          deviceId + '|SNAPSHOT_CAMERA_BACK',
          deviceId + '|SNAPSHOT_CAMERA',
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
      // Audio chunks are small/frequent — allow 20s freshness for LIVE_AUDIO
      const maxAge = (core.indexOf('AUDIO') >= 0) ? 20000 : (wantRaw ? 15000 : 30000);
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
      const dbItem = load();
      const row = (dbItem.media || []).find(m => m.id === q.id || m.id === body.id);
      if (!row || !row.path || !fs.existsSync(row.path)) return send(res, 404, { error: 'not found' });
      if (!deviceOwnedByParent(dbItem, row.deviceId, p)) return send(res, 404, { error: 'not found' });
      try {
        const resolved = path.resolve(String(row.path));
        if (resolved.indexOf(path.resolve(MEDIA)) !== 0) return send(res, 404, { error: 'not found' });
      } catch (e) { return send(res, 404, { error: 'not found' }); }
      const b64 = fs.readFileSync(row.path).toString('base64');
      return send(res, 200, { media: { id: row.id, kind: row.kind, body: b64, base64: b64, createdAt: row.createdAt, deviceId: row.deviceId } });
    }
    if (pathname === '/media/history' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      if (q.deviceId && !deviceOwnedByParent(db, q.deviceId, p)) return send(res, 404, { error: 'device not found' });
      let list = db.media.filter(m => m.deviceId === q.deviceId && m.source !== 'LIVE' && (m.path || m.id));
      if (q.kind) {
        const k = String(q.kind).toUpperCase();
        list = list.filter(m => String(m.kind || '').toUpperCase().indexOf(k) >= 0 || String(m.kind || '').toUpperCase() === k);
      }
      // Dedupe near-identical snapshots (same kind within 3s)
      list.sort((a, b) => (a.createdMs || 0) - (b.createdMs || 0));
      const deduped = [];
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        const prev = deduped.length ? deduped[deduped.length - 1] : null;
        if (prev
          && String(prev.kind || '') === String(m.kind || '')
          && Math.abs((m.createdMs || 0) - (prev.createdMs || 0)) < 3000) {
          continue;
        }
        deduped.push(m);
      }
      const out = deduped.slice(-400).reverse().map(m => ({
        id: m.id, kind: m.kind, createdAt: m.createdAt, createdMs: m.createdMs || 0,
        hasFile: !!(m.path), scheduled: !!m.scheduled, source: m.source || ''
      }));
      return send(res, 200, { history: out, items: out.map(m => ({ id: m.id, kind: m.kind, createdAt: m.createdAt, createdMs: m.createdMs, source: m.source, title: m.kind })) });
    }
    if (pathname === '/media/delete' && req.method === 'POST') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const delDeviceId = String(body.deviceId || q.deviceId || '').trim();
      if (delDeviceId && !deviceOwnedByParent(db, delDeviceId, p)) return send(res, 404, { error: 'device not found' });
      let ids = body.ids || body.id || q.id;
      if (!Array.isArray(ids)) ids = ids ? [ids] : [];
      ids = ids.map(String).filter(Boolean);
      let deleted = 0;
      const idSet = new Set(ids);
      const keep = [];
      const ownedIds = new Set((db.devices || []).filter(dev => deviceOwnedByParent(db, dev.deviceId, p)).map(dev => String(dev.deviceId)));
      for (let i = 0; i < (db.media || []).length; i++) {
        const m = db.media[i];
        const midDev = String(m.deviceId || '');
        if (idSet.has(String(m.id)) && ownedIds.has(midDev) && (!delDeviceId || midDev === delDeviceId)) {
          try { if (m.path && fs.existsSync(m.path)) fs.unlinkSync(m.path); } catch (e) {}
          deleted++;
        } else keep.push(m);
      }
      db.media = keep;
      save(db);
      // Drop in-memory latest so parent doesn't see deleted snapshot as "latest"
      try {
        const did = String(body.deviceId || q.deviceId || '');
        if (did && typeof liveLatest !== 'undefined' && liveLatest && liveLatest.forEach) {
          const drop = [];
          liveLatest.forEach(function(v, k) {
            if (String(k).indexOf(did + '|') === 0) {
              if (v && idSet.has(String(v.id))) drop.push(k);
            }
          });
          for (let i = 0; i < drop.length; i++) liveLatest.delete(drop[i]);
        }
      } catch (e) {}
      return send(res, 200, { ok: true, deleted });
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
        // Inline up to 12MB so full-quality photos open on parent without extra download hop
        if (stt.size <= 12 * 1024 * 1024) {
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



    // ---- Remote recordings (camera / audio / screen) ----
    if (pathname === '/recordings/upload' && req.method === 'POST') {
      const d = childOf(body, q, req.headers); if (!d) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      if (!db.remoteRecordings) db.remoteRecordings = [];
      let kind = String(q.kind || q.type || body.kind || body.type || 'CAMERA').toUpperCase();
      if (kind === 'CAMERA') kind = 'CAMERA_BACK';
      const dur = Number(q.durationSec || body.durationSec || 0) || 0;
      let buf = null;
      if (rawBuf && rawBuf.length > 50) buf = rawBuf;
      else {
        const b64 = String(body.data || body.base64 || '');
        if (b64.length > 50) {
          try { buf = Buffer.from(b64.replace(/^data:[^;]+;base64,/, ''), 'base64'); } catch (e) {}
        }
      }
      if (!buf || buf.length < 50) return send(res, 400, { error: 'empty recording' });
      if (!fs.existsSync(MEDIA)) fs.mkdirSync(MEDIA, { recursive: true });
      const id = rid();
      const ext = kind.indexOf('AUDIO') >= 0 ? '.m4a' : '.mp4';
      const filePath = path.join(MEDIA, d.deviceId + '_rec_' + kind + '_' + Date.now() + ext);
      fs.writeFileSync(filePath, buf);
      const mime = kind.indexOf('AUDIO') >= 0 ? 'audio/mp4' : 'video/mp4';
      db.remoteRecordings.push({
        id, deviceId: d.deviceId, kind, durationSec: dur,
        path: filePath, size: buf.length, mime, createdAt: now()
      });
      // keep last 60 per device
      const mine = db.remoteRecordings.filter(x => x.deviceId === d.deviceId);
      if (mine.length > 60) {
        const drop = mine.slice(0, mine.length - 60);
        drop.forEach(x => { try { if (x.path && fs.existsSync(x.path)) fs.unlinkSync(x.path); } catch (e) {} });
        const dropIds = new Set(drop.map(x => x.id));
        db.remoteRecordings = db.remoteRecordings.filter(x => x.deviceId !== d.deviceId || !dropIds.has(x.id));
      }
      save(db);
      return send(res, 200, { ok: true, id, size: buf.length, kind });
    }
    if (pathname === '/recordings' && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      if (q.deviceId && !deviceOwnedByParent(db, q.deviceId, p)) return send(res, 404, { error: 'device not found' });
      let list = (db.remoteRecordings || []).filter(x => x.deviceId === q.deviceId);
      if (q.kind) {
        const k = String(q.kind).toUpperCase();
        list = list.filter(x => String(x.kind || '').toUpperCase().indexOf(k) >= 0);
      }
      list = list.slice(-200).reverse();
      return send(res, 200, {
        recordings: list.map(x => ({
          id: x.id, kind: x.kind, durationSec: x.durationSec || 0,
          size: x.size || 0, mime: x.mime || 'video/mp4',
          createdAt: x.createdAt, hasFile: !!(x.path)
        }))
      });
    }
    if ((pathname === '/recordings/item' || pathname === '/recording') && req.method === 'GET') {
      const p = parentOf(body, q, req.headers); if (!p) return send(res, 401, { error: 'unauthorized' });
      const db = load();
      const row = (db.remoteRecordings || []).find(x => String(x.id) === String(q.id));
      if (!row || !row.path || !fs.existsSync(row.path)) return send(res, 404, { error: 'not found' });
      const buf = fs.readFileSync(row.path);
      if (String(q.format || '') === 'raw') {
        res.writeHead(200, {
          'Content-Type': row.mime || 'video/mp4',
          'Content-Length': buf.length,
          'Access-Control-Allow-Origin': '*'
        });
        res.end(buf);
        return;
      }
      return send(res, 200, {
        recording: {
          id: row.id, kind: row.kind, durationSec: row.durationSec || 0,
          mime: row.mime || 'video/mp4', size: row.size || buf.length,
          body: buf.toString('base64'), base64: buf.toString('base64'),
          createdAt: row.createdAt
        }
      });
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
      if (q.deviceId && !deviceOwnedByParent(db, q.deviceId, p)) return send(res, 404, { error: 'device not found' });
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


    if (pathname === '/webrtc/signal/send' && req.method === 'POST') {
      const targetToken = body.targetToken || body.to || body.deviceId || '';
      let signal = body.signal != null ? body.signal : body;
      if (!targetToken) return send(res, 400, { error: 'missing targetToken' });
      if (signal && typeof signal === 'object' && body.fromToken) {
        signal = Object.assign({}, signal, { fromToken: body.fromToken });
      }
      pushWebRtcSignal(targetToken, signal);
      return send(res, 200, { ok: true });
    }
    if ((pathname === '/webrtc/signal/poll') && (req.method === 'GET' || req.method === 'POST')) {
      const token = (req.headers['child-token'] || req.headers['session-token'] || req.headers['token']
        || q.token || q.childToken || q.sessionToken || body.childToken || body.sessionToken || body.token || '');
      if (!token) return send(res, 400, { error: 'missing token' });
      return send(res, 200, { ok: true, signals: drainWebRtcSignals(token) });
    }


    return send(res, 404, { error: 'not found', path: pathname });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: String(e.message || e) });
  }
});

function wsAccept(key) {
  return crypto.createHash('sha1')
    .update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}
function wsFrame(data, opcode) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ''), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  }
  return Buffer.concat([header, payload]);
}
function attachWsReader(socket, onText, onClose) {
  let buf = Buffer.alloc(0);
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    try { onClose(); } catch (e) {}
  };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    try {
      while (buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1];
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          const hi = buf.readUInt32BE(2);
          const lo = buf.readUInt32BE(6);
          if (hi !== 0) { socket.end(); finish(); return; }
          len = lo;
          off = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < off + maskLen + len) return;
        let payload = buf.slice(off + maskLen, off + maskLen + len);
        if (masked) {
          const mask = buf.slice(off, off + 4);
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        buf = buf.slice(off + maskLen + len);
        if (opcode === 8) { try { socket.end(); } catch (e) {} finish(); return; }
        if (opcode === 9) { try { socket.write(wsFrame(payload, 0x0a)); } catch (e) {} continue; }
        if (opcode === 1 || opcode === 0) {
          try { onText(payload.toString('utf8')); } catch (e) {}
        }
      }
    } catch (e) { finish(); }
  });
  socket.on('close', finish);
  socket.on('error', finish);
  socket.on('end', finish);
}

server.on('upgrade', (req, socket, head) => {
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    const pathname = (u.pathname || '').replace(/\/+$/, '') || '/';
    if (pathname !== '/presence/ws') {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const q = Object.fromEntries(u.searchParams.entries());
    const headers = req.headers || {};
    const childTok = q.childToken || headers['x-child-token'] || '';
    const sessTok = q.sessionToken || headers['x-session-token'] || '';
    let childDev = null;
    if (childTok) {
      try { childDev = childOf({ childToken: childTok }, q, headers); } catch (e) {}
    }
    // Require a valid child OR parent token — reject anonymous upgrades
    if (!childDev) {
      let parentOk = false;
      if (sessTok) {
        try { parentOk = !!parentOf({ sessionToken: sessTok }, q, headers); } catch (e) {}
      }
      if (!parentOk) {
        try {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        } catch (e) {}
        socket.destroy();
        return;
      }
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
    );
    try { socket.setKeepAlive(true, 5000); socket.setNoDelay(true); } catch (e) {}
    if (head && head.length) socket.unshift(head);

    const slotRaw = String(q.slot || 'a').toLowerCase();
    const wsSlot = slotRaw === 'b' ? 'wb' : 'wa';
    let gen = 0;
    if (childDev && childDev.deviceId) {
      const rec = holdRecord(childDev.deviceId);
      gen = ((rec[wsSlot] && rec[wsSlot].gen) || 0) + 1;
      rec[wsSlot] = { alive: true, t: Date.now(), gen: gen };
      try { markPresence(childDev, true, 'ws-' + wsSlot); } catch (e) {}
    }
    const ping = setInterval(() => {
      try { socket.write(wsFrame('P', 0x01)); } catch (e) { try { clearInterval(ping); } catch (e2) {} }
      if (childDev && childDev.deviceId) {
        const rec = presenceHolds.get(childDev.deviceId);
        if (rec && rec[wsSlot] && rec[wsSlot].gen === gen) {
          rec[wsSlot].alive = true;
          rec[wsSlot].t = Date.now();
        }
        const pr = presenceRam.get(childDev.deviceId);
        if (pr) {
          pr.lastMs = Date.now();
          pr.online = true;
          pr.misses = 0;
          pr.pendingOffMs = 0;
        }
        childDev.lastSeen = now();
      }
    }, 2500);
    attachWsReader(socket, (text) => {
      if (childDev && childDev.deviceId) {
        const rec = presenceHolds.get(childDev.deviceId);
        if (rec && rec[wsSlot] && rec[wsSlot].gen === gen) {
          rec[wsSlot].alive = true;
          rec[wsSlot].t = Date.now();
        }
        const pr = presenceRam.get(childDev.deviceId);
        if (pr) {
          pr.lastMs = Date.now();
          pr.online = true;
          pr.misses = 0;
          pr.pendingOffMs = 0;
        }
      }
    }, () => {
      try { clearInterval(ping); } catch (e) {}
      if (childDev && childDev.deviceId) {
        const rec = presenceHolds.get(childDev.deviceId);
        if (rec && rec[wsSlot] && rec[wsSlot].gen === gen) {
          // Short grace so brief WS recycle does not drop LINK count
          rec[wsSlot].alive = true;
          const dropGen = gen;
          setTimeout(() => {
            const cur = presenceHolds.get(childDev.deviceId);
            if (!cur || !cur[wsSlot] || cur[wsSlot].gen !== dropGen) return;
            cur[wsSlot].alive = false;
          }, 4000);
        }
      }
    });
  } catch (e) {
    try { socket.destroy(); } catch (e2) {}
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Backend ready on http://0.0.0.0:' + PORT + '/  (GET /health)  ws=/presence/ws');
});
