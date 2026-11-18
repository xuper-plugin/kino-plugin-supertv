// The server list end to end through catalog.js with a fake kino: the person's choice survives the 6-hour refresh and the
// health check's jump, dead accounts cost no request, SuperTV probes live categories only, panels are grouped from the
// health check's own answers, and a live failover never touches the stored server state.
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, installKino, res, kinoError, param, fresh, virtualNet } from "./helpers/fake-kino.mjs";
import { keyOf, readPanels, isDead } from "../src/panels.js";
import { channelTok } from "../src/channelMatch.js";

const fx = fixture();
const catsOf = (s) => fx.categories[s].map(([category_id, category_name]) => ({ category_id, category_name }));
const streamsOf = (s, c) => fx.streams[s][c].map(([stream_id, name]) => ({ stream_id, name }));
const H = 3600000;

// The service's list: an https account that is dead (sorts first), two accounts of one panel, another panel, one offline.
const SRV = {
  dead: { url: "https://dead.example", username: "ud", password: "pd", name: "🇲🇽", answer: () => res(200, { user_info: { auth: 0, status: "Invalid", message: "Invalid username or password" } }) },
  a1: { url: "http://a1.example", username: "u1", password: "p1", name: "🇲🇽", cats: "A" },
  a2: { url: "http://a2.example", username: "u2", password: "p2", name: "🇪🇸", cats: "B" },
  c: { url: "http://c.example", username: "uc", password: "pc", name: "🇪🇸", cats: "C" },
  off: { url: "http://off.example", username: "uo", password: "po", name: "🇺🇸", answer: () => kinoError("network", "connection refused") },
};
const NAMES = Object.keys(SRV);
const srvOf = (n) => ({ url: SRV[n].url, username: SRV[n].username, password: SRV[n].password, name: SRV[n].name });
const text = (names) => names.map((n) => `${SRV[n].url}/get.php?username=${SRV[n].username}&password=${SRV[n].password} [${SRV[n].name}]`).join("\n");

function world({ names = NAMES, probe = {}, storage = {}, lang } = {}) {
  const log = [];
  let list = names;
  const added = { cats: [], streams: {} }; // categories panel A lists on top of the fixture's (addCategory)
  const routes = [(url) => {
    const u = new URL(url);
    if (u.hostname === "vegetatvv2.duckdns.org") { log.push({ n: "boot" }); return res(200, { ok: true, servers_text: text(list) }); }
    const n = NAMES.find((x) => new URL(SRV[x].url).hostname === u.hostname);
    if (!n) return undefined;
    if (u.pathname.startsWith("/live/")) {
      log.push({ n, kind: "probe" });
      const v = probe[n] || "302";
      return v === "302" ? res(302, "", { Location: "http://203.0.113.9/x.m3u8" }) : res(Number(v), "");
    }
    const action = param(url, "action");
    log.push({ n, action, cat: param(url, "category_id") });
    if (SRV[n].answer) return SRV[n].answer();
    if (action === "get_live_categories") return res(200, [...catsOf(SRV[n].cats), ...(SRV[n].cats === "A" ? added.cats : [])]);
    if (action === "get_live_streams") {
      const c = param(url, "category_id");
      if (SRV[n].cats === "A" && added.streams[c]) return res(200, added.streams[c]);
      return res(200, SRV[n].cats === "C" ? (c === "196" ? streamsOf("C", 196) : []) : c === "2956" ? streamsOf("A", 2956) : []);
    }
    return res(200, []);
  }];
  const k = installKino({ routes, storage, lang });
  const addCategory = (id, name, streams) => {
    added.cats.push({ category_id: id, category_name: name });
    added.streams[id] = streams.map(([stream_id, sname]) => ({ stream_id, name: sname }));
  };
  return { ...k, log, setList: (l) => { list = l; }, addCategory };
}

let T = Date.UTC(2026, 10, 17, 12);
const realNow = Date.now;
test.beforeEach(() => { Date.now = () => T; });
test.afterEach(() => { Date.now = realNow; });
const advance = (ms) => { T += ms; };
const srvs = (w) => JSON.parse(w.store.get("srvs"));
const activeName = (w) => { const s = srvs(w); return NAMES.find((n) => SRV[n].url === s.list[s.idx].url); };

