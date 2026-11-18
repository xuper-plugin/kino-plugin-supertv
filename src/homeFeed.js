// Baja el Home pre-armado que el Action publica 2x/día, SELLADO (home/<serverKey>.enc.json, AES-256-GCM con el secreto feedKey,
// igual que Xuper). El plugin lo abre con kino.secret("feedKey") — solo dentro de Kino: una copia del código fuera de Kino (un
// fork) no puede. Si existe y es reciente, pinta el Home al instante; si falta, está viejo, no abre o falla, se carga en vivo.
// Solo trae canales ESTABLES (los eventos del momento NO se cachean: se cargan en vivo).
import { put } from "./store.js";
import { liveRef } from "./liveFailover.js";
import { categoryTok, channelTok } from "./channelMatch.js";

// Where the feeds live. The Action force-pushes the complete current set to the orphan `data` branch on every run (no
// history) and keeps the same paths on `main` while older installs still read only `main`. A device reads `data` first;
// when that copy is missing or unusable (any non-2xx answer, or a body that does not open or fails the checks below; never
// a network error, since `main` is on the same host) it reads the same path on `main`. Only a `data` 404 for a feed `main`
// serves fresh says the branch does not exist yet: then `data` is skipped for DATA_MISS_MS (in memory and in kino.storage,
// with the time it was seen), so a device does not pay two requests per feed before `data` exists. Anything else (a 5xx or
// 429, an account `data` dropped, a copy missing on both) is never remembered: once `main` is no longer written, a mark set
// by it would leave the Home without its feed for hours.
const REPO = "https://raw.githubusercontent.com/xuper-plugin/kino-plugin-supertv/";
const DIR = "home/";
export const DATA_MISS_KEY = "feedData:v1";
export const DATA_MISS_MS = 6 * 60 * 60 * 1000;
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // tolera varias corridas perdidas; más viejo que esto -> se ignora y se carga en vivo
const FEED_TIMEOUT_MS = 8000; // per request, only when the caller gives a deadline (the first-run tick)

// When `data` last lacked the feed (ms, 0 = never); null until read from storage, once per runtime.
let dataMissAt = null;

function dataMissing(now) {
  if (dataMissAt === null) {
    let v = null;
    try { v = kino.storage.get(DATA_MISS_KEY); } catch (_) { v = null; }
    dataMissAt = /^\d+$/.test(String(v || "")) ? Number(v) : 0;
  }
  const age = now - dataMissAt;
  return dataMissAt > 0 && age >= 0 && age < DATA_MISS_MS;
}

function noteDataMissing(now) {
  dataMissAt = now;
  try { put(DATA_MISS_KEY, String(now)); } catch (_) { /* remembered for this runtime only */ }
}

// Abre el sobre sellado { v:1, iv:b64, data:b64 } con el secreto feedKey (AES-256-GCM). null si no abre. Nunca lanza.
function openBox(box) {
  if (!box || typeof box !== "object" || box.v !== 1 || typeof box.iv !== "string" || typeof box.data !== "string") return null;
  try {
    const text = kino.crypto.decrypt("aes-256-gcm", { key: kino.secret("feedKey"), iv: box.iv, ivEncoding: "base64", data: box.data });
    return JSON.parse(text);
  } catch (_) { return null; }
}

// Deja una lista de filas de un tab solo con filas válidas (id/title/items), o null si no sirve.
function railsOf(rails) {
  if (!Array.isArray(rails)) return null;
  const r = rails.filter((x) => x && typeof x.id === "string" && typeof x.title === "string" && Array.isArray(x.items) && x.items.length);
  return r.length ? r : null;
}

// The opened feed when it is this server's, recent and has at least one valid tab; else null.
function feedOf(box, serverKey) {
  const d = openBox(box);
  if (!d || d.v !== 1 || d.serverKey !== serverKey || !d.tabs || typeof d.tabs !== "object") return null;
  if (typeof d.at === "number" && Date.now() - d.at > MAX_AGE_MS) return null;
  const tabs = {};
  for (const k of Object.keys(d.tabs)) { const t = railsOf(d.tabs[k]); if (t) tabs[k] = t; }
  return Object.keys(tabs).length ? { tabs } : null;
}

