// src/store.js
var SOFT_CAP = 200 * 1024;
var CLASSES = {
  servers: { match: (k) => k === "srvs" || k === "vcode", budget: 5 * 1024, keep: true },
  cats: { match: (k) => k.startsWith("cats:"), budget: 60 * 1024 },
  hero: { match: (k) => k.startsWith("vinfo:"), budget: 30 * 1024 },
  hist: { match: (k) => k.startsWith("searchHist:"), budget: 10 * 1024 },
  recent: { match: (k) => k.startsWith("recent:"), budget: 30 * 1024 },
  idx: { match: (k) => k.startsWith("idx:"), budget: 6 * 1024 },
  tmdb: { match: (k) => k.startsWith("tmdb:"), budget: 24 * 1024 },
  // Snapshots de las pestañas (una entrada por servidor+tab): pintan el Home al instante al reabrir, aun sin red.
  homeSnap: { match: (k) => k.startsWith("homeSnap:"), budget: 40 * 1024 },
  misc: { match: () => true, budget: 2 * 1024 }
};
var ORDER = ["servers", "cats", "hero", "hist", "recent", "idx", "tmdb", "homeSnap", "misc"];
var IDX = "_idx";
var classOf = (key) => ORDER.find((c) => CLASSES[c].match(key));
function utf8Len(s) {
  let n = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 128) n += 1;
    else if (c < 2048) n += 2;
    else if (c >= 55296 && c <= 56319) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
var sizeOf = (key, value) => utf8Len(key) + utf8Len(value);
function readIndex() {
  try {
    const o = JSON.parse(kino.storage.get(IDX) || "null");
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch (_) {
    return {};
  }
}
function writeIndex(idx) {
  try {
    kino.storage.set(IDX, JSON.stringify(idx));
  } catch (_) {
  }
}
function entries() {
  let keys = [];
  try {
    keys = kino.storage.keys();
  } catch (_) {
    return [];
  }
  const idx = readIndex();
  const out = [];
  for (const k of keys) {
    if (k === IDX) continue;
    let v = null;
    try {
      v = kino.storage.get(k);
    } catch (_) {
      v = null;
    }
    if (v === null || v === void 0) continue;
    out.push({ key: k, klass: classOf(k), bytes: sizeOf(k, v), ts: Number(idx[k]) || 0 });
  }
  return out;
}
function evict(list, idx, key) {
  try {
    kino.storage.remove(key);
  } catch (_) {
  }
  delete idx[key];
  const i = list.findIndex((e) => e.key === key);
  if (i >= 0) list.splice(i, 1);
}
function put(key, value) {
  try {
    const klass = classOf(key);
    const need = sizeOf(key, value);
    if (need > CLASSES[klass].budget) return false;
    const idx = readIndex();
    const list = entries().filter((e) => e.key !== key);
    const oldest = (pred) => list.filter(pred).sort((a, b) => a.ts - b.ts)[0];
    let used = list.filter((e) => e.klass === klass).reduce((n, e) => n + e.bytes, 0);
    while (used + need > CLASSES[klass].budget) {
      const victim = oldest((e) => e.klass === klass);
      if (!victim) return false;
      used -= victim.bytes;
      evict(list, idx, victim.key);
    }
    let total = list.reduce((n, e) => n + e.bytes, 0) + need + 512;
    while (total > SOFT_CAP) {
      const victim = oldest((e) => !CLASSES[e.klass].keep && e.klass !== klass) || oldest((e) => !CLASSES[e.klass].keep);
      if (!victim) return false;
      total -= victim.bytes;
      evict(list, idx, victim.key);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        kino.storage.set(key, value);
        idx[key] = Date.now();
        writeIndex(idx);
        return true;
      } catch (_) {
        const victim = oldest((e) => !CLASSES[e.klass].keep);
        if (!victim) return false;
        evict(list, idx, victim.key);
      }
    }
    return false;
  } catch (_) {
    return false;
  }
}

