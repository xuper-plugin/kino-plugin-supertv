// The Home snapshot at real size. A feed's five tabs (Todo, Premium, Países, Deportes, Radio) of 12 rails x 20 channels,
// with the enriched refs a listing builds (`live:<id>~<cat>~<catTok>~<chanTok>`) and real-length logo URLs, all land in the
// one snapshot entry, inside the homeSnap class: the next cold open paints every tab's saved rows from storage, with no
// request. On 2026-11-18 (Redmi, D-S1) the entry held only the Radio tab, so every other tab opened on the skeleton.
import test from "node:test";
import assert from "node:assert/strict";
import { installKino, res, fresh } from "./helpers/fake-kino.mjs";
import { liveRef } from "../src/liveFailover.js";
import { categoryTok, channelTok } from "../src/channelMatch.js";
import { CLASSES, SOFT_CAP, usage } from "../src/store.js";
import { keyOf } from "../src/panels.js";

const T = Date.UTC(2026, 10, 18, 12);
const realNow = Date.now;
test.beforeEach(() => { Date.now = () => T; });
test.afterEach(() => { Date.now = realNow; });

const SRV = { url: "http://a1.example", username: "u1", password: "p1", name: "🇪🇸" };

// Channel and category names of the forms the panels use, logos as long as the real ones (64-75 characters).
const TABS = {
  all: { cc: "ES", cats: ["ENTRETENIMIENTO", "NOTICIAS", "INFANTIL", "DOCUMENTALES", "CINE", "SERIES"], names: ["ANTENA 3", "TELECINCO", "LA SEXTA", "CUATRO", "NAT GEO WILD", "DISCOVERY CHANNEL"], dir: "spain/atresmedia" },
  premium: { cc: "US", cats: ["HBO", "STARZ", "SHOWTIME", "CINEMAX", "AMC", "PARAMOUNT"], names: ["HBO SIGNATURE", "STARZ ENCORE ACTION", "SHOWTIME EXTREME", "CINEMAX MOREMAX", "AMC PREMIERE", "PARAMOUNT NETWORK"], dir: "usa/premium_networks" },
  paises: { cc: "FR", cats: ["FRANCE", "BELGIQUE", "SUISSE", "CANADA", "MAROC", "ALGERIE"], names: ["F3 ALPES", "TF1 SERIES FILMS", "RTL TVI", "RTS UN", "TVA MONTREAL", "2M MAROC"], dir: "france/canal_plus" },
  deportes: { cc: "ES", cats: ["DAZN", "M+ DEPORTES", "LALIGA TV", "EUROSPORT", "ESPN", "SKY SPORT"], names: ["M+ LIGA DE CAMPEONES", "DAZN LALIGA", "LALIGA TV HYPERMOTION", "EUROSPORT 1", "ESPN PREMIUM", "SKY SPORT BUNDESLIGA"], dir: "spain/movistar" },
};

function railsOf(tab, n, per, { posters = true } = {}) {
  const t = TABS[tab] || { cc: "NL", cats: ["RADIO"], names: ["JOE NL"], dir: "" };
  return Array.from({ length: n }, (_, r) => {
    const catId = String(300 + Object.keys(TABS).indexOf(tab) * 40 + r);
    const catRaw = `${t.cc} ▎${t.cats[r % t.cats.length]}`;
    const items = Array.from({ length: per }, (_, i) => {
      const id = String(400000 + r * 1000 + i * 7 + tab.length);
      const title = `${t.names[(r + i) % t.names.length]} ${i + 1} ${i % 2 ? "FHD" : "HD"}`;
      const poster = `https://logos.example.net/logo/countries/${t.dir}/${title.replace(/[^A-Za-z0-9]+/g, "_")}.png`;
      return { id: "live-" + id, ref: liveRef(id, catId, categoryTok(catRaw), channelTok(`${t.cc} ▎${title}`)), title, kind: "live", ...(posters ? { poster } : {}) };
    });
    return { id: "lcat-" + catId, catId, title: t.cats[r % t.cats.length], items };
  });
}

const feedTabs = () => ({ all: railsOf("all", 12, 20), premium: railsOf("premium", 12, 20), paises: railsOf("paises", 12, 20), deportes: railsOf("deportes", 12, 20), radio: railsOf("radio", 3, 20, { posters: false }) });
const box2 = (obj) => JSON.stringify({ v: 2, iv: "AAAAAAAAAAAAAAAA", data: Buffer.from(JSON.stringify(obj)).toString("base64") });

