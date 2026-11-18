// The Home feed's source and its bare refs. The feed is read from the orphan `data` branch first and from `main` when that
// copy is missing or unusable; only a `data` 404 for a feed `main` serves makes `data` skipped for 6 h (in memory and in
// storage); a network error costs no second request. Bare `live:<id>` refs that 0.4.0 code wrote, in a feed or a Home snapshot, gain their category (and, from a feed,
// the channel's raw name) with no request, so the live failover covers Home rows right after the update.
import test from "node:test";
import assert from "node:assert/strict";
import { installKino, res, kinoError, param, fresh } from "./helpers/fake-kino.mjs";
import { parseLiveRef, liveRef } from "../src/liveFailover.js";
import { categoryTok, channelTok } from "../src/channelMatch.js";
import { upgradeBareRefs, DATA_MISS_MS } from "../src/homeFeed.js";

const H = 3600000;
let T = Date.UTC(2026, 10, 17, 12);
const realNow = Date.now;
test.beforeEach(() => { Date.now = () => T; });
test.afterEach(() => { Date.now = realNow; });

const RAW = "raw.githubusercontent.com";
const KEY = "1abcdef";

// A sealed feed as the plugin sees it: the fake decrypt only checks the call and decodes the payload.
const box = (obj) => JSON.stringify({ v: 1, iv: "AAAAAAAAAAAAAAAA", data: Buffer.from(JSON.stringify(obj)).toString("base64") });
function sealing(kino) {
  kino.secret = (name) => (name === "feedKey" ? "test-key" : null);
  kino.crypto = {
    decrypt: (alg, o) => {
      if (alg !== "aes-256-gcm" || o.key !== "test-key" || o.ivEncoding !== "base64") throw new Error("bad decrypt call");
      return Buffer.from(o.data, "base64").toString("utf8");
    },
  };
}
const feedFor = (serverKey, tabs, at = T) => ({ v: 1, at, serverKey, tabs });
const RAILS = [{ id: "lcat-2956", catId: "2956", title: "ES DAZN", items: [{ id: "live-1", ref: "live:1~2956~es.dazn~es.hd.dazn.1", title: "DAZN 1 HD", kind: "live" }] }];

// raw.githubusercontent.com: [data] and [main] answer per branch: a body (served as 200), a number (that status) or an Error.
function github({ data, main, storage } = {}) {
  const log = [];
  const k = installKino({ storage, routes: [(url) => {
    const u = new URL(url);
    if (u.hostname !== RAW) return undefined;
    const m = u.pathname.match(/^\/xuper-plugin\/kino-plugin-supertv\/([^/]+)\/home\/([^/]+)\.enc\.json$/);
    if (!m) return res(404, "404: Not Found");
    log.push({ branch: m[1], key: decodeURIComponent(m[2]), v: param(url, "v") });
    const a = m[1] === "data" ? data : m[1] === "main" ? main : 404;
    if (a instanceof Error) return a;
    if (typeof a === "number") return res(a, "404: Not Found");
    return a === undefined ? res(404, "404: Not Found") : res(200, a);
  }] });
  sealing(k.kino);
  return { ...k, log, branches: () => log.map((e) => e.branch) };
}

test("the data branch is read first: one request when it has the feed, same path and hourly cache-bust as main", async () => {
  const g = github({ data: box(feedFor(KEY, { all: RAILS })), main: box(feedFor(KEY, { all: [] })) });
  const hf = await fresh("homeFeed.js");
  const feed = await hf.fetchHomeFeed(KEY);
  assert.deepEqual(feed.tabs.all, RAILS);
  assert.deepEqual(g.branches(), ["data"]);
  assert.equal(g.log[0].key, KEY);
  assert.equal(g.log[0].v, String(Math.floor(T / H)));
  assert.equal(g.kino.storage.get("feedData:v1"), null, "nothing to remember");
});

