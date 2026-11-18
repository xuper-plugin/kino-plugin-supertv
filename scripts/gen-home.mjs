// Builds, for each account of the service, SuperTV's prebuilt Home (channels per group/tab), sealed with FEED_KEY. The
// Action (.github/workflows/home.yml) runs it 2 times a day. It writes the COMPLETE current set into --out: what it built now
// plus the previous set's files carried forward (scripts/feed-set.mjs); the Action force-pushes that to the `data` branch
// and copies what --main still needs for installed versions that read only `main`. The plugin pulls its account's file
// and paints its Home at once.
// Solo se pre-arman CANALES ESTABLES (iguales todo el día). Los EVENTOS del momento (partidos con hora, "X vs Y", PPV, agenda)
// cambian de un momento a otro: cachearlos los dejaría desfasados, así que se excluyen; esos se cargan en vivo normal.
//   FEED_KEY=<64 hex> node scripts/gen-home.mjs --out <empty dir> [--prev <previous set>]
//     [--main <main checkout> --main-plan <file>] [--main-every-h 36] [--only <host>] [--servers N] [--max-panel-requests N]
// Nothing here touches git: a run with --out in a temp dir and a throwaway FEED_KEY is a dry run.
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import * as feedSet from "./feed-set.mjs";

const arg = (name, def) => feedSet.argOf(process.argv, name, def);
const dirArg = (name) => { const v = arg(name, ""); return v ? resolve(process.cwd(), v) : null; };
const MAX_SERVERS = parseInt(arg("servers", "99"), 10);
const OUT = dirArg("out");
const PREV = dirArg("prev");
const MAIN = dirArg("main");
const MAIN_PLAN = dirArg("main-plan");
const ONLY = arg("only", "").trim().toLowerCase();
const MAIN_EVERY_MS = arg("main-every-h", "") !== "" ? Number(arg("main-every-h")) * 3600000 : feedSet.MAIN_EVERY_MS;
const SUBDIRS = ["home"];
if (!OUT || !Number.isFinite(MAIN_EVERY_MS)) {
  console.error("usage: node scripts/gen-home.mjs --out <empty dir> [--prev <dir>] [--main <dir> --main-plan <file>] [--main-every-h H] [--only <host>] [--servers N] [--max-panel-requests N]");
  process.exit(2);
}
// --out holds exactly this run's set (the Action publishes it as is), so it must start with no feeds in it.
if (feedSet.feedPaths(OUT, SUBDIRS).length) { console.error("--out already holds feeds: give it an empty directory"); process.exit(2); }
const OUT_DIR = join(OUT, "home");

// Clave AES-256 (hex) para sellar el feed como Xuper: el plugin la abre con kino.secret("feedKey"); un fork no puede.
// En el Action viene del secret FEED_KEY; si falta, se aborta (NO se publica nada en claro).
const FEED_KEY = (process.env.FEED_KEY || "").trim();
if (!/^[0-9a-fA-F]{64}$/.test(FEED_KEY)) { console.error("Falta FEED_KEY (64 hex). No se genera nada en claro."); process.exit(2); }
const KEY = Buffer.from(FEED_KEY, "hex");
// Sella un objeto -> sobre { v:1, iv:b64(12B), data:b64(ciphertext+tag16) } (mismo formato que seedBox.js).
function seal(obj) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), data: Buffer.concat([ct, c.getAuthTag()]).toString("base64") });
}
// Opens a .enc.json (to read the `at` of a previous or `main` copy). null when it does not open.
function openEnc(text) {
  try {
    const box = JSON.parse(text);
    const iv = Buffer.from(box.iv, "base64"), data = Buffer.from(box.data, "base64");
    const d = createDecipheriv("aes-256-gcm", KEY, iv); d.setAuthTag(data.subarray(data.length - 16));
    return JSON.parse(Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]).toString("utf8"));
  } catch (_) { return null; }
}

// Al re-crear el kino por servidor, un timer pendiente del servidor anterior (rate-limit) puede rechazar tarde: inofensivo.
process.on("unhandledRejection", () => {});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createKino } = await import(pathToFileURL(join(root, "sdk", "kino-shim.mjs")).href);
const { validateManifest } = await import(pathToFileURL(join(root, "sdk", "contract.mjs")).href);
const checked = validateManifest(readFileSync(join(root, "kino-plugin.json"), "utf8"));

const TABS = ["all", "premium", "paises", "deportes", "radio"]; // = TAB_IDS del plugin
const RAILS_PER_TAB = 12, RAIL_ITEMS = 20;
const SCHEMA = 1;

const tmp = mkdtempSync(join(tmpdir(), "stv-gen-"));
// Requests are counted (totals only, never URLs) so the log shows what each build spends against the harness cap.
// --max-panel-requests N (local runs): past N, a panel request fails like a dead panel, so a test never hammers a panel.
const counter = { all: 0, panel: 0 };
const MAX_PANEL = parseInt(arg("max-panel-requests", "0"), 10) || 0;
const countingFetch = (url, init) => {
  const isPanel = String(url && url.href ? url.href : url).includes("/player_api.php");
  if (isPanel && MAX_PANEL && counter.panel >= MAX_PANEL) return Promise.reject(new Error("--max-panel-requests reached"));
  counter.all++;
  if (isPanel) counter.panel++;
  return fetch(url, init);
};
// Mismo storage para todas las instancias (comparte servidores/categorías); kino nuevo por servidor para RESETEAR los límites del shim.
const kinoOpts = { storageFile: join(tmp, "s.json"), cookiesFile: join(tmp, "c.json"), secretsFile: join(tmp, "x.json"), config: {}, env: process.env, fetchImpl: countingFetch };
let harness = null;
const freshKino = () => { harness = createKino(checked.manifest, kinoOpts); globalThis.kino = harness.kino; };
freshKino();
// The harness allows 60 requests per "call" per instance; the server probe and the build are separate calls in Kino, so
// the build starts with the whole budget. The returned function says what the build spent.
const phase = () => {
  harness.resetBudget();
  const all = counter.all, panel = counter.panel;
  return () => `${counter.all - all} requests, ${counter.panel - panel} to the panel`;
};
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

