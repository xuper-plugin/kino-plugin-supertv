// The first open of a fresh install, in Kino's network and virtual time. The first tick runs the rolling race: the accounts
// of the picker's ranking (Spanish first, never a dead or blocked one) three at a time, never two of one host, 2.5 s each,
// the next starting as soon as one fails, within 9 s; the winner's feed loads in that same tick, so the Home paints right after
// it, and the health check runs only once the Home shows. When the race finds no account, the next tick runs the health check
// and picks the best-ranked account that answered, feed included; only when none answered does the manual picker show. A
// choice already made is never touched.
//
// Kino is modelled as on a device: it holds a call until every request the call sent has settled (the plugin does not set
// __kinoDropPendingFetches), runs a plugin's requests 6 at once, and waits the view's timer (1 s) before the next tick, or
// twice what the last one took when that is longer (PluginScreenSession.nextWait).
import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import { installKino, res, kinoError, param, fresh, virtualNet } from "./helpers/fake-kino.mjs";
import { keyOf, isDead } from "../src/panels.js";

const realNow = Date.now;
test.afterEach(() => { Date.now = realNow; });

const cats = [{ category_id: "2956", category_name: "ES ▎DAZN" }, { category_id: "3100", category_name: "MUNDIAL 2026" }];
const BOOT_MS = 500;
const FEED_MS = 300;
const PANEL = (u) => u.hostname !== "vegetatvv2.duckdns.org" && u.hostname !== "raw.githubusercontent.com";

// [accounts]: name -> { url, flag, b } in the service's order. How an account's live categories answer, [b]: a number (a
// good list after that many ms; over the request's timeoutMs it times out instead), { dead: ms } (auth 0), "hang" (until its
// timeout) or "down" (a network error after 200 ms). Every account has a feed on the data branch unless [noFeed].
function world({ accounts, storage, noFeed = false, start = Date.UTC(2026, 10, 17, 12) }) {
  const net = virtualNet({ start });
  Date.now = net.now;
  const names = Object.keys(accounts);
  const acc = Object.fromEntries(names.map((n, i) => [n, { username: "u" + i, password: "p" + i, ...accounts[n] }]));
  const listText = names.map((n) => `${acc[n].url}/get.php?username=${acc[n].username}&password=${acc[n].password} [${acc[n].flag}]`).join("\n");
  const log = [];
  const pending = new Set();
  const inFlight = { all: 0, max: 0, host: {}, maxHost: {} };
  // Every request the plugin sends: counted while in flight (panel hosts apart) and kept until it settles.
  const track = (u, p) => {
    const panel = PANEL(u);
    const h = u.hostname;
    if (panel) {
      inFlight.all++; inFlight.max = Math.max(inFlight.max, inFlight.all);
      inFlight.host[h] = (inFlight.host[h] || 0) + 1; inFlight.maxHost[h] = Math.max(inFlight.maxHost[h] || 0, inFlight.host[h]);
    }
    const q = p.then((v) => { if (panel) { inFlight.all--; inFlight.host[h]--; } pending.delete(q); return v; });
    pending.add(q);
    return q;
  };
  const k = installKino({ storage, routes: [(url, init) => {
    const u = new URL(url);
    const lim = (init && init.timeoutMs) || 15000;
    if (u.hostname === "vegetatvv2.duckdns.org") { log.push({ n: "boot", at: net.now() }); return track(u, net.request(BOOT_MS).then(() => res(200, { ok: true, servers_text: listText }))); }
    if (u.hostname === "raw.githubusercontent.com") {
      const file = u.pathname.split("/").pop();
      const v2 = file.endsWith(".v2.enc.json");
      const key = decodeURIComponent(file.replace(/(\.v2)?\.enc\.json$/, ""));
      log.push({ n: "feed", at: net.now(), key, v2 });
      const feed = Buffer.from(JSON.stringify({ v: 1, at: net.now(), serverKey: key, tabs: { all: [{ id: "lcat-2956", catId: "2956", title: "ES DAZN", items: [{ id: "live-201583", ref: "live:201583~2956~es.dazn~es.hd.dazn.1", title: "DAZN 1 HD", kind: "live" }] }] } }));
      const body = JSON.stringify({ v: v2 ? 2 : 1, iv: "AAAA", data: (v2 ? gzipSync(feed) : feed).toString("base64") });
      return track(u, net.request(FEED_MS).then(() => (noFeed ? res(404, "") : res(200, body))));
    }
    const n = names.find((x) => new URL(acc[x].url).hostname === u.hostname && acc[x].username === param(url, "username"));
    if (!n) return undefined;
    const action = param(url, "action");
    const e = { n, action, at: net.now(), timeoutMs: init && init.timeoutMs };
    log.push(e);
    const b = acc[n].b === undefined ? 1200 : acc[n].b;
    const timeout = () => net.request(lim).then(() => { e.end = net.now(); return kinoError("timeout", "timed out"); });
    if (action !== "get_live_categories") return track(u, net.request(400).then(() => res(200, [])));
    if (b === "hang") return track(u, timeout());
    if (b === "down") return track(u, net.request(200).then(() => { e.end = net.now(); return kinoError("network", "connection refused"); }));
    if (typeof b === "object") return track(u, b.dead > lim ? timeout() : net.request(b.dead).then(() => { e.end = net.now(); return res(200, { user_info: { auth: 0 } }); }));
    return track(u, b > lim ? timeout() : net.request(b).then(() => { e.end = net.now(); return res(200, cats); }));
  }] });
  k.kino.secret = () => "test-key";
  k.kino.crypto = {
    decrypt: (_alg, o) => (o.outputEncoding === "base64" ? o.data : Buffer.from(o.data, "base64").toString("utf8")),
    gunzip: (b64) => gunzipSync(Buffer.from(b64, "base64")).toString("utf8"),
  };
  // Kino answers a call only once every request it sent has settled.
  const drain = async () => { if (pending.size) await net.run(Promise.all([...pending])); };
  return { ...k, net, log, inFlight, acc, drain };
}

