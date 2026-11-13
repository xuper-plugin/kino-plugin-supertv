// Genera, por cada servidor, el Home pre-armado de SuperTV (canales por grupo/tab) y lo escribe en home/<serverKey>.json.
// Lo corre un Action 2 veces al día; el plugin baja el JSON de su servidor y pinta el Home al instante.
// Solo se pre-arman CANALES ESTABLES (iguales todo el día). Los EVENTOS del momento (partidos con hora, "X vs Y", PPV, agenda)
// cambian de un momento a otro: cachearlos los dejaría desfasados, así que se excluyen; esos se cargan en vivo normal.
//   node scripts/gen-home.mjs [--servers N] [--out home]
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

// Al re-crear el kino por servidor, un timer pendiente del servidor anterior (rate-limit) puede rechazar tarde: inofensivo.
process.on("unhandledRejection", () => {});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createKino } = await import(pathToFileURL(join(root, "sdk", "kino-shim.mjs")).href);
const { validateManifest } = await import(pathToFileURL(join(root, "sdk", "contract.mjs")).href);
const checked = validateManifest(readFileSync(join(root, "kino-plugin.json"), "utf8"));

const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : def; };
const MAX_SERVERS = parseInt(arg("servers", "99"), 10);
const OUT_DIR = join(root, arg("out", "home"));
const TABS = ["all", "premium", "paises", "deportes", "radio"]; // = TAB_IDS del plugin
const RAILS_PER_TAB = 12, RAIL_ITEMS = 20;
const SCHEMA = 1;

const tmp = mkdtempSync(join(tmpdir(), "stv-gen-"));
// Mismo storage para todas las instancias (comparte servidores/categorías); kino nuevo por servidor para RESETEAR los límites del shim.
const kinoOpts = { storageFile: join(tmp, "s.json"), cookiesFile: join(tmp, "c.json"), secretsFile: join(tmp, "x.json"), config: {}, env: process.env };
const freshKino = () => { globalThis.kino = createKino(checked.manifest, kinoOpts).kino; };
freshKino();
const cat = await import(pathToFileURL(join(root, "src", "catalog.js")).href);

const ms = (t0) => Math.round(performance.now() - t0);
const inGroup = (tab, c) => tab === "all" || c.group === tab; // igual que el plugin
const channelCard = (i) => ({ id: i.id, ref: i.ref, title: i.title, kind: "live", ...(i.logo ? { poster: i.logo } : {}), ...(i.adult ? { adult: true } : {}) });

// Eventos del día: se detectan por nombre de categoría y por títulos con hora/fecha/"vs"; se excluyen (se desfasan si se cachean).
const EVENT_CAT = /event|ppv|pay.?per.?view|agenda|jornada|cartelera|fecha\b|partidos?\b/i;
const EVENT_TITLE = /(\b\d{1,2}:\d{2}\b)|(\bvs\.?\b)|(\b\d{1,2}[/-]\d{1,2}\b)|(\bppv\b)/i;
function isEventRail(name, items) {
  if (EVENT_CAT.test(String(name || ""))) return true;
  if (!items.length) return false;
  return items.filter((it) => EVENT_TITLE.test(it.title || "")).length / items.length >= 0.3;
}

// Un servidor: arma las filas (canales por categoría) de cada tab, excluyendo eventos. Devuelve { v, at, serverKey, tabs } o null.
async function buildServer() {
  const catsAll = await cat.liveCategories();
  const chanCache = new Map(); // catId -> tarjetas[] | null (una categoría puede salir en varios tabs: se pide una sola vez)
  const railFor = async (c) => {
    if (!chanCache.has(c.id)) {
      try { const p = await cat.liveChannels({ categoryId: c.id }); chanCache.set(c.id, p.items.slice(0, RAIL_ITEMS).map(channelCard)); }
      catch (_) { chanCache.set(c.id, null); }
    }
    const items = chanCache.get(c.id);
    if (!items || !items.length || isEventRail(c.title, items)) return null;
    return { id: "lcat-" + c.id, catId: c.id, title: c.title, items };
  };
  const tabs = {};
  let total = 0;
  for (const tab of TABS) {
    const cands = catsAll.filter((c) => inGroup(tab, c));
    const rails = [];
    for (const c of cands) { if (rails.length >= RAILS_PER_TAB) break; const r = await railFor(c); if (r) rails.push(r); }
    if (rails.length) { tabs[tab] = rails; total += rails.length; }
  }
  return total ? { v: SCHEMA, at: Date.now(), serverKey: cat.serverKey(), tabs } : null;
}

mkdirSync(OUT_DIR, { recursive: true });
const list = await cat.serverList();
const total = Math.min((list.items || []).length, MAX_SERVERS);
console.log(`servidores a procesar: ${total} de ${(list.items || []).length}`);
let ok = 0, empty = 0, fail = 0;
const index = [];
const builtKeys = new Set();
for (let i = 0; i < total; i++) {
  const t0 = performance.now();
  try {
    freshKino(); // resetea los límites del shim para este servidor
    const sel = await cat.selectServer(i);
    if (!sel.ok) { console.log(`#${i + 1} (${ms(t0)} ms): servidor no responde, se salta`); fail++; continue; }
    const key = cat.serverKey();
    if (builtKeys.has(key)) { console.log(`#${i + 1} ${key}: ya generado (mismo servidor), se salta`); continue; }
    builtKeys.add(key);
    const home = await buildServer();
    if (!home) { console.log(`#${i + 1} ${key} (${ms(t0)} ms): sin canales`); empty++; continue; }
    writeFileSync(join(OUT_DIR, key + ".json"), JSON.stringify(home));
    const bytes = JSON.stringify(home).length;
    const nTabs = Object.keys(home.tabs).length;
    const nRails = Object.values(home.tabs).reduce((n, r) => n + r.length, 0);
    index.push({ serverKey: key, at: home.at, tabs: nTabs, rails: nRails, bytes });
    console.log(`#${i + 1} ${key} (${ms(t0)} ms): ${nTabs} tabs, ${nRails} filas, ${Math.round(bytes / 1024)} KB -> ${key}.json`);
    ok++;
  } catch (e) { console.log(`#${i + 1} (${ms(t0)} ms): error ${e && e.message}`); fail++; }
}
writeFileSync(join(OUT_DIR, "index.json"), JSON.stringify({ v: SCHEMA, at: Date.now(), servers: index }));
console.log(`\nlisto: ${ok} ok, ${empty} vacíos, ${fail} fallos. Índice: ${index.length} servidores.`);
