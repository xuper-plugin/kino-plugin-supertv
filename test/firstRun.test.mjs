// The first open of a fresh install, in Kino's network and virtual time: the first tick races the top three accounts of the
// picker's ranking at once (4 s each, never more than Kino's per-host limit), chooses the first that answers well (never a
// dead one), and loads the feed in that same tick, so the Home paints right after it; the health check runs only once the
// Home shows. When no account answers, the health check and the manual picker follow. A choice already made is never touched.
import test from "node:test";
import assert from "node:assert/strict";
import { installKino, res, kinoError, param, fresh, virtualNet } from "./helpers/fake-kino.mjs";
import { keyOf } from "../src/panels.js";

const realNow = Date.now;
test.afterEach(() => { Date.now = realNow; });

const cats = [{ category_id: "2956", category_name: "ES ▎DAZN" }, { category_id: "3100", category_name: "MUNDIAL 2026" }];
// The service's list (https first, as the bootstrap's list is sorted): three panels; d, h and g are the top three of the
// ranking (Spanish and Mexican first, by list order); h and g are two accounts of one panel host.
const ACC = {
  d: { url: "https://d.example", username: "ud", password: "pd", name: "🇪🇸" },
  h: { url: "http://p.example", username: "uh", password: "ph", name: "🇪🇸" },
  g: { url: "http://p.example", username: "ug", password: "pg", name: "🇲🇽" },
  g2: { url: "http://q.example", username: "u2", password: "p2", name: "🇪🇸" },
  us: { url: "http://r.example", username: "uu", password: "pu", name: "🇺🇸" },
};
const NAMES = Object.keys(ACC);
const listText = NAMES.map((n) => `${ACC[n].url}/get.php?username=${ACC[n].username}&password=${ACC[n].password} [${ACC[n].name}]`).join("\n");

// [behave]: per account, how its live categories answer: "ok" (after [ms]), "dead" (auth 0), "hang" (until its timeout),
// "down" (a network error). Feeds exist on the data branch for every account.
function world({ behave, storage, start = Date.UTC(2026, 10, 17, 12) }) {
  const net = virtualNet({ start });
  Date.now = net.now;
  const log = [];
  const inFlight = { all: 0, max: 0, host: {}, maxHost: 0 };
  const track = (host, p) => {
    inFlight.all++; inFlight.max = Math.max(inFlight.max, inFlight.all);
    inFlight.host[host] = (inFlight.host[host] || 0) + 1; inFlight.maxHost = Math.max(inFlight.maxHost, inFlight.host[host]);
    return p.then((v) => { inFlight.all--; inFlight.host[host]--; return v; });
  };
  const k = installKino({ storage, routes: [(url, init) => {
    const u = new URL(url);
    if (u.hostname === "vegetatvv2.duckdns.org") { log.push({ n: "boot", at: net.now() }); return track(u.hostname, net.request(500).then(() => res(200, { ok: true, servers_text: listText }))); }
    if (u.hostname === "raw.githubusercontent.com") {
      const key = decodeURIComponent(u.pathname.split("/").pop().replace(/\.enc\.json$/, ""));
      log.push({ n: "feed", at: net.now(), key });
      const feed = { v: 1, at: net.now(), serverKey: key, tabs: { all: [{ id: "lcat-2956", catId: "2956", title: "ES DAZN", items: [{ id: "live-201583", ref: "live:201583~2956~es.dazn~es.hd.dazn.1", title: "DAZN 1 HD", kind: "live" }] }] } };
      return track(u.hostname, net.request(300).then(() => res(200, JSON.stringify({ v: 1, iv: "AAAA", data: Buffer.from(JSON.stringify(feed)).toString("base64") }))));
    }
    const n = NAMES.find((x) => new URL(ACC[x].url).hostname === u.hostname && ACC[x].username === param(url, "username"));
    if (!n) return undefined;
    const action = param(url, "action");
    log.push({ n, action, at: net.now(), timeoutMs: init && init.timeoutMs });
    const b = behave[n] || "ok";
    if (action !== "get_live_categories") return track(u.hostname, net.request(400).then(() => res(200, [])));
    if (b === "dead") return track(u.hostname, net.request(300).then(() => res(200, { user_info: { auth: 0 } })));
    if (b === "hang") return track(u.hostname, net.request((init && init.timeoutMs) || 15000).then(() => kinoError("timeout", "timed out")));
    if (b === "down") return track(u.hostname, net.request(200).then(() => kinoError("network", "connection refused")));
    return track(u.hostname, net.request(typeof b === "number" ? b : 1200).then(() => res(200, cats)));
  }] });
  k.kino.secret = () => "test-key";
  k.kino.crypto = { decrypt: (_alg, o) => Buffer.from(o.data, "base64").toString("utf8") };
  return { ...k, net, log, inFlight };
}

const srvs = (w) => JSON.parse(w.store.get("srvs"));
const probes = (w, from = 0) => w.log.slice(from).filter((e) => e.action === "get_live_categories");

async function driver(w) {
  const screen = await fresh("screen.js");
  let state = {};
  const tick = async () => { const r = await w.net.run(screen.screenEvent({ name: "tick", state, lang: "es" })); state = { ...state, ...(r && r.state) }; };
  const view = async () => JSON.stringify(await screen.screen({ route: { name: "main" }, state, device: { kind: "phone" } }));
  return { screen, tick, view };
}

