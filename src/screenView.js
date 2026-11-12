// Los árboles de la pantalla de SuperTV: funciones puras sobre lo que screen.js guarda en memoria. Sin red.
import { twin } from "./i18n.js";
import { LOGO_DATA } from "./logo.js";

// Pestañas por grupo de canales. "all" = todas las categorías; el resto filtra por grupo (categoryRules.LIVE_GROUPS).
export const TAB_IDS = ["all", "premium", "paises", "deportes", "radio"];
const TAB_KEYS = { all: "tabAll", premium: "tabPremium", paises: "tabCountries", deportes: "tabSports", radio: "tabRadio" };
const POLL_MS = 1_500;
const GRID_CAP = 60;
const HTTPS = /^https:\/\//;
export const PRESS_MS = 30_000;

export function cardOf(item) {
  const out = { id: item.id, ref: item.ref, title: item.title, kind: item.kind || "live" };
  const poster = item.poster || item.logo;
  if (poster && HTTPS.test(poster)) out.poster = poster;
  if (item.adult === true) out.adult = true;
  return out;
}

const slim = (card) => {
  const { overview, ...rest } = card;
  return rest;
};

const railSkeleton = (n) => ({
  type: "Column", key: "skel" + n, gap: 8, children: [
    { type: "Skeleton", shape: "line", width: 120 },
    { type: "Row", gap: 24, children: [1, 2, 3, 4, 5].map((i) => ({ type: "Skeleton", shape: "circle", key: `sk${n}c${i}`, width: 88, height: 88 })) },
  ],
});

const gridSkeleton = () => ({
  type: "Column", key: "gridSkeleton", gap: 12, children: [
    ...[1, 2].map((r) => ({ type: "Row", gap: 12, sizes: ["compact"], key: `gc${r}`, children: [1, 2, 3].map((i) => ({ type: "Skeleton", shape: "card", key: `gc${r}-${i}`, flex: 1 })) })),
    ...[1, 2].map((r) => ({ type: "Row", gap: 12, sizes: ["medium", "expanded"], key: `gw${r}`, children: [1, 2, 3, 4, 5, 6].map((i) => ({ type: "Skeleton", shape: "card", key: `gw${r}-${i}`, flex: 1 })) })),
  ],
});

const brandText = () => ({ type: "Text", key: "brandText", text: "SuperTV", textEn: "SuperTV", style: "h4" });
const title = () => ({
  type: "Row", key: "brand", gap: 8, crossAxisAlignment: "center",
  children: [{ type: "Image", key: "logo", url: LOGO_DATA, aspect: "1:1", fit: "contain", h: 32, alt: "SuperTV", altEn: "SuperTV" }, brandText()],
});

const tabBar = (active) => ({
  type: "TabBar", key: "tabs", divider: false, value: active, onChanged: "tab",
  tabs: TAB_IDS.map((id) => ({ value: id, ...twin(TAB_KEYS[id], "label") })),
});

const roundChannel = (c, n) => ({
  type: "Column", key: "ch-" + n, w: 120, gap: 8, crossAxisAlignment: "center",
  onTap: { go: { play: { ref: c.ref, kind: "live", id: c.id, title: c.title } } },
  children: [
    { type: "CircleAvatar", key: "chl-" + n, radius: 44, ...(c.poster ? { image: c.poster } : { text: String(c.title).slice(0, 2).toUpperCase() }), labelText: c.title, labelTextEn: c.title },
    { type: "Text", text: c.title, textEn: c.title, style: "caption", maxLines: 1, textAlign: "center" },
  ],
});

// Fila de canales (avatares redondos) con un "Ver todos" opcional que abre la categoría completa.
const roundRail = (items, key, titleProps, onMore) => ({
  type: "Column", key, gap: 8, children: [
    onMore
      ? { type: "Row", key: key + "H", mainAxisAlignment: "spaceBetween", crossAxisAlignment: "center", children: [
        { type: "Text", ...titleProps, style: "h4" },
        { type: "TextButton", key: key + "More", ...twin("seeAll", "labelText"), onPressed: onMore },
      ] }
      : { type: "Text", ...titleProps, style: "h4" },
    { type: "SingleChildScrollView", key: key + "Scroll", direction: "horizontal", children: [{ type: "Row", gap: 24, children: items.slice(0, 20).map(roundChannel) }] },
  ],
});

const barButton = (key, icon, labelKey, onPressed) => ({ type: "IconButton", key, icon, ...twin(labelKey, "labelText"), ...twin(labelKey, "tooltip"), onPressed });

/**
 * `data`: { rails: [{ id, catId, title, items }], partial } del grupo activo, o null. `loading`: algo falta por cargar
 * (el temporizador solo corre entonces). `failed`: el grupo activo no cargó.
 */
