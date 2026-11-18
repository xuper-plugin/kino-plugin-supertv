// kino.storage holds 262144 bytes per plugin, measured the way Kino writes it: the whole store as ONE JSON object
// (PluginStorage.encodeStorageJson; Android's org.json escapes `"`, `\` and `/`), and every set() or remove() rewrites that
// whole file. Everything persistent goes through here: each class has its budget, a class over it loses its oldest entries,
// and the total stays under SOFT_CAP, all in Kino's measure. `_idx` keeps each entry's last write AND its size, so a put
// never reads the rest of the store; it is written once per call (flushIndex, which plugin.js runs when each export ends),
// not after every put. A set() that fails never breaks the plugin: put() degrades (returns false).
export const TOTAL_CAP = 262144;
export const SOFT_CAP = 200 * 1024;

// Clases: prefijo de clave -> presupuesto en bytes (medida de Kino). "keep" = nunca se expulsa por falta de espacio de otra clase.
export const CLASSES = {
  servers: { match: (k) => k === "srvs" || k === "vcode", budget: 9 * 1024, keep: true },
  // The person's choices: nothing else can evict them (they used to share the 2 KB "misc" class with the health result).
  prefs: { match: (k) => k === "srvChosen:v1" || k === "superTab" || k === "seed:v1", budget: 256, keep: true },
  health: { match: (k) => k === "health:v1", budget: 3 * 1024, keep: true },
  panels: { match: (k) => k === "panels:v1", budget: 4 * 1024, keep: true },
  acct: { match: (k) => k === "acct:v1", budget: 2 * 1024, keep: true },
  // The live failover's last switch (live:v1): the account it moved a channel to survives a runtime restart.
  live: { match: (k) => k === "live:v1", budget: 512, keep: true },
  cats: { match: (k) => k.startsWith("cats:"), budget: 60 * 1024 },
  hist: { match: (k) => k.startsWith("searchHist:"), budget: 10 * 1024 },
  // The Home snapshot: every tab of one server in ONE entry (one rewrite per feed), painted at once on the next open.
  homeSnap: { match: (k) => k.startsWith("homeSnap:"), budget: 40 * 1024 },
  misc: { match: () => true, budget: 2 * 1024 },
};
const ORDER = ["servers", "prefs", "health", "panels", "acct", "live", "cats", "hist", "homeSnap", "misc"];
const IDX = "_idx";

export const classOf = (key) => ORDER.find((c) => CLASSES[c].match(key));

/** UTF-8 bytes of [s] written as a JSON string the way Kino writes its store (quotes included): `"`, `\`, `/` escaped. */
export function jsonLen(s) {
  let n = 2;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c === 0x2f) n += 2;
    else if (c < 0x20) n += c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6;
    else if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) { n += 4; i++; } else n += 3;
  }
  return n;
}

/** What one entry adds to Kino's measure of the store: its key and value as JSON strings, the colon and the comma. */
export const entryLen = (key, value) => jsonLen(key) + jsonLen(value) + 2;

// The index of this call: Map key -> { ts, bytes }. Read once per call (the storage object it belongs to is checked, so a
// test's new store is never read through an old index), written by flushIndex.
let memo = null;

function loadIdx() {
  let storage = null;
  try { storage = kino.storage; } catch (_) { storage = null; }
  if (memo && memo.of === storage) return memo;
  const map = new Map();
  let dirty = false;
  let keys = [];
  try { keys = kino.storage.keys(); } catch (_) { keys = []; }
  let raw = {};
  try {
    const o = JSON.parse(kino.storage.get(IDX) || "null");
    if (o && typeof o === "object" && !Array.isArray(o)) raw = o;
  } catch (_) { raw = {}; }
  for (const k of keys) {
    if (k === IDX) continue;
    const e = raw[k];
    if (Array.isArray(e) && Number.isFinite(e[0]) && Number.isFinite(e[1]) && e[1] > 0) { map.set(k, { ts: e[0], bytes: e[1] }); continue; }
    // Written before sizes were kept (or by a call that ended before its flush): measured once, then kept.
    let v = null;
    try { v = kino.storage.get(k); } catch (_) { v = null; }
    if (v === null || v === undefined) continue;
    map.set(k, { ts: typeof e === "number" && Number.isFinite(e) ? e : 0, bytes: entryLen(k, v) });
    dirty = true;
  }
  if (Object.keys(raw).some((k) => !map.has(k))) dirty = true;
  memo = { of: storage, map, dirty };
  return memo;
}

