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
  misc: { match: () => true, budget: 2 * 1024 }
};
var ORDER = ["servers", "cats", "hero", "hist", "recent", "idx", "tmdb", "misc"];
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
    return { url: base, username, password };
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
function serverKey() {
  const st = readSrvs();
  const srv = st && Array.isArray(st.list) ? st.list[st.idx] : null;
  if (!srv) return "";
  let h = 5381;
  const text2 = srv.url + "|" + srv.username;
  for (let i = 0; i < text2.length; i++) h = (h << 5) + h + text2.charCodeAt(i) | 0;
  return (h >>> 0).toString(36);
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
  if (!force && usable && cached.ts && Date.now() - cached.ts < CACHE_TTL_MS) return cached;
  try {
    const list = await fetchServerList();
    const st = { ts: Date.now(), list, idx: 0, ok: false };
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
async function resolve(ref) {
  const { url, username, password } = await activeServer();
  const s = String(ref || "");
  if (s.startsWith("live:")) {
    const id = s.slice(5);
    if (!/^\d+$/.test(id)) throw kino.error("not_found");
    return { url: `${url}/live/${username}/${password}/${id}.${liveFormat()}` };
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
var LOGO_DATA = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MTIiIGhlaWdodD0iNTEyIiB2aWV3Qm94PSIwIDAgNTEyIDUxMiI+CiAgPGRlZnM+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzNCOEJGRiIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMxNTUyRDYiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgPC9kZWZzPgogIDxyZWN0IHg9IjI0IiB5PSIyNCIgd2lkdGg9IjQ2NCIgaGVpZ2h0PSI0NjQiIHJ4PSIxMDgiIGZpbGw9InVybCgjYmcpIi8+CiAgPCEtLSBzZcOxYWwgZW4gdml2byAob25kYXMpIC0tPgogIDxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iI0ZGRkZGRiIgc3Ryb2tlLXdpZHRoPSIyMCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBvcGFjaXR5PSIwLjkyIj4KICAgIDxwYXRoIGQ9Ik0xNzAgMTUwIEExMjAgMTIwIDAgMCAwIDE1MCAxNzAiLz4KICAgIDxwYXRoIGQ9Ik0xNTAgMTEwIEExNzAgMTcwIDAgMCAwIDExMiAxNDgiLz4KICA8L2c+CiAgPCEtLSBwbGF5IC0tPgogIDxwYXRoIGQ9Ik0yMTQgMTk2IEwyMTQgMzUyIEwzNDggMjc0IFoiIGZpbGw9IiNGRkZGRkYiLz4KICA8IS0tIHB1bnRvIGxpdmUgLS0+CiAgPGNpcmNsZSBjeD0iMzcyIiBjeT0iMTUwIiByPSIyMiIgZmlsbD0iI0ZGNEQ0RCIvPgo8L3N2Zz4K";

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
var roundChannel = (c, n) => ({
  type: "Column",
  key: "ch-" + n,
  w: 120,
  gap: 8,
  crossAxisAlignment: "center",
  onTap: { go: { play: { ref: c.ref, kind: "live", id: c.id, title: c.title } } },
  children: [
    { type: "CircleAvatar", key: "chl-" + n, radius: 44, ...c.poster ? { image: c.poster } : { text: String(c.title).slice(0, 2).toUpperCase() }, labelText: c.title, labelTextEn: c.title },
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
    { type: "SingleChildScrollView", key: key + "Scroll", direction: "horizontal", children: [{ type: "Row", gap: 24, children: items.slice(0, 20).map(roundChannel) }] }
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
  else if (items && tv) body.push({ type: "Row", key: "channels", wrap: true, gap: 24, children: items.slice(0, 40).map(roundChannel) });
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
function settingsView({ srv, busy, pluginVersion, appVersion, device }) {
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

// src/screen.js
var PLUGIN_VERSION = "0.1.0";
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
var cacheKey = null;
function resetCaches() {
  groupRails.clear();
  liveChans.clear();
  liveCatsAll = null;
  found = null;
}
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
  return ["cats", "tab:" + tab];
}
function isDone(unit) {
  if (unit === "cats") return liveCatsAll !== null;
  const [, tab] = unit.split(":");
  return groupRails.has(tab);
}
function pendingUnit(state, tab) {
  const failed = state.failed || {};
  return unitsFor(tab).find((u) => !isDone(u) && !failed[u]) || null;
}
async function runUnit(unit) {
  if (unit === "cats") {
    liveCatsAll = await liveCategories();
    return;
  }
  const [, tab] = unit.split(":");
  await loadGroupTab(tab);
}
function mainView(ctx) {
  const state = ctx.state || {};
  const tab = tabOf(state, ctx.route);
  const data = groupRails.get(tab) || null;
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
      return settingsView({ srv: state.srv || null, busy: state.busy === true, pluginVersion: PLUGIN_VERSION, appVersion, device: c.device });
    }
    return mainView({ ...c, state });
  } catch (_) {
    return { type: "Column", padding: 16, children: [{ type: "settings", key: "classicForm" }] };
  }
}
var events = {
  open({ route, state }) {
    if (route && route.name && route.name !== "main") return null;
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
    return { state: { srv: await serverStatus() } };
  },
  async "srv.check"() {
    return { state: { srv: await serverStatus(), busy: false } };
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
