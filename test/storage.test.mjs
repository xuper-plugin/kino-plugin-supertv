// Fills everything SuperTV keeps in kino.storage and checks the person's choices are never evicted, the panel and account
// entries keep their own budget, and the total stays under the plugin's 262144-byte cap in KINO'S measure (the whole store
// as one JSON object, `"` and `/` escaped) without ever throwing. A put reads no other entry (the sizes live in `_idx`), and
// `_idx` is written once per call, not once per put.
import test from "node:test";
import assert from "node:assert/strict";
import { installKino } from "./helpers/fake-kino.mjs";
import { put, usage, classOf, CLASSES, TOTAL_CAP, SOFT_CAP, flushIndex, entryLen, jsonLen } from "../src/store.js";

// Kino's measure (PluginStorage.encodeStorageJson through Android's org.json, which also escapes "/").
const kinoBytes = (store) => Buffer.byteLength(JSON.stringify(Object.fromEntries(store)).replace(/\//g, "\\/"));

const srvList = (n) => Array.from({ length: n }, (_, i) => ({
  url: `http://a-rather-long-host-name-number-${i}.example-panel.xyz:8080`,
  username: "user" + "x".repeat(14), password: "pass" + "y".repeat(14),
  name: "🇲🇽 Servidor de ejemplo con nombre largo " + i,
}));

test.afterEach(() => flushIndex());

test("jsonLen is Kino's measure of one string: quotes, escapes and UTF-8", () => {
  for (const s of ["", "abc", 'a"b', "a/b\\c", "ñandú", "🇲🇽 x", "line\nnext\u0001", JSON.stringify({ u: "http://x/y" })]) {
    assert.equal(jsonLen(s), Buffer.byteLength(JSON.stringify(s).replace(/\//g, "\\/")), JSON.stringify(s));
  }
  assert.equal(entryLen("k", "v"), kinoBytes(new Map([["k", "v"]])) - 2 + 1);
});

test("30 long servers plus the chosen key fit the never-evicted servers class", () => {
  installKino();
  const text = JSON.stringify({ ts: Date.now(), list: srvList(30).map((s) => ({ ...s, name: s.name.slice(0, 40) })), idx: 29, ok: true, okAt: Date.now(), homeAt: Date.now(), chosen: "1abcdef", mig: 1, v: 2 });
  assert.ok(put("srvs", text), entryLen("srvs", text) + " B in Kino's measure");
  assert.ok(put("vcode", "25"));
});

test("the person's choice survives any pressure from other classes; panels and accounts keep their budgets; Kino's measure stays under the cap", () => {
  const { store } = installKino();
  assert.equal(classOf("srvChosen:v1"), "prefs");
  assert.equal(classOf("superTab"), "prefs");
  assert.equal(classOf("health:v1"), "health");
  assert.equal(classOf("panels:v1"), "panels");
  assert.equal(classOf("acct:v1"), "acct");
  assert.equal(classOf("live:v1"), "live");
  assert.equal(classOf("homeSnap:v2:1abcdef"), "homeSnap");
  for (const c of ["prefs", "health", "panels", "acct", "live", "servers"]) assert.equal(CLASSES[c].keep, true, c);
  put("srvChosen:v1", "1");
  put("superTab", "deportes");
  put("seed:v1", "123456789");
  put("srvs", JSON.stringify({ ts: 1, list: srvList(30), idx: 0, v: 2 }));
  const g = {}; const t = {};
  for (let i = 0; i < 60; i++) { g["k" + i.toString(36).padStart(7, "0")] = "k000000" + (i % 9); t["k" + i.toString(36).padStart(7, "0")] = Date.now(); }
  assert.ok(put("panels:v1", JSON.stringify({ v: 1, at: Date.now(), g, t })), "60 servers fit the panels class");
  const dead = {}; for (let i = 0; i < 30; i++) dead["k" + i.toString(36).padStart(6, "0")] = [Date.now(), "abcdef"];
  assert.ok(put("acct:v1", JSON.stringify({ v: 1, dead, blocked: { a: "0.4.1", b: "0.4.1" } })), "30 dead accounts fit");
  put("health:v1", JSON.stringify({ ts: Date.now(), online: srvList(30).map((s) => s.url) }));
  put("live:v1", JSON.stringify({ p: "k0000001|201583", k: "k0000002", id: "201583", a: "k0000001", at: Date.now() }));
  // Everything else the plugin writes, over and over, with values full of what Kino escapes ("/" in every URL).
  const card = (i) => ({ id: "live-" + i, ref: `live:${i}~2956~es.dazn~es.hd.dazn.${i}`, title: "DAZN " + i, kind: "live", poster: `https://img.example/a/b/c/${i}.png` });
  for (let round = 0; round < 40; round++) {
    put("cats:live:s" + round, JSON.stringify({ ts: Date.now(), l: Array.from({ length: 300 }, (_, i) => [String(i), "CATEGORÍA / EJEMPLO " + i]) }));
    put("homeSnap:v2:s" + round, JSON.stringify({ v: 2, at: Date.now(), tabs: { all: [{ id: "lcat-1", catId: "1", title: "A", items: Array.from({ length: 150 }, (_, i) => card(i)) }] } }));
    put("searchHist:v1:s" + round, JSON.stringify({ v: 1, e: Array.from({ length: 12 }, (_, i) => card(round * 100 + i)) }));
    put("misc-" + round, "z/".repeat(300)); // the 2 KB misc class
    if (round % 7 === 0) flushIndex(); // a new call now and then
  }
  flushIndex();
  for (const k of ["srvChosen:v1", "superTab", "seed:v1", "srvs", "panels:v1", "acct:v1", "health:v1", "live:v1"]) assert.ok(store.has(k), k + " evicted");
  const u = usage();
  const real = kinoBytes(store);
  assert.ok(real < TOTAL_CAP, String(real));
  assert.ok(u.total >= real && u.total - real < 600, `the index's measure ${u.total} vs Kino's ${real}`);
  for (const [c, n] of Object.entries(u.byClass)) assert.ok(n <= CLASSES[c].budget, `${c}: ${n} > ${CLASSES[c].budget}`);
  assert.ok(u.total <= SOFT_CAP + 2048, String(u.total));
});

test("a value too big for its class is refused with false, never thrown", () => {
  installKino();
  assert.equal(put("panels:v1", "x".repeat(5000)), false);
  assert.equal(put("srvChosen:v1", "x".repeat(400)), false);
});

test("a put reads no other entry, and _idx is written once per call with each entry's size", () => {
  const { kino, store, writes } = installKino();
  for (let i = 0; i < 10; i++) put("cats:live:s" + i, JSON.stringify({ ts: 1, l: [["1", "A/B"]] }));
  flushIndex();
  assert.equal(writes.filter((k) => k === "_idx").length, 1, writes.join(","));
  // A new call: the index is read once; then no put reads any value.
  const get = kino.storage.get;
  const reads = [];
  kino.storage.get = (k) => { reads.push(k); return get(k); };
  writes.length = 0;
  put("health:v1", JSON.stringify({ ts: 2, online: [] }));
  put("srvChosen:v1", "1");
  put("cats:live:s3", JSON.stringify({ ts: 3, l: [] }));
  assert.deepEqual(reads, ["_idx"]);
  assert.deepEqual(writes, ["health:v1", "srvChosen:v1", "cats:live:s3"], "no index write before the call ends");
  flushIndex();
  assert.deepEqual(writes.slice(3), ["_idx"]);
  const idx = JSON.parse(store.get("_idx"));
  for (const k of store.keys()) if (k !== "_idx") assert.deepEqual(idx[k][1], entryLen(k, store.get(k)), k);
  kino.storage.get = get;
});

test("an index from before sizes were kept (or missing) is measured once and kept", () => {
  const { store, writes } = installKino({ storage: {
    _idx: JSON.stringify({ srvs: 5, "cats:live:a": 6 }),
    srvs: JSON.stringify({ ts: 1, list: srvList(2), idx: 0, v: 2 }),
    "cats:live:a": JSON.stringify({ ts: 1, l: [] }),
    "superTab": "all",
  } });
  const u = usage();
  assert.equal(u.count, 3);
  assert.equal(u.total, 2 + 16 + ["srvs", "cats:live:a", "superTab"].reduce((n, k) => n + entryLen(k, store.get(k)) + jsonLen(k) + 32, 0));
  flushIndex();
  const idx = JSON.parse(store.get("_idx"));
  assert.deepEqual(idx.srvs, [5, entryLen("srvs", store.get("srvs"))], "the old write time is kept");
  assert.deepEqual(idx.superTab, [0, entryLen("superTab", "all")]);
  writes.length = 0;
  usage();
  flushIndex();
  assert.deepEqual(writes, [], "nothing to measure the next time");
});
