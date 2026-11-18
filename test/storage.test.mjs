// Fills everything SuperTV keeps in kino.storage and checks the person's choices are never evicted, the new panel and
// account entries keep their own budget, and the total stays under the plugin's 262144-byte cap without ever throwing.
import test from "node:test";
import assert from "node:assert/strict";
import { installKino } from "./helpers/fake-kino.mjs";
import { put, usage, classOf, CLASSES, TOTAL_CAP } from "../src/store.js";

const srvList = (n) => Array.from({ length: n }, (_, i) => ({
  url: `http://a-rather-long-host-name-number-${i}.example-panel.xyz:8080`,
  username: "user" + "x".repeat(14), password: "pass" + "y".repeat(14),
  name: "🇲🇽 Servidor de ejemplo con nombre largo " + i,
}));

test("30 long servers plus the chosen key fit the never-evicted servers class", () => {
  installKino();
  const text = JSON.stringify({ ts: Date.now(), list: srvList(30).map((s) => ({ ...s, name: s.name.slice(0, 40) })), idx: 29, ok: true, okAt: Date.now(), homeAt: Date.now(), chosen: "1abcdef", mig: 1, v: 2 });
  assert.ok(put("srvs", text), text.length + " B");
  assert.ok(put("vcode", "25"));
});

test("the person's choice survives any pressure from other classes; panels and accounts keep their budgets", () => {
  const { store } = installKino();
  assert.equal(classOf("srvChosen:v1"), "prefs");
  assert.equal(classOf("superTab"), "prefs");
  assert.equal(classOf("health:v1"), "health");
  assert.equal(classOf("panels:v1"), "panels");
  assert.equal(classOf("acct:v1"), "acct");
  assert.equal(classOf("live:v1"), "live");
  for (const c of ["prefs", "health", "panels", "acct", "live", "servers"]) assert.equal(CLASSES[c].keep, true, c);
  put("srvChosen:v1", "1");
  put("superTab", "deportes");
  put("seed:v1", "123456789");
  put("srvs", JSON.stringify({ ts: 1, list: srvList(30), idx: 0, v: 2 }));
  const g = {}; const t = {};
  for (let i = 0; i < 60; i++) { g["k" + i.toString(36).padStart(7, "0")] = "k000000" + (i % 9); t["k" + i.toString(36).padStart(7, "0")] = Date.now(); }
  assert.ok(put("panels:v1", JSON.stringify({ v: 1, at: Date.now(), g, t })), "60 servers fit the panels class");
  const dead = {}; for (let i = 0; i < 40; i++) dead["k" + i.toString(36).padStart(6, "0")] = [Date.now(), "abcdef"];
  assert.ok(put("acct:v1", JSON.stringify({ v: 1, dead, blocked: { a: "0.4.1", b: "0.4.1" } })), "40 dead accounts fit");
  put("health:v1", JSON.stringify({ ts: Date.now(), online: srvList(30).map((s) => s.url) }));
  put("live:v1", JSON.stringify({ p: "k0000001|201583", k: "k0000002", id: "201583", a: "k0000001", at: Date.now() }));
  // Everything else the plugin writes, over and over.
  for (let round = 0; round < 40; round++) {
    put("cats:live:s" + round, JSON.stringify({ ts: Date.now(), l: Array.from({ length: 300 }, (_, i) => [String(i), "CATEGORÍA DE EJEMPLO " + i]) }));
    put("homeSnap:v1:s" + round + ":all", "x".repeat(9000));
    put("searchHist:v1:s" + round, "y".repeat(3000));
    put("misc-" + round, "z".repeat(600)); // the 2 KB misc class
  }
  for (const k of ["srvChosen:v1", "superTab", "seed:v1", "srvs", "panels:v1", "acct:v1", "health:v1", "live:v1"]) assert.ok(store.has(k), k + " evicted");
  const u = usage();
  assert.ok(u.total < TOTAL_CAP, String(u.total));
  for (const [c, n] of Object.entries(u.byClass)) assert.ok(n <= CLASSES[c].budget, `${c}: ${n} > ${CLASSES[c].budget}`);
});

test("a value too big for its class is refused with false, never thrown", () => {
  installKino();
  assert.equal(put("panels:v1", "x".repeat(5000)), false);
  assert.equal(put("srvChosen:v1", "x".repeat(400)), false);
});