// src/names.js
var ADULT = /(\bxxx\b|\badult[oa]?s?\b|\bporn\w*|\ber[oó]tic\w*|\bsex(o|y)?\b|\bhentai\b|\beros\b|\+\s?18|18\s?\+|\b18\s?plus\b)/i;
var isAdultName = (name) => ADULT.test(String(name || ""));
var KEEP_UPPER = /* @__PURE__ */ new Set(["NBA", "NFL", "NHL", "MLB", "UFC", "WNBA", "NCAAB", "PPV", "DAZN", "RFEF", "ESPN", "HBO", "CNN", "LMP", "VIX", "USA", "UK", "TV", "FHD", "HD", "LAT", "DC", "ABC", "NBC", "CBS", "TNT", "AMC", "SVT", "ITV", "BBC", "RAI", "ZDF", "CBC", "RTVE", "NHK"]);
var LOWER_WORDS = /* @__PURE__ */ new Set(["Y", "E", "O", "A", "DE", "DEL", "LA", "LAS", "LOS", "EL", "EN", "THE", "OF", "AND"]);
function titleCase(text2) {
  const s = String(text2 || "");
  if (/\p{Ll}/u.test(s)) return s;
  let first = true;
  return s.split(/([\s\-/]+)/).map((w) => {
    if (w === "" || /^[\s\-/]+$/.test(w)) return w;
    const letters = w.replace(/[^\p{L}]/gu, "");
    const atStart = first;
    first = false;
    if (/\d/.test(w) || KEEP_UPPER.has(letters)) return w;
    if (!atStart && LOWER_WORDS.has(letters)) return w.toLowerCase();
    if (letters.length <= 2 && letters === w) return w;
    return w.charAt(0) + w.slice(1).toLocaleLowerCase();
  }).join("");
}
function prettyLiveTitle(raw) {
  const original = String(raw || "").trim();
  let s = original.replace(/[︎️‍]/g, "");
  s = s.replace(/[^\p{L}\p{N}\s&+./'|,:()-]/gu, " ").replace(/\|/g, "   |   ");
  const chunks = s.split(/\s{3,}/).map((c) => c.trim()).filter(Boolean).map((c) => {
    if (c === "|") return "\xB7";
    return /^(?:[\p{L}\p{N}] ){2,}[\p{L}\p{N}]$/u.test(c) ? c.replace(/ /g, "") : c.replace(/\s+/g, " ");
  });
  const out = chunks.join(" ").replace(/^[\s\-·|:]+|[\s\-·|:]+$/g, "").trim();
  return out ? titleCase(out) : original;
}
var norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
var COUNTRY_PHRASES = [
  ["ARGENTINA", "AR"],
  ["BRASIL", "BR"],
  ["BRAZIL", "BR"],
  ["BOLIVIA", "BO"],
  ["CHILE", "CL"],
  ["COLOMBIA", "CO"],
  ["COSTA RICA", "CR"],
  ["CUBA", "CU"],
  ["CURACAO", "CW"],
  ["ECUADOR", "EC"],
  ["EL SALVADOR", "SV"],
  ["GUATEMALA", "GT"],
  ["HAITI", "HT"],
  ["HONDURAS", "HN"],
  ["JAMAIKA", "JM"],
  ["JAMAICA", "JM"],
  ["MEXICO", "MX"],
  ["NICARAGUA", "NI"],
  ["PANAMA", "PA"],
  ["PARAGUAY", "PY"],
  ["PERU", "PE"],
  ["PUERTO RICO", "PR"],
  ["R DOMINICANA", "DO"],
  ["REPUBLICA DOMINICANA", "DO"],
  ["DOMINICANA", "DO"],
  ["URUGUAY", "UY"],
  ["VENEZUELA", "VE"],
  ["ESPANA", "ES"],
  ["CANADA", "CA"],
  ["USA", "US"],
  ["ESTADOS UNIDOS", "US"],
  ["FRANCE", "FR"],
  ["GERMANY", "DE"],
  ["ITALY", "IT"],
  ["PORTUGAL", "PT"],
  ["UK", "GB"],
  ["NETHERLANDS", "NL"],
  ["MARRUECOS", "MA"]
].sort((a, b) => b[0].length - a[0].length);
function countryMatch(title2) {
  const t = norm(title2);
  const padded = ` ${t} `;
  for (const [phrase, cc] of COUNTRY_PHRASES) {
    if (padded.includes(` ${phrase} `)) return { cc, exact: t === phrase || t.replace(/ \d+$/, "") === phrase, starts: t.startsWith(phrase + " ") };
  }
  return null;
}
var countryOf = (title2) => {
  const m = countryMatch(title2);
  return m ? m.cc : null;
};
function liveGenreOf(title2) {
  const t = norm(title2);
  if (/\b(RADIO|MUSICA|MUSIC)\b/.test(t)) return "musica";
  if (/\b(KIDS|INFANTIL|INFANTILES|CARTOON|CARTOONS|ANIMACION|DIBUJOS)\b/.test(t)) return "infantil";
  if (/\bANIME\b/.test(t)) return "anime";
  if (/\b(DOCUMENTARY|DOCUMENTALES|DOCUMENTAL|SCIENCE|CULTURA)\b/.test(t)) return "documentales";
  if (/\b(NEWS|NOTICIAS)\b/.test(t)) return "noticias";
  if (/\b(SPORTS|SPORT|DEPORTES|FUTBOL|LEAGUE|LIGA|NBA|NFL|NHL|MLB|WNBA|UFC|NCAAB|F1|FORMULA|MOTOR|TENIS|BEISBOL|BASEBALL|CHAMPIONS|LIBERTADORES|SUDAMERICANA|PPV|EVENTOS|EVENTS|EVENT)\b/.test(t)) return "deportes";
  if (/\b(MOVIES|CINE|PELICULAS|FILM)\b/.test(t)) return "peliculas";
  if (/\b(SERIES|REALITY|NOVELAS)\b/.test(t)) return "series";
  if (/\b(ENTRETENIMIENTO|ENTERTAINMENT)\b/.test(t)) return "entretenimiento";
  return null;
}

// src/categoryTable.js
var LIVE = {
  "eventos diarios 03 11": ["Eventos Diarios 03/11", "", "deportes", "premium", 0, ""],
  "eventos diarios exclusivos": ["Eventos Diarios \xB7 Exclusivos", "", "deportes", "premium", 1, ""],
  "cine premium": ["Cine Premium", "", "peliculas", "premium", 2, ""],
  "deportes premium": ["Deportes Premium", "", "deportes", "premium", 4, ""],
  "movies channels usa": ["Movies Channels - USA", "US", "peliculas", "paises", 10003, ""],
  "documentary science usa": ["Documentary & Science - USA", "US", "documentales", "paises", 10007, ""],
  "entertainment usa": ["Entertainment - USA", "US", "entretenimiento", "paises", 10009, ""],
  "news usa": ["News - USA", "US", "noticias", "paises", 10013, ""],
  "kids cartoons usa": ["Kids & Cartoons - USA", "US", "infantil", "paises", 10015, ""],
  "usa 24 7 mix": ["USA - 24/7 - Mix", "US", "", "paises", 10029, ""],
  "cine box 24 7 usa": ["Cine Box - 24/7 - USA", "US", "peliculas", "paises", 10032, ""],
  "argentina": ["Argentina", "AR", "", "paises", 10047, ""],
  "brasil": ["Brasil", "BR", "", "paises", 10048, ""],
  "bolivia": ["Bolivia", "BO", "", "paises", 10050, ""],
  "bolivia 2 test": ["Bolivia 2 (test)", "BO", "", "paises", 10051, "h"],
  "canada general": ["Canada - General", "CA", "", "paises", 10052, ""],
  "canada cinema entertainment": ["Canada - Cinema - Entertainment", "CA", "entretenimiento", "paises", 10053, ""],
  "canada french": ["Canada - French", "CA", "", "paises", 10055, ""],
  "canada local": ["Canada - Local", "CA", "", "paises", 10056, ""],
  "canada kids": ["Canada - Kids", "CA", "infantil", "paises", 10057, ""],
  "chile": ["Chile", "CL", "", "paises", 10058, ""],
  "colombia": ["Colombia", "CO", "", "paises", 10059, ""],
  "colombia 2": ["Colombia 2", "CO", "", "paises", 10060, ""],
  "costa rica": ["Costa Rica", "CR", "", "paises", 10061, ""],
  "curacao": ["Cura\xE7ao", "CW", "", "paises", 10062, ""],
  "cuba": ["Cuba", "CU", "", "paises", 10063, ""],
  "ecuador": ["Ecuador", "EC", "", "paises", 10064, ""],
  "el salvador": ["EL Salvador", "SV", "", "paises", 10066, ""],
  "guatemala": ["Guatemala", "GT", "", "paises", 10067, ""],
  "haiti": ["Haiti", "HT", "", "paises", 10068, ""],
  "honduras": ["Honduras", "HN", "", "paises", 10069, ""],
  "jamaika": ["Jamaika", "JM", "", "paises", 10071, ""],
  "mexico": ["Mexico", "MX", "", "paises", 10072, ""],
  "vix mexico": ["VIX - Mexico", "MX", "", "paises", 10073, ""],
  "nicaragua": ["Nicaragua", "NI", "", "paises", 10075, ""],
  "panama": ["Panama", "PA", "", "paises", 10076, ""],
  "paraguay": ["Paraguay", "PY", "", "paises", 10077, ""],
  "peru": ["Peru", "PE", "", "paises", 10078, ""],
  "puerto rico": ["Puerto Rico", "PR", "", "paises", 10080, ""],
  "r dominicana": ["R. Dominicana", "DO", "", "paises", 10081, ""],
  "uruguay": ["Uruguay", "UY", "", "paises", 10083, ""],
  "uruguay 2": ["Uruguay 2", "UY", "", "paises", 10084, ""],
  "abc local usa": ["ABC - Local - USA", "US", "", "paises", 10085, ""],
  "cbs local usa": ["CBS Local - USA", "US", "", "paises", 10086, ""],
  "cw local usa": ["CW - Local - USA", "US", "", "paises", 10087, ""],
  "fox local usa": ["Fox - Local - USA", "US", "", "paises", 10089, ""],
  "nbc local usa": ["NBC - Local - USA", "US", "", "paises", 10090, ""],
  "venezuela": ["Venezuela", "VE", "", "paises", 10091, ""],
  "espana": ["Espa\xF1a", "ES", "", "paises", 10092, ""],
  "cine y series espana": ["Cine y Series Espa\xF1a", "ES", "peliculas", "paises", 10093, ""],
  "documentales espana": ["Documentales Espa\xF1a", "ES", "documentales", "paises", 10098, ""],
  "dazn espana": ["DAZN Espa\xF1a", "ES", "", "paises", 10099, ""],
  "espana autonomicos": ["Espa\xF1a - Autonomicos", "ES", "", "paises", 10101, ""],
  "france": ["France", "FR", "", "paises", 10102, ""],
  "germany": ["Germany", "DE", "", "paises", 10104, ""],
  "italy": ["Italy", "IT", "", "paises", 10105, ""],
  "marruecos": ["Marruecos", "MA", "", "paises", 10106, ""],
  "netherlands": ["Netherlands", "NL", "", "paises", 10107, ""],
  "portugal": ["Portugal", "PT", "", "paises", 10108, ""],
  "uk": ["UK", "GB", "", "paises", 10110, ""],
  "sports usa": ["Sports - USA", "US", "deportes", "deportes", 20005, ""],
  "directv sports ar co ec pe ch ur": ["Directv Sports AR-CO-EC-PE-CH-UR", "", "deportes", "deportes", 20016, ""],
  "champions league": ["Champions League", "", "deportes", "deportes", 20036, ""],
  "formula 1": ["Formula 1", "", "deportes", "deportes", 20037, ""],
  "motor event": ["Motor - Event", "", "deportes", "deportes", 20038, ""],
  "nba eventos": ["NBA Eventos", "", "deportes", "deportes", 20039, ""],
  "nhl eventos": ["NHL Eventos", "", "deportes", "deportes", 20040, ""],
  "nfl eventos": ["NFL Eventos", "", "deportes", "deportes", 20041, ""],
  "peacock events": ["Peacock Events", "", "deportes", "deportes", 20042, ""],
  "ppv events": ["PPV Events", "", "deportes", "deportes", 20043, ""],
  "tenis padel": ["Tenis / Padel", "", "deportes", "deportes", 20044, ""],
  "ufc eventos": ["UFC Eventos", "", "deportes", "deportes", 20045, ""],
  "wnba events": ["WNBA Events", "", "deportes", "deportes", 20046, ""],
  "brasil sports": ["Brasil Sports", "BR", "deportes", "deportes", 20049, ""],
  "canada sports": ["Canada - Sports", "CA", "deportes", "deportes", 20054, ""],
  "liga pro ec": ["Liga Pro EC", "", "deportes", "deportes", 20065, ""],
  "deportes honduras": ["Deportes Honduras", "HN", "deportes", "deportes", 20070, ""],
  "liga mexicana baseball lmp": ["Liga Mexicana Baseball - LMP", "", "deportes", "deportes", 20074, ""],
  "deportes peru": ["Deportes Peru", "PE", "deportes", "deportes", 20079, ""],
  "beisbol r dominicana": ["Beisbol R. Dominicana", "DO", "deportes", "deportes", 20082, ""],
  "liga endesa": ["Liga Endesa", "", "deportes", "deportes", 20094, ""],
  "futbol espana": ["Futbol Espa\xF1a", "ES", "deportes", "deportes", 20095, ""],
  "deportes espana": ["Deportes Espa\xF1a", "ES", "deportes", "deportes", 20097, ""],
  "france sports": ["France Sports", "FR", "deportes", "deportes", 20103, ""],
  "portugal sports": ["Portugal Sports", "PT", "deportes", "deportes", 20109, ""],
  "uk sports": ["UK Sports", "GB", "deportes", "deportes", 20111, ""],
  "deportes arabes": ["Deportes Arabes", "", "deportes", "deportes", 20112, ""],
  "conference league": ["Conference League", "", "deportes", "deportes", 20113, ""],
  "copa sudamericana": ["Copa Sudamericana", "", "deportes", "deportes", 20114, ""],
  "europa league": ["Europa League", "", "deportes", "deportes", 20115, ""],
  "libertadores": ["Libertadores", "", "deportes", "deportes", 20116, ""],
  "mlb eventos": ["MLB Eventos", "", "deportes", "deportes", 20117, ""],
  "ncaab solo eventos": ["NCAAB - Solo Eventos", "", "deportes", "deportes", 20118, ""],
  "nfl teams only events": ["NFL Teams - Only Events", "", "deportes", "deportes", 20119, ""],
  "premier league": ["Premier League", "", "deportes", "deportes", 20120, ""],
  "todo motor": ["Todo Motor", "", "deportes", "deportes", 20121, ""],
  "cultura": ["Cultura", "", "documentales", "tematicos", 30006, ""],
  "entretenimiento": ["Entretenimiento", "", "entretenimiento", "tematicos", 30008, ""],
  "noticias": ["Noticias", "", "noticias", "tematicos", 30012, ""],
  "infantiles": ["Infantiles", "", "infantil", "tematicos", 30014, ""],
  "24 7 animacion": ["24/7 - Animacion", "", "infantil", "tematicos", 30017, ""],
  "24 7 dibujos animados n": ["24/7 - Dibujos Animados-N", "", "infantil", "tematicos", 30020, ""],
  "24 7 series y reality n": ["24/7 - Series y Reality-N", "", "series", "tematicos", 30021, ""],
  "24 7 peliculas n": ["24/7 - Peliculas-N", "", "peliculas", "tematicos", 30022, ""],
  "24 7 anime": ["24/7 Anime", "", "anime", "tematicos", 30023, ""],
  "24 7 documentales": ["24/7 - Documentales", "", "documentales", "tematicos", 30024, ""],
  "extra cine": ["Extra Cine", "", "peliculas", "tematicos", 30026, ""],
  "novelas y novelas": ["Novelas y Novelas", "", "series", "tematicos", 30027, ""],
  "musica": ["Musica", "", "musica", "tematicos", 30033, ""],
  "radio 60 70": ["Radio 60,70", "", "musica", "radio", 40122, ""],
  "radio 80 90": ["Radio 80,90", "", "musica", "radio", 40123, ""],
  "radio alternativo": ["Radio Alternativo", "", "musica", "radio", 40124, ""],
  "radio cristiana": ["Radio Cristiana", "", "musica", "radio", 40125, ""],
  "radio clasica": ["Radio Clasica", "", "musica", "radio", 40126, ""],
  "radio club": ["Radio Club", "", "musica", "radio", 40127, ""],
  "radio pop": ["Radio Pop", "", "musica", "radio", 40128, ""],
  "radio retro": ["Radio Retro", "", "musica", "radio", 40129, ""],
  "radio dance": ["Radio Dance", "", "musica", "radio", 40130, ""],
  "radio disco": ["Radio Disco", "", "musica", "radio", 40131, ""],
  "radio electronica": ["Radio Electronica", "", "musica", "radio", 40132, ""],
  "radio hard rock": ["Radio Hard Rock", "", "musica", "radio", 40133, ""],
  "radio hip hop": ["Radio Hip Hop", "", "musica", "radio", 40134, ""],
  "radio jazz": ["Radio Jazz", "", "musica", "radio", 40135, ""],
  "radio latino": ["Radio Latino", "", "musica", "radio", 40136, ""],
  "radio reggae": ["Radio Reggae", "", "musica", "radio", 40137, ""],
  "radio salsa": ["Radio Salsa", "", "musica", "radio", 40138, ""],
  "radio sinfonica": ["Radio Sinfon\xEDca", "", "musica", "radio", 40139, ""],
  "radio techno": ["Radio Techno", "", "musica", "radio", 40140, ""],
  "radio metal": ["Radio Metal", "", "musica", "radio", 40141, ""],
  "telemundo unimas univision galavision": ["Telemundo-Unimas-Univision-Galavision", "", "", "otros", 50010, ""],
  "telemundo unimas univision galavision opc2": ["Telemundo - Unimas - Univision - Galavision OPC2", "", "", "otros", 50011, ""],
  "24 7 comedia": ["24/7 - Comedia", "", "", "otros", 50018, ""],
  "24 7 programas de tv": ["24/7 - Programas de TV", "", "", "otros", 50019, ""],
  "24 7 temporal": ["24/7 - Temporal", "", "", "otros", 50025, "h"],
  "vix": ["VIX", "", "", "otros", 50028, ""],
  "gran hermano uy": ["Gran Hermano UY", "", "", "otros", 50030, ""],
  "la granja vip": ["LA Granja Vip", "", "", "otros", 50031, ""],
  "religion": ["Religion", "", "", "otros", 50034, ""],
  "club fight": ["Club Fight", "", "", "otros", 50035, ""],
  "testapp": ["Testapp", "", "", "otros", 50088, "h"],
  "rfef tv": ["RFEF TV", "", "", "otros", 50100, ""],
  "adultos": ["Adultos", "", "", "otros", 50142, "a"]
};

// src/categoryRules.js
var LIVE_GROUPS = ["premium", "paises", "deportes", "tematicos", "radio", "otros"];
var normKey = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function liveGroupOf(title2, country, genre) {
  const t = normKey(title2);
  if (/\b(premium|eventos diarios|exclusivos)\b/.test(t)) return "premium";
  if (/^radio\b/.test(t)) return "radio";
  if (genre === "deportes") return "deportes";
  if (country) return "paises";
  if (genre) return "tematicos";
  return "otros";
}
function fallbackLive(name, i) {
  const title2 = prettyLiveTitle(name);
  const country = countryOf(title2) || countryOf(name) || "";
  const genre = liveGenreOf(title2) || liveGenreOf(name) || "";
  const group = liveGroupOf(title2, country, genre);
  return { name, title: title2, country, genre, group, order: LIVE_GROUPS.indexOf(group) * 1e4 + 9e3 + Math.min(i, 999), adult: isAdultName(name), known: false };
}

// src/categories.js
function mergeLive(list, { showAdult: showAdult2 = false } = {}) {
  const seen = /* @__PURE__ */ new Map();
  const out = [];
  (Array.isArray(list) ? list : []).forEach((c, i) => {
    const id = String(c.category_id || "");
    const name = String(c.category_name || "").trim();
    if (!id || !name) return;
    const key = normKey(prettyLiveTitle(name));
    const e = LIVE[key];
    let cat;
    if (e) {
      const [title2, country, genre, group, order, flags] = e;
      if (flags.includes("h")) return;
      cat = { id, name, title: title2, country, genre, group, order, adult: flags.includes("a"), known: true };
    } else cat = { id, ...fallbackLive(name, i) };
    if (cat.adult && !showAdult2) return;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 1) cat.title = `${cat.title} (${n})`;
    out.push(cat);
  });
  return out.sort((a, b) => a.order - b.order);
}

// src/catalog.js
var BOOTSTRAP_URL = "http://vegetatvv2.duckdns.org/bootstrap.php";
var VEGETA_VERSION_CODE = "21";
var CACHE_TTL_MS = 6 * 60 * 60 * 1e3;
var SRVS_V = 2;
var PER_PAGE = 60;
function cfg(key, fallback) {
  try {
    const v = kino.config.get(key);
    return v === void 0 || v === null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}
var showAdult = () => cfg("showAdult", false) === true;
var liveFormat = () => cfg("liveFormat", "m3u8") === "ts" ? "ts" : "m3u8";
function parseServerLine(line) {
  const url = line.split(/\s/)[0].trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    if (!path.endsWith("player_api.php") && !path.endsWith("get.php")) return null;
    const username = u.searchParams.get("username") || u.searchParams.get("user") || "";
    const password = u.searchParams.get("password") || u.searchParams.get("pass") || "";
    if (!username) return null;
    const base = (u.protocol + "//" + u.host).replace(/\/+$/, "");
    const name = line.slice(url.length).trim().replace(/^\[|\]$/g, "").trim().slice(0, 40);
    return { url: base, username, password, ...name ? { name } : {} };
  } catch (_) {
    return null;
  }
}
var vegetaHeaders = (code) => ({
  "X-Vegeta-Version-Code": String(code),
  "X-Vegeta-Servers-Direct": "1",
  "Cache-Control": "no-cache, no-store",
  "Pragma": "no-cache"
});
function readVersionCode() {
  try {
    const v = String(kino.storage.get("vcode") || "");
    return /^\d+$/.test(v) && Number(v) >= Number(VEGETA_VERSION_CODE) ? v : VEGETA_VERSION_CODE;
  } catch (_) {
    return VEGETA_VERSION_CODE;
  }
}
var MAX_SERVERS = 30;
function parseServers(text2) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const line of String(text2).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const s = parseServerLine(t);
    if (!s) continue;
    const key = s.url + "|" + s.username;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.sort((a, b) => (b.url.startsWith("https://") ? 1 : 0) - (a.url.startsWith("https://") ? 1 : 0));
}
async function fetchServerList() {
  let code = readVersionCode();
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await kino.fetch(BOOTSTRAP_URL + "?v=" + Date.now(), { headers: { ...vegetaHeaders(code), "Accept": "application/json" } });
    let data = null;
    try {
      data = r.json();
    } catch (_) {
      data = null;
    }
    if (!r.ok || !data || data.ok === false) {
      const want = data ? Math.max(Number(data.minimum_version_code) || 0, Number(data.latest_version_code) || 0) : 0;
      if (attempt === 0 && want > Number(code)) {
        code = String(want);
        continue;
      }
      throw kino.error("unavailable", "bootstrap " + r.status, { userMessage: "No se pudo conectar con el servicio." });
    }
    let list = [];
    if (typeof data.servers_text === "string" && data.servers_text.trim()) list = parseServers(data.servers_text);
    if (!list.length && typeof data.servers_url === "string" && data.servers_url.trim()) {
      const r2 = await kino.fetch(data.servers_url, { headers: { ...vegetaHeaders(code), "Accept": "text/plain" } });
      if (r2.ok) list = parseServers(r2.text());
    }
    if (!list.length) {
      const want = Math.max(Number(data.minimum_version_code) || 0, Number(data.latest_version_code) || 0);
      if (attempt === 0 && want > Number(code)) {
        code = String(want);
        continue;
      }
      throw kino.error("unavailable", "bootstrap: sin servidores", { userMessage: "El servicio no tiene servidores disponibles." });
    }
    put("vcode", String(code));
    return list.slice(0, MAX_SERVERS);
  }
  throw kino.error("unavailable", "bootstrap: sin servidores", { userMessage: "El servicio no tiene servidores disponibles." });
}
function keyOf(srv) {
  if (!srv || !srv.url) return "";
  let h = 5381;
  const text2 = srv.url + "|" + srv.username;
  for (let i = 0; i < text2.length; i++) h = (h << 5) + h + text2.charCodeAt(i) | 0;
  return (h >>> 0).toString(36);
}
function serverKey() {
  const st = readSrvs();
  const srv = st && Array.isArray(st.list) ? st.list[st.idx] : null;
  return keyOf(srv);
}
function serverByKey(k) {
  const st = readSrvs();
  if (!st || !Array.isArray(st.list)) return null;
  return st.list.find((s) => keyOf(s) === k) || null;
}
function readSrvs() {
  try {
    return JSON.parse(kino.storage.get("srvs") || "null");
  } catch (_) {
    return null;
  }
}
function writeSrvs(st) {
  put("srvs", JSON.stringify(st));
}
async function loadServers(force) {
  const cached = readSrvs();
  const usable = cached && Array.isArray(cached.list) && cached.list.length;
  if (!force && usable && cached.ts && cached.v === SRVS_V && Date.now() - cached.ts < CACHE_TTL_MS) return cached;
  try {
    const list = await fetchServerList();
    const st = { ts: Date.now(), list, idx: 0, ok: false, v: SRVS_V };
    writeSrvs(st);
    return st;
  } catch (e) {
    lastErr = "lista: " + errText(e);
    if (usable) return cached;
    throw e;
  }
}
function badAnswer(action2, data) {
  if (data === null || typeof data !== "object") return true;
  if (!Array.isArray(data)) {
    const auth = data.user_info && data.user_info.auth;
    return auth !== void 0 && String(auth) === "0";
  }
  return data.length === 0 && action2.endsWith("_categories");
}
async function callServer(srv, action2, extra) {
  const params = new URLSearchParams({ username: srv.username, password: srv.password, action: action2, ...extra });
  const r = await kino.fetch(`${srv.url}/player_api.php?${params}`, {
    headers: {
      "Accept": "application/json,text/plain,*/*",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "User-Agent": "Mozilla/5.0 (compatible; VegetaTVCache/2.0)"
    }
  });
  if (!r.ok) throw new Error("API " + r.status);
  const data = r.json();
  if (badAnswer(action2, data)) throw new Error("respuesta inv\xE1lida");
  return data;
}
function homeIdx(_st) {
  return 0;
}
async function backHome() {
  const st = await loadServers(false);
  const home2 = homeIdx(st);
  if (st.idx === home2 || st.pin || Date.now() - (st.homeAt || 0) < 3e5) return;
  st.homeAt = Date.now();
  try {
    await callServer(st.list[home2], "get_vod_categories", {});
    st.idx = home2;
    st.ok = true;
    st.okAt = Date.now();
  } catch (_) {
  }
  writeSrvs(st);
}
async function api(action2, extra = {}) {
  let last = "";
  for (let pass = 0; pass < 2; pass++) {
    const st = await loadServers(pass === 1);
    if (pass === 0) await backHome();
    const st2 = readSrvs();
    if (st2 && pass === 0) {
      st.idx = st2.idx;
      st.ok = st2.ok;
      st.okAt = st2.okAt;
      st.homeAt = st2.homeAt;
    }
    for (let n = 0; n < st.list.length; n++) {
      const i = (st.idx + n) % st.list.length;
      try {
        const data = await callServer(st.list[i], action2, extra);
        if (i !== st.idx || !st.ok || Date.now() - (st.okAt || 0) > 5e3) {
          st.idx = i;
          st.ok = true;
          st.okAt = Date.now();
          writeSrvs(st);
        }
        return data;
      } catch (e) {
        if (e && e.code === "rate_limited") throw e;
        last = String(e && e.message || e).slice(0, 80);
        lastErr = last;
      }
    }
  }
  throw kino.error("unavailable", "ning\xFAn servidor respondi\xF3 (" + action2 + "): " + last, { userMessage: "Error al contactar el servidor." });
}
async function activeServer() {
  let st = await loadServers(false);
  if (!st.ok) {
    await api("get_vod_categories");
    st = readSrvs();
  }
  return st.list[st.idx];
}
var lastErr = "";
var errText = (e) => String(e && (e.message || e.code) || e).slice(0, 90);
var img = (u) => {
  const s = typeof u === "string" ? u.trim() : "";
  if (!s) return void 0;
  return /^http:\/\//i.test(s) ? "https://" + s.slice(7).replace(/^([^/:]+):80(?=\/|$)/, "$1") : s;
};
var hostOf = (srv) => {
  try {
    return new URL(srv.url).host;
  } catch (_) {
    return "";
  }
};
var labelOf = (srv) => srv && srv.name ? srv.name : hostOf(srv);
var FLAG_NAMES = { AR: "Argentina", BO: "Bolivia", BR: "Brasil", CA: "Canad\xE1", CL: "Chile", CO: "Colombia", CR: "Costa Rica", CU: "Cuba", DE: "Alemania", DO: "Rep. Dominicana", EC: "Ecuador", ES: "Espa\xF1a", FR: "Francia", GB: "Reino Unido", GT: "Guatemala", HN: "Honduras", IT: "Italia", MX: "M\xE9xico", NI: "Nicaragua", PA: "Panam\xE1", PE: "Per\xFA", PR: "Puerto Rico", PT: "Portugal", PY: "Paraguay", SV: "El Salvador", US: "EE. UU.", UY: "Uruguay", VE: "Venezuela" };
function flagInfo(s) {
  const cp = [...String(s || "")];
  if (cp.length >= 2) {
    const a = cp[0].codePointAt(0), b = cp[1].codePointAt(0);
    if (a >= 127462 && a <= 127487 && b >= 127462 && b <= 127487) {
      const code = String.fromCharCode(a - 127462 + 65) + String.fromCharCode(b - 127462 + 65);
      return { code: code.toLowerCase(), name: FLAG_NAMES[code] || code };
    }
  }
  return String(s || "").includes("\u{1F310}") ? { code: "", name: "Global" } : null;
}
var niceLabel = (srv) => {
  const fi = flagInfo(labelOf(srv));
  return fi ? fi.code ? `${fi.code.toUpperCase()} \xB7 ${fi.name}` : fi.name : labelOf(srv);
};
async function serverStatus() {
  const cached = readSrvs();
  if (cached && cached.ok && cached.list && cached.list[cached.idx] && Date.now() - (cached.okAt || 0) < 2e4) return { ok: true, host: hostOf(cached.list[cached.idx]), index: cached.idx + 1, total: cached.list.length, at: cached.okAt };
  try {
    await api("get_vod_categories");
    const st = readSrvs();
    return { ok: true, host: hostOf(st.list[st.idx]), index: st.idx + 1, total: st.list.length, at: st.okAt };
  } catch (e) {
    lastErr = errText(e);
    const st = readSrvs();
    return { ok: false, host: st && st.list[st.idx] ? hostOf(st.list[st.idx]) : "", index: st ? st.idx + 1 : 0, total: st ? st.list.length : 0 };
  }
}
async function switchServer() {
  const st = await loadServers(false);
  const n = st.list.length;
  const https = st.list.filter((s) => String(s.url).startsWith("https://")).length;
  for (let k = 1; k < n; k++) {
    const i = (st.idx + k) % n;
    try {
      await callServer(st.list[i], "get_vod_categories", {});
      st.idx = i;
      st.ok = true;
      st.okAt = Date.now();
      st.pin = i !== homeIdx(st);
      writeSrvs(st);
      return { changed: true, host: hostOf(st.list[i]), index: i + 1, total: n };
    } catch (e) {
      lastErr = errText(e);
    }
  }
  return { changed: false, host: hostOf(st.list[st.idx]), index: st.idx + 1, total: n, https };
}
var LATAM = /* @__PURE__ */ new Set(["ar", "bo", "cl", "co", "cr", "cu", "do", "ec", "gt", "hn", "ni", "pa", "pe", "pr", "py", "sv", "uy", "ve"]);
function srvPriority(x) {
  const code = (x.flag || "").toLowerCase();
  if (code === "es" || code === "mx" || /latino|latam/.test(String(x.label || "").toLowerCase())) return 0;
  if (LATAM.has(code)) return 1;
  if (!code) return 2;
  return 3;
}
async function serverList() {
  const st = await loadServers(false);
  const h = healthFresh();
  const online = h ? new Set(h.online) : null;
  let items = (st.list || []).map((s, i) => {
    const fi = flagInfo(labelOf(s));
    return { i, label: niceLabel(s), host: hostOf(s), https: String(s.url).startsWith("https://"), flag: fi ? fi.code : "", online: online ? online.has(s.url) : true };
  });
  if (online && online.size > 0) items = items.filter((x) => x.online);
  items.sort((a, b) => srvPriority(a) - srvPriority(b) || a.i - b.i);
  return { current: st.idx, items, checked: !!h };
}
async function selectServer(i) {
  const st = await loadServers(false);
  const n = st.list.length;
  const start = parseInt(i, 10);
  if (!(start >= 0 && start < n)) return { ok: false };
  const wantLabel = labelOf(st.list[start]);
  const all = Array.from({ length: n }, (_, k) => k);
  const order = [start, ...all.filter((k) => k !== start && labelOf(st.list[k]) === wantLabel)].slice(0, 5);
  for (const idx of order) {
    try {
      await callServer(st.list[idx], "get_live_categories", {});
      st.idx = idx;
      st.ok = true;
      st.okAt = Date.now();
      st.pin = idx !== homeIdx(st);
      writeSrvs(st);
      return { ok: true, host: hostOf(st.list[idx]), label: labelOf(st.list[idx]), index: idx + 1, total: n, exact: idx === start };
    } catch (e) {
      lastErr = errText(e);
    }
  }
  return { ok: false, host: hostOf(st.list[start]), label: labelOf(st.list[start]), index: start + 1, total: n };
}
var HEALTH_KEY = "health:v1";
var HEALTH_TTL_MS = 30 * 60 * 1e3;
var healthRunning = false;
function readHealth() {
  try {
    const o = JSON.parse(kino.storage.get(HEALTH_KEY) || "null");
    return o && Array.isArray(o.online) && typeof o.ts === "number" ? o : null;
  } catch (_) {
    return null;
  }
}
var healthFresh = () => {
  const h = readHealth();
  return h && Date.now() - h.ts < HEALTH_TTL_MS ? h : null;
};
var healthReady = () => !!healthFresh();
var probeAlive = async (srv) => {
  try {
    await callServer(srv, "get_live_categories", {});
    return true;
  } catch (_) {
    return false;
  }
};
async function healthCheck() {
  if (healthRunning) return 0;
  healthRunning = true;
  try {
    const st = await loadServers(false);
    const list = st.list || [];
    const results = await Promise.all(list.map(async (s) => await probeAlive(s) ? s.url : null));
    const online = results.filter(Boolean);
    put(HEALTH_KEY, JSON.stringify({ ts: Date.now(), online }));
    const cur = list[st.idx];
    if (cur && online.length && !online.includes(cur.url)) {
      const i = list.findIndex((s) => s.url === online[0]);
      if (i >= 0) {
        st.idx = i;
        st.ok = true;
        st.okAt = Date.now();
        st.pin = true;
        writeSrvs(st);
      }
    }
    return online.length;
  } catch (_) {
    try {
      put(HEALTH_KEY, JSON.stringify({ ts: Date.now(), online: [] }));
    } catch (__) {
    }
    return 0;
  } finally {
    healthRunning = false;
  }
}
async function refreshServers() {
  const before = readSrvs();
  const st = await loadServers(true);
  const fresh = !before || st.ts !== before.ts;
  let ok = fresh;
  if (fresh) {
    try {
      await api("get_vod_categories");
    } catch (_) {
    }
  }
  const now = readSrvs() || st;
  return { ok, total: now.list.length, host: hostOf(now.list[now.idx]) };
}
async function settingsStatus() {
  const s = await serverStatus();
  if (!s.ok) return { status: (s.host ? `Sin respuesta de ${s.host}` : "Sin conexi\xF3n con el servicio") + (lastErr ? ` \xB7 ${lastErr}` : "") };
  return { status: `Conectado a ${s.host} (${s.index} de ${s.total}) \xB7 comprobado ${s.at ? "hace " + Math.max(0, Math.round((Date.now() - s.at) / 1e3)) + " s" : "ahora"}` };
}
async function action(key) {
  if (key === "switchServer") {
    const r = await switchServer();
    return { message: r.changed ? `Servidor cambiado a ${r.host}` : "No hay otro servidor que responda ahora" + (lastErr ? ` (${lastErr})` : ""), refresh: true };
  }
  if (key === "refreshServers") {
    const r = await refreshServers();
    return { message: r.ok ? `Lista actualizada: ${r.total} servidores` : "No se pudo actualizar la lista" + (lastErr ? ` (${lastErr})` : ""), refresh: true };
  }
  throw kino.error("not_found");
}
async function fetchCategory(action2, categoryId) {
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await api(action2, { category_id: String(categoryId) });
      if (!Array.isArray(data)) throw new Error("respuesta que no es lista");
      return data;
    } catch (e) {
      if (attempt >= 1 || e && e.code === "rate_limited") throw e;
    }
  }
}
var CAT_ACTIONS = { vod: "get_vod_categories", series: "get_series_categories", live: "get_live_categories" };
var catMemo = {};
async function categoryList(kind) {
  const key = serverKey();
  const m = catMemo[kind];
  if (key && m && m.key === key && Date.now() - m.ts < CACHE_TTL_MS) return m.list;
  if (key) {
    try {
      const o = JSON.parse(kino.storage.get("cats:" + kind + ":" + key) || "null");
      if (o && Array.isArray(o.l) && Date.now() - o.ts < CACHE_TTL_MS) {
        const list2 = o.l.map(([category_id, category_name]) => ({ category_id, category_name }));
        catMemo[kind] = { key, ts: o.ts, list: list2 };
        return list2;
      }
    } catch (_) {
    }
  }
  const data = await api(CAT_ACTIONS[kind]);
  const list = (Array.isArray(data) ? data : []).map((c) => ({ category_id: String(c.category_id || ""), category_name: String(c.category_name || "").trim() }));
  const now = serverKey();
  catMemo[kind] = { key: now, ts: Date.now(), list };
  put("cats:" + kind + ":" + now, JSON.stringify({ ts: Date.now(), l: list.map((c) => [c.category_id, c.category_name]) }));
  return list;
}
var LIVE_PAGE = 200;
var LIVE_CATS_TTL_MS = 10 * 60 * 1e3;
var liveCatsMemo = null;
async function liveCats() {
  const key = serverKey();
  if (liveCatsMemo && key && liveCatsMemo.key === key && Date.now() - liveCatsMemo.ts < LIVE_CATS_TTL_MS) return liveCatsMemo.list;
  const merged = mergeLive(await categoryList("live"), { showAdult: true });
  liveCatsMemo = { key: serverKey(), ts: Date.now(), list: merged };
  return merged;
}
var visibleLive = (list) => showAdult() ? list : list.filter((c) => !c.adult);
async function liveCategories() {
  return visibleLive(await liveCats()).map((c) => ({
    id: c.id,
    title: c.title,
    group: c.group,
    ...c.country ? { country: c.country } : {},
    ...c.genre ? { genre: c.genre } : {},
    ...c.adult ? { adult: true } : {}
  }));
}
async function browse(ref, cursor) {
  const [prefix, catId] = String(ref || "").split(":");
  if (prefix !== "lcat" || !/^\d+$/.test(catId || "")) return { items: [] };
  const page = Math.max(1, parseInt(cursor, 10) || 1);
  const start = (page - 1) * PER_PAGE;
  const out = await liveChannels({ categoryId: catId });
  const all = out.items.map((i) => ({ id: i.id, ref: i.ref, title: i.title, kind: "live", poster: i.logo, ...i.adult ? { adult: true } : {} }));
  return { items: all.slice(start, start + PER_PAGE), next: all.length > start + PER_PAGE ? String(page + 1) : void 0 };
}
function liveItem(s, categoryId, adult) {
  const id = String(s.stream_id || "");
  const title2 = String(s.name || "").trim();
  if (!id || !title2) return null;
  return {
    id: "live-" + id,
    title: title2,
    ref: "live:" + id,
    logo: img(s.stream_icon),
    number: parseInt(s.num, 10) || void 0,
    categoryId: String(categoryId || s.category_id || ""),
    ...adult ? { adult: true } : {}
  };
}
async function liveChannels({ categoryId, cursor }) {
  const cat = (await liveCats().catch(() => [])).find((c) => c.id === String(categoryId));
  const adult = !!(cat && cat.adult);
  if (adult && !showAdult()) return { items: [] };
  const all = await fetchCategory("get_live_streams", String(categoryId || ""));
  const start = Math.max(0, parseInt(cursor, 10) || 0);
  const items = all.slice(start, start + LIVE_PAGE).map((s) => liveItem(s, categoryId, adult)).filter(Boolean);
  return { items, next: all.length > start + LIVE_PAGE ? String(start + LIVE_PAGE) : void 0 };
}
async function liveSearchDetailed({ query }, { budgetMs = 11e3 } = {}) {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < 2) return { items: [], partial: false };
  const deadline = Date.now() + budgetMs;
  const cats = visibleLive(await liveCats());
  const LIMIT = 100;
  const MAX_CATS = 36;
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  let failed = 0;
  let capped = false;
  let scanned = 0;
  for (let i = 0; i < cats.length && items.length < LIMIT; i += 3) {
    if (scanned >= MAX_CATS || Date.now() > deadline) {
      capped = true;
      break;
    }
    const slice = cats.slice(i, i + 3);
    scanned += slice.length;
    const batch = await Promise.all(slice.map(async (cat) => {
      try {
        const data = await fetchCategory("get_live_streams", cat.id);
        return data.filter((s) => String(s.name || "").toLowerCase().includes(q)).map((s) => liveItem(s, cat.id, cat.adult)).filter(Boolean).map((it) => ({ ...it, adult: cat.adult === true }));
      } catch (e) {
        if (e && e.code === "rate_limited") capped = true;
        else failed++;
        return [];
      }
    }));
    for (const list of batch) for (const it of list) if (items.length < LIMIT && !seen.has(it.id)) {
      seen.add(it.id);
      items.push(it);
    }
    if (capped) break;
  }
  if (items.length < LIMIT && scanned < cats.length) capped = true;
  if (!items.length && failed) throw kino.error("unavailable", "la b\xFAsqueda no pudo completarse", { userMessage: "No se pudo completar la b\xFAsqueda." });
  return { items, partial: failed > 0 || capped };
}
async function liveSearch(args) {
  const { items } = await liveSearchDetailed(args);
  return { items };
}
var liveCard = (it) => ({ id: it.id, ref: it.ref, title: it.title, kind: "live", poster: it.logo, ...it.adult ? { adult: true } : {} });
async function home() {
  const cats = (await liveCategories()).slice(0, 10);
  const rows = [];
  for (let i = 0; i < cats.length; i += 3) {
    const batch = await Promise.all(cats.slice(i, i + 3).map(async (c) => {
      try {
        const page = await liveChannels({ categoryId: c.id });
        const items = page.items.slice(0, 20).map(liveCard);
        return items.length ? { id: "lcat-" + c.id, title: c.title, genre: "tv", ref: "lcat:" + c.id, items } : null;
      } catch (_) {
        return null;
      }
    }));
    rows.push(...batch.filter(Boolean));
  }
  if (!rows.length) throw kino.error("unavailable", "sin canales", { userMessage: "Sin canales disponibles por ahora." });
  return rows;
}
async function search(query) {
  const q = String(query && query.q || query || "").trim();
  if (!q) return [];
  const { items } = await liveSearchDetailed({ query: q });
  return items.map(liveCard);
}
function b64text(s) {
  const str = String(s || "");
  if (!str) return "";
  try {
    const bin = atob(str);
    let out = "";
    for (let i = 0; i < bin.length; i++) out += "%" + bin.charCodeAt(i).toString(16).padStart(2, "0");
    return decodeURIComponent(out);
  } catch (_) {
    return str;
  }
}
async function guide({ channelIds, from, to }) {
  const ids = (Array.isArray(channelIds) ? channelIds : []).slice(0, 50);
  const lists = await Promise.all(ids.map(async (cid) => {
    const streamId = String(cid).replace(/^live-/, "");
    if (!/^\d+$/.test(streamId)) return [];
    try {
      const data = await api("get_short_epg", { stream_id: streamId, limit: "20" });
      const rows = Array.isArray(data) ? data : data && (data.epg_listings || data.listings || data.epg) || [];
      return rows.map((e) => ({
        channelId: String(cid),
        title: b64text(e.title),
        description: b64text(e.description || e.descr),
        start: (parseInt(e.start_timestamp, 10) || 0) * 1e3,
        end: (parseInt(e.stop_timestamp || e.end_timestamp, 10) || 0) * 1e3
      })).filter((e) => e.title && e.end > e.start && e.end > from && e.start < to);
    } catch (_) {
      return [];
    }
  }));
  return lists.flat();
}
function buildAlternatives(id, activeKey) {
  const st = readSrvs();
  if (!id || !st || !Array.isArray(st.list)) return [];
  const h = healthFresh();
  const online = h ? new Set(h.online) : null;
  const countBy = {};
  const out = [];
  for (const srv of st.list) {
    const k = keyOf(srv);
    if (!k || k === activeKey) continue;
    if (online && !online.has(srv.url)) continue;
    const base = niceLabel(srv);
    countBy[base] = (countBy[base] || 0) + 1;
    out.push({ k, base, host: hostOf(srv) });
  }
  const label = (e) => countBy[e.base] > 1 && e.host ? `${e.base} \xB7 ${e.host}` : e.base;
  return out.slice(0, 12).map((e) => ({ label: label(e), ref: `at:${e.k}~l~${id}` }));
}
async function resolve(ref) {
  const s = String(ref || "");
  if (s.startsWith("at:")) {
    const segs = s.slice(3).split("~");
    const srv = serverByKey(segs[0]);
    const id = segs[2] || "";
    if (!srv || segs[1] !== "l" || !/^\d+$/.test(id)) throw kino.error("not_found", "fuente desconocida");
    return { url: `${srv.url}/live/${srv.username}/${srv.password}/${id}.${liveFormat()}` };
  }
  const active = await activeServer();
  const { url, username, password } = active;
  if (s.startsWith("live:")) {
    const id = s.slice(5).split("~")[0];
    if (!/^\d+$/.test(id)) throw kino.error("not_found");
    const out = { url: `${url}/live/${username}/${password}/${id}.${liveFormat()}` };
    const alts = buildAlternatives(id, serverKey());
    if (alts.length) {
      out.alternatives = alts;
      out.label = niceLabel(active);
    }
    return out;
  }
  throw kino.error("not_found", "ref desconocido: " + s.slice(0, 30));
}