// One branch's copy: { feed }, { miss: true, status } (a non-2xx answer or an unusable body; the HTTP status) or
// { net: true } (the request failed, or the caller's deadline leaves no time for it).
async function fetchCopy(branch, serverKey, opts) {
  let init = { headers: { Accept: "application/json" } };
  if (opts && typeof opts.until === "number") {
    const left = opts.until - Date.now() - 300;
    if (left < 1000) return { net: true };
    init = { ...init, timeoutMs: Math.min(FEED_TIMEOUT_MS, left) };
  }
  let r;
  try {
    // El `v` por hora evita una caché de CDN demasiado pegajosa sin pedir siempre de nuevo.
    r = await kino.fetch(`${REPO}${branch}/${DIR}${encodeURIComponent(serverKey)}.enc.json?v=${Math.floor(Date.now() / 3600000)}`, init);
  } catch (_) { return { net: true }; }
  const status = r ? Number(r.status) || 0 : 0;
  if (!r || !r.ok) return { miss: true, status };
  try {
    const feed = feedOf(JSON.parse(r.text()), serverKey);
    return feed ? { feed } : { miss: true, status };
  } catch (_) { return { miss: true, status }; }
}

/**
 * El Home pre-armado del servidor, o null (sin feed, viejo, no abre, no coincide, o falló): `{ tabs: { all:[rails], ... } }`.
 * opts.until (ms): a deadline for both requests (each one gets at most FEED_TIMEOUT_MS); without it Kino's own timeout applies.
 */
export async function fetchHomeFeed(serverKey, opts) {
  if (!serverKey) return null;
  try {
    if (!dataMissing(Date.now())) {
      const d = await fetchCopy("data", serverKey, opts);
      if (d.feed) return d.feed;
      if (d.net) return null;
      const m = await fetchCopy("main", serverKey, opts);
      if (m.feed && d.status === 404) noteDataMissing(Date.now());
      return m.feed || null;
    }
    const m = await fetchCopy("main", serverKey, opts);
    return m.feed || null;
  } catch (_) { return null; }
}

const BARE_REF = /^live:(\d+)$/;

/**
 * [rails] (a feed's or a Home snapshot's) with every bare `live:<id>` ref rebuilt the way a live listing builds it now, with
 * no request. 0.4.0 code wrote bare refs, and the live failover plays a bare ref on the active account only. The ref gains
 * the rail's category id and that category's name, read through [catName] (the active server's cached categories; an
 * unknown name travels as "_", as in a listing made without them). With [rawTitles] (a feed made by 0.4.0 code: its titles
 * are the panels' raw names) it also gains the channel's name, so the failover can find the channel on another panel. A
 * snapshot's titles may be cleaned already, so its refs carry no channel name: the failover then tries the same id on the
 * other accounts of the panel only. A rail without a numeric category id keeps its refs.
 */
export function upgradeBareRefs(rails, { catName, rawTitles = false } = {}) {
  if (!Array.isArray(rails)) return rails;
  return rails.map((r) => {
    if (!r || !Array.isArray(r.items) || !/^\d+$/.test(String(r.catId || ""))) return r;
    const catId = String(r.catId);
    let catTok = null;
    let changed = false;
    const items = r.items.map((it) => {
      const m = it && typeof it.ref === "string" ? BARE_REF.exec(it.ref) : null;
      if (!m) return it;
      if (catTok === null) {
        let name = "";
        try { name = String((typeof catName === "function" && catName(catId)) || ""); } catch (_) { name = ""; }
        catTok = categoryTok(name);
      }
      changed = true;
      const tok = rawTitles && typeof it.title === "string" ? channelTok(it.title) : "";
      return { ...it, ref: liveRef(m[1], catId, catTok, tok) };
    });
    return changed ? { ...r, items } : r;
  });
}