const srvs = (w) => JSON.parse(w.store.get("srvs"));
const probes = (w, from = 0) => w.log.slice(from).filter((e) => e.action === "get_live_categories");
const srvOf = (w, n) => ({ url: w.acc[n].url, username: w.acc[n].username, password: w.acc[n].password, name: w.acc[n].flag });
const keyOfAcc = (w, n) => keyOf(srvOf(w, n));

// The screen as Kino drives it. tick(): one tick event, held until its requests settle; `took` is what Kino measures.
// run(): open the screen and tick on Kino's timer until the Home shows a rail or the manual picker shows.
async function driver(w) {
  const screen = await fresh("screen.js");
  let state = {};
  const ticks = [];
  const view = async () => JSON.stringify(await screen.screen({ route: { name: "main" }, state, device: { kind: "phone" } }));
  const tick = async () => {
    const at = w.net.now();
    const from = w.log.length;
    const r = await w.net.run(screen.screenEvent({ name: "tick", state, lang: "es" }));
    state = { ...state, ...(r && r.state) };
    await w.drain();
    const t = { at, took: w.net.now() - at, requests: w.log.length - from, from };
    ticks.push(t);
    return t;
  };
  const sleep = (ms) => w.net.run(w.net.request(ms));
  const run = async (maxTicks = 8) => {
    const t0 = w.net.now();
    const timer = (v) => { const e = JSON.parse(v).every; return e ? e.ms : 1000; };
    let wait = timer(await view());
    for (let i = 0; i < maxTicks; i++) {
      await sleep(wait);
      const t = await tick();
      const v = await view();
      if (v.includes('"rail-lcat-')) return { kind: "home", at: w.net.now() - t0, ticks: i + 1 };
      if (v.includes('"fpPage"')) return { kind: "picker", at: w.net.now() - t0, ticks: i + 1 };
      wait = Math.max(timer(v), 2 * t.took);
    }
    return { kind: "none", at: w.net.now() - t0, ticks: maxTicks };
  };
  return { screen, tick, view, run, ticks };
}