export function browseView({ tab, data, loading, failed, device = "phone" }) {
  const tv = device === "tv";
  const active = TAB_IDS.includes(tab) ? tab : TAB_IDS[0];
  const body = [];
  if (data) {
    for (const r of data.rails) {
      body.push(roundRail(r.items, "rail-" + r.id, { text: r.title, textEn: r.title }, { event: "gocat", arg: r.catId }));
    }
    if (data.rails.length === 0) body.push({ type: "Text", ...twin("empty", "text"), color: "muted" });
    if (data.partial) body.push({ type: "MaterialBanner", key: "partialRows", role: "warning", ...twin("partial"), action: { ...twin("retry", "label"), onTap: "retry" } });
  } else if (failed) {
    body.push({ type: "MaterialBanner", key: "loadFailed", role: "error", ...twin("failed"), action: { ...twin("retry", "label"), onTap: "retry" } });
  } else {
    body.push(railSkeleton(1), railSkeleton(2), railSkeleton(3));
  }
  return {
    type: "Scaffold",
    appBar: {
      type: "AppBar", divider: false, mergeWithKinoBar: true, dense: true,
      leading: barButton("close", "close", "close", { go: { close: true } }),
      title: tv ? { type: "Row", key: "titleRow", gap: 24, crossAxisAlignment: "center", children: [title(), tabBar(active)] } : title(),
      actions: [
        ...(tv ? [barButton("searchButton", "search", "search", "openSearch")] : []),
        barButton("settings", "settings", "settings", { event: "go", arg: "settings" }),
      ],
    },
    ...(tv ? {} : { floatingActionButton: { type: "FloatingActionButton", key: "searchFab", icon: "search", ...twin("search", "tooltip"), onPressed: "openSearch" } }),
    body: { type: "Column", key: "page", children: [
      ...(tv ? [] : [{ type: "Column", key: "tabsRow", padding: { compact: 0, expanded: 24 }, children: [tabBar(active)] }]),
      { type: "SingleChildScrollView", key: "browse-" + active, flex: 1, children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: body }] },
    ] },
    ...(loading ? { every: { ms: POLL_MS, event: "tick" } } : {}),
  };
}

const searchForm = (tv, query, key, field, event, hintKey, goKey) => ({
  type: "Form", key, onSubmitted: event, gap: 8, children: tv
    ? [{ type: "Row", key: key + "Row", gap: 16, crossAxisAlignment: "center", children: [
      { type: "TextField", key: field, kind: "text", value: query, ...twin(hintKey, "labelText"), maxLength: 100, autofocus: true, onSubmitted: event, weight: 1 },
      { type: "ElevatedButton", key: goKey, ...twin("search", "labelText"), icon: "search", submit: true },
    ] }]
    : [
      { type: "TextField", key: field, kind: "text", value: query, ...twin(hintKey, "labelText"), maxLength: 100, autofocus: true, onSubmitted: event },
      { type: "ElevatedButton", key: goKey, ...twin("search", "labelText"), icon: "search", submit: true },
    ],
});

const backBar = (tv, extra) => ({
  type: "AppBar", mergeWithKinoBar: true, dense: true, divider: false,
  leading: barButton("back", "arrow_back", "back", "back"),
  ...extra,
});

export function searchView({ query, status, items, partial = false, history = [], device = "phone" }) {
  const tv = device === "tv";
  const form = () => searchForm(tv, query, "searchForm", "q", "search", "searchHint", "searchGo");
  const body = tv ? [] : [form()];
  if (status === "fail") {
    body.push({ type: "MaterialBanner", key: "searchFailed", role: "error", ...twin("searchFailed"), action: { ...twin("retry", "label"), onTap: "sretry" } });
  } else if (status === "done" && items) {
    if (items.length === 0) body.push({ type: "Text", ...twin("noResults", "text"), color: "muted" });
    else body.push({ type: "titleGrid", key: "results", columns: { compact: 3, expanded: 6 }, items: items.slice(0, GRID_CAP).map(slim) });
    if (partial) body.push({ type: "Text", ...twin("searchPartial", "text"), style: "caption", color: "muted" });
  } else if (status !== "idle") {
    body.push(gridSkeleton());
  } else if (history.length > 0) {
    body.push({ type: "Text", ...twin("searchedBefore", "text"), style: "h4" });
    body.push({ type: "titleGrid", key: "history", columns: { compact: 3, expanded: 6 }, items: history.slice(0, GRID_CAP) });
  }
  return {
    type: "Scaffold",
    appBar: backBar(tv, tv ? { title: form() } : twin("searchTitle", "title")),
    body: { type: "SingleChildScrollView", key: "search-page", children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: body }] },
    ...(status === "loading" ? { every: { ms: 1_000, event: "stick" } } : {}),
  };
}