test("the health check: live categories only, panels grouped from its answers, dead accounts marked and then skipped", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  assert.ok(w.log.every((e) => !e.action || e.action === "get_live_categories"), "SuperTV never asks for VOD");
  const map = readPanels();
  assert.equal(map.g[keyOf(srvOf("a1"))], map.g[keyOf(srvOf("a2"))], "a1 and a2: one panel");
  assert.notEqual(map.g[keyOf(srvOf("a1"))], map.g[keyOf(srvOf("c"))]);
  assert.ok(isDead(srvOf("dead"), T));
  // The active server was the dead https one: the check moved away (same panel first), without touching any choice.
  assert.notEqual(activeName(w), "dead");
  assert.equal(srvs(w).chosen, undefined);
  assert.equal(cat.hasChosenServer(), false, "a jump is not a choice: the first-run picker still shows");
  // The next check (30 min later) spends nothing on the dead account; after 24 h it gets exactly one probe again.
  advance(31 * 60000);
  w.log.length = 0;
  await cat.healthCheck();
  assert.ok(!w.log.some((e) => e.n === "dead"));
  advance(25 * H);
  w.log.length = 0;
  const cat2 = await fresh("catalog.js");
  await cat2.healthCheck();
  assert.equal(w.log.filter((e) => e.n === "dead").length, 1);
});

test("the picker and the first-run auto-pick never offer a dead account", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  const list = await cat.serverList();
  assert.ok(!list.items.some((x) => x.host === "dead.example"));
  assert.ok(!list.items.some((x) => x.host === "off.example"), "offline after a fresh check");
  assert.equal(w.log.filter((e) => e.n === "dead").length, 1);
  // 40 min later the health result is stale (every server listed again) but the dead account still is not.
  advance(40 * 60000);
  const later = await cat.serverList();
  assert.equal(later.checked, false);
  assert.ok(later.items.some((x) => x.host === "off.example"));
  assert.ok(!later.items.some((x) => x.host === "dead.example"));
});

test("a chosen server survives the 6-hour refresh and the health check's jump; backHome returns to it", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.serverList();
  const iC = srvs(w).list.findIndex((s) => s.url === SRV.c.url);
  const r = await cat.selectServer(String(iC));
  assert.ok(r.ok);
  assert.equal(srvs(w).chosen, keyOf(srvOf("c")));
  assert.ok(cat.hasChosenServer());
  // Six hours later the list is fetched again (in another order): still on c, still chosen.
  advance(6 * H + 1);
  w.setList(["a2", "c", "dead", "a1", "off"]);
  await cat.refreshServers();
  assert.equal(activeName(w), "c");
  assert.equal(srvs(w).chosen, keyOf(srvOf("c")));
  // c goes offline: the health check jumps elsewhere but keeps the choice...
  const keep = SRV.c.answer;
  SRV.c.answer = () => kinoError("network", "down");
  advance(31 * 60000);
  await cat.healthCheck();
  assert.notEqual(activeName(w), "c");
  assert.equal(srvs(w).chosen, keyOf(srvOf("c")));
  // ...and once c answers again, the next catalog call goes back to it (at most one probe every 5 min).
  SRV.c.answer = keep;
  advance(6 * 60000);
  await cat.liveCategories();
  assert.equal(activeName(w), "c");
});

test("backHome makes no request to a dead chosen server", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.serverList();
  const st = srvs(w);
  st.chosen = keyOf(srvOf("dead"));
  st.idx = st.list.findIndex((s) => s.url === SRV.a1.url);
  st.ok = true; st.okAt = T; st.mig = 1;
  w.store.set("srvs", JSON.stringify(st));
  await cat.healthCheck(); // marks dead
  advance(6 * 60000);
  w.log.length = 0;
  await cat.liveCategories();
  assert.ok(!w.log.some((e) => e.n === "dead"));
});

test("an install from before 0.4.1: its pinned or flagged server becomes the chosen one, once", async () => {
  const list = ["dead", "a1", "a2", "c", "off"].map(srvOf);
  const old = { ts: T, list, idx: 2, ok: true, okAt: T, pin: true, v: 2 };
  const w = world({ storage: { srvs: JSON.stringify(old) } });
  const cat = await fresh("catalog.js");
  assert.ok(cat.hasChosenServer());
  const st = srvs(w);
  assert.equal(st.chosen, keyOf(srvOf("a2")));
  assert.equal(st.pin, undefined);
  assert.equal(st.mig, 1);
  const w2 = world({ storage: { srvs: JSON.stringify({ ...old, pin: false }), "srvChosen:v1": "1" } });
  const cat2 = await fresh("catalog.js");
  assert.ok(cat2.hasChosenServer());
  assert.equal(srvs(w2).chosen, keyOf(srvOf("a2")));
  const w3 = world({ storage: { srvs: JSON.stringify({ ...old, pin: false }) } });
  const cat3 = await fresh("catalog.js");
  assert.equal(cat3.hasChosenServer(), false);
  assert.equal(srvs(w3).mig, 1);
});