// A chosen server and its feed on `data`, the snapshot written by one tick; then a new runtime with no network.
async function afterFeed(feed) {
  const k = installKino({ storage: {
    srvs: JSON.stringify({ ts: T, list: [SRV], idx: 0, ok: true, okAt: T, chosen: "x", mig: 1, v: 2 }),
    "srvChosen:v1": "1",
    superTab: "deportes",
    "health:v1": JSON.stringify({ ts: T, online: [SRV.url] }),
  }, routes: [(url) => (new URL(url).hostname === "raw.githubusercontent.com" ? res(200, box2({ v: 1, at: T, serverKey: keyOf(SRV), tabs: feed() })) : res(200, []))] });
  // Feed v2 opened by a fake decrypt and gunzip (the payload is plain JSON here).
  k.kino.secret = () => "k";
  k.kino.crypto = { decrypt: (_a, o) => (o.outputEncoding === "base64" ? o.data : Buffer.from(o.data, "base64").toString("utf8")), gunzip: (b64) => Buffer.from(b64, "base64").toString("utf8") };
  const screen = await fresh("screen.js");
  await screen.screenEvent({ name: "tick", state: {}, lang: "es" });
  assert.ok(k.requests.some((r) => r.url.includes("/data/home/")), "the feed was read");
  // Cold open: a new runtime (the screen's memory gone, a new kino) over the same stored values, and no network at all.
  const cold = installKino({ storage: Object.fromEntries(k.store) });
  const coldScreen = await fresh("screen.js");
  const render = async (tab, device = "tv") => coldScreen.screen({ route: { name: "main" }, state: { tab }, device: { kind: device } });
  return { k, cold, render };
}

// What a rendered Home shows: its rails' keys and, per rail, its channel cards with their logos.
function railsShown(view) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (typeof o.key === "string" && /^rail-lcat-\d+$/.test(o.key)) { out.push({ key: o.key, cards: [], logos: 0 }); }
    if (typeof o.key === "string" && /^chl-rail-lcat-\d+-\d+$/.test(o.key) && out.length) { out.at(-1).cards.push(o.labelText); if (o.image) out.at(-1).logos++; }
    for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v);
  };
  walk(view);
  return out;
}

test("a real-size feed: the snapshot keeps all five tabs, and a cold open paints each one's saved rows from storage", async () => {
  const w = await afterFeed(feedTabs);
  for (const tab of ["all", "premium", "paises", "deportes", "radio"]) {
    const view = await w.render(tab);
    const json = JSON.stringify(view);
    assert.ok(!json.includes('"skel1"'), `${tab}: the skeleton instead of the saved rows`);
    const rails = railsShown(view);
    if (tab === "radio") {
      assert.equal(rails.length, 3, "radio: its three rails");
      assert.ok(rails.every((r) => r.cards.length >= 6), "radio: six channels or more a rail");
      continue;
    }
    assert.ok(rails.length >= 8, `${tab}: ${rails.length} rails`);
    assert.ok(rails.every((r) => r.cards.length >= 6 && r.logos === r.cards.length), `${tab}: ${rails.map((r) => r.cards.length + "/" + r.logos).join(" ")}`);
  }
  assert.equal(w.cold.requests.length, 0, "painted from storage alone");
  // The store kept to its budgets, in Kino's own measure.
  const u = usage();
  assert.ok(u.byClass.homeSnap <= CLASSES.homeSnap.budget, `homeSnap ${u.byClass.homeSnap}`);
  assert.ok(u.total <= SOFT_CAP, String(u.total));
});

test("the saved cards are the feed's: the same ref (the failover's category and channel), title and logo", async () => {
  const w = await afterFeed(feedTabs);
  const card = feedTabs().deportes[0].items[0];
  const json = JSON.stringify(await w.render("deportes"));
  assert.ok(json.includes(`"ref":"${card.ref}"`), "the enriched ref, whole");
  assert.ok(json.includes(`"id":"${card.id}"`));
  assert.ok(json.includes(`"image":"${card.poster}"`), "the whole logo URL");
});

test("tabs far over their share still keep rows: fewer channels, then no logos, never a tab left out", async () => {
  // Logos five times as long and titles three times as long as real ones.
  const huge = () => {
    const tabs = feedTabs();
    for (const t of Object.keys(tabs)) for (const r of tabs[t]) for (const it of r.items) { it.title = `${it.title} ${it.title} ${it.title}`; if (it.poster) it.poster = it.poster.replace(".png", "/x".repeat(150) + ".png"); }
    return tabs;
  };
  const w = await afterFeed(huge);
  for (const tab of ["all", "premium", "paises", "deportes", "radio"]) {
    const rails = railsShown(await w.render(tab));
    assert.ok(rails.length >= 3 && rails.every((r) => r.cards.length >= 3), `${tab}: ${rails.length} rails`);
  }
  const u = usage();
  assert.ok(u.byClass.homeSnap <= CLASSES.homeSnap.budget, `homeSnap ${u.byClass.homeSnap}`);
});
