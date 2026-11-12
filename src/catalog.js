// SuperTV — canales de TV en vivo: servicio, categorías, canales, búsqueda, EPG y resolución del stream.
// Las credenciales se obtienen automáticamente del servidor bootstrap. El usuario no configura nada.

import { put } from "./store.js";
import { countryMatch, COUNTRY_PHRASES } from "./names.js";
import { mergeLive } from "./categories.js";

const BOOTSTRAP_URL = "http://vegetatvv2.duckdns.org/bootstrap.php";
const VEGETA_VERSION_CODE = "21"; // versionCode de la app (VegetaTV 11.1): el bootstrap rechaza menos de 21 con 426
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

const PER_PAGE = 60;
const HOME_PREVIEW = 20;

function cfg(key, fallback) {
  try {
    const v = kino.config.get(key);
    return v === undefined || v === null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

export const showAdult = () => cfg("showAdult", false) === true;
export const liveFormat = () => (cfg("liveFormat", "m3u8") === "ts" ? "ts" : "m3u8");
export const homeCountry = () => String(cfg("homeCountry", "none"));

// ---- bootstrap / caché de credenciales ------------------------------------------

// Parsea una línea del servers_text ("http://host/player_api.php?username=u&password=p [nombre]")
// y extrae { url, username, password }.
function parseServerLine(line) {
  const url = line.split(/\s/)[0].trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    if (!path.endsWith("player_api.php") && !path.endsWith("get.php")) return null;
    const username = u.searchParams.get("username") || u.searchParams.get("user") || "";
    const password = u.searchParams.get("password") || u.searchParams.get("pass") || "";
    if (!username) return null;
    const base = (u.protocol + "//" + u.host).replace(/\/+$/, "");
    return { url: base, username, password };
  } catch (_) {
    return null;
  }
}

const vegetaHeaders = (code) => ({
  "X-Vegeta-Version-Code": String(code),
  "X-Vegeta-Servers-Direct": "1",
  "Cache-Control": "no-cache, no-store",
  "Pragma": "no-cache",
});

function readVersionCode() {
  try {
    const v = String(kino.storage.get("vcode") || "");
    return /^\d+$/.test(v) && Number(v) >= Number(VEGETA_VERSION_CODE) ? v : VEGETA_VERSION_CODE;
  } catch (_) {
    return VEGETA_VERSION_CODE;
  }
}

const MAX_SERVERS = 30;

function parseServers(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const s = parseServerLine(t);
    if (!s) continue;
    const key = s.url + "|" + s.username;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  // HTTPS primero: es lo único que Kino deja usar con servidores externos.
  return out.sort((a, b) => (b.url.startsWith("https://") ? 1 : 0) - (a.url.startsWith("https://") ? 1 : 0));
}

// El bootstrap exige un código de versión mínimo (426 / ok:false). Se parte del guardado y se reintenta UNA vez con el
// mayor entre minimum_version_code y latest_version_code que el propio servicio declare; el que funciona se guarda.
async function fetchServerList() {
  let code = readVersionCode();
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await kino.fetch(BOOTSTRAP_URL + "?v=" + Date.now(), { headers: { ...vegetaHeaders(code), "Accept": "application/json" } });
    let data = null;
    try { data = r.json(); } catch (_) { data = null; }
    if (!r.ok || !data || data.ok === false) {
      const want = data ? Math.max(Number(data.minimum_version_code) || 0, Number(data.latest_version_code) || 0) : 0;
      if (attempt === 0 && want > Number(code)) { code = String(want); continue; }
      throw kino.error("unavailable", "bootstrap " + r.status, { userMessage: "No se pudo conectar con el servicio." });
    }

    let list = [];
    if (typeof data.servers_text === "string" && data.servers_text.trim()) list = parseServers(data.servers_text);
    if (!list.length && typeof data.servers_url === "string" && data.servers_url.trim()) {
      const r2 = await kino.fetch(data.servers_url, { headers: { ...vegetaHeaders(code), "Accept": "text/plain" } });
      if (r2.ok) list = parseServers(r2.text());
    }
    if (!list.length) {
      const want = Math.max(Number(data.minimum_version_code) || 0, Number(data.latest_version_code) || 0);
      if (attempt === 0 && want > Number(code)) { code = String(want); continue; }
      throw kino.error("unavailable", "bootstrap: sin servidores", { userMessage: "El servicio no tiene servidores disponibles." });
    }
    put("vcode", String(code));
    return list.slice(0, MAX_SERVERS);
  }
  throw kino.error("unavailable", "bootstrap: sin servidores", { userMessage: "El servicio no tiene servidores disponibles." });
}