// The device list of 2026-11-17: the top three Spanish accounts are two dead ones (auth 0 in about 1 s) and a host that times
// out, then working accounts.
const DEVICE = {
  cap: { url: "https://cap.example", flag: "🇪🇸", b: { dead: 1050 } },
  xiq: { url: "https://xiq.example", flag: "🇪🇸", b: { dead: 880 } },
  kri: { url: "https://kri.example", flag: "🇪🇸", b: "hang" },
  nex: { url: "https://nex.example", flag: "🇪🇸", b: 1000 },
  fv: { url: "https://fv.example", flag: "🇪🇸", b: "hang" },
  zee: { url: "https://zee.example", flag: "🇪🇸", b: 900 },
  us: { url: "https://us.example", flag: "🇺🇸", b: 300 },
};

test("D1, the device list: the race replaces each failed account and picks the working one in about 2 s; the Home paints in that tick", async () => {
  const w = world({ accounts: DEVICE });
  const d = await driver(w);
  assert.ok((await d.view()).includes('"verifying"'), "before the first tick");
  const out = await d.run();
  assert.equal(out.kind, "home");
  assert.equal(out.ticks, 1, "race, pick and feed in the first tick");
  const t = d.ticks[0];
  const race = probes(w);
  const raceStart = race[0].at;
  assert.equal(raceStart - t.at, BOOT_MS, "the race starts once the list is in");
  assert.deepEqual(race.slice(0, 3).map((e) => e.n), ["cap", "xiq", "kri"], "the top three of the ranking first, together");
  assert.ok(race.slice(0, 3).every((e) => e.at === raceStart));
  assert.equal(race[3].n, "nex", "the first failure (xiq, auth 0) is replaced by the next account at once");
  assert.equal(race[3].at - raceStart, 880);
  assert.equal(srvs(w).chosen, keyOfAcc(w, "nex"));
  assert.equal(w.store.get("srvChosen:v1"), "1");
  assert.ok(isDead(srvOf(w, "cap")) && isDead(srvOf(w, "xiq")), "the dead accounts are marked as before");
  const feed = w.log.filter((e) => e.n === "feed");
  assert.equal(feed.length, 1);
  assert.equal(feed[0].key, keyOfAcc(w, "nex"));
  assert.ok(feed[0].v2, "data's gzip copy (feed v2)");
  assert.ok(feed[0].at - raceStart <= 3000, `the winner after ${feed[0].at - raceStart} ms of race`);
  assert.ok(!race.some((e) => e.n === "us"), "no other account starts once there is a winner");
  // Kino's limits.
  assert.ok(race.every((e) => e.timeoutMs > 0 && e.timeoutMs <= 2500), String(race.map((e) => e.timeoutMs)));
  assert.ok(w.inFlight.max <= 3, JSON.stringify(w.inFlight));
  assert.ok(Object.values(w.inFlight.maxHost).every((m) => m <= 1), JSON.stringify(w.inFlight.maxHost));
  assert.ok(t.requests <= 60);
  // The hanging account holds Kino's call to its own 2.5 s timeout, never longer (it was 4 s: d1-device.md's open point 1).
  for (const e of race.filter((x) => x.n === "kri" || x.n === "fv")) assert.equal(e.end - e.at, e.timeoutMs);
  assert.equal(t.took, Math.max(...race.map((e) => e.end)) - t.at, "Kino releases the call when the last account settles");
  assert.equal(t.took, BOOT_MS + 1050 + 2500, "fv, started at 1.05 s when cap died, holds the call to its 2.5 s (nex won at 1.9 s)");
  assert.equal(out.at, 1000 + BOOT_MS + 1050 + 2500, "content 5.05 s after the open (1.5 s timer and 4 s tries: 7.05 s; 0.4.0 on the device: about 16 s)");
  // The health check comes after the Home's other units: the dead accounts are skipped, the choice stays.
  const n = w.log.length;
  for (let i = 0; i < 3 && !probes(w, n).length; i++) await d.tick();
  const health = probes(w, n).map((e) => e.n);
  assert.ok(!health.includes("cap") && !health.includes("xiq") && health.includes("zee"), health.join(","));
  assert.equal(srvs(w).chosen, keyOfAcc(w, "nex"));
});

