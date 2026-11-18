// The screen's health check, in Kino's network and virtual time: off the Home's path (its last unit), in ticks of six
// accounts at once, so a channel tapped meanwhile waits for one short tick at most. Most rounds only ask each account if it
// is alive (player_api.php with no action, 3 s); once the panel map is 18 h old a round downloads each account's live
// categories (5 s) and groups the panels again, because the failover moves a channel within a panel only to accounts
// confirmed in the last 24 h. The result is good for 6 h.
import test from "node:test";
import assert from "node:assert/strict";
import { installKino, res, kinoError, param, fresh, virtualNet } from "./helpers/fake-kino.mjs";
import { keyOf } from "../src/panels.js";

const realNow = Date.now;
test.afterEach(() => { Date.now = realNow; });
const H = 3600000;
const cats = Array.from({ length: 12 }, (_, i) => ({ category_id: String(100 + i), category_name: "CAT " + i }));

// 30 accounts, one host each; every third one hangs ([hangAll]: every one). [panelsAt]: when the stored panel map was written
// (null: none), with [members] (keys) confirmed then. [healthAt]: a stored health result of that time, every account online.
function world({ panelsAt = null, n = 30, healthAt = null, hangAll = false, members = [] } = {}) {
  const start = Date.UTC(2026, 10, 18, 12);
  const net = virtualNet({ start });
  Date.now = net.now;
  const list = Array.from({ length: n }, (_, i) => ({ url: `http://h${i}.example`, username: "u" + i, password: "p" + i, name: "🇪🇸" }));
  const hang = (u) => hangAll || Number(u.hostname.slice(1).split(".")[0]) % 3 === 0;
  const log = [];
  const pending = new Set();
  const g = Object.fromEntries(members.map((m) => [m, "P1"]));
  const t = Object.fromEntries(members.map((m) => [m, panelsAt]));
  const k = installKino({ storage: {
    srvs: JSON.stringify({ ts: start, list, idx: 1, ok: true, okAt: start, chosen: keyOf(list[1]), mig: 1, v: 2 }),
    "srvChosen:v1": "1",
    ...(panelsAt !== null ? { "panels:v1": JSON.stringify({ v: 1, at: panelsAt, g, t }) } : {}),
    ...(healthAt !== null ? { "health:v1": JSON.stringify({ ts: healthAt, online: list.map((s) => s.url) }) } : {}),
  }, routes: [(url, init) => {
    const u = new URL(url);
    const action = param(url, "action");
    const e = { host: u.hostname, action, at: net.now(), timeoutMs: init && init.timeoutMs };
    log.push(e);
    const lim = (init && init.timeoutMs) || 15000;
    const p = hang(u) ? net.request(lim).then(() => kinoError("timeout", "t"))
      : net.request(600).then(() => (action === null ? res(200, { user_info: { auth: 1, status: "Active" }, server_info: {} }) : res(200, cats)));
    const q = p.then((v) => { pending.delete(q); return v; });
    pending.add(q);
    return q;
  }] });
  const drain = async () => { if (pending.size) await net.run(Promise.all([...pending])); };
  return { ...k, net, log, list, drain, start };
}

// Runs healthStep ticks as Kino would hold them (until every request settles) until the result is written.
async function round(w, cat) {
  const ticks = [];
  for (let i = 0; i < 20 && !w.store.get("health:v1"); i++) {
    const t0 = w.net.now();
    const from = w.log.length;
    await w.net.run(cat.healthStep());
    await w.drain();
    ticks.push({ took: w.net.now() - t0, requests: w.log.length - from });
  }
  return ticks;
}

test("panels confirmed lately: a liveness round, six accounts a tick, 3 s each, written once at the end", async () => {
  const w = world({ panelsAt: Date.UTC(2026, 10, 18, 2) }); // 10 h old
  const cat = await fresh("catalog.js");
  const ticks = await round(w, cat);
  assert.equal(ticks.length, 5);
  assert.ok(ticks.every((t) => t.requests === 6 && t.took <= 3000), JSON.stringify(ticks));
  assert.ok(w.log.every((e) => e.action === null && e.timeoutMs === 3000), "player_api.php with no action");
  assert.deepEqual(w.log.slice(0, 2).map((e) => e.host), ["h1.example", "h0.example"], "the active and chosen account first");
  const h = JSON.parse(w.store.get("health:v1"));
  assert.equal(h.online.length, 20);
  assert.equal(JSON.parse(w.store.get("panels:v1")).at, Date.UTC(2026, 10, 18, 2), "the panel map is left as it was");
  assert.ok(cat.healthReady());
  // Fresh for 6 h: nothing more until then.
  await w.net.run(w.net.request(6 * H - 20000));
  assert.ok(cat.healthReady());
  await w.net.run(w.net.request(30000));
  assert.ok(!cat.healthReady(), "stale after 6 h");
});

