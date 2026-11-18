// The guide in Kino's network and virtual time. Native En vivo asks the guide of a category's first 40 visible channels in
// one call, before the categories and the channels, which wait behind it on the plugin's single call lane
// (LiveViewModel.load -> requestEpg). Kino stores an answer for every channel it sent, an empty one for a channel left out,
// for 30 min (PluginLiveProvider.askGuide), and never asks that channel again: so a call answers every channel, on the
// active account alone, with one backHome, 4 at once (Kino's per-host limit), each request within 2.5 s, none started with
// less than 0.5 s left of the call's 3.5 s.
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

const idsOf = (n) => Array.from({ length: n }, (_, i) => "live-" + (5000 + i));
const ids = idsOf(40);
const epgOf = (w) => w.log.filter((e) => e.action === "get_short_epg");

test("40 channels at 250 ms: every one answered, on the active account, 4 at once, each within 2.5 s; 2.5 s in all", async () => {
  const w = world({ epg: 250 });
  const cat = await fresh("catalog.js");
  const t0 = w.net.now();
  const out = await w.net.run(cat.guide({ channelIds: ids, from: w.start - 3600000, to: w.start + 3600000 }));
  await w.drain();
  const epg = epgOf(w);
  assert.equal(epg.length, 40);
  assert.deepEqual(epg.map((e) => e.host), Array(40).fill("a.example"));
  assert.ok(epg.every((e) => e.timeoutMs > 0 && e.timeoutMs <= 2500));
  assert.ok(w.inFlight.max <= 4, String(w.inFlight.max));
  assert.equal(w.log.length, 40, "no backHome probe, no other request");
  assert.deepEqual([...new Set(out.map((p) => p.channelId))], ids, "a programme for every channel Kino sent");
  assert.equal(out[0].title, "Programa 5000");
  assert.equal(w.net.now() - t0, 2500, "ten rounds of four");
});

test("Kino's whole chunk of 50 at 250 ms: all answered within the call's 3.5 s", async () => {
  const w = world({ epg: 250 });
  const cat = await fresh("catalog.js");
  const t0 = w.net.now();
  const out = await w.net.run(cat.guide({ channelIds: idsOf(60), from: 0, to: Infinity }));
  await w.drain();
  assert.equal(epgOf(w).length, 50, "never past Kino's chunk");
  assert.equal(new Set(out.map((p) => p.channelId)).size, 50);
  assert.equal(w.net.now() - t0, 3250);
});

test("a slow panel: the rounds already started finish, none starts after 3 s, the call ends by 3.5 s", async () => {
  const w = world({ epg: 800 });
  const cat = await fresh("catalog.js");
  const t0 = w.net.now();
  const out = await w.net.run(cat.guide({ channelIds: ids, from: 0, to: Infinity }));
  await w.drain();
  const epg = epgOf(w);
  assert.ok(epg.every((e) => e.at - t0 <= 3000), "nothing starts after 3 s");
  assert.ok(epg.every((e) => e.end - t0 <= 3500), "every request settles by 3.5 s");
  assert.ok(w.net.now() - t0 <= 3500, `Kino holds the call ${w.net.now() - t0} ms`);
  assert.equal(new Set(out.map((p) => p.channelId)).size, 16, "four rounds of 0.8 s answered; a fifth would start at 3.2 s");
  assert.equal(w.net.now() - t0, 3200);
});

test("a hanging panel: the call ends at its 3.5 s deadline, no other account is asked", async () => {
  const w = world({ epg: "hang" });
  const cat = await fresh("catalog.js");
  const t0 = w.net.now();
  const out = await w.net.run(cat.guide({ channelIds: ids, from: 0, to: Infinity }));
  await w.drain();
  assert.deepEqual(out, []);
  assert.equal(w.net.now() - t0, 3500, "Kino holds the call to the deadline, not past it");
  assert.ok(w.log.every((e) => e.host === "a.example"));
  assert.equal(w.log.length, 8, "a 2.5 s round, then one cut to the 1 s left");
});

test("away from the chosen account: one backHome probe per call, with a short timeout", async () => {
  const w = world({ chosen: true });
  const cat = await fresh("catalog.js");
  const t0 = w.net.now();
  await w.net.run(cat.guide({ channelIds: ids, from: 0, to: Infinity }));
  await w.drain();
  const probes = w.log.filter((e) => e.action === "get_live_categories");
  assert.equal(probes.length, 1);
  assert.equal(probes[0].host, "b.example");
  assert.ok(probes[0].timeoutMs <= 2500);
  const onA = epgOf(w).filter((e) => e.host === "a.example");
  assert.equal(onA.length, 36, "B did not answer (0.4 s): the guide stays on A, nine rounds of 0.3 s within the call's 3.5 s");
  assert.ok(w.net.now() - t0 <= 3500);
});
