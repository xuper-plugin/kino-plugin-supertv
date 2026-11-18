// La pantalla propia de SuperTV (apiVersion 14, vía enhancements) y la sección nativa. La vista es pura: lo cargado vive en
// memoria y, si el runtime se reinicia, el temporizador `tick` lo vuelve a traer; el estado solo guarda tab, n y fallos.
// Todo lo cargado se descarta si cambia el servidor activo (las categorías e ids no coinciden entre servidores).
import * as cat from "./catalog.js";
import { say, twin } from "./i18n.js";
import { put, jsonLen } from "./store.js";
import { TAB_IDS, browseView, searchView, liveView, settingsView, verifyingView, firstPickView, cardOf } from "./screenView.js";
import { homeFeed, upgradeBareRefs } from "./homeFeed.js";
import { PLUGIN_VERSION } from "./version.js";
import { cleanCards, cleanRails } from "./channelTitle.js";

const TAB_KEY = "superTab";
const HIST_KEY = "searchHist:v1";
const HIST_MAX = 24;
const CHANNELS_CAP = 60;
const RAILS_PER_TAB = 12;
const RAIL_ITEMS = 20;
const SCREEN_ROUTES = ["main", "search", "live", "settings"];

// "all" no filtra; el resto exige ese grupo (categoryRules.LIVE_GROUPS). "tematicos"/"otros" solo salen en "all".
const inGroup = (tab, c) => tab === "all" || c.group === tab;

const groupRails = new Map(); // grupo -> { rails: [{ id, catId, title, items }], partial }
const liveChans = new Map();  // categoría -> tarjetas de canal (drilldown)
let liveCatsAll = null;       // [{ id, title, group, country?, genre?, adult? }]
let found = null;             // búsqueda de canales: { q, items, partial }
let pickServers = null;       // lista para el selector de servidor (respaldo si el auto-elegido no responde)
let cacheKey = null;
let autoPickTried = false;    // primera instalación: ya se intentó elegir servidor automáticamente (sin que la persona elija)
let rescueTried = false;      // first run, the race found no account: the health check with its automatic pick ran
const homeFeedData = new Map(); // tab -> [rails] del feed pre-armado (si se bajó): Home al instante, sin recorrer el IPTV
let homeFeedTried = false;      // ya se intentó el feed (haya salido o no)
let eventsRow = null;           // fila DINÁMICA de eventos en vivo (la única en vivo del Home); null = aún sin cargar/vacía
let eventsTried = false;        // ya se intentó cargar los eventos en esta entrada (se reintenta en cada `open`)

// La persona ya eligió servidor al menos una vez: se recuerda para no volver a mostrar el selector inicial (se cambia con 🌐).
// The flag, or the chosen server kept with the server list (both never evicted); a missing flag is written again.
const SRVCHOSEN_KEY = "srvChosen:v1";
const markServerChosen = () => { try { put(SRVCHOSEN_KEY, "1"); } catch (_) { /* da igual */ } };
function serverChosen() {
  if (getStored(SRVCHOSEN_KEY) === "1") return true;
  if (!cat.hasChosenServer()) return false;
  markServerChosen();
  return true;
}

function resetCaches() {
  groupRails.clear();
  liveChans.clear();
  liveCatsAll = null;
  found = null;
  homeFeedData.clear();
  homeFeedTried = false;
  eventsRow = null;
  eventsTried = false;
}

// Config de la fila de eventos en vivo: grupo cuyo "en vivo ahora" se muestra arriba del Home. "off" la oculta. Por defecto deportes.
const cfg = (k, d) => { try { const v = kino.config.get(k); return v === undefined || v === null ? d : v; } catch (_) { return d; } };
const eventsGroup = () => String(cfg("eventsGroup", "deportes"));
const eventsOn = () => eventsGroup() !== "off";

function syncServer() {
  const key = cat.serverKey();
  if (cacheKey === null || cacheKey === "") { cacheKey = key; return; }
  if (key !== cacheKey) { resetCaches(); cacheKey = key; }
}

const langOf = (ev) => (ev && ev.lang === "en" ? "en" : "es");
const getStored = (k) => { try { return kino.storage.get(k) || null; } catch (_) { return null; } };
const storedTab = () => { const t = getStored(TAB_KEY); return TAB_IDS.includes(t) ? t : null; };

const histKey = () => HIST_KEY + ":" + cat.serverKey();

function readHistory() {
  try {
    const o = JSON.parse(kino.storage.get(histKey()) || "null");
    // Cards an older build stored keep their panel-decorated titles: cleaned on the way out, like every channel title.
    return o && o.v === 1 && Array.isArray(o.e) ? cleanCards(o.e.filter((c) => c && typeof c.id === "string" && typeof c.ref === "string").slice(0, HIST_MAX), { lang: cat.langNow() }) : [];
  } catch (_) { return []; }
}