// Clave corta del servidor activo (sin usuario ni contraseña a la vista): separa las cachés de catálogo entre servidores.
export function serverKey() {
  const st = readSrvs();
  const srv = st && Array.isArray(st.list) ? st.list[st.idx] : null;
  if (!srv) return "";
  let h = 5381;
  const text = srv.url + "|" + srv.username;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function readSrvs() {
  try { return JSON.parse(kino.storage.get("srvs") || "null"); } catch (_) { return null; }
}

function writeSrvs(st) {
  put("srvs", JSON.stringify(st));
}

// Estado en storage: { ts, list, idx (servidor activo), ok (idx ya comprobado) }.
async function loadServers(force) {
  const cached = readSrvs();
  const usable = cached && Array.isArray(cached.list) && cached.list.length;
  if (!force && usable && cached.ts && Date.now() - cached.ts < CACHE_TTL_MS) return cached;
  try {
    const list = await fetchServerList();
    const st = { ts: Date.now(), list, idx: 0, ok: false };
    writeSrvs(st);
    return st;
  } catch (e) {
    lastErr = "lista: " + errText(e);
    if (usable) return cached; // bootstrap caído: seguimos con la lista vieja
    throw e;
  }
}

// ---- Xtream Codes API -----------------------------------------------------------

function badAnswer(action, data) {
  if (data === null || typeof data !== "object") return true;
  if (!Array.isArray(data)) {
    const auth = data.user_info && data.user_info.auth;
    return auth !== undefined && String(auth) === "0";
  }
  return data.length === 0 && action.endsWith("_categories");
}

async function callServer(srv, action, extra) {
  const params = new URLSearchParams({ username: srv.username, password: srv.password, action, ...extra });
  const r = await kino.fetch(`${srv.url}/player_api.php?${params}`, {
    headers: {
      "Accept": "application/json,text/plain,*/*",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "User-Agent": "Mozilla/5.0 (compatible; VegetaTVCache/2.0)"
    }
  });
  if (!r.ok) throw new Error("API " + r.status);
  const data = r.json();
  if (badAnswer(action, data)) throw new Error("respuesta inválida");
  return data;
}

// El servidor "de casa" es el primero de la lista (HTTPS primero): al que se vuelve cuando responde tras un fallo.
function homeIdx(_st) {
  return 0;
}

// Tras un fallo se pasó a otro servidor: se vuelve al de casa en cuanto responde (se mira cada 5 min), salvo que la persona haya
// elegido otro a mano con «Cambiar servidor».
async function backHome() {
  const st = await loadServers(false);
  const home = homeIdx(st);
  if (st.idx === home || st.pin || Date.now() - (st.homeAt || 0) < 300000) return;
  st.homeAt = Date.now();
  try {
    await callServer(st.list[home], "get_vod_categories", {});
    st.idx = home; st.ok = true; st.okAt = Date.now();
  } catch (_) { /* sigue en el actual */ }
  writeSrvs(st);
}

async function api(action, extra = {}) {
  let last = "";
  for (let pass = 0; pass < 2; pass++) {
    const st = await loadServers(pass === 1);
    if (pass === 0) await backHome();
    const st2 = readSrvs();
    if (st2 && pass === 0) { st.idx = st2.idx; st.ok = st2.ok; st.okAt = st2.okAt; st.homeAt = st2.homeAt; }
    for (let n = 0; n < st.list.length; n++) {
      const i = (st.idx + n) % st.list.length;
      try {
        const data = await callServer(st.list[i], action, extra);
        if (i !== st.idx || !st.ok || Date.now() - (st.okAt || 0) > 5000) {
          st.idx = i;
          st.ok = true;
          st.okAt = Date.now();
          writeSrvs(st);
        }
        return data;
      } catch (e) {
        if (e && e.code === "rate_limited") throw e;
        last = String((e && e.message) || e).slice(0, 80);
        lastErr = last;
      }
    }
  }
  throw kino.error("unavailable", "ningún servidor respondió (" + action + "): " + last, { userMessage: "Error al contactar el servidor." });
}

async function activeServer() {
  let st = await loadServers(false);
  if (!st.ok) {
    await api("get_vod_categories");
    st = readSrvs();
  }
  return st.list[st.idx];
}

// ---- estado y cambio de servidor (ajustes) ---------------------------------------

let lastErr = "";
const errText = (e) => String((e && (e.message || e.code)) || e).slice(0, 90);
// Kino solo carga imágenes por HTTPS: un logo http se pide por https (si ese host no lo sirve, sale sin imagen como antes).
const img = (u) => {
  const s = typeof u === "string" ? u.trim() : "";
  if (!s) return undefined;
  return /^http:\/\//i.test(s) ? "https://" + s.slice(7).replace(/^([^/:]+):80(?=\/|$)/, "$1") : s;
};
const hostOf = (srv) => {
  try { return new URL(srv.url).host; } catch (_) { return ""; }
};

// Nunca expone usuario ni contraseña: solo el host y la posición en la lista.
export async function serverStatus() {
  const cached = readSrvs();
  // Si ya hubo una respuesta buena de este servidor, se informa sin otra petición (el servicio puede tardar y el estado caducaba).
  if (cached && cached.ok && cached.list && cached.list[cached.idx] && Date.now() - (cached.okAt || 0) < 20000) return { ok: true, host: hostOf(cached.list[cached.idx]), index: cached.idx + 1, total: cached.list.length, at: cached.okAt };
  try {
    await api("get_vod_categories");
    const st = readSrvs();
    return { ok: true, host: hostOf(st.list[st.idx]), index: st.idx + 1, total: st.list.length, at: st.okAt };
  } catch (e) {
    lastErr = errText(e);
    const st = readSrvs();
    return { ok: false, host: st && st.list[st.idx] ? hostOf(st.list[st.idx]) : "", index: st ? st.idx + 1 : 0, total: st ? st.list.length : 0 };
  }
}

export async function switchServer() {
  const st = await loadServers(false);
  const n = st.list.length;
  const https = st.list.filter((s) => String(s.url).startsWith("https://")).length;
  for (let k = 1; k < n; k++) {
    const i = (st.idx + k) % n;
    try {
      await callServer(st.list[i], "get_vod_categories", {});
      st.idx = i;
      st.ok = true;
      st.okAt = Date.now();
      st.pin = i !== homeIdx(st); // elegido a mano: no se vuelve solo al de casa
      writeSrvs(st);
      return { changed: true, host: hostOf(st.list[i]), index: i + 1, total: n };
    } catch (e) { lastErr = errText(e); }
  }
  return { changed: false, host: hostOf(st.list[st.idx]), index: st.idx + 1, total: n, https };
}

export async function refreshServers() {
  const before = readSrvs();
  const st = await loadServers(true);
  const fresh = !before || st.ts !== before.ts; // la lista se pidió de nuevo (si el arranque falla, loadServers devuelve la vieja)
  let ok = fresh;
  if (fresh) { try { await api("get_vod_categories"); } catch (_) { /* la lista nueva ya está; el servidor se prueba al usarlo */ } }
  const now = readSrvs() || st;
  return { ok, total: now.list.length, host: hostOf(now.list[now.idx]) };
}

export async function settingsStatus() {
  const s = await serverStatus();
  if (!s.ok) return { status: (s.host ? `Sin respuesta de ${s.host}` : "Sin conexión con el servicio") + (lastErr ? ` · ${lastErr}` : "") };
  return { status: `Conectado a ${s.host} (${s.index} de ${s.total}) · comprobado ${s.at ? "hace " + Math.max(0, Math.round((Date.now() - s.at) / 1000)) + " s" : "ahora"}` };
}

export async function action(key) {
  if (key === "switchServer") {
    const r = await switchServer();
    return { message: r.changed ? `Servidor cambiado a ${r.host}` : "No hay otro servidor que responda ahora" + (lastErr ? ` (${lastErr})` : ""), refresh: true };
  }
  if (key === "refreshServers") {
    const r = await refreshServers();
    return { message: r.ok ? `Lista actualizada: ${r.total} servidores` : "No se pudo actualizar la lista" + (lastErr ? ` (${lastErr})` : ""), refresh: true };
  }
  throw kino.error("not_found");
}


// Una categoría: vacía ([]) es válida; fallar lanza (se reintenta una vez, con respaldo de servidor dentro de api()).
async function fetchCategory(action, categoryId) {
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await api(action, { category_id: String(categoryId) });
      if (!Array.isArray(data)) throw new Error("respuesta que no es lista");
      return data;
    } catch (e) {
      if (attempt >= 1 || (e && e.code === "rate_limited")) throw e;
    }
  }
}