// src/i18n.js
var TEXTS = Object.freeze({
  tabAll: ["Todo", "All"],
  tabPremium: ["Premium", "Premium"],
  tabCountries: ["Pa\xEDses", "Countries"],
  tabSports: ["Deportes", "Sports"],
  tabRadio: ["Radio", "Radio"],
  search: ["Buscar", "Search"],
  searchTitle: ["Buscar canales", "Search channels"],
  searchHint: ["Nombre del canal", "Channel name"],
  searchFailed: ["La b\xFAsqueda fall\xF3.", "The search failed."],
  noResults: ["No encontramos ning\xFAn canal con esas palabras.", "No channel found for those words."],
  searchedBefore: ["Buscado antes", "Searched before"],
  retry: ["Reintentar", "Retry"],
  seeAll: ["Ver todos", "See all"],
  back: ["Atr\xE1s", "Back"],
  close: ["Cerrar", "Close"],
  settings: ["Ajustes", "Settings"],
  live: ["En vivo", "Live"],
  liveCategory: ["Categor\xEDa", "Category"],
  liveEmpty: ["No hay canales para mostrar.", "No channels to show."],
  liveMore: ["Se muestran los primeros {n}. Usa la b\xFAsqueda para encontrar otros.", "Showing the first {n}. Use search to find others."],
  partial: ["Algunas filas no cargaron.", "Some rows did not load."],
  searchPartial: ["Resultados parciales: no se revisaron todas las categor\xEDas (el servidor limita las peticiones).", "Partial results: not every category was checked (the server limits requests)."],
  verifying: ["Verificando servidores\u2026", "Checking servers\u2026"],
  firstPickTitle: ["Elige tu servidor", "Choose your server"],
  firstPickHint: ["Elige desde d\xF3nde ver. El primero ya est\xE1 listo; puedes elegir otro. Luego lo cambias cuando quieras con el bot\xF3n \u{1F310}.", "Pick where to watch from. The first one is ready; you can choose another. Change it anytime later with the \u{1F310} button."],
  firstPickContinue: ["Usar este", "Use this one"],
  empty: ["Todav\xEDa no hay canales para mostrar.", "No channels to show yet."],
  failed: ["No se pudo cargar. Revisa tu conexi\xF3n.", "Could not load. Check your connection."],
  setTitle: ["Ajustes de SuperTV", "SuperTV settings"],
  setConnection: ["Conexi\xF3n", "Connection"],
  setConnectionHint: ["Los servidores se obtienen solos. Aqu\xED puedes cambiar de uno si va mal.", "Servers are picked automatically. Switch here if one misbehaves."],
  setServer: ["Servidor activo", "Active server"],
  setServerOk: ["Responde", "Online"],
  setServerDown: ["Sin respuesta", "No answer"],
  setServerNone: ["Sin servidores", "No servers"],
  setServerPos: ["{i} de {n} en la lista", "{i} of {n} in the list"],
  setPick: ["Elegir servidor", "Choose server"],
  setPickHint: ["Cada servidor muestra su pa\xEDs. Elige el tuyo; si uno no responde o no trae buenos canales o logos, prueba otro.", "Each server shows its country. Pick yours; if one does not answer or has poor channels or logos, try another."],
  srvSelected: ["Servidor fijado: {host}", "Server set: {host}"],
  srvSelectFail: ["No respondi\xF3 {host}. Prueba otro.", "{host} did not answer. Try another."],
  setSwitch: ["Cambiar servidor", "Switch server"],
  setSwitchHint: ["Prueba el siguiente servidor de la lista.", "Tries the next server in the list."],
  setRefresh: ["Actualizar lista de servidores", "Update server list"],
  setRefreshHint: ["Vuelve a pedir la lista al servicio.", "Asks the service for the list again."],
  setCheck: ["Comprobar", "Check"],
  setAdultTitle: ["Contenido 18+", "18+ content"],
  setAdultHint: ["Apagado, las categor\xEDas para adultos no aparecen. Encendido, salen marcadas y Kino las muestra solo con tu c\xF3digo 18+.", "Off, adult categories are hidden. On, they appear marked and Kino shows them only with your 18+ code."],
  setLiveTitle: ["Formato de los canales", "Channel format"],
  setLiveHint: ["Formato de los canales. Si uno no carga, prueba el otro.", "Channel format. If one will not play, try the other."],
  setAbout: ["Acerca de", "About"],
  aboutPlugin: ["Plugin", "Plugin"],
  aboutKino: ["Kino", "Kino"],
  aboutDevice: ["Aparato", "Device"],
  switched: ["Servidor cambiado a {host}", "Server switched to {host}"],
  noOther: ["No hay otro servidor disponible ahora.", "No other server is available now."],
  refreshed: ["Lista actualizada: {n} servidores.", "List updated: {n} servers."],
  refreshFail: ["No se pudo actualizar la lista.", "Could not update the list."],
  checking: ["Comprobando\u2026", "Checking\u2026"]
});
var fill = (s, vars) => vars ? s.replace(/\{(\w+)\}/g, (_, k) => k in vars ? String(vars[k]) : "") : s;
function twin(key, prop = "text", vars) {
  const [es, en] = TEXTS[key] || [key, key];
  return { [prop]: fill(es, vars), [prop + "En"]: fill(en, vars) };
}
var say = (key, lang, vars) => {
  const [es, en] = TEXTS[key] || [key, key];
  return fill(lang === "en" ? en : es, vars);
};