function rememberFound(cards) {
  try {
    const slimmed = cards.filter((c) => c.adult !== true).slice(0, 12).map(({ id, ref, title, kind, poster }) => ({ id, ref, title, kind, ...(poster ? { poster } : {}) }));
    const ids = new Set(slimmed.map((c) => c.id));
    put(histKey(), JSON.stringify({ v: 1, e: [...slimmed, ...readHistory().filter((c) => !ids.has(c.id))].slice(0, HIST_MAX) }));
  } catch (_) { /* sin historial */ }
}

const channelCard = (i) => ({ id: i.id, ref: i.ref, title: i.title, kind: "live", poster: i.logo, ...(i.adult ? { adult: true } : {}) });
const cardsOf = (items) => (Array.isArray(items) ? items : []).filter((i) => i && typeof i.id === "string" && typeof i.ref === "string").slice(0, CHANNELS_CAP).map(cardOf);
const bump = (state) => ({ n: (state.n || 0) + 1 });

// ---- Home randómico: en cada entrada (open) se renueva la semilla y se baraja el orden de filas y de las tarjetas dentro de
// cada una. Entre sesiones cambia; dentro de una misma sesión es estable (no salta mientras navega). La fila de eventos no entra aquí.
let homeSeed = (Math.random() * 2147483647) | 0;
const newHomeSeed = () => { homeSeed = (Math.random() * 2147483647) | 0; };
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffleSeeded(arr, seed) {
  const a = arr.slice();
  const rnd = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}
function randomizeRows(rails, seed) {
  return shuffleSeeded(rails, seed).map((r, i) => (r && Array.isArray(r.items) ? { ...r, items: shuffleSeeded(r.items, (seed + (i + 1) * 0x3c6ef35f) | 0) } : r));
}

// ---- Feed pre-armado + snapshot en dispositivo ----
// The snapshot: every tab of the server in ONE entry (`homeSnap:v3:<serverKey>`), so a feed costs one storage rewrite instead
// of one per tab. Kino's measure of its store (store.js jsonLen) counts every `"` and `/` twice, so the cards are packed: a
// rail is { c: catId, t: title, p: the start its logos share, i: cards } and a card [ref, title, the rest of its logo] (its
// id is "live-" + the ref's stream id and its kind "live"); a card that is not like that keeps its object form, and a rail
// whose id is not "lcat-" + catId keeps its id. A real feed tab (enriched refs, logo URLs of 64-75 characters) comes to about
// 90 B a card instead of 190-250. Each tab is cut to its share: SNAP_TAB_MAX at most, and never more than an even split of
// what is left of SNAP_MAX, so every tab fits whatever the others take, inside the 40 KB homeSnap class (another server's
// snapshot is evicted). The cut takes fewer cards per rail, then fewer rails, then below 0.4.1's floor (6 x 6) four cards,
// then no logos: a tab with rows is never left out (D-S1, 2026-11-18: a 7.5 KB cap at 6 x 6 kept only the Radio tab).
// A snapshot written by 0.4.1 (`homeSnap:v1:<serverKey>:<tab>`, one per tab) is still read until the first feed replaces it.
const SNAP_V = 3;
const SNAP_TAB_MAX = 9 * 1024;
const SNAP_MAX = 36 * 1024;
const SNAP_TAB_OVERHEAD = 16; // `"deportes":` and its comma, quotes escaped
const SNAP_STEPS = [
  ...[Infinity, 10, 8, 6].flatMap((rails) => [10, 8, 6].map((per) => [rails, per, true])),
  [6, 4, true], [4, 4, true], [6, 4, false], [4, 3, false],
];
const SNAP_ID = /^live:(\d+)(?:~|$)/;
const snapKey = () => "homeSnap:v" + SNAP_V + ":" + cat.serverKey();
const oldSnapKey = (tab) => "homeSnap:v1:" + cat.serverKey() + ":" + tab;
let snapMemo = null; // { key, tabs: { tab: rails, unpacked } } of the last snapshot read or written in this runtime

// The start every logo of [items] shares, up to its last "/" ("" for fewer than two logos).
function logoBase(items) {
  const logos = items.map((c) => c.poster).filter((p) => typeof p === "string" && p !== "");
  if (logos.length < 2) return "";
  let base = logos[0];
  for (const p of logos) { let i = 0; while (i < base.length && i < p.length && base[i] === p[i]) i++; base = base.slice(0, i); }
  return base.slice(0, base.lastIndexOf("/") + 1);
}

function packCard(c, base, logos) {
  const m = typeof c.ref === "string" ? SNAP_ID.exec(c.ref) : null;
  const poster = logos && typeof c.poster === "string" ? c.poster : "";
  const plain = m && c.id === "live-" + m[1] && typeof c.title === "string" && (!c.kind || c.kind === "live") && c.adult !== true && (!poster || (poster.startsWith(base) && poster.length > base.length));
  if (!plain) return { id: c.id, ref: c.ref, title: c.title, ...(c.kind ? { kind: c.kind } : {}), ...(poster ? { poster } : {}), ...(c.adult === true ? { adult: true } : {}) };
  return poster ? [c.ref, c.title, poster.slice(base.length)] : [c.ref, c.title];
}

