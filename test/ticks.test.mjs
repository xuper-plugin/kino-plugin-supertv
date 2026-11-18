// The screen's tick scheduler, driven the way Kino drives it, in virtual time: the open render, then ticks on the view's own
// timer (1 s), each wait twice what the last tick took when that is longer (PluginScreenSession.nextWait), each tick held
// until its requests settle. Cheap units share a tick while it stays under 1.2 s; the tab's first content paints at once;
// a heavy unit (the health check, a tab's live rows) never starts after a unit that changed the screen, and ends its tick.
import test from "node:test";
import assert from "node:assert/strict";
import { installKino, res, kinoError, param, fresh, virtualNet } from "./helpers/fake-kino.mjs";
import { keyOf } from "../src/panels.js";

const realNow = Date.now;
test.afterEach(() => { Date.now = realNow; });
const H = 3600000;

// 30 accounts (every third hangs), the second one chosen; a feed on `data` unless [noFeed]; a snapshot when [snapshot];
// health 7 h old (a liveness round is due), the panel map 2 h old. Panel answers take 600 ms, GitHub's 300 ms.
async function world({ snapshot = false, noFeed = false } = {}) {
  const start = Date.UTC(2026, 10, 18, 12);
  const net = virtualNet({ start });
  Date.now = net.now;
  const list = Array.from({ length: 30 }, (_, i) => ({ url: `http://h${i}.example`, username: "u" + i, password: "p" + i, name: "🇪🇸" }));
  const key = keyOf(list[1]);
  const card = (i, t) => ({ id: "live-" + i, ref: `live:${i}~2956~es.dazn~`, title: t + i, kind: "live" });
  const rails = (t, n, per) => Array.from({ length: n }, (_, r) => ({ id: "lcat-" + (2000 + r), catId: String(2000 + r), title: "R" + r, items: Array.from({ length: per }, (_, i) => card(r * 100 + i, t)) }));
  const feed = { v: 1, at: start, serverKey: key, tabs: { all: rails("FRESH ", 12, 20) } };
  const storage = {
    srvs: JSON.stringify({ ts: start, list, idx: 1, ok: true, okAt: start, chosen: key, mig: 1, v: 2 }),
    "srvChosen:v1": "1",
    "health:v1": JSON.stringify({ ts: start - 7 * H, online: list.map((s) => s.url) }),
    "panels:v1": JSON.stringify({ v: 1, at: start - 2 * H, g: {}, t: {} }),
    ["cats:live:" + key]: JSON.stringify({ ts: start, l: [["77", "DEPORTES EVENTOS"], ...Array.from({ length: 12 }, (_, i) => [String(300 + i), "ES ▎CANALES " + i])] }),
    // The last session's snapshot, packed as screen.js stores it: a rail { c, t, i }, a card [ref, title].
    ...(snapshot ? { ["homeSnap:v3:" + key]: JSON.stringify({ v: 3, at: start - H, tabs: { all: rails("SNAP ", 6, 6).map((r) => ({ c: r.catId, t: r.title, i: r.items.map((c) => [c.ref, c.title]) })) } }) } : {}),
  };
  const pending = new Set();
  const log = [];
  const k = installKino({ storage, routes: [(url, init) => {
    const u = new URL(url);
    const lim = (init && init.timeoutMs) || 15000;
    const track = (p) => { const q = p.then((v) => { pending.delete(q); return v; }); pending.add(q); return q; };
    if (u.hostname === "raw.githubusercontent.com") {
      log.push({ at: net.now(), n: "feed" });
      const body = JSON.stringify({ v: 1, iv: "AAAA", data: Buffer.from(JSON.stringify(feed)).toString("base64") });
      return track(net.request(300).then(() => (u.pathname.includes("/data/") && !noFeed ? res(200, body) : res(404, ""))));
    }
    const action = param(url, "action");
    log.push({ at: net.now(), n: action || "ping", cat: param(url, "category_id") });
    if (Number(u.hostname.slice(1).split(".")[0]) % 3 === 0) return track(net.request(lim).then(() => kinoError("timeout", "t")));
    if (action === "get_live_streams") return track(net.request(600).then(() => res(200, Array.from({ length: 30 }, (_, i) => ({ stream_id: 9000 + i, name: (param(url, "category_id") === "77" ? "EVENTO " : "LIVE ") + i })))));
    return track(net.request(600).then(() => res(200, { user_info: { auth: 1 } })));
  }] });
  k.kino.secret = () => "k";
  k.kino.crypto = { decrypt: (_a, o) => Buffer.from(o.data, "base64").toString("utf8") };
  const screen = await fresh("screen.js");
  let state = {};
  const view = async () => JSON.stringify(await screen.screen({ route: { name: "main" }, state, device: { kind: "phone" } }));
  // Opens the screen and runs Kino's timer until it stops; when each mark first shows, and every tick.
  async function run(marks) {
    const t0 = net.now();
    const r0 = await screen.screenEvent({ name: "open", route: { name: "main" }, state, lang: "es" });
    state = { ...state, ...(r0 && r0.state) };
    let v = await view();
    const seen = Object.fromEntries(Object.entries(marks).map(([m, text]) => [m, v.includes(text) ? 0 : null]));
    const ticks = [];
    for (let i = 0; i < 30; i++) {
      const ev = JSON.parse(v).every;
      if (!ev) break;
      await net.run(net.request(Math.max(ev.ms, ticks.length ? 2 * ticks.at(-1).took : 0)));
      const a = net.now();
      const from = log.length;
      const r = await net.run(screen.screenEvent({ name: ev.event, state, lang: "es" }));
      state = { ...state, ...(r && r.state) };
      if (pending.size) await net.run(Promise.all([...pending]));
      ticks.push({ at: a - t0, took: net.now() - a, req: log.slice(from).map((e) => e.n) });
      v = await view();
      for (const [m, text] of Object.entries(marks)) if (seen[m] === null && v.includes(text)) seen[m] = net.now() - t0;
    }
    return { seen, ticks, every: ticks.length };
  }
  const render = async (device) => screen.screen({ route: { name: "main" }, state, device: { kind: device } });
  return { run, log, render };
}

