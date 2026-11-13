// La pantalla propia de SuperTV (apiVersion 14, vía enhancements) y la sección nativa. La vista es pura: lo cargado vive en
// memoria y, si el runtime se reinicia, el temporizador `tick` lo vuelve a traer; el estado solo guarda tab, n y fallos.
// Todo lo cargado se descarta si cambia el servidor activo (las categorías e ids no coinciden entre servidores).
import * as cat from "./catalog.js";
import { say, twin } from "./i18n.js";
import { put } from "./store.js";
import { TAB_IDS, browseView, searchView, liveView, settingsView, verifyingView, firstPickView, cardOf } from "./screenView.js";
import { fetchHomeFeed } from "./homeFeed.js";

const PLUGIN_VERSION = "0.3.0";
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
let pickServers = null;       // lista para el selector de servidor de la primera vez (null = aún sin cargar)
let cacheKey = null;
const homeFeedData = new Map(); // tab -> [rails] del feed pre-armado (si se bajó): Home al instante, sin recorrer el IPTV
let homeFeedTried = false;      // ya se intentó el feed (haya salido o no)
let eventsRow = null;           // fila DINÁMICA de eventos en vivo (la única en vivo del Home); null = aún sin cargar/vacía
let eventsTried = false;        // ya se intentó cargar los eventos en esta entrada (se reintenta en cada `open`)

// La persona ya eligió servidor al menos una vez: se recuerda para no volver a mostrar el selector inicial (se cambia con 🌐).
const SRVCHOSEN_KEY = "srvChosen:v1";
const serverChosen = () => getStored(SRVCHOSEN_KEY) === "1";
const markServerChosen = () => { try { put(SRVCHOSEN_KEY, "1"); } catch (_) { /* da igual */ } };

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
    return o && o.v === 1 && Array.isArray(o.e) ? o.e.filter((c) => c && typeof c.id === "string" && typeof c.ref === "string").slice(0, HIST_MAX) : [];
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

// ---- Feed pre-armado + snapshot en dispositivo ----
const HOME_SNAP_PREFIX = "homeSnap:";
const SNAP_V = 1;
const SNAP_MAX = 9 * 1024; // por tab; varias pestañas caben en el presupuesto de la clase homeSnap (40 KB)
const slimCard = (c) => ({ id: c.id, ref: c.ref, title: c.title, ...(c.kind ? { kind: c.kind } : {}), ...(c.poster ? { poster: c.poster } : {}) });
const snapKey = (tab) => HOME_SNAP_PREFIX + "v" + SNAP_V + ":" + cat.serverKey() + ":" + tab;
function writeTabSnap(tab, rails) {
  try {
    if (!rails || !rails.length) return;
    // Se recorta hasta caber: menos ítems por fila y, si hace falta, menos filas. Tarjetas slim (lo que una fila necesita).
    for (const maxRails of [rails.length, 10, 8, 6]) {
      for (let per = 10; per >= 5; per -= 2) {
        const slim = { v: SNAP_V, at: Date.now(), rails: rails.slice(0, maxRails).map((r) => ({ id: r.id, catId: r.catId, title: r.title, items: (r.items || []).slice(0, per).map(slimCard) })) };
        const text = JSON.stringify(slim);
        if (text.length <= SNAP_MAX) { put(snapKey(tab), text); return; }
      }
    }
  } catch (_) { /* almacenamiento lleno: sin snapshot */ }
}
function readSnap(tab) {
  try {
    const o = JSON.parse(kino.storage.get(snapKey(tab)) || "null");
    return o && o.v === SNAP_V && Array.isArray(o.rails) && o.rails.length ? o : null;
  } catch (_) { return null; }
}