test("a missing data copy falls back to main, and main alone is read for the next 6 h (memory and storage)", async () => {
  const g = github({ data: 404, main: box(feedFor(KEY, { all: RAILS })) });
  const hf = await fresh("homeFeed.js");
  assert.deepEqual((await hf.fetchHomeFeed(KEY)).tabs.all, RAILS);
  assert.deepEqual(g.branches(), ["data", "main"]);
  assert.equal(g.kino.storage.get("feedData:v1"), String(T), "remembered with the time it was seen");
  // The same runtime: main only.
  g.log.length = 0;
  T += H;
  assert.ok(await hf.fetchHomeFeed(KEY));
  assert.deepEqual(g.branches(), ["main"]);
  // A new runtime (memory gone) reads the mark from storage: main only.
  g.log.length = 0;
  const hf2 = await fresh("homeFeed.js");
  assert.ok(await hf2.fetchHomeFeed(KEY));
  assert.deepEqual(g.branches(), ["main"]);
  // After 6 h the data branch is tried again.
  g.log.length = 0;
  T += DATA_MISS_MS;
  assert.ok(await hf2.fetchHomeFeed(KEY));
  assert.deepEqual(g.branches(), ["data", "main"]);
});

test("any non-2xx or unusable data copy falls back to main; a network error costs no second request and is not remembered", async () => {
  for (const data of [500, 429, "<html>not json</html>", JSON.stringify({ v: 1, iv: "x", data: "@@@" }), box(feedFor("other", { all: RAILS })), box(feedFor(KEY, { all: RAILS }, T - 4 * 24 * H))]) {
    const g = github({ data, main: box(feedFor(KEY, { all: RAILS })) });
    const hf = await fresh("homeFeed.js");
    assert.ok(await hf.fetchHomeFeed(KEY), String(data).slice(0, 40));
    assert.deepEqual(g.branches(), ["data", "main"]);
    // Only a 404 says the branch is missing: anything else is tried on data again next time.
    assert.equal(g.kino.storage.get("feedData:v1"), null, String(data).slice(0, 40));
    g.log.length = 0;
    await hf.fetchHomeFeed(KEY);
    assert.deepEqual(g.branches(), ["data", "main"], String(data).slice(0, 40));
  }
  // A data 404 that main cannot serve either (an account without a feed, or main no longer written): never remembered,
  // or a later feed on data would be skipped for hours.
  for (const main of [404, box(feedFor(KEY, { all: RAILS }, T - 4 * 24 * H))]) {
    const g = github({ data: 404, main });
    const hf = await fresh("homeFeed.js");
    assert.equal(await hf.fetchHomeFeed(KEY), null);
    assert.deepEqual(g.branches(), ["data", "main"]);
    assert.equal(g.kino.storage.get("feedData:v1"), null, String(main).slice(0, 40));
    g.log.length = 0;
    await hf.fetchHomeFeed(KEY);
    assert.deepEqual(g.branches(), ["data", "main"]);
  }
  const g = github({ data: kinoError("network", "unreachable"), main: box(feedFor(KEY, { all: RAILS })) });
  const hf = await fresh("homeFeed.js");
  assert.equal(await hf.fetchHomeFeed(KEY), null);
  assert.deepEqual(g.branches(), ["data"], "main is on the same host: not asked");
  assert.equal(g.kino.storage.get("feedData:v1"), null);
  g.log.length = 0;
  await hf.fetchHomeFeed(KEY);
  assert.deepEqual(g.branches(), ["data"], "the next load tries data again");
});

test("with a deadline every feed request carries a timeout within it; without time left none is made", async () => {
  const g = github({ data: 404, main: box(feedFor(KEY, { all: RAILS })) });
  const hf = await fresh("homeFeed.js");
  assert.ok(await hf.fetchHomeFeed(KEY, { until: T + 5000 }));
  const outs = g.requests.map((r) => r.init.timeoutMs);
  assert.equal(outs.length, 2);
  assert.ok(outs.every((t) => t >= 1000 && t <= 4700), String(outs));
  g.requests.length = 0;
  assert.equal(await hf.fetchHomeFeed(KEY, { until: T + 1000 }), null);
  assert.equal(g.requests.length, 0);
  // Without a deadline Kino's own timeout applies, as before.
  assert.ok(await hf.fetchHomeFeed(KEY));
  assert.equal(g.requests.at(-1).init.timeoutMs, undefined);
});

// ---- bare refs ----

const bare = (id, title) => ({ id: "live-" + id, ref: "live:" + id, title, kind: "live" });