// src/logo.js
var LOGO_DATA = "data:image/png;base64,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";

// src/screenView.js
var TAB_IDS = ["all", "premium", "paises", "deportes", "radio"];
var TAB_KEYS = { all: "tabAll", premium: "tabPremium", paises: "tabCountries", deportes: "tabSports", radio: "tabRadio" };
var POLL_MS = 1500;
var GRID_CAP = 60;
var HTTPS = /^https:\/\//;
var PRESS_MS = 3e4;
function cardOf(item) {
  const out = { id: item.id, ref: item.ref, title: item.title, kind: item.kind || "live" };
  const poster = item.poster || item.logo;
  if (poster && HTTPS.test(poster)) out.poster = poster;
  if (item.adult === true) out.adult = true;
  return out;
}
var slim = (card) => {
  const { overview, ...rest } = card;
  return rest;
};
var railSkeleton = (n) => ({
  type: "Column",
  key: "skel" + n,
  gap: 8,
  children: [
    { type: "Skeleton", shape: "line", width: 120 },
    { type: "Row", gap: 24, children: [1, 2, 3, 4, 5].map((i) => ({ type: "Skeleton", shape: "circle", key: `sk${n}c${i}`, width: 88, height: 88 })) }
  ]
});
var gridSkeleton = () => ({
  type: "Column",
  key: "gridSkeleton",
  gap: 12,
  children: [
    ...[1, 2].map((r) => ({ type: "Row", gap: 12, sizes: ["compact"], key: `gc${r}`, children: [1, 2, 3].map((i) => ({ type: "Skeleton", shape: "card", key: `gc${r}-${i}`, flex: 1 })) })),
    ...[1, 2].map((r) => ({ type: "Row", gap: 12, sizes: ["medium", "expanded"], key: `gw${r}`, children: [1, 2, 3, 4, 5, 6].map((i) => ({ type: "Skeleton", shape: "card", key: `gw${r}-${i}`, flex: 1 })) }))
  ]
});
var brandText = () => ({ type: "Text", key: "brandText", text: "SuperTV", textEn: "SuperTV", style: "h4" });
var title = () => ({
  type: "Row",
  key: "brand",
  gap: 8,
  crossAxisAlignment: "center",
  children: [{ type: "Image", key: "logo", url: LOGO_DATA, aspect: "1:1", fit: "contain", h: 32, alt: "SuperTV", altEn: "SuperTV" }, brandText()]
});
var tabBar = (active) => ({
  type: "TabBar",
  key: "tabs",
  divider: false,
  value: active,
  onChanged: "tab",
  tabs: TAB_IDS.map((id) => ({ value: id, ...twin(TAB_KEYS[id], "label") }))
});
var roundChannel = (c, uid) => ({
  type: "Column",
  key: "ch-" + uid,
  w: 120,
  gap: 8,
  crossAxisAlignment: "center",
  onTap: { go: { play: { ref: c.ref, kind: "live", id: c.id, title: c.title } } },
  children: [
    { type: "CircleAvatar", key: "chl-" + uid, radius: 44, ...c.poster ? { image: c.poster } : {}, text: String(c.title).slice(0, 2).toUpperCase(), labelText: c.title, labelTextEn: c.title },
    { type: "Text", text: c.title, textEn: c.title, style: "caption", maxLines: 1, textAlign: "center" }
  ]
});
var roundRail = (items, key, titleProps, onMore) => ({
  type: "Column",
  key,
  gap: 8,
  children: [
    onMore ? { type: "Row", key: key + "H", mainAxisAlignment: "spaceBetween", crossAxisAlignment: "center", children: [
      { type: "Text", ...titleProps, style: "h4" },
      { type: "TextButton", key: key + "More", ...twin("seeAll", "labelText"), onPressed: onMore }
    ] } : { type: "Text", ...titleProps, style: "h4" },
    { type: "SingleChildScrollView", key: key + "Scroll", direction: "horizontal", children: [{ type: "Row", gap: 24, children: items.slice(0, 20).map((c, i) => roundChannel(c, key + "-" + i)) }] }
  ]
});
var barButton = (key, icon, labelKey, onPressed) => ({ type: "IconButton", key, icon, ...twin(labelKey, "labelText"), ...twin(labelKey, "tooltip"), onPressed });
function browseView({ tab, data, loading, failed, device = "phone" }) {
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
      type: "AppBar",
      divider: false,
      mergeWithKinoBar: true,
      dense: true,
      leading: barButton("close", "close", "close", { go: { close: true } }),
      title: tv ? { type: "Row", key: "titleRow", gap: 24, crossAxisAlignment: "center", children: [title(), tabBar(active)] } : title(),
      actions: [
        ...tv ? [barButton("searchButton", "search", "search", "openSearch")] : [],
        barButton("serverBtn", "language", "setPick", "openServers"),
        barButton("settings", "settings", "settings", { event: "go", arg: "settings" })
      ]
    },
    ...tv ? {} : { floatingActionButton: { type: "FloatingActionButton", key: "searchFab", icon: "search", ...twin("search", "tooltip"), onPressed: "openSearch" } },
    body: { type: "Column", key: "page", children: [
      ...tv ? [] : [{ type: "Column", key: "tabsRow", padding: { compact: 0, expanded: 24 }, children: [tabBar(active)] }],
      { type: "SingleChildScrollView", key: "browse-" + active, flex: 1, children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: body }] }
    ] },
    ...loading ? { every: { ms: POLL_MS, event: "tick" } } : {}
  };
}
var searchForm = (tv, query, key, field, event, hintKey, goKey) => ({
  type: "Form",
  key,
  onSubmitted: event,
  gap: 8,
  children: tv ? [{ type: "Row", key: key + "Row", gap: 16, crossAxisAlignment: "center", children: [
    { type: "TextField", key: field, kind: "text", value: query, ...twin(hintKey, "labelText"), maxLength: 100, autofocus: true, onSubmitted: event, weight: 1 },
    { type: "ElevatedButton", key: goKey, ...twin("search", "labelText"), icon: "search", submit: true }
  ] }] : [
    { type: "TextField", key: field, kind: "text", value: query, ...twin(hintKey, "labelText"), maxLength: 100, autofocus: true, onSubmitted: event },
    { type: "ElevatedButton", key: goKey, ...twin("search", "labelText"), icon: "search", submit: true }
  ]
});
var backBar = (tv, extra) => ({
  type: "AppBar",
  mergeWithKinoBar: true,
  dense: true,
  divider: false,
  leading: barButton("back", "arrow_back", "back", "back"),
  ...extra
});
function searchView({ query, status, items, partial = false, history = [], device = "phone" }) {
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
    ...status === "loading" ? { every: { ms: 1e3, event: "stick" } } : {}
  };
}
function liveView({ cats, cat, items, failed = false, device = "phone" }) {
  const tv = device === "tv";
  const body = [];
  if (cats && cats.length > 1) {
    body.push({ type: "DropdownButton", key: "lcat", ...twin("liveCategory", "labelText"), value: cat, onChanged: "lcat", options: cats.slice(0, 500).map((c) => ({ value: c.id, label: c.title, labelEn: c.title })) });
  }
  if (failed) body.push({ type: "MaterialBanner", key: "liveFailed", role: "error", ...twin("failed"), action: { ...twin("retry", "label"), onTap: "lretry" } });
  else if (cats && cats.length === 0) body.push({ type: "Text", ...twin("liveEmpty", "text"), color: "muted" });
  else if (items && items.length === 0) body.push({ type: "Text", ...twin("liveEmpty", "text"), color: "muted" });
  else if (items && tv) body.push({ type: "Row", key: "channels", wrap: true, gap: 24, children: items.slice(0, 40).map((c, i) => roundChannel(c, "lv-" + i)) });
  else if (items) {
    body.push({ type: "titleGrid", key: "channels", columns: { compact: 3, expanded: 6 }, items: items.slice(0, GRID_CAP) });
    if (items.length >= GRID_CAP) body.push({ type: "Text", ...twin("liveMore", "text", { n: GRID_CAP }), style: "caption", color: "muted" });
  } else body.push(gridSkeleton());
  return {
    type: "Scaffold",
    appBar: backBar(tv, tv ? { ...twin("live", "title") } : twin("live", "title")),
    body: { type: "SingleChildScrollView", key: "live-" + String(cat).replace(/[^A-Za-z0-9_-]/g, "_"), children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: body }] },
    ...!failed && (!cats || !items) ? { every: { ms: 1e3, event: "ltick" } } : {}
  };
}
var text = (key, extra = {}, vars) => ({ type: "Text", ...twin(key, "text", vars), ...extra });
var caption = (key, extra = {}, vars) => text(key, { style: "caption", color: "muted", ...extra }, vars);
var section = (key) => text(key, { style: "h4" });
var press = (event, arg) => ({ event, ...arg !== void 0 ? { arg } : {}, timeoutMs: PRESS_MS });
function settingsView({ srv, servers, busy, pluginVersion, appVersion, device }) {
  const status = !srv ? { badge: "checking", sub: null } : !srv.host ? { badge: "setServerNone", sub: null } : { badge: srv.ok ? "setServerOk" : "setServerDown", sub: srv.total ? twin("setServerPos", "subtitle", { i: srv.index, n: srv.total }) : null };
  const deviceName = device === "tv" ? ["televisor", "TV"] : device === "desktop" ? ["computador", "desktop"] : ["tel\xE9fono", "phone"];
  const rows = [
    ["aboutPlugin", [pluginVersion, pluginVersion]],
    ["aboutKino", [appVersion || "?", appVersion || "?"]],
    ["aboutDevice", deviceName]
  ].map(([k, v], n) => ({ type: "TableRow", key: "diag" + n, children: [
    { type: "TableCell", ...twin(k) },
    { type: "TableCell", text: v[0], textEn: v[1] }
  ] }));
  return {
    type: "Scaffold",
    appBar: backBar(device === "tv", { ...twin("setTitle", "title") }),
    body: { type: "SingleChildScrollView", key: "settings-page", children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: [
      { type: "Card", key: "connCard", children: [
        section("setConnection"),
        caption("setConnectionHint"),
        {
          type: "ListTile",
          key: "serverRow",
          ...twin("setServer", "title"),
          ...status.sub || {},
          leading: { type: "Icon", name: "language" },
          trailing: { type: "Badge", ...twin(status.badge) }
        },
        ...servers && Array.isArray(servers.items) && servers.items.length > 1 ? [
          {
            type: "DropdownButton",
            key: "serverPick",
            ...twin("setPick", "labelText"),
            value: String(servers.current),
            onChanged: "srv.select",
            enabled: !busy,
            options: servers.items.slice(0, 60).map((s) => {
              const t = `${s.label === s.host ? s.host : s.label + "  " + s.host}${s.https ? "" : " \xB7 http"}`;
              return { value: String(s.i), label: t, labelEn: t };
            })
          },
          caption("setPickHint")
        ] : [],
        { type: "Row", wrap: true, gap: 8, children: [
          { type: "ElevatedButton", key: "switchServer", ...twin("setSwitch", "labelText"), icon: "refresh", ...twin("setSwitchHint", "tooltip"), enabled: !busy, onPressed: press("srv.switch") },
          { type: "Button", variant: "secondary", key: "refreshServers", ...twin("setRefresh", "labelText"), icon: "download", ...twin("setRefreshHint", "tooltip"), enabled: !busy, onPressed: press("srv.refresh") },
          { type: "TextButton", key: "checkServer", ...twin("setCheck", "labelText"), enabled: !busy, onPressed: press("srv.check") }
        ] }
      ] },
      { type: "Card", key: "adultCard", children: [
        section("setAdultTitle"),
        caption("setAdultHint"),
        { type: "settings", key: "adultForm", keys: ["showAdult"], autoSave: true, onSaved: "saved" }
      ] },
      { type: "Card", key: "liveCard", children: [
        section("setLiveTitle"),
        caption("setLiveHint"),
        { type: "settings", key: "liveForm", keys: ["liveFormat"], autoSave: true, onSaved: "saved" }
      ] },
      { type: "Card", key: "aboutCard", children: [
        section("setAbout"),
        { type: "DataTable", key: "aboutTable", columns: [{ flex: 2 }, { flex: 3 }], wrap: true, zebra: true, children: rows }
      ] }
    ] }] },
    ...!srv ? { every: { ms: 1e3, event: "sstatus" } } : {}
  };
}
function verifyingView({ device } = {}) {
  return {
    type: "Scaffold",
    appBar: {
      type: "AppBar",
      divider: false,
      mergeWithKinoBar: true,
      dense: true,
      leading: barButton("close", "close", "close", { go: { close: true } }),
      title: title()
    },
    body: { type: "Column", key: "verifying", flex: 1, mainAxisAlignment: "center", crossAxisAlignment: "center", gap: 16, padding: { compact: 24, expanded: 48 }, children: [
      { type: "CircularProgressIndicator", key: "verifySpin" },
      { type: "Text", ...twin("verifying", "text"), textAlign: "center", color: "muted" }
    ] },
    every: { ms: POLL_MS, event: "tick" }
  };
}
function firstPickView({ servers, failed = false, device } = {}) {
  const appBar = {
    type: "AppBar",
    divider: false,
    mergeWithKinoBar: true,
    dense: true,
    leading: barButton("close", "close", "close", { go: { close: true } }),
    title: title()
  };
  if (!servers) {
    return {
      type: "Scaffold",
      appBar,
      body: { type: "Column", key: "fpLoad", flex: 1, mainAxisAlignment: "center", crossAxisAlignment: "center", gap: 16, padding: { compact: 24, expanded: 48 }, children: failed ? [{ type: "MaterialBanner", key: "fpFail", role: "error", ...twin("failed"), action: { ...twin("retry", "label"), onTap: "retry" } }] : [{ type: "CircularProgressIndicator", key: "fpSpin" }, { type: "Text", ...twin("verifying", "text"), textAlign: "center", color: "muted" }] },
      ...failed ? {} : { every: { ms: POLL_MS, event: "tick" } }
    };
  }
  const items = (servers.items || []).slice(0, 60);
  const rows = items.map((s, idx) => {
    const hasCountry = s.label !== s.host;
    const ttl = hasCountry ? s.label : s.host;
    const sub = hasCountry ? s.https ? s.host : `${s.host} \xB7 http` : s.https ? "" : "http";
    const leading = s.flag ? { type: "Image", key: "fpflag-" + s.i, url: `https://flagcdn.com/w40/${s.flag}.png`, w: 32, h: 24 } : { type: "Icon", name: "language" };
    return {
      type: "ListTile",
      key: "fprow-" + s.i,
      title: ttl,
      titleEn: ttl,
      selected: idx === 0,
      leading,
      ...sub ? { subtitle: sub, subtitleEn: sub } : {},
      ...idx === 0 ? { trailing: { type: "Icon", name: "check" } } : {},
      onTap: { event: "srv.first", arg: String(s.i) }
    };
  });
  const list = items.length ? rows : [{ type: "Text", key: "fpEmpty", ...twin("liveEmpty", "text"), color: "muted" }];
  return {
    type: "Scaffold",
    appBar,
    body: { type: "Column", key: "fpPage", flex: 1, children: [
      { type: "SingleChildScrollView", key: "fpScroll", flex: 1, children: [{ type: "Column", padding: { compact: 16, expanded: 24 }, gap: 12, children: [
        { type: "Text", ...twin("firstPickTitle", "text"), style: "h4" },
        { type: "Text", ...twin("firstPickHint", "text"), color: "muted" },
        ...list
      ] }] }
    ] }
  };
}