function packRail(r, per, logos) {
  const items = (r.items || []).slice(0, per);
  const base = logos ? logoBase(items) : "";
  return { ...(r.id !== "lcat-" + r.catId ? { id: r.id } : {}), c: r.catId, t: r.title, ...(base ? { p: base } : {}), i: items.map((c) => packCard(c, base, logos)) };
}

// A stored rail as the screen draws it; null when nothing usable is left in it.
function unpackRail(r) {
  if (!r || typeof r !== "object" || !Array.isArray(r.i)) return null;
  const base = typeof r.p === "string" ? r.p : "";
  const items = [];
  for (const x of r.i) {
    if (Array.isArray(x)) {
      const m = typeof x[0] === "string" ? SNAP_ID.exec(x[0]) : null;
      if (m && typeof x[1] === "string") items.push({ id: "live-" + m[1], ref: x[0], title: x[1], kind: "live", ...(typeof x[2] === "string" && x[2] ? { poster: base + x[2] } : {}) });
    } else if (x && typeof x.id === "string" && typeof x.ref === "string") items.push(x);
  }
  return items.length ? { id: typeof r.id === "string" ? r.id : "lcat-" + r.c, catId: r.c, title: typeof r.t === "string" ? r.t : "", items } : null;
}

function unpackTabs(tabs) {
  const out = {};
  for (const tab of Object.keys(tabs || {})) {
    const rails = Array.isArray(tabs[tab]) ? tabs[tab].map(unpackRail).filter(Boolean) : [];
    if (rails.length) out[tab] = rails;
  }
  return out;
}

// [rails] packed and cut by SNAP_STEPS until the tab fits [max] bytes in Kino's measure: { packed, bytes }, or null.
function snapTab(rails, max) {
  const tried = new Set();
  for (const [maxRails, per, logos] of SNAP_STEPS) {
    const n = Math.min(maxRails, rails.length);
    const step = n + "," + per + "," + logos;
    if (tried.has(step)) continue;
    tried.add(step);
    const packed = rails.slice(0, n).map((r) => packRail(r, per, logos));
    const bytes = jsonLen(JSON.stringify(packed));
    if (bytes <= max) return { packed, bytes };
  }
  return null;
}

function writeSnap(tabsRails) {
  try {
    const tabs = {};
    let left = SNAP_MAX;
    // The tab the person looks at first goes first; each tab gets at most an even split of what is left.
    const order = [storedTab() || TAB_IDS[0], ...TAB_IDS].filter((t, i, a) => a.indexOf(t) === i && (tabsRails.get(t) || []).length);
    order.forEach((tab, i) => {
      const cut = snapTab(tabsRails.get(tab), Math.min(SNAP_TAB_MAX, Math.floor(left / (order.length - i)) - SNAP_TAB_OVERHEAD));
      if (!cut) return;
      tabs[tab] = cut.packed;
      left -= cut.bytes + SNAP_TAB_OVERHEAD;
    });
    if (!Object.keys(tabs).length) return;
    const key = snapKey();
    if (put(key, JSON.stringify({ v: SNAP_V, at: Date.now(), tabs }))) snapMemo = { key, tabs: unpackTabs(tabs) };
  } catch (_) { /* almacenamiento lleno: sin snapshot */ }
}

// The stored rails of [tab]: the server's snapshot (read once per runtime), else a 0.4.1 per-tab snapshot. null: none.
function storedSnapRails(tab) {
  const key = snapKey();
  if (!snapMemo || snapMemo.key !== key) {
    let tabs = {};
    try {
      const o = JSON.parse(kino.storage.get(key) || "null");
      if (o && o.v === SNAP_V && o.tabs && typeof o.tabs === "object") tabs = unpackTabs(o.tabs);
    } catch (_) { tabs = {}; }
    snapMemo = { key, tabs };
  }
  const rails = snapMemo.tabs[tab];
  if (Array.isArray(rails) && rails.length) return rails;
  try {
    const o = JSON.parse(kino.storage.get(oldSnapKey(tab)) || "null");
    return o && o.v === 1 && Array.isArray(o.rails) && o.rails.length ? o.rails : null;
  } catch (_) { return null; }
}

// The active server's category names, looked up (from its cached categories, no request) only when a bare ref needs one.
function catNames() {
  let names = null;
  return (catId) => (names || (names = cat.liveCatNamer()))(catId);
}

// A feed's rails as the screen shows them: bare refs from 0.4.0 code gain their category and the channel's raw name (the
// feed's titles are still raw then), then the titles are cleaned.
const feedRails = (rails, catName = catNames()) => cleanRails(upgradeBareRefs(rails, { catName, rawTitles: true }), cat.langNow());

function readSnap(tab) {
  try {
    const rails = storedSnapRails(tab);
    if (!rails) return null;
    // A snapshot written by an older build (or from an older feed) carries decorated titles: cleaned when read. Its bare refs
    // (0.4.0) gain their category, so the live failover covers a tap before the feed lands; its titles may be cleaned
    // already, so they carry no channel name.
    return { rails: cleanRails(upgradeBareRefs(rails, { catName: catNames() }), cat.langNow()) };
  } catch (_) { return null; }
}