test("first tick: the top three race at once, the first good answer wins (never the dead one), the feed paints; health after", async () => {
  const w = world({ behave: { d: "dead", h: "hang", g: 1200 } });
  const d = await driver(w);
  assert.ok((await d.view()).includes('"verifying"'), "before the first tick");
  const t0 = w.net.now();
  await d.tick();
  const race = probes(w);
  assert.deepEqual(race.map((e) => e.n).sort(), ["d", "g", "h"], "the top three of the ranking, nothing else (no health check)");
  assert.equal(new Set(race.map((e) => e.at)).size, 1, "asked together");
  assert.ok(race.every((e) => e.timeoutMs > 0 && e.timeoutMs <= 4000), String(race.map((e) => e.timeoutMs)));
  assert.ok(w.inFlight.maxHost <= 4 && w.inFlight.max <= 6, JSON.stringify(w.inFlight));
  assert.equal(srvs(w).chosen, keyOf(ACC.g), "the first account that answered well");
  assert.notEqual(srvs(w).list[srvs(w).idx].username, "ud");
  assert.equal(w.store.get("srvChosen:v1"), "1");
  const feed = w.log.filter((e) => e.n === "feed");
  assert.equal(feed.length, 1);
  assert.equal(feed[0].key, keyOf(ACC.g));
  assert.ok(feed[0].at >= race[0].at + 1200, "the feed comes after the winner, in the same tick");
  assert.ok(w.net.now() - t0 < 4000, `content after ${w.net.now() - t0} ms (a hanging account does not hold it)`);
  const home = await d.view();
  assert.ok(home.includes("rail-lcat-2956") && home.includes('"live:201583~2956~es.dazn~es.hd.dazn.1"'), "the Home paints from the feed");
  assert.ok(!home.includes('"verifying"'));
  // The next tick runs the health check (every usable account; the dead one is marked and skipped).
  const n = w.log.length;
  await d.tick();
  const health = probes(w, n).map((e) => e.n).sort();
  assert.deepEqual(health, ["g", "g2", "h", "us"]);
  assert.equal(srvs(w).chosen, keyOf(ACC.g), "the health check keeps the choice");
});

test("no feed for the account: the Home loads live first, and the health check only after it", async () => {
  const w = world({ behave: { d: "down", h: 900, g: 300 } });
  const d = await driver(w);
  w.kino.crypto = { decrypt: () => { throw new Error("no feed key"); } }; // every feed copy is unusable
  await d.tick();
  assert.equal(srvs(w).chosen, keyOf(ACC.g), "g answered first");
  assert.ok(!(await d.view()).includes('"verifying"'), "the account answered: a loading Home, not 'Verificando…'");
  const order = [];
  for (let i = 0; i < 4; i++) { const n = w.log.length; await d.tick(); order.push(...w.log.slice(n).filter((e) => e.action).map((e) => e.action)); }
  const firstHealth = order.indexOf("get_live_categories");
  assert.ok(firstHealth > 0, order.join(","));
  assert.equal(order.slice(0, firstHealth).filter((a) => a === "get_live_streams").length, cats.length, "both Home rows first: " + order.join(","));
});

test("when none of the three answers: the health check runs, then the manual picker with the servers that answer", async () => {
  const w = world({ behave: { d: "dead", h: "hang", g: "down" } });
  const d = await driver(w);
  await d.tick();
  assert.equal(srvs(w).chosen, undefined);
  assert.equal(w.store.get("srvChosen:v1"), undefined);
  assert.ok(!w.log.some((e) => e.n === "feed"));
  assert.ok((await d.view()).includes('"verifying"'));
  const n = w.log.length;
  await d.tick(); // health
  assert.deepEqual(probes(w, n).map((e) => e.n).sort(), ["g", "g2", "h", "us"], "every usable account (the dead one skipped)");
  await d.tick(); // the picker's list
  const pick = await d.view();
  assert.ok(pick.includes('"fpPage"'), "the manual picker");
  assert.ok(pick.includes("q.example") && pick.includes("r.example"), "the servers that answer");
  assert.ok(!pick.includes("d.example"), "never the dead one");
  assert.equal(srvs(w).chosen, undefined, "nothing chosen for the person");
});

test("a server the person chose is never raced or replaced", async () => {
  const start = Date.UTC(2026, 10, 17, 12);
  const list = NAMES.map((n) => ACC[n]);
  const st = { ts: start, list, idx: 3, ok: true, okAt: start, chosen: keyOf(ACC.g2), mig: 1, v: 2 };
  const w = world({ behave: {}, storage: { srvs: JSON.stringify(st), "srvChosen:v1": "1" }, start });
  const cat = await fresh("catalog.js");
  const r = await w.net.run(cat.autoPickServer());
  assert.ok(r.ok && r.kept);
  assert.equal(w.log.length, 0, "no request");
  assert.equal(srvs(w).chosen, keyOf(ACC.g2));
  const d = await driver(w);
  await d.tick();
  assert.equal(probes(w).length, 0, "the first tick loads the feed, no race");
  assert.equal(w.log[0].n, "feed");
  assert.equal(srvs(w).chosen, keyOf(ACC.g2));
  assert.equal(srvs(w).idx, 3);
  // Even with the flag lost and only the stored choice left, nothing is raced.
  w.store.delete("srvChosen:v1");
  const d2 = await driver(w);
  const n = w.log.length;
  await d2.tick();
  assert.equal(probes(w, n).length, 0);
  assert.equal(srvs(w).chosen, keyOf(ACC.g2));
});