// src/homeFeed.js
var BASE = "https://raw.githubusercontent.com/xuper-plugin/kino-plugin-supertv/main/home/";
var MAX_AGE_MS = 3 * 24 * 60 * 60 * 1e3;
function railsOf(rails) {
  if (!Array.isArray(rails)) return null;
  const r = rails.filter((x) => x && typeof x.id === "string" && typeof x.title === "string" && Array.isArray(x.items) && x.items.length);
  return r.length ? r : null;
}
async function fetchHomeFeed(serverKey2) {
  if (!serverKey2) return null;
  try {
    const r = await kino.fetch(`${BASE}${encodeURIComponent(serverKey2)}.json?v=${Math.floor(Date.now() / 36e5)}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const d = r.json();
    if (!d || d.v !== 1 || d.serverKey !== serverKey2 || !d.tabs || typeof d.tabs !== "object") return null;
    if (typeof d.at === "number" && Date.now() - d.at > MAX_AGE_MS) return null;
    const tabs = {};
    for (const k of Object.keys(d.tabs)) {
      const t = railsOf(d.tabs[k]);
      if (t) tabs[k] = t;
    }
    return Object.keys(tabs).length ? { tabs } : null;
  } catch (_) {
    return null;
  }
}

// src/screen.js
var PLUGIN_VERSION = "0.3.1";
var TAB_KEY = "superTab";
var HIST_KEY = "searchHist:v1";
var HIST_MAX = 24;
var CHANNELS_CAP = 60;
var RAILS_PER_TAB = 12;
var RAIL_ITEMS = 20;
var SCREEN_ROUTES = ["main", "search", "live", "settings"];
var inGroup = (tab, c) => tab === "all" || c.group === tab;
var groupRails = /* @__PURE__ */ new Map();
var liveChans = /* @__PURE__ */ new Map();
var liveCatsAll = null;
var found = null;
var pickServers = null;
var cacheKey = null;
var homeFeedData = /* @__PURE__ */ new Map();
var homeFeedTried = false;
var eventsRow = null;
var eventsTried = false;
var SRVCHOSEN_KEY = "srvChosen:v1";
var serverChosen = () => getStored(SRVCHOSEN_KEY) === "1";
var markServerChosen = () => {
  try {
    put(SRVCHOSEN_KEY, "1");
  } catch (_) {
  }
};
function resetCaches() {
  groupRails.clear();
  liveChans.clear();
  liveCatsAll = null;
  found = null;
  homeFeedData.clear();
  homeFeedTried = false;
  eventsRow = null;
  eventsTried = false;
}
var cfg2 = (k, d) => {
  try {
    const v = kino.config.get(k);
    return v === void 0 || v === null ? d : v;
  } catch (_) {
    return d;
  }
};
var eventsGroup = () => String(cfg2("eventsGroup", "deportes"));
var eventsOn = () => eventsGroup() !== "off";
function syncServer() {
  const key = serverKey();
  if (cacheKey === null || cacheKey === "") {
    cacheKey = key;
    return;
  }
  if (key !== cacheKey) {
    resetCaches();
    cacheKey = key;
  }
}
var langOf = (ev) => ev && ev.lang === "en" ? "en" : "es";
var getStored = (k) => {
  try {
    return kino.storage.get(k) || null;
  } catch (_) {
    return null;
  }
};
var storedTab = () => {
  const t = getStored(TAB_KEY);
  return TAB_IDS.includes(t) ? t : null;
};
var histKey = () => HIST_KEY + ":" + serverKey();
function readHistory() {
  try {
    const o = JSON.parse(kino.storage.get(histKey()) || "null");
    return o && o.v === 1 && Array.isArray(o.e) ? o.e.filter((c) => c && typeof c.id === "string" && typeof c.ref === "string").slice(0, HIST_MAX) : [];
  } catch (_) {
    return [];
  }
}
function rememberFound(cards) {
  try {
    const slimmed = cards.filter((c) => c.adult !== true).slice(0, 12).map(({ id, ref, title: title2, kind, poster }) => ({ id, ref, title: title2, kind, ...poster ? { poster } : {} }));
    const ids = new Set(slimmed.map((c) => c.id));
    put(histKey(), JSON.stringify({ v: 1, e: [...slimmed, ...readHistory().filter((c) => !ids.has(c.id))].slice(0, HIST_MAX) }));
  } catch (_) {
  }
}
var channelCard = (i) => ({ id: i.id, ref: i.ref, title: i.title, kind: "live", poster: i.logo, ...i.adult ? { adult: true } : {} });
var cardsOf = (items) => (Array.isArray(items) ? items : []).filter((i) => i && typeof i.id === "string" && typeof i.ref === "string").slice(0, CHANNELS_CAP).map(cardOf);
var bump = (state) => ({ n: (state.n || 0) + 1 });
var homeSeed = Math.random() * 2147483647 | 0;
var newHomeSeed = () => {
  homeSeed = Math.random() * 2147483647 | 0;
};
function mulberry32(a) {
  return function() {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function shuffleSeeded(arr, seed) {
  const a = arr.slice();
  const rnd = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}
function randomizeRows(rails, seed) {
  return shuffleSeeded(rails, seed).map((r, i) => r && Array.isArray(r.items) ? { ...r, items: shuffleSeeded(r.items, seed + (i + 1) * 1013904223 | 0) } : r);
}
var HOME_SNAP_PREFIX = "homeSnap:";
var SNAP_V = 1;
var SNAP_MAX = 9 * 1024;
var slimCard = (c) => ({ id: c.id, ref: c.ref, title: c.title, ...c.kind ? { kind: c.kind } : {}, ...c.poster ? { poster: c.poster } : {} });
var snapKey = (tab) => HOME_SNAP_PREFIX + "v" + SNAP_V + ":" + serverKey() + ":" + tab;
function writeTabSnap(tab, rails) {
  try {
    if (!rails || !rails.length) return;
    for (const maxRails of [rails.length, 10, 8, 6]) {
      for (let per = 10; per >= 5; per -= 2) {
        const slim2 = { v: SNAP_V, at: Date.now(), rails: rails.slice(0, maxRails).map((r) => ({ id: r.id, catId: r.catId, title: r.title, items: (r.items || []).slice(0, per).map(slimCard) })) };
        const text2 = JSON.stringify(slim2);
        if (text2.length <= SNAP_MAX) {
          put(snapKey(tab), text2);
          return;
        }
      }
    }
  } catch (_) {
  }
}
function readSnap(tab) {
  try {
    const o = JSON.parse(kino.storage.get(snapKey(tab)) || "null");
    return o && o.v === SNAP_V && Array.isArray(o.rails) && o.rails.length ? o : null;
  } catch (_) {
    return null;
  }
}
async function loadHomeFeed() {
  homeFeedTried = true;
  let feed = null;
  try {
    feed = await fetchHomeFeed(serverKey());
  } catch (_) {
    feed = null;
  }
  if (!feed || !feed.tabs) return;
  for (const tab of Object.keys(feed.tabs)) {
    homeFeedData.set(tab, feed.tabs[tab]);
    writeTabSnap(tab, feed.tabs[tab]);
  }
}
function pickEventsCat(cats) {
  const group = eventsGroup();
  const inGrp = (cats || []).filter((c) => c.group === group && !c.adult);
  return inGrp.find((c) => /event|agenda|hoy|vivo|directo|jornada|partidos?|cartelera/i.test(c.title || "")) || inGrp[0] || null;
}
async function loadEvents() {
  eventsTried = true;
  if (!eventsOn()) return;
  try {
    const cats = liveCatsAll || (liveCatsAll = await liveCategories());
    const c = pickEventsCat(cats);
    if (!c) return;
    const page = await liveChannels({ categoryId: c.id });
    const items = page.items.slice(0, RAIL_ITEMS).map(channelCard);
    eventsRow = items.length ? { id: "lcat-" + c.id, catId: c.id, title: c.title, items } : null;
  } catch (_) {
  }
}
function serverSheet(servers) {
  const cur = servers.current;
  const rows = (servers.items || []).slice(0, 60).map((s) => {
    const sel = s.i === cur;
    const hasCountry = s.label !== s.host;
    const title2 = hasCountry ? s.label : s.host;
    const sub = hasCountry ? s.https ? s.host : `${s.host} \xB7 http` : s.https ? "" : "http";
    const leading = s.flag ? { type: "Image", key: "flag-" + s.i, url: `https://flagcdn.com/w40/${s.flag}.png`, w: 32, h: 24 } : { type: "Icon", name: "language" };
    return {
      type: "ListTile",
      key: "srvrow-" + s.i,
      title: title2,
      titleEn: title2,
      selected: sel,
      leading,
      ...sub ? { subtitle: sub, subtitleEn: sub } : {},
      ...sel ? { trailing: { type: "Icon", name: "check" } } : {},
      onTap: { event: "srv.pick", arg: String(s.i) }
    };
  });
  const body = rows.length ? rows : [{ type: "Text", key: "srvEmpty", ...twin("liveEmpty", "text") }];
  return { ...twin("setPick", "title"), body };
}
async function loadGroupTab(tab) {
  const cats = (liveCatsAll || []).filter((c) => inGroup(tab, c)).slice(0, RAILS_PER_TAB);
  let failed = 0;
  const results = [];
  for (let i = 0; i < cats.length; i += 3) {
    results.push(...await Promise.all(cats.slice(i, i + 3).map(async (c) => {
      try {
        return { c, page: await liveChannels({ categoryId: c.id }) };
      } catch (_) {
        failed++;
        return null;
      }
    })));
  }
  const rails = [];
  for (const r of results) {
    if (!r) continue;
    const items = r.page.items.slice(0, RAIL_ITEMS).map(channelCard);
    if (items.length) rails.push({ id: "lcat-" + r.c.id, catId: r.c.id, title: r.c.title, items });
  }
  if (!rails.length && failed) throw new Error("tab");
  groupRails.set(tab, { rails, partial: failed > 0 });
}
var tabOf = (state, route) => {
  const a = route && route.args && typeof route.args === "object" ? route.args : {};
  return TAB_IDS.includes(state.tab) ? state.tab : TAB_IDS.includes(a.tab) ? a.tab : storedTab() || TAB_IDS[0];
};
function unitsFor(tab) {
  if (!serverChosen()) return ["health", "pick"];
  let base;
  if (homeFeedData.has(tab)) base = ["hfeed", "health"];
  else if (!homeFeedTried) base = ["hfeed", "health", "cats", "tab:" + tab];
  else base = ["health", "cats", "tab:" + tab];
  if (tab === TAB_IDS[0] && eventsOn() && !eventsTried) base = [...base, "events"];
  return base;
}
function isDone(unit) {
  if (unit === "events") return eventsTried;
  if (unit === "hfeed") return homeFeedTried;
  if (unit === "cats") return liveCatsAll !== null;
  if (unit === "health") return healthReady();
  if (unit === "pick") return pickServers !== null;
  const [, tab] = unit.split(":");
  return groupRails.has(tab);
}
function pendingUnit(state, tab) {
  const failed = state.failed || {};
  return unitsFor(tab).find((u) => !isDone(u) && !failed[u]) || null;
}
async function runUnit(unit) {
  if (unit === "events") {
    await loadEvents();
    return;
  }
  if (unit === "hfeed") {
    await loadHomeFeed();
    return;
  }
  if (unit === "cats") {
    liveCatsAll = await liveCategories();
    return;
  }
  if (unit === "health") {
    await healthCheck();
    return;
  }
  if (unit === "pick") {
    pickServers = await serverList();
    return;
  }
  const [, tab] = unit.split(":");
  await loadGroupTab(tab);
}
function mainView(ctx) {
  const state = ctx.state || {};
  if (!serverChosen()) {
    if (!healthReady() && !(state.failed && state.failed.health)) return verifyingView({ device: ctx.device });
    return firstPickView({ servers: pickServers, failed: !!(state.failed && state.failed.pick), device: ctx.device });
  }
  const tab = tabOf(state, ctx.route);
  const feedRails = homeFeedData.get(tab);
  const live = groupRails.get(tab) || null;
  const snap = !feedRails && !live ? readSnap(tab) : null;
  let data = feedRails ? { rails: feedRails, partial: false } : live || (snap ? { rails: snap.rails, partial: false, stale: true } : null);
  if (data && Array.isArray(data.rails)) data = { ...data, rails: randomizeRows(data.rails, homeSeed) };
  if (tab === TAB_IDS[0] && eventsRow) {
    const rest = (data && data.rails || []).filter((r) => r.id !== eventsRow.id);
    data = { ...data || { partial: false }, rails: [eventsRow, ...rest] };
  }
  if (!data && !healthReady() && !(state.failed && state.failed.health)) return verifyingView({ device: ctx.device });
  const failed = unitsFor(tab).some((u) => state.failed && state.failed[u]);
  return browseView({ tab, data, loading: pendingUnit(state, tab) !== null, failed: !data && failed, device: ctx.device });
}
async function screen(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const state = c.state && typeof c.state === "object" ? c.state : {};
  const name = c.route && SCREEN_ROUTES.includes(c.route.name) ? c.route.name : "main";
  try {
    syncServer();
    if (name === "search") {
      const query = typeof state.sq === "string" ? state.sq : "";
      const items = found && found.q === query ? found.items : null;
      const status = query === "" ? "idle" : state.sstate === "fail" ? "fail" : items ? "done" : "loading";
      return searchView({ query, status, items, partial: !!(found && found.q === query && found.partial), history: query === "" ? readHistory() : [], device: c.device });
    }
    if (name === "live") {
      const cur = typeof state.lcat === "string" ? state.lcat : liveCatsAll && liveCatsAll[0] ? liveCatsAll[0].id : null;
      const failed = state.lfail === true;
      return liveView({ cats: liveCatsAll, cat: cur, items: cur !== null && liveChans.has(cur) ? liveChans.get(cur) : null, failed, device: c.device });
    }
    if (name === "settings") {
      let appVersion = "";
      try {
        appVersion = typeof kino.appVersion === "string" ? kino.appVersion : "";
      } catch (_) {
        appVersion = "";
      }
      return settingsView({ srv: state.srv || null, servers: state.servers || null, busy: state.busy === true, pluginVersion: PLUGIN_VERSION, appVersion, device: c.device });
    }
    return mainView({ ...c, state });
  } catch (_) {
    return { type: "Column", padding: 16, children: [{ type: "settings", key: "classicForm" }] };
  }
}
var events = {
  open({ route, state }) {
    if (route && route.name && route.name !== "main") return null;
    eventsTried = false;
    newHomeSeed();
    return { state: { tab: tabOf(state, route), ...bump(state), failed: null } };
  },
  tab({ value, arg, state }) {
    const tab = TAB_IDS.includes(value) ? value : TAB_IDS.includes(arg) ? arg : null;
    if (!tab) return null;
    try {
      put(TAB_KEY, tab);
    } catch (_) {
    }
    const failed = { ...state.failed || {} };
    for (const u of unitsFor(tab)) delete failed[u];
    return { state: { tab, ...bump(state), failed } };
  },
  retry({ state }) {
    const tab = tabOf(state);
    const data = groupRails.get(tab);
    if (data && data.partial) groupRails.delete(tab);
    return { state: { failed: null, ...bump(state) } };
  },
  async tick({ state }) {
    const tab = tabOf(state);
    const unit = pendingUnit(state, tab);
    if (!unit) return null;
    const failed = { ...state.failed || {} };
    try {
      await runUnit(unit);
    } catch (_) {
      failed[unit] = true;
    }
    cacheKey = serverKey();
    return { state: { ...bump(state), failed } };
  },
  openSearch() {
    return { route: { push: "search" }, state: { sq: "", sstate: null } };
  },
  search({ value, route }) {
    const raw = typeof value === "string" ? value : value && typeof value.q === "string" ? value.q : "";
    const q = raw.trim().slice(0, 100);
    if (q === "") return null;
    const state = { sq: q, sstate: "loading" };
    return route && route.name === "search" ? { state } : { route: { push: "search" }, state };
  },
  async stick({ state }) {
    const q = typeof state.sq === "string" ? state.sq : "";
    if (q === "") return null;
    if (found && found.q === q) return { state: { sstate: "done" } };
    try {
      const out = await liveSearchDetailed({ query: q }, { budgetMs: 14e3 });
      found = { q, items: cardsOf(out.items.map(channelCard)), partial: out.partial };
      rememberFound(found.items);
      cacheKey = serverKey();
      return { state: { sstate: "done" } };
    } catch (_) {
      return { state: { sstate: "fail" } };
    }
  },
  sretry({ state }) {
    if (typeof state.sq !== "string" || state.sq === "") return null;
    found = null;
    return { state: { sstate: "loading" } };
  },
  back() {
    return { route: { pop: true }, state: { sq: null, sstate: null } };
  },
  gocat({ arg }) {
    const id = typeof arg === "string" ? arg : "";
    if (!id) return null;
    return { route: { push: "live" }, state: { lcat: id, lfail: null } };
  },
  async ltick({ state }) {
    if (!liveCatsAll) {
      try {
        liveCatsAll = await liveCategories();
      } catch (_) {
        return { state: { lfail: true } };
      }
      cacheKey = serverKey();
      return { state: { lcat: typeof state.lcat === "string" ? state.lcat : null } };
    }
    const cur = typeof state.lcat === "string" ? state.lcat : liveCatsAll[0] ? liveCatsAll[0].id : null;
    if (cur === null) return { state: { lcat: null } };
    if (!liveChans.has(cur)) {
      let page;
      try {
        page = await liveChannels({ categoryId: cur });
      } catch (_) {
        return { state: { lfail: true } };
      }
      liveChans.set(cur, cardsOf(page.items.map(channelCard)));
    }
    return { state: { lcat: cur } };
  },
  lcat({ value }) {
    return typeof value === "string" && value !== "" ? { state: { lcat: value, lfail: null } } : null;
  },
  lretry() {
    return { state: { lfail: null } };
  },
  go({ arg }) {
    if (arg === "settings") return { route: { push: "settings" }, state: { srv: null, busy: false } };
    return null;
  },
  async sstatus() {
    return { state: { srv: await serverStatus(), servers: await serverList() } };
  },
  async "srv.check"() {
    return { state: { srv: await serverStatus(), servers: await serverList(), busy: false } };
  },
  async "srv.select"({ value, lang }) {
    const i = typeof value === "string" ? value : value && typeof value.serverPick === "string" ? value.serverPick : "";
    const r = await selectServer(i);
    if (r.ok) {
      resetCaches();
      cacheKey = serverKey();
    }
    const srv = await serverStatus();
    const servers = await serverList();
    return { state: { srv, servers, busy: false }, toast: { text: say(r.ok ? "srvSelected" : "srvSelectFail", lang, { host: r.label || r.host || "" }), role: r.ok ? "success" : "error" } };
  },
  async "srv.switch"({ lang }) {
    const r = await switchServer();
    const srv = await serverStatus();
    return { state: { srv, busy: false }, toast: { text: say(r.changed ? "switched" : "noOther", lang, { host: r.host }), role: r.changed ? "success" : "warning" } };
  },
  async "srv.refresh"({ lang }) {
    const r = await refreshServers();
    const srv = await serverStatus();
    return { state: { srv, busy: false }, toast: { text: say(r.ok ? "refreshed" : "refreshFail", lang, { n: r.total }), role: r.ok ? "success" : "error" } };
  },
  // Modal (sheet) del selector de servidor, abierto desde el botón del header.
  async openServers() {
    let servers;
    try {
      servers = await serverList();
    } catch (_) {
      servers = { current: -1, items: [] };
    }
    return { state: { servers }, sheet: serverSheet(servers) };
  },
  // Elegido un servidor: fijar, recargar el Home por debajo y re-dibujar el sheet con el ✓ en el elegido (NO cerrar el plugin).
  async "srv.pick"({ arg, state, lang }) {
    const r = await selectServer(arg);
    if (r.ok) {
      resetCaches();
      cacheKey = serverKey();
    }
    let servers;
    try {
      servers = await serverList();
    } catch (_) {
      servers = { current: -1, items: [] };
    }
    return { state: { ...bump(state), failed: null, servers }, sheet: serverSheet(servers), toast: { text: say(r.ok ? "srvSelected" : "srvSelectFail", lang, { host: r.host || r.label || "" }), role: r.ok ? "success" : "error" } };
  },
  // Elegido un servidor en el selector de la primera vez: lo fija, lo recuerda y manda al Home (que ya carga con ese servidor).
  // Si no respondió, se queda en el selector (con el aviso) para elegir otro.
  async "srv.first"({ arg, state, lang }) {
    const r = await selectServer(arg);
    if (r.ok) {
      resetCaches();
      cacheKey = serverKey();
      markServerChosen();
    }
    return { state: { ...bump(state), failed: null }, toast: { text: say(r.ok ? "srvSelected" : "srvSelectFail", lang, { host: r.host || r.label || "" }), role: r.ok ? "success" : "error" } };
  },
  saved({ state }) {
    return { state: bump(state) };
  }
};
async function screenEvent(ev) {
  const e = ev && typeof ev === "object" ? ev : {};
  const handler = Object.hasOwn(events, e.name) ? events[e.name] : null;
  if (!handler) return null;
  try {
    syncServer();
    return await handler({ ...e, state: e.state || {}, lang: langOf(e) }) ?? null;
  } catch (_) {
    return { toast: { text: say("failed", langOf(e)), role: "error" } };
  }
}
var SECTION_TABS = [
  { id: "all", label: "Todo", en: "All" },
  { id: "premium", label: "Premium", en: "Premium" },
  { id: "paises", label: "Pa\xEDses", en: "Countries" },
  { id: "deportes", label: "Deportes", en: "Sports" },
  { id: "radio", label: "Radio", en: "Radio" }
];
async function section2(arg) {
  const asked = arg && typeof arg === "object" ? arg.tab : null;
  const tab = SECTION_TABS.some((t) => t.id === asked) ? asked : SECTION_TABS[0].id;
  const english = /^en/i.test(String(kino.lang || ""));
  const cats = (await liveCategories()).filter((c) => inGroup(tab, c)).slice(0, RAILS_PER_TAB);
  const rows = [];
  for (let i = 0; i < cats.length; i += 3) {
    const batch = await Promise.all(cats.slice(i, i + 3).map(async (c) => {
      try {
        const page = await liveChannels({ categoryId: c.id });
        const items = page.items.slice(0, RAIL_ITEMS).map(channelCard);
        return items.length ? { id: "lcat-" + c.id, title: c.title, ref: "lcat:" + c.id, items } : null;
      } catch (_) {
        return null;
      }
    }));
    rows.push(...batch.filter(Boolean));
  }
  return { tabs: SECTION_TABS.map((t) => ({ id: t.id, label: english ? t.en : t.label })), tab, rows };
}
export {
  action,
  browse,
  guide,
  home,
  liveCategories,
  liveChannels,
  liveSearch,
  resolve,
  screen,
  screenEvent,
  search,
  section2 as section,
  settingsStatus
};