// A first-run unit and the feed after it share one screen call: 16 s of the 20 s Kino allows, 2.5 s of them kept for the feed.
const FIRST_RUN_TICK_MS = 16000;
const FEED_MIN_MS = 2500;

// First run: the server is chosen automatically and remembered, so the person never has to pick one. The accounts of the
// picker's ranking (Spanish first, never a dead or blocked one) race three at a time, 2.5 s each, the next starting as soon as
// one fails, and the first that answers well is chosen (cat.autoPickServer). The feed then loads in this same tick, so the
// Home paints right after it, and the health check runs once the Home shows (unitsFor). When no account answered in time
// the next tick runs rescue(). The 🌐 button in the header still changes the server at any time.
async function autoPick() {
  autoPickTried = true;
  const until = Date.now() + FIRST_RUN_TICK_MS;
  let r = null;
  try { r = await cat.autoPickServer({ until: until - FEED_MIN_MS }); } catch (_) { r = null; }
  if (r && r.ok) await picked(until);
}

// The race found no account (every one it reached failed, or the slow ones needed more than 4 s): the health check (10 s per
// account, all of them) and its automatic pick of the best-ranked account that answered run in ONE tick, the feed after it
// when time is left, so Kino's doubled wait after a slow tick is paid once. Only when no account answered does the manual
// picker show, its rows read in this same tick from the list in hand (no request), so no second doubled wait comes before it.
async function rescue() {
  rescueTried = true;
  const until = Date.now() + FIRST_RUN_TICK_MS;
  try { await cat.healthCheck({ until: until - FEED_MIN_MS, pick: true }); } catch (_) { /* nothing chosen: the picker */ }
  if (cat.hasChosenServer()) { await picked(until); return; }
  try { pickServers = cat.cachedServerList(); } catch (_) { pickServers = null; } // no list stored: the "pick" unit fetches it
}

// A server was chosen for the person: remembered, then its feed while the tick has time for it.
async function picked(until) {
  markServerChosen();
  cacheKey = cat.serverKey();
  if (until - Date.now() >= FEED_MIN_MS) await loadHomeFeed({ until });
}

// Intenta el feed pre-armado del servidor (una sola descarga). Si llega, todas las pestañas quedan listas para pintar al
// instante (sin tocar el IPTV) y se guarda un snapshot por tab; si no, se marca intentado y se cae a la carga en vivo. Nunca lanza.
// opts.until: a deadline for the download (the first-run tick).
async function loadHomeFeed(opts) {
  homeFeedTried = true;
  let feed = null;
  try { feed = await homeFeed(cat.serverKey(), opts); } catch (_) { feed = null; }
  if (!feed || !feed.tabs) return;
  const names = catNames();
  for (const tab of Object.keys(feed.tabs)) {
    // The feed is built by the Action from the published code: a feed from before the title cleanup still carries the
    // panels' decorated names (and bare refs). Cleaning again is a no-op on titles already clean.
    homeFeedData.set(tab, feedRails(feed.tabs[tab], names));
  }
  writeSnap(homeFeedData);
}

// Elige la categoría de "eventos en vivo" del grupo configurado: prefiere la de agenda/eventos/hoy/vivo, si no la primera.
function pickEventsCat(cats) {
  const group = eventsGroup();
  const inGrp = (cats || []).filter((c) => c.group === group && !c.adult);
  return inGrp.find((c) => /event|agenda|hoy|vivo|directo|jornada|partidos?|cartelera/i.test(c.title || "")) || inGrp[0] || null;
}

// Fila DINÁMICA de eventos en vivo: se carga SIEMPRE en vivo (nunca del feed ni del snapshot: son eventos del momento). Baja la
// última prioridad del `tick`, así NO bloquea el Home (que ya se pintó del feed). Nunca lanza; si no hay, simplemente no sale.
async function loadEvents() {
  eventsTried = true;
  if (!eventsOn()) return;
  try {
    const cats = liveCatsAll || (liveCatsAll = await cat.liveCategories());
    const c = pickEventsCat(cats);
    if (!c) return;
    const page = await cat.liveChannels({ categoryId: c.id });
    const items = page.items.slice(0, RAIL_ITEMS).map(channelCard);
    eventsRow = items.length ? { id: "lcat-" + c.id, catId: c.id, title: c.title, items } : null;
  } catch (_) { /* se queda sin fila de eventos; el resto del Home ya está */ }
}

// El sheet del selector de servidor: un ✓ y resalte en el servidor activo.
function serverSheet(servers) {
  const cur = servers.current;
  const rows = (servers.items || []).slice(0, 60).map((s) => {
    const sel = s.i === cur;
    const hasCountry = s.label !== s.host;
    const title = hasCountry ? s.label : s.host; // "MX · México" (país) o el host
    const sub = hasCountry ? (s.https ? s.host : `${s.host} · http`) : (s.https ? "" : "http"); // la URL
    const leading = s.flag
      ? { type: "Image", key: "flag-" + s.i, url: `https://flagcdn.com/w40/${s.flag}.png`, w: 32, h: 24 }
      : { type: "Icon", name: "language" };
    return {
      type: "ListTile", key: "srvrow-" + s.i, title, titleEn: title, selected: sel, leading,
      ...(sub ? { subtitle: sub, subtitleEn: sub } : {}),
      ...(sel ? { trailing: { type: "Icon", name: "check" } } : {}),
      onTap: { event: "srv.pick", arg: String(s.i) },
    };
  });
  const body = rows.length ? rows : [{ type: "Text", key: "srvEmpty", ...twin("liveEmpty", "text") }];
  return { ...twin("setPick", "title"), body };
}