test("a panel map 18 h old (or none): the round downloads live categories, 5 s each, and groups the panels again", async () => {
  for (const panelsAt of [null, Date.UTC(2026, 10, 17, 17)]) {
    const w = world({ panelsAt });
    const cat = await fresh("catalog.js");
    const ticks = await round(w, cat);
    assert.equal(ticks.length, 5);
    assert.ok(ticks.every((t) => t.took <= 5000), JSON.stringify(ticks));
    assert.ok(w.log.every((e) => e.action === "get_live_categories" && e.timeoutMs === 5000));
    const map = JSON.parse(w.store.get("panels:v1"));
    assert.equal(map.at, w.net.now());
    assert.equal(Object.keys(map.t).length, 20, "every account that answered is confirmed now");
  }
});

test("a tick a channel tap could wait behind: at most 3 s, against up to 15 s for the old one-call check", async () => {
  const w = world({ panelsAt: Date.UTC(2026, 10, 18, 2) });
  const cat = await fresh("catalog.js");
  const ticks = await round(w, cat);
  assert.equal(Math.max(...ticks.map((t) => t.took)), 3000);
  // The first run's rescue still checks every account in one call.
  const w2 = world({ panelsAt: Date.UTC(2026, 10, 18, 2) });
  const cat2 = await fresh("catalog.js");
  const t0 = w2.net.now();
  await w2.net.run(cat2.healthCheck());
  await w2.drain();
  assert.ok(w2.net.now() - t0 > 10000, String(w2.net.now() - t0));
});

test("no server list at all (bootstrap down, none stored): the step ends the check instead of asking every second", async () => {
  const start = Date.UTC(2026, 10, 18, 12);
  Date.now = () => start;
  const k = installKino({ routes: [() => kinoError("network", "down")] });
  const cat = await fresh("catalog.js");
  await cat.healthStep();
  assert.ok(cat.healthReady());
  const n = k.requests.length;
  assert.ok(n >= 1 && n <= 2, String(n));
  await cat.healthStep();
  assert.equal(k.requests.length, n * 2, "a direct call still tries");
});

// The screen's ticks until the check is ready (Kino holds each one until its requests settle).
async function untilReady(w, cat) {
  const ticks = [];
  for (let i = 0; i < 20 && !cat.healthReady(); i++) {
    const t0 = w.net.now();
    const from = w.log.length;
    await w.net.run(cat.healthStep());
    await w.drain();
    ticks.push({ took: w.net.now() - t0, requests: w.log.length - from });
  }
  return ticks;
}

test("a panel map 18 h old with a health result still fresh: the full round runs anyway, before the 24 h confirmations lapse", async () => {
  // Checked 1 h ago (a liveness round: fresh for 5 more hours) while the map was 18 h old; it is 19 h old now. Waiting for the
  // health result to age would put the full round at 24 h at best, when the failover's same-panel step has no member left.
  const w = world({ panelsAt: Date.UTC(2026, 10, 17, 17), healthAt: Date.UTC(2026, 10, 18, 11) });
  const cat = await fresh("catalog.js");
  assert.ok(!cat.healthReady(), "the full round is due");
  const ticks = await untilReady(w, cat);
  assert.equal(ticks.length, 5);
  assert.ok(w.log.every((e) => e.action === "get_live_categories"));
  const map = JSON.parse(w.store.get("panels:v1"));
  assert.equal(map.at, w.net.now());
  assert.equal(Object.keys(map.t).length, 20);
});

test("a full round nothing answered leaves the panel map as it was and is tried again in 30 min, not on every tick", async () => {
  const members = ["m1", "m2", "m3"];
  const panelsAt = Date.UTC(2026, 10, 17, 17);
  const w = world({ panelsAt, healthAt: Date.UTC(2026, 10, 18, 11), hangAll: true, members });
  const cat = await fresh("catalog.js");
  const before = w.store.get("panels:v1");
  const ticks = await untilReady(w, cat);
  assert.equal(ticks.length, 5);
  assert.equal(w.store.get("panels:v1"), before, "no account confirmed: the members keep their own confirmation time");
  assert.ok(cat.healthReady(), "not again at once");
  const n = w.log.length;
  await w.net.run(w.net.request(29 * 60000));
  assert.ok(cat.healthReady());
  await w.net.run(w.net.request(2 * 60000));
  assert.ok(!cat.healthReady(), "tried again after 30 min");
  assert.equal(w.log.length, n);
});