// ---- categorías y filas ---------------------------------------------------------

// Lista real de categorías (pequeña): en memoria y en storage, con la clave del servidor activo y vigencia de 6 h.
const CAT_ACTIONS = { vod: "get_vod_categories", series: "get_series_categories", live: "get_live_categories" };
const catMemo = {};

async function categoryList(kind) {
  const key = serverKey();
  const m = catMemo[kind];
  if (key && m && m.key === key && Date.now() - m.ts < CACHE_TTL_MS) return m.list;
  if (key) {
    try {
      const o = JSON.parse(kino.storage.get("cats:" + kind + ":" + key) || "null");
      if (o && Array.isArray(o.l) && Date.now() - o.ts < CACHE_TTL_MS) {
        const list = o.l.map(([category_id, category_name]) => ({ category_id, category_name }));
        catMemo[kind] = { key, ts: o.ts, list };
        return list;
      }
    } catch (_) { /* se vuelve a pedir */ }
  }
  const data = await api(CAT_ACTIONS[kind]);
  const list = (Array.isArray(data) ? data : []).map((c) => ({ category_id: String(c.category_id || ""), category_name: String(c.category_name || "").trim() }));
  const now = serverKey();
  catMemo[kind] = { key: now, ts: Date.now(), list };
  put("cats:" + kind + ":" + now, JSON.stringify({ ts: Date.now(), l: list.map((c) => [c.category_id, c.category_name]) }));
  return list;
}

