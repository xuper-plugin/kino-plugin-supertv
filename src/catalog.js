// SuperTV — canales de TV en vivo: servicio, categorías, canales, búsqueda, EPG y resolución del stream.
// Las credenciales se obtienen automáticamente del servidor bootstrap. El usuario no configura nada.

import { put } from "./store.js";
import { countryMatch, COUNTRY_PHRASES } from "./names.js";
import { mergeLive } from "./categories.js";
import { say } from "./i18n.js";
import { keyOf, pairHashes, groupPanels, readPanels, writePanels, panelOf, noteDead, noteBlocked, noteAlive, usable, accountVerdict } from "./panels.js";
import { categoryTok, channelTok } from "./channelMatch.js";
import { createLiveFailover, liveRef } from "./liveFailover.js";
import { channelTitles, cleanChannelTitle, categoryKey, normName } from "./channelTitle.js";

export { keyOf };

const BOOTSTRAP_URL = "http://vegetatvv2.duckdns.org/bootstrap.php";
const VEGETA_VERSION_CODE = "21"; // versionCode de la app (VegetaTV 11.1): el bootstrap rechaza menos de 21 con 426
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas
const SRVS_V = 2; // versión de la caché de servidores: subir para invalidar listas viejas (p. ej. sin el país del servidor)