test("live items carry an enriched ref; resolve plays it with no request, and a failover never touches srvs", async () => {
  const w = world({ probe: { a1: "509" } });
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  const st = srvs(w);
  st.idx = st.list.findIndex((s) => s.url === SRV.a1.url);
  st.chosen = keyOf(srvOf("a1"));
  w.store.set("srvs", JSON.stringify(st));
  const page = await cat.liveChannels({ categoryId: "2956" });
  const item = page.items.find((i) => i.id === "live-201583");
  assert.equal(item.title, "DAZN 1 HD", "the shown title has no 'ES ▎'");
  assert.equal(item.ref, "live:201583~2956~es.dazn~es.hd.dazn.1", "the ref still reads the raw name (es.hd.dazn.1)");
  const before = w.store.get("srvs");
  w.log.length = 0;
  const out = await cat.resolve(item.ref);
  assert.ok(out.url.startsWith(SRV.a1.url + "/live/"));
  assert.equal(w.log.length, 0);
  const again = await cat.resolve(item.ref); // a cut: R2 sees the 509 and moves to a2 (same panel, same id)
  assert.ok(again.url.startsWith(SRV.a2.url + "/live/") && again.url.endsWith("/201583.m3u8"), again.url);
  assert.equal(w.store.get("srvs"), before, "the active server, the choice and the list are untouched");
});

test("the 'no server' message follows Kino's language tag", async () => {
  const w = world({ probe: { a1: "509", a2: "509", c: "509" }, lang: "en-US" });
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  const st = srvs(w);
  st.idx = st.list.findIndex((s) => s.url === SRV.a1.url);
  w.store.set("srvs", JSON.stringify(st));
  const ref = "live:201583~2956~es.dazn~es.hd.dazn.1";
  await cat.resolve(ref);
  await assert.rejects(cat.resolve(ref), (e) => e.code === "unavailable" && /isn't answering on any server/.test(e.userMessage));
});

test("an ISP block that redirects to another host is not a blocked account; Kino refusing the server's own host is", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.serverList();
  SRV.a1.answer = () => kinoError("host_not_allowed", "not allowed", { host: "www.coljuegos.gov.co" });
  SRV.a2.answer = () => kinoError("host_not_allowed", "not allowed", { host: "a2.example" });
  await cat.healthCheck();
  delete SRV.a1.answer;
  delete SRV.a2.answer;
  const acct = JSON.parse(w.store.get("acct:v1"));
  assert.ok(!(keyOf(srvOf("a1")) in acct.blocked));
  assert.ok(keyOf(srvOf("a2")) in acct.blocked);
});

test("refs are identical for every account of a panel (a favourite does not churn when the account changes)", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.serverList();
  const refsOn = async (n) => {
    const st = srvs(w);
    st.idx = st.list.findIndex((s) => s.url === SRV[n].url);
    st.ok = true; st.okAt = T;
    w.store.set("srvs", JSON.stringify(st));
    const c = await fresh("catalog.js");
    return (await c.liveChannels({ categoryId: "2956" })).items.map((i) => i.ref);
  };
  const a = await refsOn("a1");
  const b = await refsOn("a2");
  assert.ok(a.length > 20);
  assert.deepEqual(a, b);
});

test("first run: the auto-pick races the ranking three at a time and never chooses a dead account; a lost flag heals", async () => {
  const w = world();
  const screen = await fresh("screen.js");
  let state = {};
  const tick = async () => { const r = await screen.screenEvent({ name: "tick", state, lang: "es" }); state = { ...state, ...(r && r.state) }; };
  await tick();
  // The dead https account sorts first and answers first: it is marked, never chosen, and the next account (c) takes its
  // place at once; no health check before the Home.
  assert.deepEqual(w.log.filter((e) => e.action).map((e) => e.n + " " + e.action), ["dead get_live_categories", "a1 get_live_categories", "a2 get_live_categories", "c get_live_categories"]);
  assert.equal(activeName(w), "a1");
  assert.equal(srvs(w).chosen, keyOf(srvOf("a1")));
  assert.ok(isDead(srvOf("dead"), T));
  assert.equal(w.store.get("srvChosen:v1"), "1");
  // The flag disappears (an older build's eviction): the chosen server still counts and the flag is written again.
  w.store.delete("srvChosen:v1");
  const view = await screen.screen({ route: { name: "main" }, state, device: { kind: "phone" } });
  assert.ok(view);
  assert.equal(w.store.get("srvChosen:v1"), "1");
});