// Cada fila es una petición y el servidor IPTV admite 60 por minuto: se piden pocas categorías y pocos canales por fila.
// TAB_LANES at once: Kino runs 4 of a plugin's requests per host, and every row asks the active account's host.
const TAB_LANES = 4;
async function loadGroupTab(tab) {
  const cats = (liveCatsAll || []).filter((c) => inGroup(tab, c)).slice(0, RAILS_PER_TAB);
  let failed = 0;
  const results = new Array(cats.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(TAB_LANES, cats.length) }, async () => {
    while (next < cats.length) {
      const i = next++;
      const c = cats[i];
      try { results[i] = { c, page: await cat.liveChannels({ categoryId: c.id }) }; } catch (_) { failed++; }
    }
  }));
  const rails = [];
  for (const r of results) {
    if (!r) continue;
    const items = r.page.items.slice(0, RAIL_ITEMS).map(channelCard);
    if (items.length) rails.push({ id: "lcat-" + r.c.id, catId: r.c.id, title: r.c.title, items });
  }
  if (!rails.length && failed) throw new Error("tab");
  groupRails.set(tab, { rails, partial: failed > 0 });
}

const tabOf = (state, route) => {
  const a = route && route.args && typeof route.args === "object" ? route.args : {};
  return TAB_IDS.includes(state.tab) ? state.tab : TAB_IDS.includes(a.tab) ? a.tab : storedTab() || TAB_IDS[0];
};

// Unidades que faltan por cargar. Sin servidor elegido aún: la elección automática (carrera, luego rescate) y, si ninguna
// encontró servidor, la lista para el selector inicial. Ya elegido: salud, categorías y las filas del tab.
// Primero el feed pre-armado (una sola descarga): si está, el Home sale al instante y NO se recorre el IPTV. Si el feed
// tiene el tab, no hace falta nada más; si falta/está viejo/falló, se cae a la carga en vivo (categorías + filas del tab).
function unitsFor(tab) {
  // First run: the auto-pick races the accounts and loads the feed in the same tick. When no account answered, the rescue
  // (health check + automatic pick + feed) runs in the next one; only when that finds none does the manual picker show.
  if (!serverChosen()) return autoPickTried ? ["rescue", "pick"] : ["autopick"];
  // The Home's content first (the feed, else the live categories and the tab's rows), then the live events row (only on
  // the "all" tab), and the health check LAST, in short ticks of its own (cat.healthStep): it never holds the content, and
  // a channel tapped meanwhile waits for one short tick at most. A failing account is walked past by every request anyway.
  const base = homeFeedData.has(tab) ? ["hfeed"] : !homeFeedTried ? ["hfeed", "cats", "tab:" + tab] : ["cats", "tab:" + tab];
  if (tab === TAB_IDS[0] && eventsOn() && !eventsTried) base.push("events");
  base.push("health");
  return base;
}

function isDone(unit) {
  if (unit === "autopick") return autoPickTried;
  if (unit === "rescue") return rescueTried;
  if (unit === "events") return eventsTried;
  if (unit === "hfeed") return homeFeedTried;
  if (unit === "cats") return liveCatsAll !== null;
  if (unit === "health") return cat.healthReady();
  if (unit === "pick") return pickServers !== null;
  const [, tab] = unit.split(":");
  return groupRails.has(tab);
}

function pendingUnit(state, tab) {
  const failed = state.failed || {};
  return unitsFor(tab).find((u) => !isDone(u) && !failed[u]) || null;
}

async function runUnit(unit) {
  if (unit === "autopick") { await autoPick(); return; }
  if (unit === "rescue") { await rescue(); return; }
  if (unit === "events") { await loadEvents(); return; }
  if (unit === "hfeed") { await loadHomeFeed(); return; }
  if (unit === "cats") { liveCatsAll = await cat.liveCategories(); return; }
  if (unit === "health") { await cat.healthStep(); return; }
  if (unit === "pick") { pickServers = await cat.serverList(); return; }
  const [, tab] = unit.split(":");
  await loadGroupTab(tab);
}

// ---- the tick scheduler -------------------------------------------------------------------------------------------------
// Kino waits the timer's 1 s after a tick, or twice what a slow tick took (PluginScreenSession.nextWait), and holds every
// other call of the plugin (a channel the person taps) while a tick runs. So one tick runs several units back to back while
// it stays under TICK_BUDGET_MS, and stops early when there is something new to paint before a long unit:
// - the first content of the tab paints at once (the unit that brought it ends the tick);
// - a heavy unit (HEAVY: many requests, or the first run's own deadlines) never starts after a unit that changed what the
//   person sees, and ends its tick, so what it brings paints right after it;
// - the first run's units (autopick, rescue, pick) always run alone.
const TICK_BUDGET_MS = 1200;
const HEAVY = (unit) => unit === "health" || unit.startsWith("tab:");
const ALONE = new Set(["autopick", "rescue", "pick"]);