// SuperTV is live-only: a server is checked with its live categories everywhere (an empty VOD list says nothing about it).
const PROBE = "get_live_categories";
const SRVCHOSEN_KEY = "srvChosen:v1"; // written by the screen when the person (or the first-run auto-pick) chose a server

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
    // Tras la URL, la línea puede traer un nombre: "http://host/player_api.php?... [Mi Servidor]".
    const name = line.slice(url.length).trim().replace(/^\[|\]$/g, "").trim().slice(0, 40);
    return { url: base, username, password, ...(name ? { name } : {}) };
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
async function fetchServerList(opts) {
  const t = opts && opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {};
  let code = readVersionCode();
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await kino.fetch(BOOTSTRAP_URL + "?v=" + Date.now(), { headers: { ...vegetaHeaders(code), "Accept": "application/json" }, ...t });
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
      const r2 = await kino.fetch(data.servers_url, { headers: { ...vegetaHeaders(code), "Accept": "text/plain" }, ...t });
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

// Clave corta del servidor activo (keyOf, sin usuario ni contraseña a la vista): separa las cachés de catálogo entre servidores.
export function serverKey() {
  const st = readSrvs();
  const srv = st && Array.isArray(st.list) ? st.list[st.idx] : null;
  return keyOf(srv);
}

// El servidor de la lista cuya clave es [k] (para resolver una fuente alternativa contra ese servidor).
function serverByKey(k) {
  const st = readSrvs();
  if (!st || !Array.isArray(st.list)) return null;
  return st.list.find((s) => keyOf(s) === k) || null;
}

function readSrvs() {
  try { return JSON.parse(kino.storage.get("srvs") || "null"); } catch (_) { return null; }
}

function writeSrvs(st) {
  put("srvs", JSON.stringify(st));
}

// Before 0.4.1 a choice was only `pin` (also set by the health check's jump) plus the screen's flag, which the 2 KB "misc"
// storage class could evict. Once: the server active then becomes the person's `chosen` server, and `pin` goes away.
function migrate(st) {
  if (!st || !Array.isArray(st.list) || st.mig === 1) return st;
  let flag = null;
  try { flag = kino.storage.get(SRVCHOSEN_KEY); } catch (_) { flag = null; }
  if (st.chosen === undefined && (st.pin || flag === "1") && st.list[st.idx]) st.chosen = keyOf(st.list[st.idx]);
  delete st.pin;
  st.mig = 1;
  writeSrvs(st);
  return st;
}

// A new list keeps the person's choice: the chosen server (when it is still listed and not dead), else the one active
// before, else home. Without this every 6-hour refresh went back to the first server and lost the choice.
function carryOver(prev, st) {
  if (!prev) { st.idx = homeIdx(st); return st; }
  const keys = st.list.map(keyOf);
  const at = (k) => (k ? keys.indexOf(k) : -1);
  if (prev.chosen) st.chosen = prev.chosen;
  if (prev.mig) st.mig = prev.mig;
  const c = at(prev.chosen);
  const a = at(keyOf(prev.list[prev.idx]));
  st.idx = c >= 0 && usable(st.list[c]) ? c : a >= 0 ? a : homeIdx(st);
  if (st.idx === a) { st.ok = !!prev.ok; st.okAt = prev.okAt; st.homeAt = prev.homeAt; }
  return st;
}

// Estado en storage: { ts, list, idx (servidor activo), ok (idx ya comprobado), chosen (clave del elegido por la persona) }.
async function loadServers(force, opts) {
  const cached = migrate(readSrvs());
  const usableList = cached && Array.isArray(cached.list) && cached.list.length;
  if (!force && usableList && cached.ts && cached.v === SRVS_V && Date.now() - cached.ts < CACHE_TTL_MS) return cached;
  try {
    const list = await fetchServerList(opts);
    const st = carryOver(usableList ? cached : null, { ts: Date.now(), list, idx: 0, ok: false, v: SRVS_V });
    writeSrvs(st);
    return st;
  } catch (e) {
    lastErr = "lista: " + errText(e);
    if (usableList) return cached; // bootstrap caído: seguimos con la lista vieja
    throw e;
  }
}

/** The person (or the first-run auto-pick) chose a server: a key in `srvs`, never evicted. */
export function hasChosenServer() {
  const st = migrate(readSrvs());
  return !!(st && st.chosen);
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

const hostnameOf = (srv) => { try { return new URL(srv.url).hostname; } catch (_) { return ""; } };

// One Xtream call. Remembers the account: dead (auth 0 / expired) for a day, blocked (Kino refuses this server's own host)
// until the next version. A refusal of ANOTHER host (an ISP block that redirects to a government page over http) is a plain
// failure: it depends on the network, not on the account. opts.timeoutMs: the health check and the failover keep it short.
// [action] null: player_api.php with no action, the account's own small answer (`user_info`): the liveness probe.
async function callServer(srv, action, extra, opts) {
  const params = new URLSearchParams({ username: srv.username, password: srv.password, ...(action ? { action } : {}), ...extra });
  let r;
  try {
    r = await kino.fetch(`${srv.url}/player_api.php?${params}`, {
      headers: {
        "Accept": "application/json,text/plain,*/*",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "User-Agent": "Mozilla/5.0 (compatible; VegetaTVCache/2.0)"
      },
      ...(opts && opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  } catch (e) {
    if (e && e.code === "host_not_allowed" && e.host && e.host === hostnameOf(srv)) noteBlocked(srv);
    throw e;
  }
  if (!r.ok) throw new Error("API " + r.status);
  let data;
  try { data = r.json(); } catch (_) { throw new Error("respuesta inválida"); }
  if (accountVerdict(data) === "dead") {
    noteDead(srv);
    throw Object.assign(new Error("cuenta no válida"), { dead: true });
  }
  if (action ? badAnswer(action, data) : !(data && typeof data === "object" && data.user_info && typeof data.user_info === "object")) throw new Error("respuesta inválida");
  noteAlive(srv);
  return data;
}

// The live categories a probe just brought, kept as that server's category cache (no second request when it becomes active).
function rememberLiveCats(srv, data) {
  const k = keyOf(srv);
  if (!k || !Array.isArray(data) || !data.length) return;
  const list = data.map((c) => ({ category_id: String(c.category_id || ""), category_name: String(c.category_name || "").trim() }));
  if (serverKey() === k) catMemo.live = { key: k, ts: Date.now(), list };
  put("cats:live:" + k, JSON.stringify({ ts: Date.now(), l: list.map((c) => [c.category_id, c.category_name]) }));
}

// El servidor "de casa" es el primero de la lista (HTTPS primero).
function homeIdx(_st) {
  return 0;
}

// Where backHome returns: the person's chosen server, else home.
function backTarget(st) {
  if (st.chosen) {
    const i = st.list.findIndex((s) => keyOf(s) === st.chosen);
    if (i >= 0) return i;
  }
  return homeIdx(st);
}

// Tras un fallo (o el salto del chequeo de salud) se pasó a otro servidor: se vuelve al elegido por la persona (o al de casa)
// en cuanto responde. Se mira cada 5 min; nunca a uno muerto o bloqueado (cero peticiones).
// opts.timeoutMs: the timeout of its requests (the guide keeps them short).
async function backHome(opts) {
  const st = await loadServers(false, opts);
  const target = backTarget(st);
  if (st.idx === target || Date.now() - (st.homeAt || 0) < 300000 || !usable(st.list[target])) return;
  st.homeAt = Date.now();
  try {
    const data = await callServer(st.list[target], PROBE, {}, opts);
    st.idx = target; st.ok = true; st.okAt = Date.now();
    rememberLiveCats(st.list[target], data);
  } catch (_) { /* sigue en el actual */ }
  writeSrvs(st);
}

// The failover walk: the active server, then the other accounts of its panel (same ids, same lists), then the rest in
// list order. Dead and blocked accounts cost no request.
function walkOrder(st) {
  const n = st.list.length;
  const map = readPanels();
  const p = panelOf(keyOf(st.list[st.idx]), map);
  const ring = Array.from({ length: n }, (_, j) => (st.idx + j) % n);
  const same = p ? ring.filter((i) => i !== st.idx && panelOf(keyOf(st.list[i]), map) === p) : [];
  return [st.idx, ...same, ...ring.filter((i) => i !== st.idx && !same.includes(i))].filter((i) => usable(st.list[i]));
}

async function api(action, extra = {}) {
  let last = "";
  for (let pass = 0; pass < 2; pass++) {
    const st = await loadServers(pass === 1);
    if (pass === 0) await backHome();
    const st2 = readSrvs();
    if (st2 && pass === 0) { st.idx = st2.idx; st.ok = st2.ok; st.okAt = st2.okAt; st.homeAt = st2.homeAt; }
    for (const i of walkOrder(st)) {
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
const labelOf = (srv) => (srv && srv.name ? srv.name : hostOf(srv));

// En Android TV no se dibujan los emojis de bandera: decodifica la bandera a nombre de país (texto) para que se lea igual.
const FLAG_NAMES = { AR: "Argentina", BO: "Bolivia", BR: "Brasil", CA: "Canadá", CL: "Chile", CO: "Colombia", CR: "Costa Rica", CU: "Cuba", DE: "Alemania", DO: "Rep. Dominicana", EC: "Ecuador", ES: "España", FR: "Francia", GB: "Reino Unido", GT: "Guatemala", HN: "Honduras", IT: "Italia", MX: "México", NI: "Nicaragua", PA: "Panamá", PE: "Perú", PR: "Puerto Rico", PT: "Portugal", PY: "Paraguay", SV: "El Salvador", US: "EE. UU.", UY: "Uruguay", VE: "Venezuela" };
// { code (ISO2 minúsculas, para la imagen de bandera), name } o null. 🌐 => Global sin código.
function flagInfo(s) {
  const cp = [...String(s || "")];
  if (cp.length >= 2) {
    const a = cp[0].codePointAt(0), b = cp[1].codePointAt(0);
    if (a >= 0x1f1e6 && a <= 0x1f1ff && b >= 0x1f1e6 && b <= 0x1f1ff) {
      const code = String.fromCharCode(a - 0x1f1e6 + 65) + String.fromCharCode(b - 0x1f1e6 + 65);
      return { code: code.toLowerCase(), name: FLAG_NAMES[code] || code };
    }
  }
  return String(s || "").includes("🌐") ? { code: "", name: "Global" } : null;
}
// Etiqueta legible en todas partes: la bandera (si la hay) + el nombre del país; en un TV solo se ve el nombre.
const niceLabel = (srv) => { const fi = flagInfo(labelOf(srv)); return fi ? (fi.code ? `${fi.code.toUpperCase()} · ${fi.name}` : fi.name) : labelOf(srv); };

// Nunca expone usuario ni contraseña: solo el host y la posición en la lista.
export async function serverStatus() {
  const cached = readSrvs();
  // Si ya hubo una respuesta buena de este servidor, se informa sin otra petición (el servicio puede tardar y el estado caducaba).
  if (cached && cached.ok && cached.list && cached.list[cached.idx] && Date.now() - (cached.okAt || 0) < 20000) return { ok: true, host: hostOf(cached.list[cached.idx]), index: cached.idx + 1, total: cached.list.length, at: cached.okAt };
  try {
    await api(PROBE);
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
    if (!usable(st.list[i])) continue;
    try {
      const data = await callServer(st.list[i], PROBE, {});
      st.idx = i;
      st.ok = true;
      st.okAt = Date.now();
      st.chosen = keyOf(st.list[i]); // elegido a mano: es adonde se vuelve
      writeSrvs(st);
      rememberLiveCats(st.list[i], data);
      return { changed: true, host: hostOf(st.list[i]), index: i + 1, total: n };
    } catch (e) { lastErr = errText(e); }
  }
  return { changed: false, host: hostOf(st.list[st.idx]), index: st.idx + 1, total: n, https };
}

// Público hispanohablante: España, México y "Latino" primero, luego el resto de Latinoamérica, luego Global, luego otros países.
const LATAM = new Set(["ar", "bo", "cl", "co", "cr", "cu", "do", "ec", "gt", "hn", "ni", "pa", "pe", "pr", "py", "sv", "uy", "ve"]);
function srvPriority(x) {
  const code = (x.flag || "").toLowerCase();
  if (code === "es" || code === "mx" || /latino|latam/.test(String(x.label || "").toLowerCase())) return 0;
  if (LATAM.has(code)) return 1;
  if (!code) return 2; // Global / sin país
  return 3;
}
const flagOf = (srv) => { const fi = flagInfo(labelOf(srv)); return fi ? fi.code : ""; };
const priorityOf = (srv) => srvPriority({ flag: flagOf(srv), label: niceLabel(srv) });

// La lista para el selector (nunca usuario ni contraseña). Con un chequeo de salud fresco, solo muestra los que responden.
export async function serverList() {
  const st = await loadServers(false);
  const { items, checked } = listItems(st);
  return { current: st.idx, items, checked };
}

// serverList from the stored server list, with no request (the first run's rescue: the picker shows in that same tick, not
// after Kino's doubled wait); null when no list is stored.
export function cachedServerList() {
  const st = migrate(readSrvs());
  if (!st || !Array.isArray(st.list) || !st.list.length) return null;
  const { items, checked } = listItems(st);
  return { current: st.idx, items, checked };
}

// The picker's rows for [st] (no request): usable accounts only, online ones only after a fresh health check, Spanish first.
function listItems(st) {
  const h = healthFresh();
  const online = h ? new Set(h.online) : null;
  // Dead (auth 0) and blocked accounts are never offered: the first-run auto-pick and the picker skip them.
  let items = (st.list || []).map((s, i) => ({ s, i })).filter(({ s }) => usable(s)).map(({ s, i }) => {
    const fi = flagInfo(labelOf(s));
    const flag = fi ? fi.code : "";
    const label = niceLabel(s);
    // es = servidor hispanohablante (ES/MX/Latino o país de LATAM): para preferirlo al elegir automáticamente.
    return { i, label, host: hostOf(s), https: String(s.url).startsWith("https://"), flag, es: srvPriority({ flag, label }) <= 1, online: online ? online.has(s.url) : true };
  });
  if (online && online.size > 0) items = items.filter((x) => x.online);
  items.sort((a, b) => srvPriority(a) - srvPriority(b) || a.i - b.i); // hispanohablantes primero (estable por índice)
  return { items, checked: !!h };
}

// ---- first-run auto-pick ---------------------------------------------------------------------------------------------
const RACE_LANES = 3;          // accounts asked at once, one per panel host (Kino runs 6 of a plugin's requests, 4 per host)
// Each account's timeout. On the Redmi (2026-11-17) working accounts answered in 0.5-1.0 s and dead ones in 0.8-1.0 s, while
// a silent host held Kino's call to its whole timeout after the winner had answered (Kino holds a call until every request
// it sent settles): 2.5 s, not 4 s. A working account slower than that is still found by the rescue's 10 s health check.
const RACE_TRY_MS = 2500;
const RACE_MIN_TRY_MS = 1500;  // no account starts with less time than this left before the race's deadline
// The race's own deadline, counted from when the server list is in hand. The first-run tick keeps to 16 s of Kino's 20 s
// call: the list (about 0.5-2.5 s, 4 s a request at most) + this race + the feed that loads right after the winner (the
// screen keeps 2.5 s for it, the [until] it passes). Every account's timeout ends by this deadline, so Kino, which holds a
// call until each request it sent has settled, never holds the tick past it. 9 s is three rounds of 2.5 s timeouts on each
// of the three lanes, or some 25 dead accounts at about 1 s each.
const RACE_MS = 9000;

// A failure that says the panel HOST is out of reach (its other accounts would wait the same), not the account.
const HOST_DOWN = new Set(["timeout", "network", "host_not_allowed"]);
// Kino refused the request itself (the call's or the site's request budget): no more accounts start.
const NO_MORE = new Set(["rate_limited", "invalid_request"]);

/**
 * The rolling race over [cands] (ranked, Spanish first: `{ srv, es, host }`): up to RACE_LANES accounts are asked for their
 * live categories at once, never two of one host, and as soon as one fails the next in rank whose host is free starts, until
 * one answers a real list or [deadline]. Each request's timeout ends by the deadline. A host that timed out or could not be
 * reached is not asked again in this race. A Spanish answer wins at once; any other waits for the Spanish accounts still in
 * flight (Kino holds the call until they settle anyway) and wins only if none of them answers. A dead account is marked by
 * callServer and never wins. `{ srv, data }` or null; never rejects.
 */
function raceAccounts(cands, deadline) {
  return new Promise((resolve) => {
    const queue = cands.slice();
    const busy = new Set();
    const gone = new Set();
    let flying = 0, flyingEs = 0, reserve = null, stop = false, done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const settle = (c, data, e) => {
      flying--; if (c.es) flyingEs--; busy.delete(c.host);
      if (done) return;
      if (data) {
        if (c.es) { finish({ srv: c.srv, data }); return; }
        if (!reserve) reserve = { srv: c.srv, data };
      } else {
        lastErr = errText(e);
        const code = e && e.code;
        if (HOST_DOWN.has(code)) gone.add(c.host);
        if (NO_MORE.has(code)) stop = true;
      }
      pump();
    };
    const start = (c, timeoutMs) => {
      flying++; if (c.es) flyingEs++; busy.add(c.host);
      callServer(c.srv, PROBE, {}, { timeoutMs }).then(
        (data) => (Array.isArray(data) && data.length ? settle(c, data, null) : settle(c, null, new Error("respuesta inválida"))),
        (e) => settle(c, null, e));
    };
    function pump() {
      while (!stop && !reserve && flying < RACE_LANES) {
        const left = deadline - Date.now();
        if (left < RACE_MIN_TRY_MS) break;
        const at = queue.findIndex((c) => !busy.has(c.host) && !gone.has(c.host));
        if (at < 0) break;
        start(queue.splice(at, 1)[0], Math.min(RACE_TRY_MS, left));
      }
      if (reserve ? !flyingEs : !flying) finish(reserve);
    }
    pump();
  });
}

// Makes [srv] the active and chosen server with the live categories it just answered (the Home needs no second request).
// false when a server was chosen meanwhile (the person's choice stays) or [srv] left the list.
function choose(srv, data) {
  const cur = readSrvs();
  const k = keyOf(srv);
  const i = cur && Array.isArray(cur.list) ? cur.list.findIndex((s) => keyOf(s) === k) : -1;
  if (i < 0 || cur.chosen) return false;
  cur.idx = i; cur.ok = true; cur.okAt = Date.now(); cur.chosen = k;
  writeSrvs(cur);
  rememberLiveCats(srv, data);
  return true;
}

/**
 * First run, before any Home: the rolling race (raceAccounts) over every account of the picker's ranking (Spanish first;
 * never a dead or blocked one), within RACE_MS of the list and never past [until]. The winner becomes the active and chosen
 * server. A server already chosen is never raced or replaced. Never throws. `{ ok, host, label, kept? }`; ok false when no
 * account answered well in time (the screen then runs the health check with its own automatic pick).
 */
export async function autoPickServer({ until = Date.now() + 13500 } = {}) {
  try {
    const st = await loadServers(false, { timeoutMs: LIST_TIMEOUT_MS });
    if (st.chosen) { const cur = st.list[st.idx]; return { ok: true, kept: true, host: hostOf(cur), label: labelOf(cur) }; }
    const cands = listItems(st).items.map((x) => ({ srv: st.list[x.i], es: x.es, host: hostnameOf(st.list[x.i]) }));
    const win = await raceAccounts(cands, Math.min(Date.now() + RACE_MS, until));
    if (!win || !choose(win.srv, win.data)) return { ok: false };
    return { ok: true, host: hostOf(win.srv), label: labelOf(win.srv) };
  } catch (e) {
    lastErr = errText(e);
    return { ok: false };
  }
}

// Fija un servidor elegido a mano (no se vuelve solo al de casa). Prueba el elegido; si no responde, otros del
// mismo país (misma bandera) hasta dar con uno vivo (muchos servidores de la lista están caídos). Tope de intentos.
export async function selectServer(i) {
  const st = await loadServers(false);
  const n = st.list.length;
  const start = parseInt(i, 10);
  if (!(start >= 0 && start < n)) return { ok: false };
  const wantLabel = labelOf(st.list[start]);
  const all = Array.from({ length: n }, (_, k) => k);
  // The tapped one is always tried once; its same-country fallbacks skip dead and blocked accounts.
  const order = [start, ...all.filter((k) => k !== start && labelOf(st.list[k]) === wantLabel && usable(st.list[k]))].slice(0, 5);
  for (const idx of order) {
    try {
      const data = await callServer(st.list[idx], PROBE, {});
      st.idx = idx; st.ok = true; st.okAt = Date.now(); st.chosen = keyOf(st.list[idx]);
      writeSrvs(st);
      rememberLiveCats(st.list[idx], data);
      return { ok: true, host: hostOf(st.list[idx]), label: labelOf(st.list[idx]), index: idx + 1, total: n, exact: idx === start };
    } catch (e) { lastErr = errText(e); }
  }
  return { ok: false, host: hostOf(st.list[start]), label: labelOf(st.list[start]), index: start + 1, total: n };
}

// ---- chequeo de salud: para que el selector muestre solo los servidores que responden ----------------
// The result (health:v1, the URLs that answered) is good for HEALTH_TTL_MS. On the screen it runs LAST, after the Home has
// its content, in short ticks (healthStep): a channel the person taps waits for the plugin's call lane, so no tick of it
// holds that lane long. Most rounds only ask each account if it is alive (player_api.php with no action, a small answer,
// PING_TIMEOUT_MS); once the panel map is FULL_EVERY_MS old the round downloads each account's live categories instead and
// groups the panels again, because the live failover only moves a channel within a panel to accounts confirmed in the last
// 24 h (panels:v1). The first run's rescue still checks every account in one call (healthCheck).
const HEALTH_KEY = "health:v1";
const HEALTH_TTL_MS = 6 * 60 * 60 * 1000;
const FULL_EVERY_MS = 18 * 60 * 60 * 1000;
let healthRunning = false;

function readHealth() {
  try { const o = JSON.parse(kino.storage.get(HEALTH_KEY) || "null"); return o && Array.isArray(o.online) && typeof o.ts === "number" ? o : null; } catch (_) { return null; }
}
const healthFresh = () => { const h = readHealth(); return h && Date.now() - h.ts >= 0 && Date.now() - h.ts < HEALTH_TTL_MS ? h : null; };
export const healthReady = () => !!healthFresh();

const HEALTH_TIMEOUT_MS = 10000;
// The check runs inside one screen call (Kino gives it 20 s, ScreenLimits.CALL_TIMEOUT_MS): it stops starting probes at
// this deadline and writes what answered. Kino runs 6 of a plugin's requests at once, so a probe started here starts there
// and its timeout is the time it really has.
const HEALTH_DEADLINE_MS = 15000;
const HEALTH_PARALLEL = 6;
const LIST_TIMEOUT_MS = 4000;
// The screen's ticks: STEP_ACCOUNTS accounts each (Kino runs 6 of a plugin's requests at once), each within PING_TIMEOUT_MS
// (alive?) or STEP_FULL_TIMEOUT_MS (its live categories). A round left unfinished for ROUND_MAX_MS starts again.
const STEP_ACCOUNTS = 6;
const PING_TIMEOUT_MS = 3000;
const STEP_FULL_TIMEOUT_MS = 5000;
const ROUND_MAX_MS = 30 * 60 * 1000;

// At most [limit] calls of [fn] at once over [list].
async function pool(list, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) await fn(list[next++]);
  }));
}

// The active server and the chosen one first, then the list's order.
function healthOrder(st) {
  const list = st.list || [];
  const first = new Set([keyOf(list[st.idx]), st.chosen].filter(Boolean));
  return [...list.filter((s) => first.has(keyOf(s))), ...list.filter((s) => !first.has(keyOf(s)))];
}

// Writes a finished check: health:v1 (what answered, plus what was left unprobed: not known down), the panel map when the
// check downloaded categories ([sets]), the first run's pick ([best]), and the jump away from an active server that did not
// answer: same panel, then same country, then by priority; the jump never touches `chosen` (backHome returns there).
function finishHealth({ st, answered, unprobed, sets, best }) {
  const list = st.list || [];
  const online = list.filter((s) => answered.has(s.url)).map((s) => s.url);
  const now = Date.now();
  put(HEALTH_KEY, JSON.stringify({ ts: now, online: list.filter((s) => answered.has(s.url) || unprobed.has(s.url)).map((s) => s.url) }));
  const map = sets ? groupPanels(sets, readPanels(), now) : readPanels();
  if (sets) writePanels(map);
  if (best) choose(best.s, best.data);
  const fresh = readSrvs() || st;
  const cur = fresh.list && fresh.list[fresh.idx];
  if (cur && online.length && !online.includes(cur.url)) {
    const p = panelOf(keyOf(cur), map);
    const flag = flagOf(cur);
    const score = (s) => [p && panelOf(keyOf(s), map) === p ? 0 : 1, flagOf(s) === flag ? 0 : 1, priorityOf(s)];
    const cands = fresh.list.map((s, i) => ({ s, i, sc: score(s) })).filter((x) => online.includes(x.s.url))
      .sort((a, b) => a.sc[0] - b.sc[0] || a.sc[1] - b.sc[1] || a.sc[2] - b.sc[2] || a.i - b.i);
    if (cands.length) { fresh.idx = cands[0].i; fresh.ok = true; fresh.okAt = now; writeSrvs(fresh); }
  }
  return online.length;
}

// Probes the servers 6 at a time (never a dead or blocked account: zero requests), the active and the chosen one first, within
// HEALTH_DEADLINE_MS (or [until], when sooner), and stores the URLs of those that answer; a server the deadline left unprobed is
// stored with them (not known down: the picker keeps offering it), never as down. With the same answers it groups the servers
// into panels (0 extra requests). [pick] (a first run whose race found no account): the probes go in the picker's ranking
// and, with no server chosen yet, the best-ranked account that answered becomes the active and chosen one, with no further
// request. One run at a time; never throws. The screen's own check is healthStep.
export async function healthCheck({ until: limit = Infinity, pick = false } = {}) {
  if (healthRunning) return 0;
  healthRunning = true;
  const until = Math.min(Date.now() + HEALTH_DEADLINE_MS, limit);
  try {
    const st = await loadServers(false, { timeoutMs: LIST_TIMEOUT_MS });
    const list = st.list || [];
    const sets = new Map();
    const answered = new Set();
    const unprobed = new Set();
    const rank = new Map(list.map((s, i) => [s, priorityOf(s) * 1000 + i]));
    const order = pick ? list.slice().sort((a, b) => rank.get(a) - rank.get(b)) : healthOrder(st);
    let best = null; // [pick]: the best-ranked account that answered, with its categories
    await pool(order, HEALTH_PARALLEL, async (s) => {
      if (!usable(s)) return;
      const left = until - Date.now();
      if (left < 1500) { unprobed.add(s.url); return; }
      try {
        const data = await callServer(s, PROBE, {}, { timeoutMs: Math.min(HEALTH_TIMEOUT_MS, left - 500) });
        sets.set(keyOf(s), pairHashes(data));
        answered.add(s.url);
        if (pick && Array.isArray(data) && data.length && (!best || rank.get(s) < rank.get(best.s))) best = { s, data };
      } catch (_) { /* down */ }
    });
    return finishHealth({ st, answered, unprobed, sets, best });
  } catch (_) {
    try { put(HEALTH_KEY, JSON.stringify({ ts: Date.now(), online: [] })); } catch (__) { /* nada */ }
    return 0;
  } finally { healthRunning = false; }
}

let round = null; // the screen's check under way: { of, at, st, full, order, next, answered, sets }

/**
 * One tick of the screen's health check: the next STEP_ACCOUNTS usable accounts of the round (the active and the chosen one
 * first), all at once. A round asks each account if it is alive, or, once the panel map is FULL_EVERY_MS old, downloads its
 * live categories and groups the panels again. The round's last tick writes it (finishHealth); until then healthReady() stays
 * false, so the screen keeps its timer for the next tick. Never throws.
 */
export async function healthStep() {
  if (healthRunning) return;
  healthRunning = true;
  try {
    const now = Date.now();
    if (!round || round.of !== globalThis.kino || !(now - round.at >= 0 && now - round.at < ROUND_MAX_MS)) {
      const st = await loadServers(false, { timeoutMs: LIST_TIMEOUT_MS });
      const panels = readPanels();
      const full = !panels || !(now - (Number(panels.at) || 0) >= 0 && now - (Number(panels.at) || 0) < FULL_EVERY_MS);
      round = { of: globalThis.kino, at: now, st, full, order: healthOrder(st), next: 0, answered: new Set(), sets: full ? new Map() : null };
    }
    const r = round;
    const slice = [];
    while (r.next < r.order.length && slice.length < STEP_ACCOUNTS) { const s = r.order[r.next++]; if (usable(s)) slice.push(s); }
    await pool(slice, STEP_ACCOUNTS, async (s) => {
      try {
        if (r.full) r.sets.set(keyOf(s), pairHashes(await callServer(s, PROBE, {}, { timeoutMs: STEP_FULL_TIMEOUT_MS })));
        else await callServer(s, null, {}, { timeoutMs: PING_TIMEOUT_MS });
        r.answered.add(s.url);
      } catch (_) { /* down */ }
    });
    if (r.next >= r.order.length && round === r) {
      round = null;
      finishHealth({ st: r.st, answered: r.answered, unprobed: new Set(), sets: r.sets, best: null });
    }
  } catch (_) {
    round = null;
  } finally { healthRunning = false; }
}

export async function refreshServers() {
  const before = readSrvs();
  const st = await loadServers(true);
  const fresh = !before || st.ts !== before.ts; // la lista se pidió de nuevo (si el arranque falla, loadServers devuelve la vieja)
  let ok = fresh;
  if (fresh) { try { await api(PROBE); } catch (_) { /* la lista nueva ya está; el servidor se prueba al usarlo */ } }
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


// ---- category lists: one short memo for every reader ------------------------------------------------------------------
// A live category's channel list, kept LIST_MEMO_MS per ACCOUNT and category (an account of a panel may carry only part of
// its channels, and the failover checks each account's own list): Kino's pages, "Ver todos", the Home rows, the events row,
// search and the failover's look-ups (callServerMemo) share one download. Slim entries (what those read), LIST_MEMO_MAX lists.
const LIST_MEMO_MS = 3 * 60 * 1000;
const LIST_MEMO_MAX = 8;
const listMemo = new Map(); // "<serverKey>|<catId>" -> { ts, list, items? }
let listMemoOf = null;      // the kino those lists were fetched with
const slimStream = (s) => ({ stream_id: s && s.stream_id, name: s && s.name, stream_icon: s && s.stream_icon, num: s && s.num, category_id: s && s.category_id });
// Every in-memory list belongs to the kino it was fetched with (one per runtime; a test's new kino starts empty).
const memoFor = () => {
  if (listMemoOf !== globalThis.kino) { listMemo.clear(); for (const k of Object.keys(catMemo)) delete catMemo[k]; liveCatsMemo = null; listMemoOf = globalThis.kino; }
  return listMemo;
};

function memoList(k, catId) {
  const m = k ? memoFor().get(k + "|" + catId) : null;
  return m && Date.now() - m.ts >= 0 && Date.now() - m.ts < LIST_MEMO_MS ? m : null;
}

function keepList(k, catId, data) {
  if (!k || !Array.isArray(data)) return data;
  memoFor();
  const list = data.map(slimStream);
  const key = k + "|" + catId;
  listMemo.delete(key);
  listMemo.set(key, { ts: Date.now(), list });
  while (listMemo.size > LIST_MEMO_MAX) listMemo.delete(listMemo.keys().next().value);
  return list;
}

// callServer through the memo for a category's channels (the live failover's calls): a hit costs no request.
async function callServerMemo(srv, action, extra, opts) {
  const catId = action === "get_live_streams" && extra && extra.category_id !== undefined ? String(extra.category_id) : null;
  if (catId === null) return callServer(srv, action, extra, opts);
  const m = memoList(keyOf(srv), catId);
  if (m) return m.list;
  return keepList(keyOf(srv), catId, await callServer(srv, action, extra, opts));
}

// Una categoría: vacía ([]) es válida; fallar lanza (se reintenta una vez, con respaldo de servidor dentro de api()).
// A live category's channels come from the memo when the active account fetched them lately.
async function fetchCategory(action, categoryId) {
  const id = String(categoryId);
  const live = action === "get_live_streams";
  if (live) { const m = memoList(serverKey(), id); if (m) return m.list; }
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await api(action, { category_id: id });
      if (!Array.isArray(data)) throw new Error("respuesta que no es lista");
      // api() may have answered from another account: the list is that account's (the active one now).
      return live ? keepList(serverKey(), id, data) : data;
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
  memoFor();
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

const LIVE_PAGE = 500; // Kino's most per page (PluginLiveContract.MAX_CHANNELS_PER_PAGE)
const LIVE_CATS_TTL_MS = 10 * 60 * 1000;
let liveCatsMemo = null;

// Las categorías cambian de un servidor a otro: la caché lleva la clave del servidor activo.
async function liveCats() {
  memoFor();
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

// Página de una categoría en vivo (para "ver más" de una fila). Solo refs "lcat:<id>". Pages run over the WHOLE category
// (it used to page over liveChannels' first page only, so it never showed more than 200 channels).
export async function browse(ref, cursor) {
  const [prefix, catId] = String(ref || "").split(":");
  if (prefix !== "lcat" || !/^\d+$/.test(catId || "")) return { items: [] };
  const page = Math.max(1, parseInt(cursor, 10) || 1);
  const start = (page - 1) * PER_PAGE;
  const all = await categoryItems(catId);
  const items = all.slice(start, start + PER_PAGE).map((i) => ({ id: i.id, ref: i.ref, title: i.title, kind: "live", poster: i.logo, ...(i.adult ? { adult: true } : {}) }));
  return { items, next: all.length > start + PER_PAGE ? String(page + 1) : undefined };
}

// The category's name by id, from the live categories in memory (the listing's own server).
let catNames = { list: null, map: null };
function catNameOf(catId) {
  const m = catMemo.live;
  if (!m || !Array.isArray(m.list)) return "";
  if (catNames.list !== m.list) catNames = { list: m.list, map: new Map(m.list.map((c) => [String(c.category_id), c.category_name])) };
  return catNames.map.get(String(catId)) || "";
}

// A live item. Its ref carries the category (id and name) and the channel's name, identical for every account of a
// panel: resolve() can then tell whether the id belongs to the active server's panel and find the channel by name on
// another panel when every account of its own refuses it. The ref always reads the panel's RAW name; [shown] (the name
// without its decorations, channelTitles) is only what the person sees.
function liveItem(s, categoryId, adult, shown) {
  const id = String(s.stream_id || "");
  const raw = String(s.name || "").trim();
  if (!id || !raw) return null;
  const catId = String(categoryId || s.category_id || "");
  return {
    id: "live-" + id,
    title: shown || raw,
    ref: liveRef(id, catId, categoryTok(catNameOf(catId)), channelTok(raw)),
    logo: img(s.stream_icon),
    number: parseInt(s.num, 10) || undefined,
    categoryId: String(categoryId || s.category_id || ""),
    ...(adult ? { adult: true } : {}),
  };
}

// Every channel of a live category as Kino lists it ([] for an 18+ category while 18+ is off). The list comes through the
// memo, and its items are worked out once per list and language: the shown titles over the whole category (a channel looks
// the same on every page), so every page after the first costs neither a request nor a cleanup.
async function categoryItems(categoryId) {
  const id = String(categoryId || "");
  const c = (await liveCats().catch(() => [])).find((x) => x.id === id);
  const adult = !!(c && c.adult);
  if (adult && !showAdult()) return [];
  const all = await fetchCategory("get_live_streams", id);
  const m = memoList(serverKey(), id);
  const tag = langNow() + (adult ? "|a" : "") + "|" + catNameOf(id);
  if (m && m.list === all && m.items && m.items.tag === tag) return m.items.list;
  const shown = shownTitles(all, categoryKey(catNameOf(id)));
  const items = [];
  for (let i = 0; i < all.length; i++) { const it = liveItem(all[i], id, adult, shown[i]); if (it) items.push(it); }
  if (m && m.list === all) m.items = { tag, list: items };
  return items;
}

export async function liveChannels({ categoryId, cursor }) {
  const items = await categoryItems(categoryId);
  const start = Math.max(0, parseInt(cursor, 10) || 0);
  return { items: items.slice(start, start + LIVE_PAGE), next: items.length > start + LIVE_PAGE ? String(start + LIVE_PAGE) : undefined };
}

// The shown titles of one list of panel streams (`[{ name }]`) whose category's country or region is [catKey].
const shownTitles = (streams, catKey) => channelTitles(streams.map((s) => (s && s.name) || ""), { cat: catKey, lang: langNow() });

// Whether a stream's name holds [q] (lowercase): as the panel writes it, or as the person sees it. The shown title only adds
// text the raw name lacks when it gained a " · " or a quality moved to its end, so only such a query cleans each name.
const SHOWN_ONLY = /·|\b(?:4k|8k|uhd|fhd|hd|sd|hevc)\b/;
const nameHas = (s, q) => {
  const raw = String((s && s.name) || "");
  return raw.toLowerCase().replace(/\s+/g, " ").includes(q) || (SHOWN_ONLY.test(q) && cleanChannelTitle(raw).title.toLowerCase().includes(q));
};

export async function liveSearchDetailed({ query }, { budgetMs = 11000 } = {}) {
  const q = String(query || "").trim().toLowerCase().replace(/\s+/g, " ");
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
        return data.filter((s) => nameHas(s, q)).map((s) => liveItem(s, cat.id, cat.adult)).filter(Boolean)
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
  // The hits are one mixed list: their shown titles are worked out together. A query that IS a hit's raw name (Kino looks a
  // channel saved under its old, decorated name up this way) gets that hit under its raw name, so Kino recognises it.
  const shown = shownTitles(items.map((it) => ({ name: it.title })), "");
  const asked = normName(query);
  items.forEach((it, i) => { if (normName(it.title) !== asked) it.title = shown[i]; });
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
  const shown = shownTitles(items.map((it) => ({ name: it.title })), cc.toLowerCase());
  items.forEach((it, i) => { it.title = shown[i]; });
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

// Native En vivo asks the guide of a category's first 40 visible channels in ONE call (LiveViewModel.requestEpg) before it
// asks the categories and the channels, and those wait behind it on the plugin's single call lane: one get_short_epg per
// channel, each through api() with its own backHome and a walk over every account, held the categories 2.4-4.4 s behind
// 25-51 panel requests (2026-11-17, Redmi). Now a call asks only the first GUIDE_MAX channels (the top of the grid), on the
// ACTIVE account alone (a stream id's guide is its panel's; another account's walk would only add requests), with one
// backHome per call, GUIDE_LANES at once (Kino runs 4 of a plugin's requests per host), each within GUIDE_TRY_MS and the
// whole call within GUIDE_MS. Channels past GUIDE_MAX get no programme from this call: Kino keeps that answer 30 min.
const GUIDE_MAX = 12;
const GUIDE_LANES = 4;
const GUIDE_TRY_MS = 3000;
const GUIDE_MS = 4000;
const GUIDE_MIN_TRY_MS = 1000;

export async function guide({ channelIds, from, to }) {
  const ids = (Array.isArray(channelIds) ? channelIds : []).map((cid) => [String(cid), String(cid).replace(/^live-/, "")])
    .filter(([, streamId]) => /^\d+$/.test(streamId)).slice(0, GUIDE_MAX);
  if (!ids.length) return [];
  const until = Date.now() + GUIDE_MS;
  if (readSrvs()) { try { await backHome({ timeoutMs: GUIDE_TRY_MS }); } catch (_) { /* stays on the active account */ } }
  const st = readSrvs();
  const srv = st && Array.isArray(st.list) ? st.list[st.idx] : null;
  if (!srv || !usable(srv)) return [];
  const out = [];
  await pool(ids, GUIDE_LANES, async ([cid, streamId]) => {
    const left = until - Date.now();
    if (left < GUIDE_MIN_TRY_MS) return;
    try {
      const data = await callServer(srv, "get_short_epg", { stream_id: streamId, limit: "20" }, { timeoutMs: Math.min(GUIDE_TRY_MS, left) });
      const rows = Array.isArray(data) ? data : (data && (data.epg_listings || data.listings || data.epg)) || [];
      for (const e of rows) {
        const p = {
          channelId: cid,
          title: b64text(e.title),
          description: b64text(e.description || e.descr),
          start: (parseInt(e.start_timestamp, 10) || 0) * 1000,
          end: (parseInt(e.stop_timestamp || e.end_timestamp, 10) || 0) * 1000,
        };
        if (p.title && p.end > p.start && p.end > from && p.start < to) out.push(p);
      }
    } catch (_) { /* no guide for this channel this time */ }
  });
  return out;
}

// ---- resolve --------------------------------------------------------------------

// ---- live failover ---------------------------------------------------------------------------------------------------

// The cached live categories of [srv] (memory or storage, any age) and when they were fetched: no request.
function cachedLive(srv) {
  const k = keyOf(srv);
  if (!k) return null;
  const m = catMemo.live;
  if (m && m.key === k && Array.isArray(m.list)) return { ts: m.ts, list: m.list };
  try {
    const o = JSON.parse(kino.storage.get("cats:live:" + k) || "null");
    if (o && Array.isArray(o.l)) return { ts: o.ts, list: o.l.map(([category_id, category_name]) => ({ category_id: String(category_id), category_name: String(category_name) })) };
  } catch (_) { /* not cached */ }
  return null;
}
const cachedCats = (srv) => { const c = cachedLive(srv); return c ? c.list : null; };
const cachedCatsAt = (srv) => { const c = cachedLive(srv); return c && typeof c.ts === "number" ? c.ts : null; };

/** The active server's raw live category names by id, from its cached categories (any age): no request; "" when unknown. */
export function liveCatNamer() {
  const st = readSrvs();
  const srv = st && Array.isArray(st.list) ? st.list[st.idx] : null;
  const list = (srv && cachedCats(srv)) || [];
  const names = new Map(list.map((c) => [String(c.category_id), String(c.category_name || "")]));
  return (catId) => names.get(String(catId)) || "";
}

// The server list for a live resolve: the cached one (even past its 6 h), never a failover walk; the bootstrap only on a
// fresh install, with short timeouts (resolve has 20 s).
async function liveServers() {
  const st = readSrvs();
  if (st && Array.isArray(st.list) && st.list.length) return st;
  return loadServers(false, { timeoutMs: 4000 });
}

// A per-install number: equally ranked accounts are not all picked in the same order by every device (the accounts are
// shared and allow 1-3 connections).
let seedMemo = "";
function installSeed() {
  if (seedMemo) return seedMemo;
  let v = null;
  try { v = kino.storage.get("seed:v1"); } catch (_) { v = null; }
  if (!v || !/^\d+$/.test(v)) { v = String(Math.floor(Math.random() * 1e9)); put("seed:v1", v); }
  seedMemo = v;
  return v;
}

export const langNow = () => { try { return /^en/i.test(String(kino.lang || "")) ? "en" : "es"; } catch (_) { return "es"; } };

const failover = createLiveFailover({
  servers: liveServers,
  cachedCats,
  catsAt: cachedCatsAt,
  storeCats: rememberLiveCats,
  callServer: callServerMemo,
  playUrl: (srv, id, format) => `${srv.url}/live/${srv.username}/${srv.password}/${id}.${format || liveFormat()}`,
  label: niceLabel,
  host: hostOf,
  online: () => { const h = healthFresh(); return h ? new Set(h.online) : null; },
  flag: flagOf,
  priority: priorityOf,
  seed: installSeed,
  now: () => Date.now(),
  unavailable: () => kino.error("unavailable", "no account plays this channel now", { userMessage: say("liveNoServer", langNow()) }),
  notFound: () => kino.error("not_found", "channel not found"),
});

export async function resolve(ref) {
  const s = String(ref || "");

  // Fuente alternativa (el menú "Servidor"): el canal en otro servidor elegido por la persona (no el activo, y sin cambiarlo).
  if (s.startsWith("at:")) {
    const segs = s.slice(3).split("~");
    const srv = serverByKey(segs[0]);
    const id = segs[2] || "";
    if (!srv || segs[1] !== "l" || !/^\d+$/.test(id)) throw kino.error("not_found", "fuente desconocida");
    return { url: `${srv.url}/live/${srv.username}/${srv.password}/${id}.${liveFormat()}` };
  }
  if (s.startsWith("live:")) return failover.resolve(s);
  throw kino.error("not_found", "ref desconocido: " + s.slice(0, 30));
}

export { api, liveItem };