// ---- live -----------------------------------------------------------------------

const LIVE_PAGE = 200;
const LIVE_CATS_TTL_MS = 10 * 60 * 1000;
let liveCatsMemo = null;

// Las categorías cambian de un servidor a otro: la caché lleva la clave del servidor activo.
async function liveCats() {
  const key = serverKey();
  if (liveCatsMemo && key && liveCatsMemo.key === key && Date.now() - liveCatsMemo.ts < LIVE_CATS_TTL_MS) return liveCatsMemo.list;
  const merged = mergeLive(await categoryList("live"), { showAdult: true });
  liveCatsMemo = { key: serverKey(), ts: Date.now(), list: merged };
  return merged;
}

const visibleLive = (list) => (showAdult() ? list : list.filter((c) => !c.adult));

export async function liveCategories() {
  return visibleLive(await liveCats()).map((c) => ({
    id: c.id,
    title: c.title,
    group: c.group,
    ...(c.country ? { country: c.country } : {}),
    ...(c.genre ? { genre: c.genre } : {}),
    ...(c.adult ? { adult: true } : {}),
  }));
}

// Página de una categoría en vivo (para "ver más" de una fila). Solo refs "lcat:<id>".
export async function browse(ref, cursor) {
  const [prefix, catId] = String(ref || "").split(":");
  if (prefix !== "lcat" || !/^\d+$/.test(catId || "")) return { items: [] };
  const page = Math.max(1, parseInt(cursor, 10) || 1);
  const start = (page - 1) * PER_PAGE;
  const out = await liveChannels({ categoryId: catId });
  const all = out.items.map((i) => ({ id: i.id, ref: i.ref, title: i.title, kind: "live", poster: i.logo, ...(i.adult ? { adult: true } : {}) }));
  return { items: all.slice(start, start + PER_PAGE), next: all.length > start + PER_PAGE ? String(page + 1) : undefined };
}

