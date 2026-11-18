// The Home feed's v2 copy (scripts/gen-home.mjs HOME_V2_RAILS x HOME_V2_ITEMS) exists so a tab fits Kino's 600 screen nodes
// without Kino cutting it: a full v2 tab, with a full events row on top and the "partial" banner, on phone and TV, stays
// under 600, while v1's RAILS_PER_TAB x RAIL_ITEMS does not. Every rail of a tab stays: only the cards are capped.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installKino } from "./helpers/fake-kino.mjs";
import { browseView } from "../src/screenView.js";

const MAX_NODES = 600; // Kino's ScreenLimits.MAX_NODES
const gen = readFileSync(new URL("../scripts/gen-home.mjs", import.meta.url), "utf8");
const num = (name) => {
  const m = new RegExp(`\\b${name} = (\\d+)\\b`).exec(gen);
  assert.ok(m, `${name} in scripts/gen-home.mjs`);
  return Number(m[1]);
};

// What Kino's screen parser counts: every object with a `type`.
const count = (n) => {
  if (Array.isArray(n)) return n.reduce((s, x) => s + count(x), 0);
  if (!n || typeof n !== "object") return 0;
  return (typeof n.type === "string" ? 1 : 0) + Object.values(n).reduce((s, v) => s + count(v), 0);
};
const rail = (r, n) => ({
  id: "lcat-" + r, catId: String(r), title: "Categoría " + r,
  items: Array.from({ length: n }, (_, i) => ({ id: `c${r}-${i}`, ref: `live:${i}`, title: "Canal " + i, kind: "live", poster: "https://img.example/a.png" })),
});
const nodes = (rails, n, device) => {
  const data = { rails: [rail("ev", num("RAIL_ITEMS")), ...Array.from({ length: rails }, (_, r) => rail(r, n))], partial: true };
  return count(browseView({ tab: "all", data, loading: true, failed: false, device }));
};

// Since the screen caps what it draws itself (13 rails of 12 channels, src/screenView.js), a full v1 tab fits too: v2's cap
// now only saves bytes. Both must fit, on the phone and on the TV.
test("a full v2 tab with a full events row fits Kino's 600 nodes, and so does a full v1 tab under the screen's own cap", () => {
  installKino();
  const rails = num("HOME_V2_RAILS"), items = num("HOME_V2_ITEMS");
  assert.equal(rails, num("RAILS_PER_TAB"), "v2 keeps every rail of a tab: only the cards are capped");
  assert.ok(items < num("RAIL_ITEMS"));
  for (const device of ["phone", "tv"]) {
    assert.ok(nodes(rails, items, device) <= MAX_NODES, `v2 on ${device}: ${nodes(rails, items, device)} nodes`);
    assert.ok(nodes(num("RAILS_PER_TAB"), num("RAIL_ITEMS"), device) <= MAX_NODES, `v1 on ${device}: ${nodes(num("RAILS_PER_TAB"), num("RAIL_ITEMS"), device)} nodes`);
  }
});