test("a live category the panel added after the person's server was picked: its ref plays there after one refresh", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  const iA1 = srvs(w).list.findIndex((s) => s.url === SRV.a1.url);
  assert.ok((await cat.selectServer(String(iA1))).ok, "picking a server keeps its live categories");
  advance(H);
  w.addCategory("3100", "ES ▎MUNDIAL 2026", [[777001, "ES ▎MUNDIAL 1 HD"]]);
  // A new runtime opens the channel from fresher data (the CI-built Home feed, a favourite from another device).
  const cat2 = await fresh("catalog.js");
  const ref = "live:777001~3100~es.2026.mundial~es.hd.mundial.1";
  w.log.length = 0;
  const out = await cat2.resolve(ref);
  assert.ok(out.url.startsWith(SRV.a1.url + "/live/") && out.url.endsWith("/777001.m3u8"), out.url);
  assert.deepEqual(w.log.map((e) => e.n + " " + (e.action || e.kind)), ["a1 get_live_categories"]);
  // The refresh is now a1's category cache: listing the category builds the very same ref.
  const page = await cat2.liveChannels({ categoryId: "3100" });
  assert.equal(page.items[0].ref, ref);
});

test("the health check ends within a screen call with hanging servers and a stale list, and writes what answered", async () => {
  const net = virtualNet({ start: T });
  Date.now = net.now;
  const hosts = Array.from({ length: 30 }, (_, i) => ({ url: `http://h${i}.example`, username: "u" + i, password: "p" + i, name: "🇲🇽" }));
  const hanging = new Set(hosts.filter((_, i) => i % 3 === 0).map((s) => new URL(s.url).hostname)); // 10 of 30
  const listText = hosts.map((s) => `${s.url}/get.php?username=${s.username}&password=${s.password} [${s.name}]`).join("\n");
  const boot = [];
  const routes = [(url, init) => {
    const u = new URL(url);
    if (u.hostname === "vegetatvv2.duckdns.org") { boot.push(init && init.timeoutMs); return net.request(800).then(() => res(200, { ok: true, servers_text: listText })); }
    if (hanging.has(u.hostname)) return net.request((init && init.timeoutMs) || 15000).then(() => kinoError("timeout", "timed out"));
    return net.request(1200).then(() => res(200, catsOf("A")));
  }];
  const stale = { ts: net.now() - 7 * H, list: hosts, idx: 0, ok: true, okAt: net.now(), v: 2, mig: 1 };
  const k = installKino({ routes, storage: { srvs: JSON.stringify(stale) } });
  const cat = await fresh("catalog.js");
  const t0 = net.now();
  const online = await net.run(cat.healthCheck());
  const took = net.now() - t0;
  assert.ok(took <= 16000, `took ${took} ms (Kino's screen call limit is 20 s)`);
  assert.ok(boot.length >= 1 && boot.every((t) => t && t <= 4000), "the server list is asked with a short timeout");
  assert.ok(online >= 10, String(online));
  assert.ok(JSON.parse(k.store.get("health:v1")).online.length >= online);
  assert.ok(k.store.get("panels:v1"));
});

test("live titles: the panels' decorations are gone from what Kino lists; ids and refs are built from the raw names as before", async () => {
  const w = world();
  w.addCategory("3200", "UHD CHANNELS", [[900001, "4K ▎DAZN 1"], [900002, "┃UCL┃ CHAMPIONS 1"], [900003, "|PT| DAZN 1 HD"]]);
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  const st = srvs(w);
  st.idx = st.list.findIndex((s) => s.url === SRV.a1.url);
  st.chosen = keyOf(srvOf("a1"));
  w.store.set("srvs", JSON.stringify(st));
  // A category of Spain: every "ES ▎" goes, nothing else; ids and refs are built from the raw names exactly as before.
  const raw = streamsOf("A", 2956);
  const page = await cat.liveChannels({ categoryId: "2956" });
  assert.deepEqual(page.items.map((i) => i.title), raw.map((s) => s.name.replace(/^ES ▎/, "")));
  assert.deepEqual(page.items.map((i) => i.id), raw.map((s) => "live-" + s.stream_id));
  assert.deepEqual(page.items.map((i) => i.ref), raw.map((s) => `live:${s.stream_id}~2956~es.dazn~${channelTok(s.name)}`));
  // A category of no country: the quality is kept at the end, a group before a panel bar goes; refs read the raw names.
  const uhd = await cat.liveChannels({ categoryId: "3200" });
  assert.deepEqual(uhd.items.map((i) => i.title), ["DAZN 1 4K", "CHAMPIONS 1", "DAZN 1 HD"]);
  assert.equal(uhd.items[0].ref, "live:900001~3200~_~_.4k.dazn.1");
  assert.equal(uhd.items[1].ref, `live:900002~3200~_~${channelTok("┃UCL┃ CHAMPIONS 1")}`);
});