function liveItem(s, categoryId, adult) {
  const id = String(s.stream_id || "");
  const title = String(s.name || "").trim();
  if (!id || !title) return null;
  return {
    id: "live-" + id,
    title,
    ref: "live:" + id,
    logo: img(s.stream_icon),
    number: parseInt(s.num, 10) || undefined,
    categoryId: String(categoryId || s.category_id || ""),
    ...(adult ? { adult: true } : {}),
  };
}

export async function liveChannels({ categoryId, cursor }) {
  const cat = (await liveCats().catch(() => [])).find((c) => c.id === String(categoryId));
  const adult = !!(cat && cat.adult);
  if (adult && !showAdult()) return { items: [] };
  const all = await fetchCategory("get_live_streams", String(categoryId || ""));
  const start = Math.max(0, parseInt(cursor, 10) || 0);
  const items = all.slice(start, start + LIVE_PAGE).map((s) => liveItem(s, categoryId, adult)).filter(Boolean);
  return { items, next: all.length > start + LIVE_PAGE ? String(start + LIVE_PAGE) : undefined };
}

export async function liveSearchDetailed({ query }, { budgetMs = 11000 } = {}) {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < 2) return { items: [], partial: false };
  const deadline = Date.now() + budgetMs;
  const cats = visibleLive(await liveCats());
  const LIMIT = 100;
  const MAX_CATS = 36; // una petición por categoría; el servidor IPTV admite 60 por minuto
  const items = [];
  const seen = new Set();
  let failed = 0;
  let capped = false;
  let scanned = 0;
  for (let i = 0; i < cats.length && items.length < LIMIT; i += 3) {
    if (scanned >= MAX_CATS || Date.now() > deadline) { capped = true; break; }
    const slice = cats.slice(i, i + 3);
    scanned += slice.length;
    const batch = await Promise.all(slice.map(async (cat) => {
      try {
        const data = await fetchCategory("get_live_streams", cat.id);
        return data.filter((s) => String(s.name || "").toLowerCase().includes(q)).map((s) => liveItem(s, cat.id, cat.adult)).filter(Boolean)
          .map((it) => ({ ...it, adult: cat.adult === true }));
      } catch (e) {
        if (e && e.code === "rate_limited") capped = true; else failed++;
        return [];
      }
    }));
    for (const list of batch) for (const it of list) if (items.length < LIMIT && !seen.has(it.id)) { seen.add(it.id); items.push(it); }
    if (capped) break;
  }
  if (items.length < LIMIT && scanned < cats.length) capped = true;
  if (!items.length && failed) throw kino.error("unavailable", "la búsqueda no pudo completarse", { userMessage: "No se pudo completar la búsqueda." });
  return { items, partial: failed > 0 || capped };
}

export async function liveSearch(args) {
  const { items } = await liveSearchDetailed(args);
  return { items };
}

// Tarjeta de canal para las capacidades nativas (home/search): el logo va de póster.
const liveCard = (it) => ({ id: it.id, ref: it.ref, title: it.title, kind: "live", poster: it.logo, ...(it.adult ? { adult: true } : {}) });