test("a 0.4.0 feed's bare refs become the listing's refs: category id and name, and the channel's raw name", () => {
  const rails = [{ id: "lcat-2956", catId: "2956", title: "ES DAZN", items: [bare(201583, "ES ▎DAZN 1 HD"), { id: "live-7", ref: "live:7~2956~es.dazn~es.hd.dazn.7", title: "DAZN 7" }] }];
  const asked = [];
  const out = upgradeBareRefs(rails, { catName: (id) => { asked.push(id); return "ES ▎DAZN"; }, rawTitles: true });
  assert.equal(out[0].items[0].ref, "live:201583~2956~es.dazn~es.hd.dazn.1");
  assert.equal(out[0].items[0].ref, liveRef("201583", "2956", categoryTok("ES ▎DAZN"), channelTok("ES ▎DAZN 1 HD")));
  assert.equal(parseLiveRef(out[0].items[0].ref).bare, false);
  assert.equal(out[0].items[1], rails[0].items[1], "an enriched ref is left as it is");
  assert.deepEqual(asked, ["2956"], "one name lookup per rail");
  assert.equal(rails[0].items[0].ref, "live:201583", "the input is not changed");
});

test("a snapshot's bare refs gain their category only; unknown names travel as '_'; no numeric category keeps them", () => {
  const rails = [
    { id: "lcat-2956", catId: "2956", title: "ES DAZN", items: [bare(201583, "DAZN 1 HD · España")] },
    { id: "lcat-x", catId: "x9", title: "Otros", items: [bare(5, "Canal 5")] },
    { id: "lcat-3100", catId: "3100", title: "Mundial", items: [bare(6, "Canal 6")] },
  ];
  const out = upgradeBareRefs(rails, { catName: (id) => (id === "2956" ? "ES ▎DAZN" : "") });
  assert.equal(out[0].items[0].ref, "live:201583~2956~es.dazn~");
  const r = parseLiveRef(out[0].items[0].ref);
  assert.deepEqual([r.bare, r.catId, r.catTok, r.tok], [false, "2956", "es.dazn", ""]);
  assert.equal(out[1], rails[1], "no category id: untouched");
  assert.equal(out[2].items[0].ref, "live:6~3100~_~");
  const nothing = [{ id: "lcat-1", catId: "1", title: "A", items: [{ id: "live-2", ref: "live:2~1~_~_._.a", title: "A" }] }];
  assert.equal(upgradeBareRefs(nothing, { catName: () => { throw new Error("not needed"); } })[0], nothing[0]);
});

// ---- through the screen ----

const SRV = { url: "http://a1.example", username: "u1", password: "p1", name: "🇪🇸" };

// A chosen server with its live categories cached, an optional Home snapshot and an optional feed on the data branch.
async function chosenWorld({ snap, feed } = {}) {
  const log = [];
  const panel = (url) => { const u = new URL(url); if (u.hostname !== "a1.example") return undefined; log.push(param(url, "action") || u.pathname); return res(200, []); };
  const routes = [(url) => {
    const u = new URL(url);
    if (u.hostname === RAW) { log.push("feed " + u.pathname.split("/")[3]); return feed ? res(200, box(feed)) : res(404, "404: Not Found"); }
    return panel(url);
  }];
  const k = installKino({ routes, storage: {
    srvs: JSON.stringify({ ts: T, list: [SRV], idx: 0, ok: true, okAt: T, chosen: "x", mig: 1, v: 2 }),
    "srvChosen:v1": "1",
    "health:v1": JSON.stringify({ ts: T, online: [SRV.url] }),
  } });
  sealing(k.kino);
  const cat = await import("../src/catalog.js");
  const key = cat.serverKey();
  k.store.set("cats:live:" + key, JSON.stringify({ ts: T, l: [["2956", "ES ▎DAZN"], ["3100", "MUNDIAL 2026"]] }));
  if (snap) k.store.set(`homeSnap:v1:${key}:all`, JSON.stringify({ v: 1, at: T, rails: snap }));
  return { ...k, log, key, cat };
}

test("a Home snapshot from 0.4.0: its first paint already carries refs the failover covers, with no request", async () => {
  const w = await chosenWorld({ snap: [{ id: "lcat-2956", catId: "2956", title: "ES DAZN", items: [bare(201583, "ES ▎DAZN 1 HD")] }] });
  const screen = await fresh("screen.js");
  const view = JSON.stringify(await screen.screen({ route: { name: "main" }, state: {}, device: { kind: "phone" } }));
  assert.ok(view.includes('"live:201583~2956~es.dazn~"'), "category id and name, no channel name");
  assert.ok(!view.includes('"live:201583"'));
  assert.deepEqual(w.log, []);
});