// `_idx`'s own share of the measure: `"k":[ts,bytes],` per entry, each quote escaped inside the stored string.
const idxLen = (map) => { let n = 16; for (const k of map.keys()) n += jsonLen(k) + 32; return n; };

/** Writes `_idx` when this call changed it, and forgets it (the next call reads it again). plugin.js runs it after every export. */
export function flushIndex() {
  const m = memo;
  memo = null;
  if (!m || !m.dirty) return;
  const o = {};
  for (const [k, e] of m.map) o[k] = [e.ts, e.bytes];
  try { kino.storage.set(IDX, JSON.stringify(o)); } catch (_) { /* no index: the next call measures what it lacks */ }
}

/** Kino's measure of the store as this index sees it: total bytes, bytes per class, entries. */
export function usage() {
  const idx = loadIdx();
  const byClass = {};
  let total = 2 + idxLen(idx.map);
  for (const [k, e] of idx.map) { const c = classOf(k); byClass[c] = (byClass[c] || 0) + e.bytes; total += e.bytes; }
  return { total, byClass, count: idx.map.size };
}

function evict(idx, key) {
  try { kino.storage.remove(key); } catch (_) { /* ya no está */ }
  idx.map.delete(key);
  idx.dirty = true;
}

// Guarda [value] (texto) bajo [key]. Devuelve true si quedó guardado; false si no cupo (el plugin sigue sin esa caché).
export function put(key, value) {
  try {
    const klass = classOf(key);
    const need = entryLen(key, value);
    if (need > CLASSES[klass].budget) return false;
    const idx = loadIdx();
    const others = () => [...idx.map].filter(([k]) => k !== key).map(([k, e]) => ({ key: k, klass: classOf(k), ...e }));
    const oldest = (list, pred) => list.filter(pred).sort((a, b) => a.ts - b.ts)[0];

    let list = others();
    let used = list.filter((e) => e.klass === klass).reduce((n, e) => n + e.bytes, 0);
    while (used + need > CLASSES[klass].budget) {
      const victim = oldest(list, (e) => e.klass === klass);
      if (!victim) return false;
      used -= victim.bytes;
      evict(idx, victim.key);
      list = others();
    }
    let total = 2 + idxLen(idx.map) + list.reduce((n, e) => n + e.bytes, 0) + need;
    while (total > SOFT_CAP) {
      const victim = oldest(list, (e) => !CLASSES[e.klass].keep && e.klass !== klass) || oldest(list, (e) => !CLASSES[e.klass].keep);
      if (!victim) return false;
      total -= victim.bytes;
      evict(idx, victim.key);
      list = others();
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        kino.storage.set(key, value);
        idx.map.set(key, { ts: Date.now(), bytes: need });
        idx.dirty = true;
        return true;
      } catch (_) {
        // Kino measured more than the index says (an entry written outside it): the oldest evictable entry goes.
        const victim = oldest(others(), (e) => !CLASSES[e.klass].keep);
        if (!victim) return false;
        evict(idx, victim.key);
      }
    }
    return false;
  } catch (_) {
    return false;
  }
}

export function get(key) {
  try { return kino.storage.get(key); } catch (_) { return null; }
}

export function remove(key) {
  const idx = loadIdx();
  if (!idx.map.has(key)) { try { if (kino.storage.get(key) === null) return; } catch (_) { return; } }
  evict(idx, key);
}