test("live search: one mixed list, found by what the person sees, and Kino's lookup by an old decorated name still matches", async () => {
  // One account whose few categories all fit in a search (a real panel has hundreds: a search scans its first 36).
  const one = { url: "http://s1.example", username: "u", password: "p", name: "🇪🇸" };
  const cats = [["2956", "ES ▎DAZN"], ["3200", "UHD CHANNELS"], ["3300", "PT ▎DAZN"]];
  const streams = { 2956: streamsOf("A", 2956), 3200: [{ stream_id: 900001, name: "4K ▎DAZN 1" }], 3300: [{ stream_id: 900003, name: "PT ▎DAZN 1 HD" }] };
  const k = installKino({ routes: [(url) => {
    const u = new URL(url);
    if (u.hostname === "vegetatvv2.duckdns.org") return res(200, { ok: true, servers_text: `${one.url}/get.php?username=u&password=p [🇪🇸]` });
    if (u.hostname !== "s1.example") return undefined;
    const action = param(url, "action");
    if (action === "get_live_categories") return res(200, cats.map(([category_id, category_name]) => ({ category_id, category_name })));
    if (action === "get_live_streams") return res(200, streams[param(url, "category_id")] || []);
    return res(200, []);
  }] });
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  const hits = (await cat.liveSearch({ query: "dazn 1 hd" })).items;
  assert.deepEqual(hits.map((i) => i.title).sort(), ["DAZN 1 HD · España", "DAZN 1 HD · Portugal"]);
  assert.equal(hits.find((i) => i.id === "live-201583").ref, "live:201583~2956~es.dazn~es.hd.dazn.1");
  assert.deepEqual((await cat.liveSearch({ query: "dazn 1 4k" })).items.map((i) => i.id), ["live-900001"], "found by its shown title");
  // Kino looks a favourite saved under its old, decorated name up by that name: that hit answers under it, so Kino's
  // id + name comparison recognises the channel (and heals the favourite's ref).
  const old = (await cat.liveSearch({ query: "ES ▎DAZN 1 HD" })).items.find((i) => i.id === "live-201583");
  assert.equal(old.title, "ES ▎DAZN 1 HD");
  assert.equal(old.ref, "live:201583~2956~es.dazn~es.hd.dazn.1");
  // English: the suffix follows Kino's language.
  k.kino.lang = "en-US";
  assert.deepEqual((await cat.liveSearch({ query: "dazn 1 hd" })).items.map((i) => i.title).sort(), ["DAZN 1 HD · Portugal", "DAZN 1 HD · Spain"]);
});

test("a Home snapshot and a search history written by an older build show clean titles", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  const st = srvs(w);
  st.idx = st.list.findIndex((s) => s.url === SRV.a1.url);
  st.chosen = keyOf(srvOf("a1"));
  w.store.set("srvs", JSON.stringify(st));
  w.store.set("srvChosen:v1", "1");
  const key = cat.serverKey();
  const card = (id, title) => ({ id: "live-" + id, ref: "live:" + id, title, kind: "live" });
  w.store.set(`homeSnap:v1:${key}:all`, JSON.stringify({ v: 1, at: T, rails: [{ id: "lcat-2956", catId: "2956", title: "ES DAZN", items: [card(201583, "ES ▎DAZN 1 HD"), card(192289, "ES ▎DAZN 1 FHD")] }] }));
  w.store.set(`searchHist:v1:${key}`, JSON.stringify({ v: 1, e: [card(201583, "ES ▎DAZN 1 HD"), card(900003, "|PT| DAZN 1 HD")] }));
  const screen = await fresh("screen.js");
  const main = JSON.stringify(await screen.screen({ route: { name: "main" }, state: {}, device: { kind: "phone" } }));
  assert.ok(main.includes('"DAZN 1 HD"') && main.includes('"DAZN 1 FHD"'), "the snapshot's cards are clean");
  assert.ok(!main.includes("ES ▎"));
  const search = JSON.stringify(await screen.screen({ route: { name: "search" }, state: {}, device: { kind: "phone" } }));
  assert.ok(search.includes("DAZN 1 HD · España") && search.includes("DAZN 1 HD · Portugal"), "the history is one list: both say which");
  assert.ok(!search.includes("ES ▎") && !search.includes("|PT|"));
  assert.ok(search.includes('"live:201583"'), "refs untouched");
});