test("a Spanish account still in flight wins over a faster foreign one; the foreign one wins only when it fails", async () => {
  for (const [es2, want] of [[2500, "es2"], ["hang", "us"]]) {
    const w = world({ accounts: {
      es1: { url: "https://a.example", flag: "🇲🇽", b: { dead: 600 } }, // dead after the foreign answer
      es2: { url: "https://b.example", flag: "🇪🇸", b: es2 },
      us: { url: "https://c.example", flag: "🇺🇸", b: 400 },
      us2: { url: "https://e.example", flag: "🇺🇸", b: 200 },
    } });
    const d = await driver(w);
    const t = await d.tick();
    assert.equal(srvs(w).chosen, keyOfAcc(w, want), String(es2));
    assert.ok(!probes(w).some((e) => e.n === "us2"), "nothing new starts while the answer waits for the Spanish account");
    assert.ok(t.took <= BOOT_MS + 2500 + FEED_MS, `took ${t.took}`);
  }
});

test("never two accounts of one host at once; a host that timed out is not asked again; no answer: the rescue finds none, the picker", async () => {
  const w = world({ accounts: {
    d: { url: "https://d.example", flag: "🇪🇸", b: { dead: 300 } },
    p1: { url: "http://p.example", flag: "🇪🇸", b: "hang" },
    p2: { url: "http://p.example", flag: "🇲🇽", b: "hang" },
    g: { url: "http://g.example", flag: "🇪🇸", b: "down" },
  } });
  const d = await driver(w);
  const t1 = await d.tick();
  const race = probes(w);
  assert.deepEqual(race.map((e) => e.n), ["d", "p1", "g"], "p2 waits for its host, then its host timed out: never asked");
  assert.equal(w.inFlight.maxHost["p.example"], 1);
  assert.equal(srvs(w).chosen, undefined);
  assert.ok(t1.took <= BOOT_MS + 2500, `nothing left to try: the race ends when p1 times out (${t1.took} ms)`);
  assert.ok((await d.view()).includes('"verifying"'), "no picker after the race alone");
  // The rescue: the health check (every usable account, the dead one skipped) with its automatic pick; nobody answers.
  const n = w.log.length;
  const t2 = await d.tick();
  assert.deepEqual(probes(w, n).map((e) => e.n).sort(), ["g", "p1", "p2"]);
  assert.ok(t2.took <= 16000, `the rescue keeps to one tick (${t2.took} ms)`);
  assert.equal(srvs(w).chosen, undefined);
  // The picker shows right after the rescue, its rows from the list in hand: no third tick behind Kino's doubled wait.
  assert.equal(w.log.length - n, t2.requests);
  const pick = await d.view();
  assert.ok(pick.includes('"fpPage"'), "the manual picker, only now, in the rescue's tick");
  assert.ok(!pick.includes("d.example"), "never the dead one");
  const t3 = await d.tick();
  assert.equal(t3.requests, 0, "nothing left to load");
  assert.equal(srvs(w).chosen, undefined, "nothing chosen for the person");
  assert.equal(w.store.get("srvChosen:v1"), undefined);
});