test("a 0.4.0 feed: the Home rows, the rewritten snapshot and the native section carry full refs", async () => {
  const feed = feedFor(null, { all: [{ id: "lcat-2956", catId: "2956", title: "ES DAZN", items: [bare(201583, "ES ▎DAZN 1 HD")] }] });
  const w = await chosenWorld({ feed });
  feed.serverKey = w.key;
  const screen = await fresh("screen.js");
  let state = {};
  const r = await screen.screenEvent({ name: "tick", state, lang: "es" });
  state = { ...state, ...(r && r.state) };
  assert.deepEqual(w.log, ["feed data"], "the feed's tick asks the panel nothing");
  const full = "live:201583~2956~es.dazn~es.hd.dazn.1";
  const view = JSON.stringify(await screen.screen({ route: { name: "main" }, state, device: { kind: "phone" } }));
  assert.ok(view.includes(`"${full}"`), "the ref reads the raw name");
  assert.ok(view.includes('"DAZN 1 HD"') && !view.includes("ES ▎"), "the shown title is clean");
  const snap = JSON.parse(w.store.get(`homeSnap:v2:${w.key}`));
  assert.equal(snap.tabs.all[0].items[0].ref, full);
  const sec = await screen.section({ tab: "all" });
  assert.equal(sec.rows[0].items[0].ref, full);
});

test("a feed load rewrites Kino's store twice: one snapshot entry for every tab, then the index once, when the call ends", async () => {
  const feed = feedFor(null, { all: RAILS, deportes: RAILS, radio: RAILS });
  const w = await chosenWorld({ feed });
  feed.serverKey = w.key;
  const plugin = await fresh("plugin.js");
  w.writes.length = 0;
  await plugin.screenEvent({ name: "tick", state: {}, lang: "es" });
  assert.deepEqual(w.writes, [`homeSnap:v2:${w.key}`, "_idx"]);
  assert.deepEqual(Object.keys(JSON.parse(w.store.get(`homeSnap:v2:${w.key}`)).tabs).sort(), ["all", "deportes", "radio"]);
  // A render reads the snapshot once per runtime, never writes.
  w.writes.length = 0;
  await plugin.screen({ route: { name: "main" }, state: { tab: "radio" }, device: { kind: "phone" } });
  assert.deepEqual(w.writes, []);
});

test("Kino's native section asks on every tab switch: one feed download per runtime, shared with the screen", async () => {
  const feed = feedFor(null, { all: RAILS, deportes: RAILS });
  const w = await chosenWorld({ feed });
  feed.serverKey = w.key;
  const screen = await fresh("screen.js");
  for (const tab of ["all", "deportes", "radio", "all"]) await screen.section({ tab });
  assert.deepEqual(w.log, ["feed data"], "one download for four calls");
  await screen.screenEvent({ name: "tick", state: {}, lang: "es" });
  assert.deepEqual(w.log, ["feed data"], "the screen's Home uses the same copy");
  // Half an hour later the feed is asked again.
  T += 30 * 60000;
  await screen.section({ tab: "all" });
  assert.deepEqual(w.log, ["feed data", "feed data"]);
});

test("a stale health check runs after the Home's content and the events row, never before", async () => {
  const feed = feedFor(null, { all: RAILS });
  const w = await chosenWorld({ feed });
  feed.serverKey = w.key;
  w.store.set("health:v1", JSON.stringify({ ts: T - 7 * H, online: [SRV.url] }));
  w.store.set("panels:v1", JSON.stringify({ v: 1, at: T - 2 * H, g: {}, t: {} }));
  w.store.set("cats:live:" + w.key, JSON.stringify({ ts: T, l: [["2956", "ES ▎DAZN"], ["77", "DEPORTES EVENTOS"]] }));
  const screen = await fresh("screen.js");
  let state = {};
  for (let i = 0; i < 6; i++) {
    const r = await screen.screenEvent({ name: "tick", state, lang: "es" });
    state = { ...state, ...(r && r.state) };
  }
  assert.deepEqual(w.log, ["feed data", "get_live_streams", "/player_api.php"], "the feed, the events row, then the liveness check");
});
