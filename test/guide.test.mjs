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

// [epg]: ms until the active account answers each get_short_epg, "hang" (until its timeout), "down" (a network error after
// 200 ms) or "late" (the first four in 300 ms, then hang); [chosen]: B chosen while A is active (backHome's case);
// [listAge]: how old the stored server list is, the bootstrap answering a renewal after [boot] ms.
function world({ epg = 300, chosen = false, listAge = 0, boot = 2000 } = {}) {
  const start = Date.UTC(2026, 10, 17, 20);
  const net = virtualNet({ start, parallel: 6 });
  Date.now = net.now;
  const log = [];
  const inFlight = { now: 0, max: 0 };
  const pending = new Set();
  const track = (p) => { inFlight.now++; inFlight.max = Math.max(inFlight.max, inFlight.now); const q = p.then((v) => { inFlight.now--; pending.delete(q); return v; }); pending.add(q); return q; };
  const k = installKino({ storage: {
    srvs: JSON.stringify({ ts: start - listAge, list: [A, B], idx: 0, ok: true, okAt: start, ...(chosen ? { chosen: keyOf(B), homeAt: 0 } : { chosen: keyOf(A) }), mig: 1, v: 2 }),
  }, routes: [(url, init) => {
    const u = new URL(url);
    const action = param(url, "action");
    const e = { host: u.hostname, action, at: net.now(), timeoutMs: init && init.timeoutMs };
    log.push(e);
    const lim = (init && init.timeoutMs) || 15000;
    if (u.hostname === "vegetatvv2.duckdns.org") {
      const servers_text = [A, B].map((s) => `${s.url}/get.php?username=${s.username}&password=${s.password} [${s.name}]`).join("\n");
      return track(net.request(Math.min(boot, lim)).then(() => { e.end = net.now(); return boot > lim ? kinoError("timeout", "timed out") : res(200, { ok: true, servers_text }); }));
    }
    if (action === "get_short_epg") {
      if (epg === "hang") return track(net.request(lim).then(() => { e.end = net.now(); return kinoError("timeout", "timed out"); }));
      if (epg === "down") return track(net.request(200).then(() => { e.end = net.now(); return kinoError("network", "connection refused"); }));
      // "late": the first four answer at once, every later one hangs (a panel that stops answering mid-call).
      if (epg === "late" && log.filter((x) => x.action === "get_short_epg").length > 4) return track(net.request(lim).then(() => { e.end = net.now(); return kinoError("timeout", "timed out"); }));
      const now = Math.floor(start / 1000);
      return track(net.request(epg === "late" ? 300 : epg).then(() => { e.end = net.now(); return res(200, { epg_listings: [{ title: b64("Programa " + param(url, "stream_id")), description: b64("x"), start_timestamp: String(now - 600), stop_timestamp: String(now + 1800) }] }); }));
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

test("a silent panel: one round of 2.5 s, then nothing more is asked; one that cannot be reached: one round", async () => {
  for (const [epg, took] of [["hang", 2500], ["down", 200]]) {
    const w = world({ epg });
    const cat = await fresh("catalog.js");
    const t0 = w.net.now();
    const out = await w.net.run(cat.guide({ channelIds: ids, from: 0, to: Infinity }));
    await w.drain();
    assert.deepEqual(out, []);
    assert.equal(w.net.now() - t0, took, `${epg}: Kino holds the call ${w.net.now() - t0} ms`);
    assert.ok(w.log.every((e) => e.host === "a.example"), "no other account is asked");
    assert.equal(w.log.length, 4, `${epg}: the first four only`);
  }
});

test("a panel that answered and then stops: still asked until the call's 3.5 s deadline, never past it", async () => {
  const w = world({ epg: "late" });
  const cat = await fresh("catalog.js");
  const t0 = w.net.now();
  const out = await w.net.run(cat.guide({ channelIds: ids, from: 0, to: Infinity }));
  await w.drain();
  assert.equal(new Set(out.map((p) => p.channelId)).size, 4);
  assert.equal(w.net.now() - t0, 3500, "the deadline");
  assert.equal(epgOf(w).length, 12, "four answered, four timed out at 2.8 s, four cut to the 0.7 s left");
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

test("a server list 7 h old: the guide renews nothing (the next api() call does) and answers all 40; past 24 h it renews", async () => {
  const H = 3600000;
  for (const [listAge, boots, answered, took] of [[7 * H, 0, 40, 2500], [25 * H, 1, 20, 3250]]) {
    const w = world({ epg: 250, listAge });
    const cat = await fresh("catalog.js");
    const t0 = w.net.now();
    const out = await w.net.run(cat.guide({ channelIds: ids, from: 0, to: Infinity }));
    await w.drain();
    assert.equal(w.log.filter((e) => e.host === "vegetatvv2.duckdns.org").length, boots, `${listAge / H} h: bootstrap requests`);
    assert.equal(new Set(out.map((p) => p.channelId)).size, answered, `${listAge / H} h: channels with a programme (2 s of bootstrap leave 1.5 s)`);
    assert.equal(w.net.now() - t0, took, `${listAge / H} h: Kino holds the call`);
  }
});