// home nativo: filas de las primeras categorías en vivo (cada fila, una petición: el servidor admite 60 por minuto).
export async function home() {
  const cats = (await liveCategories()).slice(0, 10);
  const rows = [];
  for (let i = 0; i < cats.length; i += 3) {
    const batch = await Promise.all(cats.slice(i, i + 3).map(async (c) => {
      try {
        const page = await liveChannels({ categoryId: c.id });
        const items = page.items.slice(0, 20).map(liveCard);
        return items.length ? { id: "lcat-" + c.id, title: c.title, genre: "tv", ref: "lcat:" + c.id, items } : null;
      } catch (_) { return null; }
    }));
    rows.push(...batch.filter(Boolean));
  }
  if (!rows.length) throw kino.error("unavailable", "sin canales", { userMessage: "Sin canales disponibles por ahora." });
  return rows;
}

// search nativo: busca entre los canales.
export async function search(query) {
  const q = String((query && query.q) || query || "").trim();
  if (!q) return [];
  const { items } = await liveSearchDetailed({ query: q });
  return items.map(liveCard);
}

// ---- canales de tu país ---------------------------------------------------------

export const isCountryCode = (cc) => COUNTRY_PHRASES.some(([, code]) => code === cc);

// El país va en el nombre de la categoría ("COLOMBIA", "DEPORTES PERU", "VIX - MEXICO"): las que SON el país primero.
export async function countryRow(limit = 20) {
  const cc = homeCountry();
  if (!isCountryCode(cc)) return null;
  const ranked = visibleLive(await liveCats())
    .filter((c) => c.country === cc)
    .map((c) => ({ c, m: countryMatch(c.title) }))
    .sort((a, b) => (a.m && a.m.exact ? 0 : a.m && a.m.starts ? 1 : 2) - (b.m && b.m.exact ? 0 : b.m && b.m.starts ? 1 : 2) || a.c.order - b.c.order)
    .slice(0, 3);
  const items = [];
  const seen = new Set();
  for (const { c } of ranked) {
    if (items.length >= limit) break;
    const data = await fetchCategory("get_live_streams", c.id).catch(() => []);
    for (const s of data) {
      const it = liveItem(s, c.id, c.adult);
      if (!it || items.length >= limit || seen.has(it.id)) continue;
      seen.add(it.id);
      items.push({ id: it.id, ref: it.ref, title: it.title, kind: "live", poster: it.logo, ...(c.adult ? { adult: true } : {}) });
    }
  }
  return items.length ? { id: "live-country", title: "Canales en vivo", items } : null;
}

function b64text(s) {
  const str = String(s || "");
  if (!str) return "";
  try {
    const bin = atob(str);
    let out = "";
    for (let i = 0; i < bin.length; i++) out += "%" + bin.charCodeAt(i).toString(16).padStart(2, "0");
    return decodeURIComponent(out);
  } catch (_) {
    return str;
  }
}

export async function guide({ channelIds, from, to }) {
  const ids = (Array.isArray(channelIds) ? channelIds : []).slice(0, 50);
  const lists = await Promise.all(ids.map(async (cid) => {
    const streamId = String(cid).replace(/^live-/, "");
    if (!/^\d+$/.test(streamId)) return [];
    try {
      const data = await api("get_short_epg", { stream_id: streamId, limit: "20" });
      const rows = Array.isArray(data) ? data : (data && (data.epg_listings || data.listings || data.epg)) || [];
      return rows.map((e) => ({
        channelId: String(cid),
        title: b64text(e.title),
        description: b64text(e.description || e.descr),
        start: (parseInt(e.start_timestamp, 10) || 0) * 1000,
        end: (parseInt(e.stop_timestamp || e.end_timestamp, 10) || 0) * 1000,
      })).filter((e) => e.title && e.end > e.start && e.end > from && e.start < to);
    } catch (_) {
      return [];
    }
  }));
  return lists.flat();
}

// ---- resolve --------------------------------------------------------------------

export async function resolve(ref) {
  const { url, username, password } = await activeServer();
  const s = String(ref || "");
  if (s.startsWith("live:")) {
    const id = s.slice(5);
    if (!/^\d+$/.test(id)) throw kino.error("not_found");
    return { url: `${url}/live/${username}/${password}/${id}.${liveFormat()}` };
  }
  throw kino.error("not_found", "ref desconocido: " + s.slice(0, 30));
}

export { api, liveItem };