// Intenta el feed pre-armado del servidor (una sola descarga). Si llega, todas las pestañas quedan listas para pintar al
// instante (sin tocar el IPTV) y se guarda un snapshot por tab; si no, se marca intentado y se cae a la carga en vivo. Nunca lanza.
async function loadHomeFeed() {
  homeFeedTried = true;
  let feed = null;
  try { feed = await fetchHomeFeed(cat.serverKey()); } catch (_) { feed = null; }
  if (!feed || !feed.tabs) return;
  for (const tab of Object.keys(feed.tabs)) {
    homeFeedData.set(tab, feed.tabs[tab]);
    writeTabSnap(tab, feed.tabs[tab]);
  }
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
async function loadGroupTab(tab) {
  const cats = (liveCatsAll || []).filter((c) => inGroup(tab, c)).slice(0, RAILS_PER_TAB);
  let failed = 0;
  const results = [];
  for (let i = 0; i < cats.length; i += 3) {
    results.push(...await Promise.all(cats.slice(i, i + 3).map(async (c) => {
      try { return { c, page: await cat.liveChannels({ categoryId: c.id }) }; } catch (_) { failed++; return null; }
    })));
  }
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

// Unidades que faltan por cargar. Sin servidor elegido aún: solo salud y la lista para el selector inicial (no se carga el Home
// hasta que la persona elija, para no entrar con un servidor al azar). Ya elegido: salud, categorías y las filas del tab.
// Primero el feed pre-armado (una sola descarga): si está, el Home sale al instante y NO se recorre el IPTV. Si el feed
// tiene el tab, no hace falta nada más; si falta/está viejo/falló, se cae a la carga en vivo (categorías + filas del tab).
function unitsFor(tab) {
  if (!serverChosen()) return ["health", "pick"];
  let base;
  if (homeFeedData.has(tab)) base = ["hfeed", "health"];
  else if (!homeFeedTried) base = ["hfeed", "health", "cats", "tab:" + tab];
  else base = ["health", "cats", "tab:" + tab];
  // La fila de eventos en vivo va AL FINAL (última prioridad) y solo en el Home (tab "all"): se carga "cuando pueda", sin bloquear.
  if (tab === TAB_IDS[0] && eventsOn() && !eventsTried) base = [...base, "events"];
  return base;
}

function isDone(unit) {
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
  if (unit === "events") { await loadEvents(); return; }
  if (unit === "hfeed") { await loadHomeFeed(); return; }
  if (unit === "cats") { liveCatsAll = await cat.liveCategories(); return; }
  if (unit === "health") { await cat.healthCheck(); return; }
  if (unit === "pick") { pickServers = await cat.serverList(); return; }
  const [, tab] = unit.split(":");
  await loadGroupTab(tab);
}

function mainView(ctx) {
  const state = ctx.state || {};
  // Primera vez (sin servidor elegido): la persona elige uno. Ese flujo sí necesita el chequeo para listar los que responden.
  if (!serverChosen()) {
    if (!cat.healthReady() && !(state.failed && state.failed.health)) return verifyingView({ device: ctx.device });
    return firstPickView({ servers: pickServers, failed: !!(state.failed && state.failed.pick), device: ctx.device });
  }
  const tab = tabOf(state, ctx.route);
  // Arranque rápido: feed pre-armado o snapshot de la última sesión → se pinta YA, sin esperar "Verificando servidores…".
  // El chequeo sigue por detrás (unitsFor) y la verificación real del servidor ocurre antes de reproducir (resolve).
  const feedRails = homeFeedData.get(tab);
  const live = groupRails.get(tab) || null;
  const snap = !feedRails && !live ? readSnap(tab) : null;
  let data = feedRails ? { rails: feedRails, partial: false } : live || (snap ? { rails: snap.rails, partial: false, stale: true } : null);
  // Fila de eventos en vivo arriba del Home (solo tab "all"): se antepone cuando ya cargó, sin duplicar si esa categoría ya está.
  if (tab === TAB_IDS[0] && eventsRow) {
    const rest = ((data && data.rails) || []).filter((r) => r.id !== eventsRow.id);
    data = { ...(data || { partial: false }), rails: [eventsRow, ...rest] };
  }
  if (!data && !cat.healthReady() && !(state.failed && state.failed.health)) return verifyingView({ device: ctx.device });
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
  async tick({ state }) {
    const tab = tabOf(state);
    const unit = pendingUnit(state, tab);
    if (!unit) return null;
    const failed = { ...(state.failed || {}) };
    try { await runUnit(unit); } catch (_) { failed[unit] = true; }
    cacheKey = cat.serverKey();
    return { state: { ...bump(state), failed } };
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
  return { tabs: SECTION_TABS.map((t) => ({ id: t.id, label: english ? t.en : t.label })), tab, rows };
}