// What the person would see change: the tab's content, the events row, the picker's rows.
function shown(tab) {
  const g = groupRails.get(tab);
  return [homeFeedData.has(tab) ? 1 : 0, g ? g.rails.length : -1, eventsRow ? eventsRow.items.length : 0, pickServers ? 1 : 0].join(",");
}
// The tab shows rails already: the feed's, the live ones, or the last session's snapshot.
const hasContent = (tab) => homeFeedData.has(tab) || groupRails.has(tab) || !!storedSnapRails(tab);

// Runs the tab's pending units by the rules above; [failed] collects the units that threw. How many ran.
async function runUnits(tab, failed) {
  const t0 = Date.now();
  let ran = 0;
  let changed = false;
  for (;;) {
    const unit = pendingUnit({ failed }, tab);
    if (!unit) break;
    if (ran && (ALONE.has(unit) || Date.now() - t0 >= TICK_BUDGET_MS || (changed && HEAVY(unit)))) break;
    const before = shown(tab);
    const had = hasContent(tab);
    try { await runUnit(unit); } catch (_) { failed[unit] = true; }
    ran++;
    cacheKey = cat.serverKey();
    if (ALONE.has(unit) || HEAVY(unit) || (!had && hasContent(tab))) break;
    if (shown(tab) !== before) changed = true;
  }
  return ran;
}

function mainView(ctx) {
  const state = ctx.state || {};
  // Primera instalación: mientras se auto-elige el servidor, un breve "Verificando…". Si ni la carrera ni el rescate (chequeo de
  // salud con elección automática) encontraron uno, se muestra el selector manual como respaldo (ahí sí la persona elige).
  // El 🌐 del header permite cambiarlo en cualquier momento.
  if (!serverChosen()) {
    if (!autoPickTried) return verifyingView({ device: ctx.device });
    if (!rescueTried && !(state.failed && state.failed.rescue)) return verifyingView({ device: ctx.device });
    return firstPickView({ servers: pickServers, failed: !!(state.failed && state.failed.pick), device: ctx.device });
  }
  const tab = tabOf(state, ctx.route);
  // Arranque rápido: feed pre-armado o snapshot de la última sesión → se pinta YA, sin esperar "Verificando servidores…".
  // El chequeo sigue por detrás (unitsFor) y la verificación real del servidor ocurre antes de reproducir (resolve).
  const feedRails = homeFeedData.get(tab);
  const live = groupRails.get(tab) || null;
  const snap = !feedRails && !live ? readSnap(tab) : null;
  let data = feedRails ? { rails: feedRails, partial: false } : live || (snap ? { rails: snap.rails, partial: false, stale: true } : null);
  // Orden randómico (filas y tarjetas), renovado en cada entrada, para que el Home no se vea igual cada vez.
  if (data && Array.isArray(data.rails)) data = { ...data, rails: randomizeRows(data.rails, homeSeed) };
  // Fila de eventos en vivo arriba del Home (solo tab "all"): se antepone DESPUÉS del shuffle, así siempre queda de primera.
  if (tab === TAB_IDS[0] && eventsRow) {
    const rest = ((data && data.rails) || []).filter((r) => r.id !== eventsRow.id);
    data = { ...(data || { partial: false }), rails: [eventsRow, ...rest] };
  }
  const failed = unitsFor(tab).some((u) => state.failed && state.failed[u]);
  return browseView({ tab, data, loading: pendingUnit(state, tab) !== null, failed: !data && failed, device: ctx.device });
}

export async function screen(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const state = c.state && typeof c.state === "object" ? c.state : {};
  const name = c.route && SCREEN_ROUTES.includes(c.route.name) ? c.route.name : "main";
  try {
    syncServer();
    if (name === "search") {
      const query = typeof state.sq === "string" ? state.sq : "";
      const items = found && found.q === query ? found.items : null;
      const status = query === "" ? "idle" : state.sstate === "fail" ? "fail" : items ? "done" : "loading";
      return searchView({ query, status, items, partial: !!(found && found.q === query && found.partial), history: query === "" ? readHistory() : [], device: c.device });
    }
    if (name === "live") {
      const cur = typeof state.lcat === "string" ? state.lcat : liveCatsAll && liveCatsAll[0] ? liveCatsAll[0].id : null;
      const failed = state.lfail === true;
      return liveView({ cats: liveCatsAll, cat: cur, items: cur !== null && liveChans.has(cur) ? liveChans.get(cur) : null, failed, device: c.device });
    }
    if (name === "settings") {
      let appVersion = "";
      try { appVersion = typeof kino.appVersion === "string" ? kino.appVersion : ""; } catch (_) { appVersion = ""; }
      return settingsView({ srv: state.srv || null, servers: state.servers || null, busy: state.busy === true, pluginVersion: PLUGIN_VERSION, appVersion, device: c.device });
    }
    return mainView({ ...c, state });
  } catch (_) {
    return { type: "Column", padding: 16, children: [{ type: "settings", key: "classicForm" }] };
  }
}