test("every raced account fails (dead, or slower than 2.5 s): the rescue picks the best-ranked account that answered, feed included, never the picker", async () => {
  const w = world({ accounts: {
    es1: { url: "https://a.example", flag: "🇪🇸", b: { dead: 900 } },
    es2: { url: "https://b.example", flag: "🇪🇸", b: { dead: 1000 } },
    es3: { url: "https://c.example", flag: "🇪🇸", b: 3600 },
    es4: { url: "https://e.example", flag: "🇲🇽", b: 3300 },
    us: { url: "https://f.example", flag: "🇺🇸", b: 3000 },
  } });
  const d = await driver(w);
  const out = await d.run();
  assert.equal(out.kind, "home", JSON.stringify(out));
  assert.equal(out.ticks, 2, "the race, then the rescue with its feed: one tick each");
  const [t1, t2] = d.ticks;
  const race = probes(w).filter((e) => e.at < t1.at + t1.took);
  assert.deepEqual(race.map((e) => e.n), ["es1", "es2", "es3", "es4", "us"], "each failure replaced in rank");
  assert.ok(race.every((e) => e.timeoutMs <= 2500));
  assert.ok(t1.took <= BOOT_MS + 9000, `the race keeps to its 9 s (${t1.took} ms)`);
  // The rescue tick: health check (es1 and es2 are dead, skipped) and the pick, no further probe, then the feed.
  const rescue = w.log.slice(t2.from);
  assert.deepEqual(rescue.filter((e) => e.action).map((e) => e.n).sort(), ["es3", "es4", "us"]);
  assert.ok(rescue.filter((e) => e.action).every((e) => e.timeoutMs > 2500), "the slow accounts get the health check's longer timeout");
  assert.equal(srvs(w).chosen, keyOfAcc(w, "es3"), "Spanish first, then by rank (es4 answered sooner)");
  assert.equal(w.store.get("srvChosen:v1"), "1");
  assert.deepEqual(rescue.filter((e) => e.n === "feed").map((e) => e.key), [keyOfAcc(w, "es3")], "the feed in the same tick");
  assert.ok(t2.took <= 16000, `the rescue tick took ${t2.took} ms`);
  assert.ok(out.at <= 30000, `content at ${out.at} ms (the old fallback showed the picker at about 57 s)`);
  // The health check just ran: it is not run again before the Home.
  const n = w.log.length;
  await d.tick();
  assert.equal(probes(w, n).length, 0);
});

test("the race keeps to its 9 s: a late account gets only the time left, none starts with under 1.5 s left, the tick ends with the deadline", async () => {
  // Ranked as listed (all Spanish, one host each), three lanes, 2.5 s tries. h1 and h2 hang to 2.5 s while d1 and d2 die at
  // 1.4 s each; at 2.5 s d3 and d4 start, at 2.8 s d5; at 3.9 s h3 and h4, at 4.2 s h5; at 6.4 s h6 and h7 (2.6 s left: their
  // full 2.5 s); at 6.7 s h8 with only 2.3 s left; at 8.9 s 0.1 s is left: nothing starts.
  const accounts = { h1: { url: "https://h1.example", flag: "🇪🇸", b: "hang" }, h2: { url: "https://h2.example", flag: "🇪🇸", b: "hang" } };
  for (let i = 1; i <= 5; i++) accounts["d" + i] = { url: `https://d${i}.example`, flag: "🇪🇸", b: { dead: 1400 } };
  for (let i = 3; i <= 9; i++) accounts["h" + i] = { url: `https://h${i}.example`, flag: "🇪🇸", b: "hang" };
  accounts.slow = { url: "https://slow.example", flag: "🇪🇸", b: 2000 };
  const w = world({ accounts });
  const d = await driver(w);
  const t1 = await d.tick();
  const race = probes(w);
  const raceStart = race[0].at;
  assert.deepEqual(race.map((e) => e.n), ["h1", "h2", "d1", "d2", "d3", "d4", "d5", "h3", "h4", "h5", "h6", "h7", "h8"]);
  assert.equal(race.find((e) => e.n === "h8").timeoutMs, 2300, "the last account started gets only the time left");
  assert.ok(race.every((e) => e.at - raceStart <= 9000 - 1500), "none starts with less than 1.5 s left");
  assert.ok(race.every((e) => e.end - raceStart <= 9000), String(race.map((e) => e.n + "@" + (e.end - raceStart))));
  assert.equal(t1.took, BOOT_MS + 9000, "Kino holds the call to the race's deadline, never past it");
  assert.equal(srvs(w).chosen, undefined);
  // The rescue: six hang to 10 s, then the next ones get the 3 s left; the slow account answers and is chosen.
  const t2 = await d.tick();
  assert.equal(srvs(w).chosen, keyOfAcc(w, "slow"));
  assert.ok(t2.took <= 16000, `the rescue tick took ${t2.took} ms`);
  assert.ok(w.log.slice(t2.from).some((e) => e.n === "feed"), "the feed in the rescue's tick");
});