// The `at` sealed in [dir]/[path] when it opens with this key and belongs to the key its name says; else null.
const atIn = (dir) => (path) => {
  try {
    const d = openEnc(readFileSync(join(dir, path), "utf8"));
    return d && d.serverKey === feedSet.keyOfPath(path) && typeof d.at === "number" ? d.at : null;
  } catch (_) { return null; }
};

mkdirSync(OUT_DIR, { recursive: true });
const list = await cat.serverList();
const items = list.items || [];
const hostIs = (h) => { const x = String(h || "").toLowerCase(); return x === ONLY || x.split(":")[0] === ONLY; };
// --only <host>: just that host's accounts (a local dry run against one server). Otherwise the first MAX_SERVERS, as always.
const order = ONLY
  ? items.filter((x) => hostIs(x.host)).map((x) => x.i).slice(0, MAX_SERVERS)
  : Array.from({ length: Math.min(items.length, MAX_SERVERS) }, (_, i) => i);
if (ONLY && !order.length) console.log(`--only ${ONLY}: no account on that host (hosts: ${[...new Set(items.map((x) => x.host))].join(", ")})`);
console.log(`servidores a procesar: ${order.length} de ${items.length}`);
let ok = 0, empty = 0, fail = 0;
const builtKeys = new Set();
const written = new Map(); // relative path -> the `at` sealed in it, for each feed this run wrote
for (const i of order) {
  const t0 = performance.now();
  try {
    freshKino(); // resetea los límites del shim para este servidor
    const sel = await cat.selectServer(i);
    if (!sel.ok) { console.log(`#${i + 1} (${ms(t0)} ms): servidor no responde, se salta`); fail++; continue; }
    if (ONLY && !hostIs(sel.host)) { console.log(`#${i + 1}: answered from another host (${sel.host}), skipped`); continue; }
    const key = cat.serverKey();
    if (builtKeys.has(key)) { console.log(`#${i + 1} ${key}: ya generado (mismo servidor), se salta`); continue; }
    builtKeys.add(key);
    const spent = phase();
    const home = await buildServer();
    if (!home) { console.log(`#${i + 1} ${key} (${ms(t0)} ms): sin canales (${spent()})`); empty++; continue; }
    // api() fails over to another account when one request fails, so the build can end on another account than the one it
    // began on: the result then carries that account's serverKey and the readers reject it under this key's name. It is
    // never published; the previous set's copy is carried forward instead.
    if (home.serverKey !== key || cat.serverKey() !== key) { console.log(`#${i + 1} ${key} (${ms(t0)} ms): the build moved to another account midway; not published, the previous copy stays (${spent()})`); fail++; continue; }
    const enc = seal(home);
    writeFileSync(join(OUT_DIR, key + ".enc.json"), enc);
    written.set(`home/${key}.enc.json`, home.at);
    const nTabs = Object.keys(home.tabs).length;
    const nRails = Object.values(home.tabs).reduce((n, r) => n + r.length, 0);
    console.log(`#${i + 1} ${key} (${ms(t0)} ms): ${nTabs} tabs, ${nRails} filas, ${Math.round(enc.length / 1024)} KB -> ${key}.enc.json (${spent()})`);
    ok++;
  } catch (e) { console.log(`#${i + 1} (${ms(t0)} ms): error ${feedSet.cleanError(e)}`); fail++; }
}
console.log(`\nlisto: ${ok} ok, ${empty} vacíos, ${fail} fallos.`);
if (!ok) console.log("::warning::no account was built in this run; only the previous set's younger feeds are kept");

// The complete current set: what this run wrote plus the previous set's files carried forward (scripts/feed-set.mjs).
const now = Date.now();
const prevPaths = PREV ? feedSet.feedPaths(PREV, SUBDIRS) : [];
const { carry, drop } = feedSet.carryPlan({ prevPaths, written, atOf: PREV ? atIn(PREV) : () => null, now });
feedSet.copyFeeds(PREV, OUT, carry.map((c) => c.path));
const set = new Map([...written, ...carry.map((c) => [c.path, c.at])]);
const carried = new Set(carry.map((c) => c.path));
writeFileSync(join(OUT, feedSet.META), JSON.stringify(feedSet.metaOf({ set, carried, now }), null, 1) + "\n");
const why = (w) => drop.filter((d) => d.why === w).length;
console.log(`set: ${set.size} files (${written.size} built, ${carry.length} carried forward); dropped ${drop.length} (${why("expired")} expired, ${why("unreadable")} unreadable)`);

// What `main` still needs for the installed versions that read only `main`.
if (MAIN) {
  const plan = feedSet.mainPlan({ set, mainPaths: feedSet.feedPaths(MAIN, SUBDIRS), mainAtOf: atIn(MAIN), now, everyMs: MAIN_EVERY_MS });
  if (MAIN_PLAN) writeFileSync(MAIN_PLAN, feedSet.planLines(plan).map((l) => l + "\n").join(""));
  console.log(`main: ${plan.write.length} to rewrite, ${plan.remove.length} to remove (copies older than ${Math.round(MAIN_EVERY_MS / 3600000)} h are rewritten)`);
}