// Drilldown de una categoría completa: dropdown para cambiar + rejilla de canales.
export function liveView({ cats, cat, items, failed = false, device = "phone" }) {
  const tv = device === "tv";
  const body = [];
  if (cats && cats.length > 1) {
    body.push({ type: "DropdownButton", key: "lcat", ...twin("liveCategory", "labelText"), value: cat, onChanged: "lcat", options: cats.slice(0, 500).map((c) => ({ value: c.id, label: c.title, labelEn: c.title })) });
  }
  if (failed) body.push({ type: "MaterialBanner", key: "liveFailed", role: "error", ...twin("failed"), action: { ...twin("retry", "label"), onTap: "lretry" } });
  else if (cats && cats.length === 0) body.push({ type: "Text", ...twin("liveEmpty", "text"), color: "muted" });
  else if (items && items.length === 0) body.push({ type: "Text", ...twin("liveEmpty", "text"), color: "muted" });
  else if (items && tv) body.push({ type: "Row", key: "channels", wrap: true, gap: 24, children: items.slice(0, 40).map(roundChannel) });
  else if (items) {
    body.push({ type: "titleGrid", key: "channels", columns: { compact: 3, expanded: 6 }, items: items.slice(0, GRID_CAP) });
    if (items.length >= GRID_CAP) body.push({ type: "Text", ...twin("liveMore", "text", { n: GRID_CAP }), style: "caption", color: "muted" });
  } else body.push(gridSkeleton());
  return {
    type: "Scaffold",
    appBar: backBar(tv, tv ? { ...twin("live", "title") } : twin("live", "title")),
    body: { type: "SingleChildScrollView", key: "live-" + String(cat).replace(/[^A-Za-z0-9_-]/g, "_"), children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: body }] },
    ...(!failed && (!cats || !items) ? { every: { ms: 1_000, event: "ltick" } } : {}),
  };
}

const text = (key, extra = {}, vars) => ({ type: "Text", ...twin(key, "text", vars), ...extra });
const caption = (key, extra = {}, vars) => text(key, { style: "caption", color: "muted", ...extra }, vars);
const section = (key) => text(key, { style: "h4" });
const press = (event, arg) => ({ event, ...(arg !== undefined ? { arg } : {}), timeoutMs: PRESS_MS });

export function settingsView({ srv, busy, pluginVersion, appVersion, device }) {
  const status = !srv ? { badge: "checking", sub: null }
    : !srv.host ? { badge: "setServerNone", sub: null }
      : { badge: srv.ok ? "setServerOk" : "setServerDown", sub: srv.total ? twin("setServerPos", "subtitle", { i: srv.index, n: srv.total }) : null };
  const deviceName = device === "tv" ? ["televisor", "TV"] : device === "desktop" ? ["computador", "desktop"] : ["teléfono", "phone"];
  const rows = [
    ["aboutPlugin", [pluginVersion, pluginVersion]],
    ["aboutKino", [appVersion || "?", appVersion || "?"]],
    ["aboutDevice", deviceName],
  ].map(([k, v], n) => ({ type: "TableRow", key: "diag" + n, children: [
    { type: "TableCell", ...twin(k) },
    { type: "TableCell", text: v[0], textEn: v[1] },
  ] }));
  return {
    type: "Scaffold",
    appBar: backBar(device === "tv", { ...twin("setTitle", "title") }),
    body: { type: "SingleChildScrollView", key: "settings-page", children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: [
      { type: "Card", key: "connCard", children: [
        section("setConnection"),
        caption("setConnectionHint"),
        { type: "ListTile", key: "serverRow", ...twin("setServer", "title"), ...(status.sub || {}), leading: { type: "Icon", name: "language" },
          trailing: { type: "Badge", ...twin(status.badge) } },
        { type: "Row", wrap: true, gap: 8, children: [
          { type: "ElevatedButton", key: "switchServer", ...twin("setSwitch", "labelText"), icon: "refresh", ...twin("setSwitchHint", "tooltip"), enabled: !busy, onPressed: press("srv.switch") },
          { type: "Button", variant: "secondary", key: "refreshServers", ...twin("setRefresh", "labelText"), icon: "download", ...twin("setRefreshHint", "tooltip"), enabled: !busy, onPressed: press("srv.refresh") },
          { type: "TextButton", key: "checkServer", ...twin("setCheck", "labelText"), enabled: !busy, onPressed: press("srv.check") },
        ] },
      ] },
      { type: "Card", key: "adultCard", children: [
        section("setAdultTitle"),
        caption("setAdultHint"),
        { type: "settings", key: "adultForm", keys: ["showAdult"], autoSave: true, onSaved: "saved" },
      ] },
      { type: "Card", key: "liveCard", children: [
        section("setLiveTitle"),
        caption("setLiveHint"),
        { type: "settings", key: "liveForm", keys: ["liveFormat"], autoSave: true, onSaved: "saved" },
      ] },
      { type: "Card", key: "aboutCard", children: [
        section("setAbout"),
        { type: "DataTable", key: "aboutTable", columns: [{ flex: 2 }, { flex: 3 }], wrap: true, zebra: true, children: rows },
      ] },
    ] }] },
    ...(!srv ? { every: { ms: 1_000, event: "sstatus" } } : {}),
  };
}