test("no account answers at all: the picker shows right after the rescue, with no further doubled wait", async () => {
  const accounts = {};
  for (let i = 1; i <= 12; i++) accounts["h" + i] = { url: `https://h${i}.example`, flag: "🇪🇸", b: "hang" };
  const w = world({ accounts });
  const d = await driver(w);
  const out = await d.run();
  assert.equal(out.kind, "picker");
  assert.equal(out.ticks, 2, "the race, then the rescue, which also reads the picker's rows");
  assert.ok(out.at <= 45000, `the picker at ${out.at} ms (with a third tick for its rows: 66 s; the fixed race of three: 58.5 s)`);
});

test("no feed for the account: the Home loads live first, and the health check only after it", async () => {
  const w = world({ noFeed: true, accounts: {
    d: { url: "https://d.example", flag: "🇪🇸", b: "down" },
    h: { url: "http://p.example", flag: "🇪🇸", b: 900 },
    g: { url: "http://p.example", flag: "🇲🇽", b: 300 },
    g2: { url: "http://q.example", flag: "🇪🇸", b: 1500 },
  } });
  const d = await driver(w);
  await d.tick();
  assert.equal(srvs(w).chosen, keyOfAcc(w, "h"), "h answered first (g shares its host and never started)");
  assert.ok(!(await d.view()).includes('"verifying"'), "the account answered: a loading Home, not 'Verificando…'");
  const order = [];
  for (let i = 0; i < 4; i++) { const n = w.log.length; await d.tick(); order.push(...w.log.slice(n).filter((e) => e.action).map((e) => e.action)); }
  const firstHealth = order.indexOf("get_live_categories");
  assert.ok(firstHealth > 0, order.join(","));
  assert.equal(order.slice(0, firstHealth).filter((a) => a === "get_live_streams").length, cats.length, "both Home rows first: " + order.join(","));
});

test("a server the person chose is never raced or replaced", async () => {
  const start = Date.UTC(2026, 10, 17, 12);
  const accounts = {
    d: { url: "https://d.example", flag: "🇪🇸" },
    h: { url: "http://p.example", flag: "🇪🇸" },
    g2: { url: "http://q.example", flag: "🇪🇸" },
    us: { url: "http://r.example", flag: "🇺🇸" },
  };
  const probe = world({ accounts, start });
  const list = Object.keys(accounts).map((n) => srvOf(probe, n));
  const st = { ts: start, list, idx: 3, ok: true, okAt: start, chosen: keyOf(list[2]), mig: 1, v: 2 };
  const w = world({ accounts, storage: { srvs: JSON.stringify(st), "srvChosen:v1": "1" }, start });
  const cat = await fresh("catalog.js");
  const r = await w.net.run(cat.autoPickServer());
  assert.ok(r.ok && r.kept);
  assert.equal(w.log.length, 0, "no request");
  assert.equal(srvs(w).chosen, keyOf(list[2]));
  const d = await driver(w);
  await d.tick();
  assert.equal(probes(w).length, 0, "the first tick loads the feed, no race");
  assert.equal(w.log[0].n, "feed");
  assert.equal(srvs(w).chosen, keyOf(list[2]));
  assert.equal(srvs(w).idx, 3);
  // Even with the flag lost and only the stored choice left, nothing is raced.
  w.store.delete("srvChosen:v1");
  const d2 = await driver(w);
  const n = w.log.length;
  await d2.tick();
  // The snapshot is there now, so this tick also runs the events row: its categories, from the chosen account (backHome
  // returns there), never a race over the ranking.
  assert.ok(probes(w, n).every((e) => e.n === "g2"), probes(w, n).map((e) => e.n).join(","));
  assert.equal(srvs(w).chosen, keyOf(list[2]));
  // A health check asked to pick never replaces a choice either.
  await w.net.run(cat.healthCheck({ pick: true }));
  assert.equal(srvs(w).chosen, keyOf(list[2]));
});