const events = {
  open({ route, state }) {
    if (route && route.name && route.name !== "main") return null;
    eventsTried = false; // cada entrada al Home vuelve a traer los eventos en vivo (frescos); se mantiene la fila previa hasta que lleguen
    newHomeSeed();        // cada entrada reordena el Home, para que no se vea igual que la vez anterior
    return { state: { tab: tabOf(state, route), ...bump(state), failed: null } };
  },
  tab({ value, arg, state }) {
    const tab = TAB_IDS.includes(value) ? value : TAB_IDS.includes(arg) ? arg : null;
    if (!tab) return null;
    try { put(TAB_KEY, tab); } catch (_) { /* da igual */ }
    const failed = { ...(state.failed || {}) };
    for (const u of unitsFor(tab)) delete failed[u];
    return { state: { tab, ...bump(state), failed } };
  },
  retry({ state }) {
    const tab = tabOf(state);
    const data = groupRails.get(tab);
    if (data && data.partial) groupRails.delete(tab);
    return { state: { failed: null, ...bump(state) } };
  },
  // Runs the pending units in order, several in one tick while it is cheap to (see runUnits).
  async tick({ state }) {
    const tab = tabOf(state);
    const failed = { ...(state.failed || {}) };
    const ran = await runUnits(tab, failed);
    return ran ? { state: { ...bump(state), failed } } : null;
  },
  openSearch() { return { route: { push: "search" }, state: { sq: "", sstate: null } }; },
  search({ value, route }) {
    const raw = typeof value === "string" ? value : value && typeof value.q === "string" ? value.q : "";
    const q = raw.trim().slice(0, 100);
    if (q === "") return null;
    const state = { sq: q, sstate: "loading" };
    return route && route.name === "search" ? { state } : { route: { push: "search" }, state };
  },
  async stick({ state }) {
    const q = typeof state.sq === "string" ? state.sq : "";
    if (q === "") return null;
    if (found && found.q === q) return { state: { sstate: "done" } };
    try {
      const out = await cat.liveSearchDetailed({ query: q }, { budgetMs: 14000 });
      found = { q, items: cardsOf(out.items.map(channelCard)), partial: out.partial };
      rememberFound(found.items);
      cacheKey = cat.serverKey();
      return { state: { sstate: "done" } };
    } catch (_) {
      return { state: { sstate: "fail" } };
    }
  },
  sretry({ state }) {
    if (typeof state.sq !== "string" || state.sq === "") return null;
    found = null;
    return { state: { sstate: "loading" } };
  },
  back() { return { route: { pop: true }, state: { sq: null, sstate: null } }; },
  gocat({ arg }) {
    const id = typeof arg === "string" ? arg : "";
    if (!id) return null;
    return { route: { push: "live" }, state: { lcat: id, lfail: null } };
  },
  async ltick({ state }) {
    if (!liveCatsAll) {
      try { liveCatsAll = await cat.liveCategories(); } catch (_) { return { state: { lfail: true } }; }
      cacheKey = cat.serverKey();
      return { state: { lcat: typeof state.lcat === "string" ? state.lcat : null } };
    }
    const cur = typeof state.lcat === "string" ? state.lcat : liveCatsAll[0] ? liveCatsAll[0].id : null;
    if (cur === null) return { state: { lcat: null } };
    if (!liveChans.has(cur)) {
      let page;
      try { page = await cat.liveChannels({ categoryId: cur }); } catch (_) { return { state: { lfail: true } }; }
      liveChans.set(cur, cardsOf(page.items.map(channelCard)));
    }
    return { state: { lcat: cur } };
  },
  lcat({ value }) { return typeof value === "string" && value !== "" ? { state: { lcat: value, lfail: null } } : null; },
  lretry() { return { state: { lfail: null } }; },
  go({ arg }) {
    if (arg === "settings") return { route: { push: "settings" }, state: { srv: null, busy: false } };
    return null;
  },
  async sstatus() { return { state: { srv: await cat.serverStatus(), servers: await cat.serverList() } }; },
  async "srv.check"() { return { state: { srv: await cat.serverStatus(), servers: await cat.serverList(), busy: false } }; },
  async "srv.select"({ value, lang }) {
    const i = typeof value === "string" ? value : value && typeof value.serverPick === "string" ? value.serverPick : "";
    const r = await cat.selectServer(i);
    if (r.ok) { resetCaches(); cacheKey = cat.serverKey(); }
    const srv = await cat.serverStatus();
    const servers = await cat.serverList();
    return { state: { srv, servers, busy: false }, toast: { text: say(r.ok ? "srvSelected" : "srvSelectFail", lang, { host: r.label || r.host || "" }), role: r.ok ? "success" : "error" } };
  },
  async "srv.switch"({ lang }) {
    const r = await cat.switchServer();
    const srv = await cat.serverStatus();
    return { state: { srv, busy: false }, toast: { text: say(r.changed ? "switched" : "noOther", lang, { host: r.host }), role: r.changed ? "success" : "warning" } };
  },
  async "srv.refresh"({ lang }) {
    const r = await cat.refreshServers();
    const srv = await cat.serverStatus();
    return { state: { srv, busy: false }, toast: { text: say(r.ok ? "refreshed" : "refreshFail", lang, { n: r.total }), role: r.ok ? "success" : "error" } };
  },
  // Modal (sheet) del selector de servidor, abierto desde el botón del header.
  async openServers() {
    let servers;
    try { servers = await cat.serverList(); } catch (_) { servers = { current: -1, items: [] }; }
    return { state: { servers }, sheet: serverSheet(servers) };
  },
  // Elegido un servidor: fijar, recargar el Home por debajo y re-dibujar el sheet con el ✓ en el elegido (NO cerrar el plugin).
  async "srv.pick"({ arg, state, lang }) {
    const r = await cat.selectServer(arg);
    if (r.ok) { resetCaches(); cacheKey = cat.serverKey(); }
    let servers;
    try { servers = await cat.serverList(); } catch (_) { servers = { current: -1, items: [] }; }
    return { state: { ...bump(state), failed: null, servers }, sheet: serverSheet(servers), toast: { text: say(r.ok ? "srvSelected" : "srvSelectFail", lang, { host: r.host || r.label || "" }), role: r.ok ? "success" : "error" } };
  },
  // Elegido un servidor en el selector de la primera vez: lo fija, lo recuerda y manda al Home (que ya carga con ese servidor).
  // Si no respondió, se queda en el selector (con el aviso) para elegir otro.
  async "srv.first"({ arg, state, lang }) {
    const r = await cat.selectServer(arg);
    if (r.ok) { resetCaches(); cacheKey = cat.serverKey(); markServerChosen(); }
    return { state: { ...bump(state), failed: null }, toast: { text: say(r.ok ? "srvSelected" : "srvSelectFail", lang, { host: r.host || r.label || "" }), role: r.ok ? "success" : "error" } };
  },
  saved({ state }) { return { state: bump(state) }; },
};