// Kino's count: every node object (it has a type) of the tree.
const nodes = (o) => { if (!o || typeof o !== "object") return 0; let n = typeof o.type === "string" ? 1 : 0; for (const x of Array.isArray(o) ? o : Object.values(o)) n += nodes(x); return n; };

test("a warm open (last session's snapshot on screen): the feed and the events row share the first tick, 1 s after the open", async () => {
  const w = await world({ snapshot: true });
  const { seen, ticks } = await w.run({ snap: "SNAP ", fresh: "FRESH ", events: "EVENTO " });
  assert.equal(seen.snap, 0);
  assert.equal(ticks[0].at, 1000, "the 1 s timer");
  assert.deepEqual(ticks[0].req, ["feed", "get_live_streams"], "feed and events in one tick");
  assert.equal(seen.fresh, 1900);
  assert.equal(seen.events, 1900, "with one unit a tick and a 1.5 s timer: 3.9 s");
  // Then the liveness round, six accounts a tick, never more than 3 s each.
  assert.ok(ticks.slice(1).every((t) => t.req.every((n) => n === "ping") && t.took <= 3000), JSON.stringify(ticks));
});

test("a cold open (no snapshot): the feed paints alone at once, the events row in the next tick", async () => {
  const w = await world();
  const { seen, ticks } = await w.run({ fresh: "FRESH ", events: "EVENTO " });
  assert.deepEqual(ticks[0].req, ["feed"]);
  assert.equal(seen.fresh, 1300, "1.8 s with a 1.5 s timer");
  assert.deepEqual(ticks[1].req, ["get_live_streams"]);
  assert.equal(seen.events, 2900, "3.9 s before");
});

test("no feed: the feed's misses, the categories and the tab's rows in one tick, its rows 4 at a time", async () => {
  const w = await world({ noFeed: true });
  const { seen, ticks } = await w.run({ live: "LIVE " });
  assert.deepEqual(ticks[0].req.slice(0, 2), ["feed", "feed"]);
  assert.equal(ticks[0].req.filter((n) => n === "get_live_streams").length, 12);
  assert.equal(ticks[0].took, 600 + 3 * 600, "three rounds of four rows");
  assert.equal(seen.live, 1000 + 2400, "7.5 s before (one unit a tick, rows 3 at a time)");
});

test("the Home fits Kino's 600 nodes: the events row and all 12 feed rails, 12 channels each (20 before: about 870 nodes)", async () => {
  const w = await world({ snapshot: true });
  await w.run({});
  for (const device of ["phone", "tv"]) {
    const tree = await w.render(device);
    const text = JSON.stringify(tree);
    assert.ok(nodes(tree) <= 600, device + ": " + nodes(tree));
    assert.equal((text.match(/"rail-lcat-[0-9]+"/g) || []).length, 13, "the events row and the feed's 12 rails");
    assert.equal((text.match(/"ch-rail-lcat-2000-[0-9]+"/g) || []).length, 12);
  }
});
