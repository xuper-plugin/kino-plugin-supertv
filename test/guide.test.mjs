// The guide in Kino's network and virtual time. Native En vivo asks the guide of a category's first 40 visible channels in
// one call, before the categories and the channels, which wait behind it on the plugin's single call lane
// (LiveViewModel.load -> requestEpg). A call asks only the first 12, on the active account alone, with one backHome, 4 at
// once (Kino's per-host limit), each request within 3 s and the whole call within 4 s.
import test from "node:test";
import assert from "node:assert/strict";
import { installKino, res, kinoError, param, fresh, virtualNet } from "./helpers/fake-kino.mjs";
import { keyOf } from "../src/panels.js";

const realNow = Date.now;
test.afterEach(() => { Date.now = realNow; });

const A = { url: "http://a.example", username: "ua", password: "pa", name: "🇪🇸" };
const B = { url: "http://b.example", username: "ub", password: "pb", name: "🇪🇸" };
const b64 = (s) => Buffer.from(s).toString("base64");

// [epg]: ms until the active account answers each get_short_epg, or "hang" (until its timeout); [chosen]: B chosen while A
// is active (backHome's case).
function world({ epg = 300, chosen = false } = {}) {
  const start = Date.UTC(2026, 10, 17, 20);
  const net = virtualNet({ start, parallel: 6 });
  Date.now = net.now;
  const log = [];
  const inFlight = { now: 0, max: 0 };
  const pending = new Set();
  const track = (p) => { inFlight.now++; inFlight.max = Math.max(inFlight.max, inFlight.now); const q = p.then((v) => { inFlight.now--; pending.delete(q); return v; }); pending.add(q); return q; };
  const k = installKino({ storage: {
    srvs: JSON.stringify({ ts: start, list: [A, B], idx: 0, ok: true, okAt: start, ...(chosen ? { chosen: keyOf(B), homeAt: 0 } : { chosen: keyOf(A) }), mig: 1, v: 2 }),
  }, routes: [(url, init) => {
    const u = new URL(url);
    const action = param(url, "action");
    const e = { host: u.hostname, action, at: net.now(), timeoutMs: init && init.timeoutMs };
    log.push(e);
    const lim = (init && init.timeoutMs) || 15000;
    if (action === "get_short_epg") {
      if (epg === "hang") return track(net.request(lim).then(() => { e.end = net.now(); return kinoError("timeout", "timed out"); }));
      const now = Math.floor(start / 1000);
      return track(net.request(epg).then(() => { e.end = net.now(); return res(200, { epg_listings: [{ title: b64("Programa " + param(url, "stream_id")), description: b64("x"), start_timestamp: String(now - 600), stop_timestamp: String(now + 1800) }] }); }));
    }
    return track(net.request(400).then(() => { e.end = net.now(); return kinoError("network", "down"); }));
  }] });
  const drain = async () => { if (pending.size) await net.run(Promise.all([...pending])); };
  return { ...k, net, log, inFlight, drain, start };
}

const ids = Array.from({ length: 40 }, (_, i) => "live-" + (5000 + i));

test("40 channels asked: the first 12 only, on the active account, 4 at once, each within 3 s; about a second in all", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  const t0 = w.net.now();
  const out = await w.net.run(cat.guide({ channelIds: ids, from: w.start - 3600000, to: w.start + 3600000 }));
  await w.drain();
  const epg = w.log.filter((e) => e.action === "get_short_epg");
  assert.equal(epg.length, 12);
  assert.deepEqual(epg.map((e) => e.host), Array(12).fill("a.example"));
  assert.ok(epg.every((e) => e.timeoutMs > 0 && e.timeoutMs <= 3000));
  assert.ok(w.inFlight.max <= 4, String(w.inFlight.max));
  assert.equal(w.log.length, 12, "no backHome probe, no other request");
  assert.deepEqual([...new Set(out.map((p) => p.channelId))], ids.slice(0, 12));
  assert.equal(out[0].title, "Programa 5000");
  assert.equal(w.net.now() - t0, 900, "three rounds of four");
});

test("a hanging panel: the call ends within 4 s, no other account is asked", async () => {
  const w = world({ epg: "hang" });
  const cat = await fresh("catalog.js");
  const t0 = w.net.now();
  const out = await w.net.run(cat.guide({ channelIds: ids, from: 0, to: Infinity }));
  await w.drain();
  assert.deepEqual(out, []);
  assert.ok(w.net.now() - t0 <= 4000, `Kino holds the call ${w.net.now() - t0} ms`);
  assert.ok(w.log.every((e) => e.host === "a.example"));
  assert.ok(w.log.length <= 12);
});

test("away from the chosen account: one backHome probe per call, with a short timeout", async () => {
  const w = world({ chosen: true });
  const cat = await fresh("catalog.js");
  await w.net.run(cat.guide({ channelIds: ids, from: 0, to: Infinity }));
  await w.drain();
  const probes = w.log.filter((e) => e.action === "get_live_categories");
  assert.equal(probes.length, 1);
  assert.equal(probes[0].host, "b.example");
  assert.ok(probes[0].timeoutMs <= 3000);
  assert.equal(w.log.filter((e) => e.action === "get_short_epg" && e.host === "a.example").length, 12, "B did not answer: the guide stays on A");
});