export async function screenEvent(ev) {
  const e = ev && typeof ev === "object" ? ev : {};
  const handler = Object.hasOwn(events, e.name) ? events[e.name] : null;
  if (!handler) return null;
  try {
    syncServer();
    return (await handler({ ...e, state: e.state || {}, lang: langOf(e) })) ?? null;
  } catch (_) {
    return { toast: { text: say("failed", langOf(e)), role: "error" } };
  }
}

// ---- sección nativa (apiVersion 6) ----------------------------------------------

const SECTION_TABS = [
  { id: "all", label: "Todo", en: "All" },
  { id: "premium", label: "Premium", en: "Premium" },
  { id: "paises", label: "Países", en: "Countries" },
  { id: "deportes", label: "Deportes", en: "Sports" },
  { id: "radio", label: "Radio", en: "Radio" },
];

export async function section(arg) {
  const asked = arg && typeof arg === "object" ? arg.tab : null;
  const tab = SECTION_TABS.some((t) => t.id === asked) ? asked : SECTION_TABS[0].id;
  const english = /^en/i.test(String(kino.lang || ""));
  const tabs = SECTION_TABS.map((t) => ({ id: t.id, label: english ? t.en : t.label }));

  // Primero el feed pre-armado (1 descarga por runtime, homeFeed): así la sección nativa sale al instante en cada pestaña, SIN
  // recorrer el IPTV. Necesita saber el servidor; si aún no se cargó la lista, se pide una vez (barato). Si no hay feed, cae a
  // la carga en vivo.
  try {
    if (!cat.serverKey()) { try { await cat.serverList(); } catch (_) { /* sigue a vivo */ } }
    const feed = await homeFeed(cat.serverKey());
    const fr = feed && feed.tabs && feed.tabs[tab] && upgradeBareRefs(feed.tabs[tab], { catName: catNames(), rawTitles: true });
    if (fr && fr.length) return { tabs, tab, rows: fr.map((r) => ({ id: r.id, title: r.title, ref: "lcat:" + r.catId, items: r.items })) };
  } catch (_) { /* cae a la carga en vivo */ }

  // En vivo (respaldo: sin feed, viejo o falló). Cada fila es una petición al servidor IPTV.
  const cats = (await cat.liveCategories()).filter((c) => inGroup(tab, c)).slice(0, RAILS_PER_TAB);
  const rows = [];
  for (let i = 0; i < cats.length; i += 3) {
    const batch = await Promise.all(cats.slice(i, i + 3).map(async (c) => {
      try {
        const page = await cat.liveChannels({ categoryId: c.id });
        const items = page.items.slice(0, RAIL_ITEMS).map(channelCard);
        return items.length ? { id: "lcat-" + c.id, title: c.title, ref: "lcat:" + c.id, items } : null;
      } catch (_) { return null; }
    }));
    rows.push(...batch.filter(Boolean));
  }
  return { tabs, tab, rows };
}
