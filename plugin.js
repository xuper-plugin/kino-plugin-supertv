// src/store.js
var SOFT_CAP = 200 * 1024;
var CLASSES = {
  servers: { match: (k) => k === "srvs" || k === "vcode", budget: 9 * 1024, keep: true },
  // The person's choices: nothing else can evict them (they used to share the 2 KB "misc" class with the health result).
  prefs: { match: (k) => k === "srvChosen:v1" || k === "superTab" || k === "seed:v1", budget: 256, keep: true },
  health: { match: (k) => k === "health:v1", budget: 3 * 1024, keep: true },
  panels: { match: (k) => k === "panels:v1", budget: 4 * 1024, keep: true },
  acct: { match: (k) => k === "acct:v1", budget: 2 * 1024, keep: true },
  // The live failover's last switch (live:v1): the account it moved a channel to survives a runtime restart.
  live: { match: (k) => k === "live:v1", budget: 512, keep: true },
  cats: { match: (k) => k.startsWith("cats:"), budget: 60 * 1024 },
  hist: { match: (k) => k.startsWith("searchHist:"), budget: 10 * 1024 },
  // The Home snapshot: every tab of one server in ONE entry (one rewrite per feed), painted at once on the next open.
  homeSnap: { match: (k) => k.startsWith("homeSnap:"), budget: 40 * 1024 },
  misc: { match: () => true, budget: 2 * 1024 }
};
var ORDER = ["servers", "prefs", "health", "panels", "acct", "live", "cats", "hist", "homeSnap", "misc"];
var IDX = "_idx";
var classOf = (key) => ORDER.find((c) => CLASSES[c].match(key));
function jsonLen(s) {
  let n = 2;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 34 || c === 92 || c === 47) n += 2;
    else if (c < 32) n += c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6;
    else if (c < 128) n += 1;
    else if (c < 2048) n += 2;
    else if (c >= 55296 && c <= 56319 && i + 1 < str.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
var entryLen = (key, value) => jsonLen(key) + jsonLen(value) + 2;
var memo = null;
function loadIdx() {
  let storage = null;
  try {
    storage = kino.storage;
  } catch (_) {
    storage = null;
  }
  if (memo && memo.of === storage) return memo;
  const map = /* @__PURE__ */ new Map();
  let dirty = false;
  let keys = [];
  try {
    keys = kino.storage.keys();
  } catch (_) {
    keys = [];
  }
  let raw = {};
  try {
    const o = JSON.parse(kino.storage.get(IDX) || "null");
    if (o && typeof o === "object" && !Array.isArray(o)) raw = o;
  } catch (_) {
    raw = {};
  }
  for (const k of keys) {
    if (k === IDX) continue;
    const e = raw[k];
    if (Array.isArray(e) && Number.isFinite(e[0]) && Number.isFinite(e[1]) && e[1] > 0) {
      map.set(k, { ts: e[0], bytes: e[1] });
      continue;
    }
    let v = null;
    try {
      v = kino.storage.get(k);
    } catch (_) {
      v = null;
    }
    if (v === null || v === void 0) continue;
    map.set(k, { ts: typeof e === "number" && Number.isFinite(e) ? e : 0, bytes: entryLen(k, v) });
    dirty = true;
  }
  if (Object.keys(raw).some((k) => !map.has(k))) dirty = true;
  memo = { of: storage, map, dirty };
  return memo;
}
var idxLen = (map) => {
  let n = 16;
  for (const k of map.keys()) n += jsonLen(k) + 32;
  return n;
};
function flushIndex() {
  const m = memo;
  memo = null;
  if (!m || !m.dirty) return;
  const o = {};
  for (const [k, e] of m.map) o[k] = [e.ts, e.bytes];
  try {
    kino.storage.set(IDX, JSON.stringify(o));
  } catch (_) {
  }
}
function evict(idx, key) {
  try {
    kino.storage.remove(key);
  } catch (_) {
  }
  idx.map.delete(key);
  idx.dirty = true;
}
function put(key, value) {
  try {
    const klass = classOf(key);
    const need = entryLen(key, value);
    if (need > CLASSES[klass].budget) return false;
    const idx = loadIdx();
    const others = () => [...idx.map].filter(([k]) => k !== key).map(([k, e]) => ({ key: k, klass: classOf(k), ...e }));
    const oldest = (list2, pred) => list2.filter(pred).sort((a, b) => a.ts - b.ts)[0];
    let list = others();
    let used = list.filter((e) => e.klass === klass).reduce((n, e) => n + e.bytes, 0);
    while (used + need > CLASSES[klass].budget) {
      const victim = oldest(list, (e) => e.klass === klass);
      if (!victim) return false;
      used -= victim.bytes;
      evict(idx, victim.key);
      list = others();
    }
    let total = 2 + idxLen(idx.map) + list.reduce((n, e) => n + e.bytes, 0) + need;
    while (total > SOFT_CAP) {
      const victim = oldest(list, (e) => !CLASSES[e.klass].keep && e.klass !== klass) || oldest(list, (e) => !CLASSES[e.klass].keep);
      if (!victim) return false;
      total -= victim.bytes;
      evict(idx, victim.key);
      list = others();
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        kino.storage.set(key, value);
        idx.map.set(key, { ts: Date.now(), bytes: need });
        idx.dirty = true;
        return true;
      } catch (_) {
        const victim = oldest(others(), (e) => !CLASSES[e.klass].keep);
        if (!victim) return false;
        evict(idx, victim.key);
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
  checking: ["Comprobando\u2026", "Checking\u2026"],
  liveNoServer: ["Este canal no responde ahora en ning\xFAn servidor. Int\xE9ntalo en unos minutos.", "This channel isn't answering on any server right now. Try again in a few minutes."]
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

// src/version.js
var PLUGIN_VERSION = "0.4.1";

// src/panels.js
var PANELS_KEY = "panels:v1";
var ACCT_KEY = "acct:v1";
var DAY = 24 * 60 * 60 * 1e3;
var DEAD_TTL_MS = DAY;
var KEEP_OFFLINE_MS = 7 * DAY;
var MIN_SHARED = 8;
var MIN_SHARE = 0.8;
var djb2 = (text2) => {
  let h = 5381;
  for (let i = 0; i < text2.length; i++) h = (h << 5) + h + text2.charCodeAt(i) | 0;
  return (h >>> 0).toString(36);
};
function keyOf(srv) {
  if (!srv || !srv.url) return "";
  return djb2(srv.url + "|" + srv.username);
}
var credOf = (srv) => djb2(String(srv.url) + "|" + srv.username + "|" + srv.password).slice(0, 6);
var fnv = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
var normName = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function pairHashes(cats) {
  const out = /* @__PURE__ */ new Set();
  for (const c of Array.isArray(cats) ? cats : []) {
    const id = String(c && c.category_id || "");
    if (id) out.add(fnv(id + "|" + normName(c.category_name)));
  }
  return out;
}
function linked(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size < MIN_SHARED) return false;
  let n = 0;
  for (const h of small) if (large.has(h)) n++;
  return n >= MIN_SHARED && n >= MIN_SHARE * small.size;
}
function groupPanels(sets, prev, now) {
  const prevG = prev && prev.g || {};
  const prevT = prev && prev.t || {};
  const keys = [...sets.keys()].filter((k) => sets.get(k).size >= MIN_SHARED).sort((a, b) => sets.get(b).size - sets.get(a).size || (a < b ? -1 : a > b ? 1 : 0));
  const groups = [];
  const unknown = /* @__PURE__ */ new Set();
  for (const k of keys) {
    const hits = groups.filter((gr) => linked(sets.get(k), sets.get(gr.anchor)));
    if (!hits.length) groups.push({ anchor: k, members: [k] });
    else if (hits.length === 1) hits[0].members.push(k);
    else unknown.add(k);
  }
  const g = {};
  const t = {};
  const used = /* @__PURE__ */ new Set();
  const remap = {};
  for (const gr of groups) {
    const votes = {};
    for (const m of gr.members) if (prevG[m]) votes[prevG[m]] = (votes[prevG[m]] || 0) + 1;
    const old = Object.keys(votes).filter((l) => !used.has(l)).sort((a, b) => votes[b] - votes[a] || (a < b ? -1 : 1))[0];
    const label = old || (used.has(gr.anchor) ? gr.anchor + "~" : gr.anchor);
    used.add(label);
    for (const m of gr.members) {
      g[m] = label;
      t[m] = now;
      if (prevG[m] && !(prevG[m] in remap)) remap[prevG[m]] = label;
    }
  }
  for (const k of Object.keys(prevG)) {
    if (k in g || unknown.has(k) || sets.has(k)) continue;
    if (now - (Number(prevT[k]) || 0) >= KEEP_OFFLINE_MS) continue;
    g[k] = remap[prevG[k]] || prevG[k];
    t[k] = prevT[k];
  }
  return { v: 1, at: now, g, t };
}
function readPanels() {
  try {
    const o = JSON.parse(kino.storage.get(PANELS_KEY) || "null");
    return o && o.v === 1 && o.g && typeof o.g === "object" ? o : null;
  } catch (_) {
    return null;
  }
}
var writePanels = (map) => put(PANELS_KEY, JSON.stringify(map));
function panelOf(k, map = readPanels()) {
  return map && k && map.g[k] || null;
}
function membersOf(label, map = readPanels(), now = Date.now(), maxAgeMs = KEEP_OFFLINE_MS) {
  if (!map || !label) return [];
  return Object.keys(map.g).filter((k) => map.g[k] === label && now - (Number(map.t && map.t[k]) || 0) < maxAgeMs);
}
function readAcct() {
  try {
    const o = JSON.parse(kino.storage.get(ACCT_KEY) || "null");
    if (o && o.v === 1 && o.dead && o.blocked) return o;
  } catch (_) {
  }
  return { v: 1, dead: {}, blocked: {} };
}
function writeAcct(o, now) {
  for (const k of Object.keys(o.dead)) if (now - (Number(o.dead[k][0]) || 0) >= DEAD_TTL_MS) delete o.dead[k];
  for (const k of Object.keys(o.blocked)) if (o.blocked[k] !== PLUGIN_VERSION) delete o.blocked[k];
  put(ACCT_KEY, JSON.stringify(o));
}
function noteDead(srv, now = Date.now()) {
  const k = keyOf(srv);
  if (!k) return;
  const o = readAcct();
  o.dead[k] = [now, credOf(srv)];
  writeAcct(o, now);
}
function noteBlocked(srv, now = Date.now()) {
  const k = keyOf(srv);
  if (!k) return;
  const o = readAcct();
  if (o.blocked[k] === PLUGIN_VERSION) return;
  o.blocked[k] = PLUGIN_VERSION;
  writeAcct(o, now);
}
function noteAlive(srv) {
  const k = keyOf(srv);
  if (!k) return;
  const o = readAcct();
  if (!(k in o.dead) && !(k in o.blocked)) return;
  delete o.dead[k];
  delete o.blocked[k];
  put(ACCT_KEY, JSON.stringify(o));
}
function isDead(srv, now = Date.now()) {
  const d = readAcct().dead[keyOf(srv)];
  return !!d && d[1] === credOf(srv) && now - (Number(d[0]) || 0) < DEAD_TTL_MS;
}
var isBlocked = (srv) => readAcct().blocked[keyOf(srv)] === PLUGIN_VERSION;
var usable = (srv, now = Date.now()) => !!srv && !isBlocked(srv) && !isDead(srv, now);
function accountVerdict(data, now = Date.now()) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !data.user_info || typeof data.user_info !== "object") return null;
  const u = data.user_info;
  if (u.auth !== void 0 && String(u.auth) === "0") return "dead";
  if (/^(expired|banned|disabled)$/i.test(String(u.status || ""))) return "dead";
  const exp = Number(u.exp_date);
  if (u.exp_date !== null && u.exp_date !== void 0 && u.exp_date !== "" && Number.isFinite(exp) && exp > 0 && exp * 1e3 < now) return "dead";
  return null;
}

// src/channelMatch.js
var strip = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
var CODES = {
  es: "es",
  esp: "es",
  mx: "mx",
  mex: "mx",
  ar: "ar",
  arg: "ar",
  co: "co",
  col: "co",
  cl: "cl",
  pe: "pe",
  ve: "ve",
  ec: "ec",
  uy: "uy",
  py: "py",
  bo: "bo",
  cr: "cr",
  pa: "pa",
  gt: "gt",
  hn: "hn",
  sv: "sv",
  ni: "ni",
  do: "do",
  pr: "pr",
  cu: "cu",
  us: "us",
  usa: "us",
  ca: "ca",
  br: "br",
  pt: "pt",
  uk: "gb",
  gb: "gb",
  fr: "fr",
  de: "de",
  it: "it",
  nl: "nl",
  be: "be",
  ch: "ch",
  at: "at",
  pl: "pl",
  ro: "ro",
  tr: "tr",
  gr: "gr",
  al: "al",
  hr: "hr",
  rs: "rs",
  se: "se",
  no: "no",
  dk: "dk",
  fi: "fi",
  ie: "ie",
  au: "au",
  in: "in",
  pk: "pk",
  sa: "sa",
  ma: "ma",
  ru: "ru",
  bg: "bg",
  hu: "hu",
  cz: "cz"
};
var REGIONS = { lat: "lat", latam: "lat", latino: "lat", latinos: "lat", latina: "lat", int: "int", multi: "multi", en: "en" };
var NAMES = {
  argentina: "ar",
  brasil: "br",
  brazil: "br",
  bolivia: "bo",
  chile: "cl",
  colombia: "co",
  "costa rica": "cr",
  cuba: "cu",
  ecuador: "ec",
  "el salvador": "sv",
  guatemala: "gt",
  honduras: "hn",
  mexico: "mx",
  nicaragua: "ni",
  panama: "pa",
  paraguay: "py",
  peru: "pe",
  "puerto rico": "pr",
  "republica dominicana": "do",
  "r dominicana": "do",
  dominicana: "do",
  uruguay: "uy",
  venezuela: "ve",
  espana: "es",
  spain: "es",
  canada: "ca",
  usa: "us",
  "estados unidos": "us",
  france: "fr",
  francia: "fr",
  germany: "de",
  alemania: "de",
  deutschland: "de",
  italy: "it",
  italia: "it",
  portugal: "pt",
  uk: "gb",
  "reino unido": "gb",
  england: "gb",
  netherlands: "nl",
  holanda: "nl",
  marruecos: "ma",
  polonia: "pl",
  poland: "pl",
  rumania: "ro",
  romania: "ro",
  turquia: "tr",
  turkey: "tr",
  grecia: "gr",
  albania: "al",
  belgica: "be",
  suecia: "se"
};
var REGION_WORDS = { latino: "lat", latinos: "lat", latina: "lat", latinas: "lat", latam: "lat", latinoamerica: "lat" };
var isConcrete = (cc) => typeof cc === "string" && /^[a-z]{2}$/.test(cc) && cc !== "en";
var QUALITY = { "4k": "4k", uhd: "4k", "2160p": "4k", fhd: "fhd", "1080p": "fhd", "1080": "fhd", hd: "hd", "720p": "hd", "720": "hd", sd: "sd", "480p": "sd" };
var NOISE = /* @__PURE__ */ new Set(["hevc", "h265", "h264", "raw", "backup", "bk", "alt", "op1", "op2", "audio", "vip"]);
var EVENT_WORD = /^(eventos?|events?|ppv|jornadas?|partidos?|match(es)?|agenda)$/;
var PREFIX = /^\s*[┃|▎[(]?\s*([A-Za-z]{2,6})\s*(?:[┃|▎\])]|:|\s-\s|-)\s*/;
function normChannel(raw) {
  let s = strip(raw);
  let cc = "";
  const m = s.match(PREFIX);
  if (m) {
    const code = m[1].toLowerCase();
    if (CODES[code] || REGIONS[code]) {
      cc = CODES[code] || REGIONS[code];
      s = s.slice(m[0].length);
    }
  }
  s = s.toLowerCase().replace(/\+/g, " plus ").replace(/[^a-z0-9]+/g, " ").trim();
  let q = "";
  const key = [];
  let event = false;
  for (const t of s.split(" ")) {
    if (!t) continue;
    if (QUALITY[t]) {
      if (!q) q = QUALITY[t];
      continue;
    }
    if (NOISE.has(t) || /^\d+fps$/.test(t)) continue;
    if (EVENT_WORD.test(t)) event = true;
    key.push(t);
  }
  return { cc, q, key: key.join(" "), event };
}
var MAX_TOK = 56;
function channelTok(raw) {
  const n = normChannel(raw);
  if (n.event || !n.key) return "";
  const tok = [isConcrete(n.cc) ? n.cc : "_", n.q || "_", ...n.key.split(" ")].join(".");
  return tok.length <= MAX_TOK ? tok : "";
}
function parseChannelTok(tok) {
  const p = String(tok || "").split(".");
  if (p.length < 3 || !/^[a-z0-9._]+$/.test(String(tok)) || !/^(_|[a-z]{2})$/.test(p[0]) || !/^(_|4k|fhd|hd|sd)$/.test(p[1])) return null;
  return { cc: p[0] === "_" ? "" : p[0], q: p[1] === "_" ? "" : p[1], key: p.slice(2).join(" ") };
}
var LADDER = { sd: 0, hd: 1, fhd: 2, "4k": 3 };
var NO_Q_ORDER = ["", "fhd", "hd", "4k", "sd"];
function matchChannel(tok, list) {
  const src = parseChannelTok(tok);
  if (!src || !src.key) return { why: "bad" };
  const cands = [];
  for (const s of Array.isArray(list) ? list : []) {
    const id = String(s && s.stream_id || "");
    if (!/^\d+$/.test(id)) continue;
    const n = normChannel(s.name);
    if (n.event || n.key !== src.key) continue;
    if (src.cc && isConcrete(n.cc) && n.cc !== src.cc) continue;
    cands.push({ id, name: String(s.name || ""), q: n.q });
  }
  if (!cands.length) return { why: "none" };
  const have = new Set(cands.map((c) => c.q));
  let q;
  if (!src.q) q = NO_Q_ORDER.find((x) => have.has(x));
  else if (have.has(src.q)) q = src.q;
  else {
    const want = LADDER[src.q];
    q = [...have].sort((a, b) => Math.abs(LADDER[a || "hd"] - want) - Math.abs(LADDER[b || "hd"] - want) || LADDER[b || "hd"] - LADDER[a || "hd"])[0];
  }
  const pool2 = cands.filter((c) => c.q === q);
  if (new Set(pool2.map((c) => c.id)).size > 1) return { why: "ambiguous" };
  return { id: pool2[0].id, name: pool2[0].name };
}
var STOP = /* @__PURE__ */ new Set(["general", "generales", "canales", "channels", "tv", "hd", "fhd", "sd", "uhd", "4k", "vip", "y", "and", "de", "del", "la", "el", "los", "las", "plus"]);
var CAT_EVENT = /^(eventos?|events?|ppv|jornadas?|partidos?|match(es)?|agenda|replays?)$/;
var stem = (t) => /[lrnd]es$/.test(t) && t.length > 5 ? t.slice(0, -2) : t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t;
function normCategory(raw) {
  const s = strip(raw).toLowerCase().replace(/la\s+liga/g, "laliga").replace(/\+/g, " plus ").replace(/[^a-z0-9]+/g, " ").trim();
  const toks = s.split(" ").filter(Boolean);
  let cc = "";
  let event = false;
  const topic = /* @__PURE__ */ new Set();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (i === 0 && (CODES[t] || REGIONS[t])) {
      cc = CODES[t] || REGIONS[t];
      continue;
    }
    const two = i + 1 < toks.length ? t + " " + toks[i + 1] : "";
    if (two && NAMES[two]) {
      if (!cc) cc = NAMES[two];
      i++;
      continue;
    }
    if (NAMES[t]) {
      if (!cc) cc = NAMES[t];
      continue;
    }
    if (REGION_WORDS[t]) {
      if (!cc) cc = REGION_WORDS[t];
      continue;
    }
    if (CAT_EVENT.test(t)) event = true;
    if (STOP.has(t)) continue;
    topic.add(stem(t));
  }
  return { cc, topic, event };
}
var MAX_CAT_TOK = 32;
var EVENT_STEMS = /* @__PURE__ */ new Set(["evento", "event", "ppv", "jornada", "partido", "match", "matche", "agenda", "replay"]);
function categoryTok(raw) {
  const n = normCategory(raw);
  const tok = [n.cc && /^[a-z]{2,5}$/.test(n.cc) ? n.cc : "_", ...[...n.topic].sort()].join(".");
  return tok.length <= MAX_CAT_TOK && /^[a-z0-9._]+$/.test(tok) ? tok : "";
}
function parseCategoryTok(tok) {
  const t = String(tok || "");
  if (!t || !/^[a-z0-9._]+$/.test(t)) return null;
  const p = t.split(".");
  const topic = new Set(p.slice(1).filter(Boolean));
  return { cc: p[0] === "_" ? "" : p[0], topic, event: [...topic].some((w) => EVENT_STEMS.has(w)) };
}
var sameCategory = (tok, name) => !!tok && categoryTok(name) === tok;
function matchCategory(tok, list) {
  const src = parseCategoryTok(tok);
  if (!src || src.event || !isConcrete(src.cc)) return null;
  let best = null;
  for (const c of Array.isArray(list) ? list : []) {
    const id = String(c && c.category_id || "");
    if (!id) continue;
    const n = normCategory(c.category_name);
    if (n.event || n.cc !== src.cc) continue;
    let inter = 0;
    for (const t of src.topic) if (n.topic.has(t)) inter++;
    const uni = (/* @__PURE__ */ new Set([...src.topic, ...n.topic])).size;
    const score = uni ? inter / uni : 1;
    if (score >= 0.6 && (!best || score > best.score)) best = { id, name: String(c.category_name || ""), score };
  }
  return best;
}

// src/liveFailover.js
var CHAIN_GAP_MS = 45e3;
var STICKY_MS = 6e5;
var REFUSED_MS = 6e5;
var VERIFIED_MS = 24 * 60 * 60 * 1e3;
var NAME_MS = 30 * 60 * 1e3;
var LIST_MS = 10 * 60 * 1e3;
var CATS_FRESH_MS = 10 * 60 * 1e3;
var DEADLINE_MS = 1e4;
var MAX_PER_RESOLVE = 6;
var MAX_PER_CHANNEL = 12;
var STICKY_KEY = "live:v1";
var UA = "Mozilla/5.0 (compatible; VegetaTVCache/2.0)";
function parseLiveRef(ref) {
  const s = String(ref || "");
  if (!s.startsWith("live:")) return null;
  const segs = s.slice(5).split("~");
  if (!/^\d+$/.test(segs[0])) return null;
  if (segs.length >= 4 && /^\d+$/.test(segs[1])) return { id: segs[0], catId: segs[1], catTok: segs[2], tok: segs[3], bare: false };
  return { id: segs[0], catId: "", catTok: "", tok: "", bare: true };
}
var liveRef = (id, catId, catTok, tok) => /^\d+$/.test(String(catId || "")) ? `live:${id}~${catId}~${catTok || ""}~${tok || ""}` : `live:${id}`;
var hostnameOf = (srv) => {
  try {
    return new URL(srv.url).hostname;
  } catch (_) {
    return "";
  }
};
var REFUSAL_IN_MESSAGE = /\b(401|403|406|407|429|509)\b|HTTP_PROXY_AUTH/i;
function classifyProbe(res, err) {
  if (err) {
    if (err.code === "host_not_allowed") return "blocked";
    if (err.code === "rate_limited") return "limited";
    return REFUSAL_IN_MESSAGE.test(String(err.message || "")) ? "refused" : "unreachable";
  }
  const st = Number(res && res.status) || 0;
  if (st >= 300 && st < 400) return res.headers && res.headers.location ? "accepted" : "dead";
  if (st >= 200 && st < 300) {
    let body = "";
    try {
      body = String(res.text() || "");
    } catch (_) {
      body = "";
    }
    return /^\s*#EXTM3U/.test(body) && /#EXTINF|#EXT-X-STREAM-INF/.test(body) ? "ok" : "dead";
  }
  if (st === 404 || st === 400 || st === 410) return "missing";
  return "refused";
}
var isGood = (v) => v === "ok" || v === "accepted";
var isBad = (v) => v === "refused" || v === "dead" || v === "missing" || v === "blocked";
function createLiveFailover(deps) {
  const now = () => deps.now();
  const plays = /* @__PURE__ */ new Map();
  let lastLive = null;
  const refused = /* @__PURE__ */ new Map();
  const preferred = /* @__PURE__ */ new Map();
  const verified = /* @__PURE__ */ new Map();
  const nameHits = /* @__PURE__ */ new Map();
  const negName = /* @__PURE__ */ new Map();
  const lists = /* @__PURE__ */ new Map();
  const catsMemo = /* @__PURE__ */ new Map();
  const refreshed = /* @__PURE__ */ new Map();
  const fresh = (ts, ms) => typeof ts === "number" && now() - ts < ms;
  const trim = (map, max) => {
    while (map.size > max) map.delete(map.keys().next().value);
  };
  const isRefused = (k) => fresh(refused.get(k), REFUSED_MS);
  const isBadFor = (st, k) => fresh(st.bad.get(k), REFUSED_MS);
  const isLabel = (p) => !!p && !/^[kc]:/.test(p);
  function rankWith(active) {
    const online = deps.online();
    const aflag = deps.flag(active);
    const seed = String(deps.seed());
    const tie = (s) => {
      let h = 2166136261;
      const t = seed + keyOf(s);
      for (let i = 0; i < t.length; i++) {
        h ^= t.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return h >>> 0;
    };
    return (a, b) => {
      const oa = online ? online.has(a.url) ? 0 : 1 : 0;
      const ob = online ? online.has(b.url) ? 0 : 1 : 0;
      if (oa !== ob) return oa - ob;
      const fa = deps.flag(a) === aflag ? 0 : 1;
      const fb = deps.flag(b) === aflag ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return deps.priority(a) - deps.priority(b) || tie(a) - tie(b);
    };
  }
  const room = (ctx, needMs) => ctx.left > 0 && ctx.st.spent.length < MAX_PER_CHANNEL && ctx.until - now() >= needMs;
  function spend(ctx) {
    ctx.left--;
    ctx.st.spent.push(now());
  }
  async function probe(ctx, srv, id) {
    if (!room(ctx, 1500)) return "skipped";
    spend(ctx);
    const k = keyOf(srv);
    let v;
    try {
      const res = await kino.fetch(deps.playUrl(srv, id, "m3u8"), {
        redirect: "manual",
        cookies: false,
        maxBytes: 2048,
        timeoutMs: Math.max(1e3, Math.min(4e3, ctx.until - now() - 500)),
        headers: { "User-Agent": UA, "Accept": "*/*" }
      });
      v = classifyProbe(res, null);
    } catch (e) {
      v = classifyProbe(null, e);
      if (v === "blocked" && e && e.host && e.host !== hostnameOf(srv)) v = "unreachable";
    }
    if (v === "blocked") noteBlocked(srv);
    if (v === "refused" || v === "dead") refused.set(k, now());
    if (v === "limited") ctx.left = 0;
    ctx.probes.push(v);
    return v;
  }
  async function call2(ctx, srv, action3, extra) {
    if (!room(ctx, 2500)) return null;
    spend(ctx);
    try {
      return await deps.callServer(srv, action3, extra || {}, { timeoutMs: Math.max(1e3, Math.min(5e3, ctx.until - now() - 1500)) });
    } catch (e) {
      if (e && e.code === "rate_limited") ctx.left = 0;
      return null;
    }
  }
  async function listOf(ctx, srv, catId) {
    const key = keyOf(srv) + "|" + catId;
    const m = lists.get(key);
    if (m && fresh(m.ts, LIST_MS)) return m.list;
    let data = typeof deps.cachedList === "function" ? deps.cachedList(srv, catId) : null;
    if (!Array.isArray(data)) {
      data = await call2(ctx, srv, "get_live_streams", { category_id: String(catId) });
      if (Array.isArray(data) && typeof deps.keepList === "function") deps.keepList(srv, catId, data);
    }
    if (!Array.isArray(data)) return null;
    const list = data.map((s) => ({ stream_id: String(s && s.stream_id || ""), name: String(s && s.name || "") }));
    lists.delete(key);
    lists.set(key, { ts: now(), list });
    trim(lists, 8);
    return list;
  }
  const catsFrom = (data) => data.map((c) => ({ category_id: String(c && c.category_id || ""), category_name: String(c && c.category_name || "") }));
  function memoCats(k, cats) {
    catsMemo.delete(k);
    catsMemo.set(k, { ts: now(), cats });
    trim(catsMemo, 4);
  }
  async function catsOf(ctx, srv) {
    const k = keyOf(srv);
    const m = catsMemo.get(k);
    if (m && fresh(m.ts, NAME_MS)) return m.cats;
    let cats = deps.cachedCats(srv);
    if (!cats) {
      const data = await call2(ctx, srv, "get_live_categories", {});
      if (!Array.isArray(data)) return null;
      cats = catsFrom(data);
    }
    memoCats(k, cats);
    return cats;
  }
  async function refreshCats(ctx, srv) {
    const k = keyOf(srv);
    const at = deps.catsAt(srv);
    if (typeof at === "number" && now() - at < CATS_FRESH_MS) return null;
    if (fresh(refreshed.get(k), CATS_FRESH_MS)) return null;
    if (!room(ctx, 2500)) return null;
    refreshed.set(k, now());
    trim(refreshed, 16);
    const data = await call2(ctx, srv, "get_live_categories", {});
    if (!Array.isArray(data) || !data.length) return null;
    deps.storeCats(srv, data);
    const cats = catsFrom(data);
    memoCats(k, cats);
    return cats;
  }
  async function byName(ctx, srv, r) {
    if (!r.tok || !r.catTok) return null;
    const neg = keyOf(srv) + "|" + r.catTok + "|" + r.tok;
    if (fresh(negName.get(neg), NAME_MS)) return null;
    const cats = await catsOf(ctx, srv);
    if (!cats) return null;
    const c = matchCategory(r.catTok, cats);
    const list = c ? await listOf(ctx, srv, c.id) : null;
    if (c && !list) return null;
    const m = c ? matchChannel(r.tok, list) : { why: "none" };
    if (!m.id) {
      negName.set(neg, now());
      trim(negName, 32);
      return null;
    }
    return { id: m.id, catId: c.id, catName: c.name };
  }
  async function verify(ctx, srv, r, P) {
    const vk = keyOf(srv) + "|" + P;
    if (fresh(verified.get(vk), VERIFIED_MS)) return true;
    const list = await listOf(ctx, srv, r.catId);
    if (!list) return null;
    const entry = list.find((s) => s.stream_id === r.id);
    if (!entry || r.tok && !matchChannel(r.tok, [entry]).id) return false;
    verified.set(vk, now());
    trim(verified, 64);
    return true;
  }
  const named = (r) => !!r.catTok && r.catTok !== "_";
  function listsCategory(cats, r) {
    const c = cats && cats.find((x) => String(x.category_id) === r.catId);
    return !!c && (!named(r) || sameCategory(r.catTok, c.category_name));
  }
  async function originOf(ctx, r, active, list, map) {
    const own = deps.cachedCats(active);
    if (!own || listsCategory(own, r)) return { srv: active };
    const ap = panelOf(keyOf(active), map);
    let sure = false;
    if (named(r)) {
      for (const s of list) {
        if (s === active || !listsCategory(deps.cachedCats(s), r)) continue;
        if (usable(s, now())) return { srv: s };
        const sp = panelOf(keyOf(s), map);
        if (sp && ap && sp === ap) return { srv: active };
        if (sp && ap) sure = true;
      }
    }
    if (listsCategory(await refreshCats(ctx, active), r)) return { srv: active };
    return { foreign: true, sure };
  }
  function chainState(pkey, t0) {
    const prev = lastLive;
    lastLive = { key: pkey, at: t0 };
    let st = plays.get(pkey);
    if (st) plays.delete(pkey);
    else {
      st = { count: 0, moved: null, tried: /* @__PURE__ */ new Set(), triedPanels: /* @__PURE__ */ new Set(), spent: [], bad: /* @__PURE__ */ new Map() };
      try {
        const o = JSON.parse(kino.storage.get(STICKY_KEY) || "null");
        if (o && o.p === pkey && fresh(o.at, STICKY_MS)) st.moved = { k: o.k, id: o.id, a: o.a, at: o.at };
      } catch (_) {
      }
    }
    plays.set(pkey, st);
    trim(plays, 64);
    const chained = !!prev && prev.key === pkey && t0 - prev.at <= CHAIN_GAP_MS;
    st.count = chained ? st.count + 1 : 1;
    if (!chained) {
      st.tried.clear();
      st.triedPanels.clear();
    }
    st.spent = st.spent.filter((ts) => t0 - ts < STICKY_MS);
    return st;
  }
  function startAccount(st, P, origin, active, byKey, map, rank, r) {
    const ok = (s) => !!s && usable(s, now()) && !isRefused(keyOf(s)) && !isBadFor(st, keyOf(s));
    const ak = keyOf(active);
    const inP = (s) => {
      const k = keyOf(s);
      return P === "k:" + k || isLabel(P) && panelOf(k, map) === P;
    };
    if (ok(active) && (origin === active || inP(active))) return { srv: active, id: r.id };
    if (ok(origin)) return { srv: origin, id: r.id };
    const pref = preferred.get(P);
    if (pref && fresh(pref.ts, REFUSED_MS) && ok(byKey.get(pref.k))) return { srv: byKey.get(pref.k), id: r.id };
    if (isLabel(P)) {
      const sure = membersOf(P, map, now(), VERIFIED_MS).filter((k) => k !== ak && fresh(verified.get(k + "|" + P), VERIFIED_MS)).map((k) => byKey.get(k)).filter(ok).sort(rank);
      if (sure.length) return { srv: sure[0], id: r.id };
    }
    return null;
  }
  async function failover2(ctx, st, P, r, active, byKey, map, rank, pkey, blamed) {
    if (isLabel(P)) {
      const cands = membersOf(P, map, now(), VERIFIED_MS).map((k) => byKey.get(k)).filter((s) => s && !st.tried.has(keyOf(s)) && usable(s, now()) && !isRefused(keyOf(s)) && !isBadFor(st, keyOf(s))).sort(rank).slice(0, 2);
      if (cands.length) {
        const results = await Promise.all(cands.map(async (s) => {
          const ok = await verify(ctx, s, r, P);
          return ok ? probe(ctx, s, r.id) : ok === null ? "skipped" : "unverified";
        }));
        for (let i = 0; i < cands.length; i++) {
          if (results[i] !== "skipped") st.tried.add(keyOf(cands[i]));
          if (isGood(results[i])) {
            if (blamed) preferred.set(P, { k: keyOf(cands[i]), ts: now() });
            return { srv: cands[i], id: r.id };
          }
        }
        return null;
      }
    }
    if (!r.tok || !r.catTok) return null;
    const hit = nameHits.get(pkey);
    const foreign = (s) => {
      const k = keyOf(s);
      if (st.tried.has(k) || !usable(s, now()) || isRefused(k) || isBadFor(st, k) || P === "k:" + k) return false;
      const pl = panelOf(k, map);
      return !(isLabel(P) && pl === P) && !(pl && st.triedPanels.has(pl));
    };
    let target = hit && fresh(hit.ts, NAME_MS) && byKey.get(hit.k) && foreign(byKey.get(hit.k)) ? byKey.get(hit.k) : null;
    if (!target) target = [...byKey.values()].filter(foreign).sort((a, b) => a === active ? -1 : b === active ? 1 : rank(a, b))[0];
    if (!target) return null;
    const tk = keyOf(target);
    st.tried.add(tk);
    st.triedPanels.add(panelOf(tk, map) || "k:" + tk);
    const m = hit && hit.k === tk && fresh(hit.ts, NAME_MS) ? hit : await byName(ctx, target, r);
    if (!m) return null;
    const v = await probe(ctx, target, m.id);
    if (!isGood(v)) return null;
    nameHits.set(pkey, { k: tk, id: m.id, catId: m.catId, catName: m.catName, ts: now() });
    trim(nameHits, 64);
    return { srv: target, id: m.id };
  }
  function alternatives(P, played, r, pkey, byKey, map, rank) {
    const out = [];
    const seen = /* @__PURE__ */ new Set([keyOf(played.srv)]);
    const add = (s, id) => {
      const k = keyOf(s);
      if (s && !seen.has(k)) {
        seen.add(k);
        out.push({ s, id });
      }
    };
    const online = deps.online();
    if (isLabel(P)) {
      membersOf(P, map, now()).map((k) => byKey.get(k)).filter((s) => s && usable(s, now()) && (!online || online.has(s.url))).sort(rank).forEach((s) => add(s, r.id));
    } else if (P.startsWith("k:") && keyOf(played.srv) !== P.slice(2)) add(byKey.get(P.slice(2)), r.id);
    const hit = nameHits.get(pkey);
    if (hit && fresh(hit.ts, NAME_MS) && byKey.get(hit.k) && usable(byKey.get(hit.k), now())) add(byKey.get(hit.k), hit.id);
    const countBy = {};
    for (const e of out) {
      const b = deps.label(e.s);
      countBy[b] = (countBy[b] || 0) + 1;
    }
    if (countBy[deps.label(played.srv)]) countBy[deps.label(played.srv)]++;
    return out.slice(0, 8).map((e) => {
      const b = deps.label(e.s);
      return { label: countBy[b] > 1 && deps.host(e.s) ? `${b} \xB7 ${deps.host(e.s)}` : b, ref: `at:${keyOf(e.s)}~l~${e.id}` };
    });
  }
  function answer(st, c, P, r, pkey, byKey, map, rank, movedFrom) {
    if (movedFrom) {
      st.moved = { k: keyOf(c.srv), id: c.id, a: movedFrom, at: now() };
      st.count = 1;
      put(STICKY_KEY, JSON.stringify({ p: pkey, ...st.moved }));
    }
    const out = { url: deps.playUrl(c.srv, c.id) };
    const alts = alternatives(P, c, r, pkey, byKey, map, rank);
    if (alts.length) {
      out.alternatives = alts;
      out.label = deps.label(c.srv);
    }
    return out;
  }
  async function resolve3(ref) {
    const t0 = now();
    let r = parseLiveRef(ref);
    if (!r) throw deps.notFound();
    const { list, idx } = await deps.servers();
    if (!Array.isArray(list) || !list.length) throw deps.unavailable();
    const active = list[idx] || list[0];
    const byKey = new Map(list.map((s) => [keyOf(s), s]));
    const map = readPanels();
    const rank = rankWith(active);
    const ctx = { left: MAX_PER_RESOLVE, until: t0 + DEADLINE_MS, probes: [], st: { spent: [] } };
    if (r.bare) {
      const P2 = panelOf(keyOf(active), map) || "k:" + keyOf(active);
      const st2 = chainState(P2 + "|" + r.id, t0);
      return answer(st2, { srv: active, id: r.id }, P2, r, P2 + "|" + r.id, byKey, map, rank, null);
    }
    let where = await originOf(ctx, r, active, list, map);
    if (where.foreign) {
      const fk = "f|" + keyOf(active) + "|" + r.catId + "|" + r.id;
      const hit = nameHits.get(fk);
      const m = hit && fresh(hit.ts, NAME_MS) ? hit : await byName(ctx, active, r);
      if (m) {
        nameHits.set(fk, { ...m, k: keyOf(active), ts: hit && hit.ts ? hit.ts : now() });
        r = { id: m.id, catId: m.catId, catTok: categoryTok(m.catName), tok: r.tok, bare: false };
      } else if (where.sure) throw deps.notFound();
      where = { srv: active };
    }
    const origin = where.srv;
    const ok = keyOf(origin);
    const P = panelOf(ok, map) || "k:" + ok;
    const pkey = P + "|" + r.id;
    const st = chainState(pkey, t0);
    st.spent.push(...ctx.st.spent);
    ctx.st = st;
    const sticky = st.moved && st.moved.a === keyOf(active) && fresh(st.moved.at, STICKY_MS) ? byKey.get(st.moved.k) : null;
    let cur = sticky && usable(sticky, now()) && !isRefused(st.moved.k) && !isBadFor(st, st.moved.k) ? { srv: sticky, id: st.moved.id } : null;
    if (!cur) cur = startAccount(st, P, origin, active, byKey, map, rank, r);
    if (!cur && usable(origin, now()) && !st.tried.has(ok)) cur = { srv: origin, id: r.id, recheck: true };
    const R = st.count;
    let curBad = !cur;
    let blamed = !cur && isRefused(ok);
    if (cur) {
      if (R === 1 && !cur.recheck) return answer(st, cur, P, r, pkey, byKey, map, rank, null);
      if (R <= 2) {
        const v = await probe(ctx, cur.srv, cur.id);
        if (!isBad(v)) return answer(st, cur, P, r, pkey, byKey, map, rank, null);
        curBad = true;
        blamed = v === "refused" || v === "dead";
      } else {
        st.bad.set(keyOf(cur.srv), now());
        trim(st.bad, 32);
      }
      st.tried.add(keyOf(cur.srv));
    }
    const next = await failover2(ctx, st, P, r, active, byKey, map, rank, pkey, blamed);
    if (next) return answer(st, next, P, r, pkey, byKey, map, rank, keyOf(active));
    if (curBad && ctx.probes.length && ctx.probes.every(isBad)) throw deps.unavailable();
    if (R >= 3) {
      st.tried.clear();
      st.triedPanels.clear();
      const again = startAccount(st, P, origin, active, byKey, map, rank, r);
      if (again) return answer(st, again, P, r, pkey, byKey, map, rank, null);
    }
    if (cur) return answer(st, cur, P, r, pkey, byKey, map, rank, null);
    throw deps.unavailable();
  }
  return { resolve: resolve3 };
}

// src/channelTitle.js
var PANEL_BAR_CHARS = "\u2503\u2502\u258E\u258D\u258C\u258F\u2595\u2590\u2016\u254E\u254F\u2506\u2507\u250A\u250B\u2758\u2759";
var BAR_CHARS = "|\xA6\u2223\uFF5C" + PANEL_BAR_CHARS;
var BAR = "[" + BAR_CHARS + "]";
var PANEL_BAR = new RegExp("[" + PANEL_BAR_CHARS + "]");
var OPEN = "(?:" + BAR + "|\\[|\\(|!)";
var CLOSE = "(?:" + BAR + "|\\]|\\)|!)";
var TOK = "[A-Z0-9]{2,6}";
var BRACKET_TOKS = TOK + "(?:\\s*[/,+&-]\\s*" + TOK + ")*";
var SEP_TOKS = TOK + "(?:\\s*[/,]\\s*" + TOK + ")*";
var SEP = "(?:\\s*" + BAR + "+\\s*|\\s*:\\s*|\\s*[\u2022\xB7\u25CF\u25AA\u25BA\xBB\u27A4]\\s*|\\s+[-\u2013\u2014]+\\s*|[-\u2013\u2014]+\\s+)";
var LEAD_BRACKET = new RegExp("^\\s*" + OPEN + "\\s*(" + BRACKET_TOKS + ")\\s*" + CLOSE + "\\s*");
var LEAD_SEP = new RegExp("^\\s*(" + SEP_TOKS + ")" + SEP);
var TRAIL_BRACKET = new RegExp("\\s*" + OPEN + "\\s*(" + BRACKET_TOKS + ")\\s*" + CLOSE + "\\s*$");
var TRAIL_SEP = new RegExp("\\s*" + BAR + "+\\s*(" + SEP_TOKS + ")\\s*$");
var MID_BRACKET = new RegExp("\\s*" + BAR + "\\s*(" + BRACKET_TOKS + ")\\s*" + BAR + "\\s*", "g");
var BARS_LEFT = new RegExp("\\s*" + BAR + "+\\s*", "g");
var MAYBE_DECORATED = new RegExp("[" + BAR_CHARS + "\\[\\]()!:\u2022\xB7\u25CF\u25AA\u25BA\xBB\u27A4\u2013\u2014-]");
var JUNK = "[\\s" + BAR_CHARS + "\xB7\u2022\u25CF\u25AA\u25BA\xBB\u27A4:\u2013\u2014-]+";
var LEAD_JUNK = new RegExp("^" + JUNK);
var TRAIL_JUNK = new RegExp(JUNK + "$");
var HAS_TEXT = /[\p{L}\p{N}]/u;
var GROUP = /^[A-Z][A-Z0-9]{1,5}$/;
var NOT_GROUP = /* @__PURE__ */ new Set(["TV"]);
var TWO_LETTERS = /\p{L}{2}/u;
var OPENS_WRAP = new RegExp("^\\s*" + TOK + "\\s*" + BAR);
var COUNTRY = {
  es: "es",
  esp: "es",
  mx: "mx",
  mex: "mx",
  ar: "ar",
  arg: "ar",
  co: "co",
  col: "co",
  cl: "cl",
  pe: "pe",
  ve: "ve",
  ven: "ve",
  ec: "ec",
  ecu: "ec",
  uy: "uy",
  uru: "uy",
  py: "py",
  bo: "bo",
  cr: "cr",
  pa: "pa",
  gt: "gt",
  hn: "hn",
  sv: "sv",
  ni: "ni",
  do: "do",
  pr: "pr",
  cu: "cu",
  us: "us",
  usa: "us",
  ca: "ca",
  br: "br",
  bra: "br",
  pt: "pt",
  uk: "gb",
  gb: "gb",
  ie: "ie",
  sc: "sc",
  fr: "fr",
  fra: "fr",
  de: "de",
  ger: "de",
  it: "it",
  ita: "it",
  nl: "nl",
  be: "be",
  ch: "ch",
  at: "at",
  pl: "pl",
  ro: "ro",
  tr: "tr",
  tur: "tr",
  gr: "gr",
  al: "al",
  alb: "al",
  hr: "hr",
  rs: "rs",
  srb: "rs",
  se: "se",
  no: "no",
  dk: "dk",
  fi: "fi",
  au: "au",
  nz: "nz",
  in: "in",
  pk: "pk",
  sa: "sa",
  ksa: "sa",
  ma: "ma",
  ru: "ru",
  rus: "ru",
  bg: "bg",
  hu: "hu",
  cz: "cz",
  il: "il",
  ua: "ua",
  lu: "lu",
  jp: "jp",
  kr: "kr",
  cn: "cn",
  // the ex-Yugoslav panels' own spellings ("ARENA SPORT 1 HD (SR)", "(SL)", "(BIH)")
  sr: "rs",
  sl: "si",
  slo: "si",
  bih: "ba",
  ba: "ba",
  mkd: "mk",
  mk: "mk",
  mne: "me"
};
var REGION = {
  lat: "lat",
  latam: "lat",
  latino: "lat",
  latin: "lat",
  int: "int",
  multi: "multi",
  en: "en",
  eng: "en",
  exyu: "exyu",
  asia: "asia",
  afr: "afr",
  vip: "vip",
  ppv: "ppv"
};
var QUALITY2 = { "4k": "4K", "8k": "8K", uhd: "UHD", fhd: "FHD", hd: "HD", sd: "SD", hevc: "HEVC" };
var LABELS = {
  es: ["Espa\xF1a", "Spain"],
  mx: ["M\xE9xico", "Mexico"],
  ar: ["AR", "AR"],
  co: ["Colombia", "Colombia"],
  cl: ["Chile", "Chile"],
  pe: ["Per\xFA", "Peru"],
  ve: ["Venezuela", "Venezuela"],
  ec: ["Ecuador", "Ecuador"],
  uy: ["Uruguay", "Uruguay"],
  py: ["Paraguay", "Paraguay"],
  bo: ["Bolivia", "Bolivia"],
  cr: ["Costa Rica", "Costa Rica"],
  pa: ["Panam\xE1", "Panama"],
  gt: ["Guatemala", "Guatemala"],
  hn: ["Honduras", "Honduras"],
  sv: ["El Salvador", "El Salvador"],
  ni: ["Nicaragua", "Nicaragua"],
  do: ["Rep. Dominicana", "Dominican Rep."],
  pr: ["Puerto Rico", "Puerto Rico"],
  cu: ["Cuba", "Cuba"],
  us: ["EE. UU.", "USA"],
  ca: ["Canad\xE1", "Canada"],
  br: ["Brasil", "Brazil"],
  pt: ["Portugal", "Portugal"],
  gb: ["Reino Unido", "UK"],
  ie: ["Irlanda", "Ireland"],
  sc: ["Escocia", "Scotland"],
  fr: ["Francia", "France"],
  de: ["Alemania", "Germany"],
  it: ["Italia", "Italy"],
  nl: ["Pa\xEDses Bajos", "Netherlands"],
  be: ["B\xE9lgica", "Belgium"],
  ch: ["Suiza", "Switzerland"],
  at: ["Austria", "Austria"],
  pl: ["Polonia", "Poland"],
  ro: ["Rumania", "Romania"],
  tr: ["Turqu\xEDa", "Turkey"],
  gr: ["Grecia", "Greece"],
  al: ["Albania", "Albania"],
  hr: ["Croacia", "Croatia"],
  rs: ["Serbia", "Serbia"],
  se: ["Suecia", "Sweden"],
  no: ["Noruega", "Norway"],
  dk: ["Dinamarca", "Denmark"],
  fi: ["Finlandia", "Finland"],
  au: ["Australia", "Australia"],
  nz: ["Nueva Zelanda", "New Zealand"],
  in: ["India", "India"],
  pk: ["Pakist\xE1n", "Pakistan"],
  sa: ["Arabia Saudita", "Saudi Arabia"],
  ma: ["Marruecos", "Morocco"],
  ru: ["Rusia", "Russia"],
  bg: ["Bulgaria", "Bulgaria"],
  hu: ["Hungr\xEDa", "Hungary"],
  cz: ["Chequia", "Czechia"],
  il: ["Israel", "Israel"],
  ua: ["Ucrania", "Ukraine"],
  lu: ["Luxemburgo", "Luxembourg"],
  jp: ["Jap\xF3n", "Japan"],
  kr: ["Corea", "Korea"],
  cn: ["China", "China"],
  si: ["Eslovenia", "Slovenia"],
  ba: ["Bosnia", "Bosnia"],
  mk: ["Macedonia del Norte", "North Macedonia"],
  me: ["Montenegro", "Montenegro"],
  lat: ["Latino", "Latin"],
  int: ["Internacional", "International"],
  multi: ["Multi", "Multi"],
  en: ["Ingl\xE9s", "English"],
  exyu: ["Ex-Yu", "Ex-Yu"],
  asia: ["Asia", "Asia"],
  afr: ["\xC1frica", "Africa"],
  vip: ["VIP", "VIP"],
  ppv: ["PPV", "PPV"]
};
var labelOf = (key, lang) => {
  if (String(key).startsWith("=")) return String(key).slice(1);
  const l = LABELS[key];
  return l ? l[lang === "en" ? 1 : 0] : String(key).toUpperCase();
};
var NAME_SEP = "(?:\\s*" + BAR + "+\\s*|\\s*:\\s*|\\s*[\u2022\xB7\u25CF\u25AA\u25BA\xBB\u27A4]\\s*)";
var LEAD_NAME = new RegExp("^\\s*(?:" + OPEN + "\\s*([\\p{L} .'\u2019]{3,24}?)\\s*" + CLOSE + "\\s*|([\\p{L} .'\u2019]{3,24}?)" + NAME_SEP + ")", "u");
var fold = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[.'’]/g, "").replace(/\s+/g, " ").trim();
var COUNTRY_NAME = /* @__PURE__ */ new Map();
for (const [k, names] of Object.entries(LABELS)) if (k.length === 2) {
  for (const n of names) if (n.length > 3) COUNTRY_NAME.set(fold(n), k);
}
for (const [n, k] of [
  ["espana", "es"],
  ["argentina", "ar"],
  ["estados unidos", "us"],
  ["republica dominicana", "do"],
  ["dominicana", "do"],
  ["inglaterra", "gb"],
  ["england", "gb"],
  ["united kingdom", "gb"],
  ["portugal", "pt"]
]) COUNTRY_NAME.set(n, k);
var LATIN_TWO = /\p{Script=Latin}{2}/u;
var countryNamed = (text2) => COUNTRY_NAME.get(fold(text2)) || null;
var startsWithCountry = (rest) => {
  const words = fold(rest).split(" ");
  for (let n = Math.min(3, words.length); n >= 1; n--) if (COUNTRY_NAME.has(words.slice(0, n).join(" "))) return true;
  return false;
};
var ENTITY = /&(amp|quot|apos|lt|gt|nbsp|#\d{1,6}|#x[0-9a-f]{1,5});/gi;
var NAMED = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
function decodeEntities(text2) {
  let s = text2;
  for (let i = 0; i < 3 && /&(?:[a-z]+|#x?[0-9a-f]+);/i.test(s); i++) {
    s = s.replace(ENTITY, (all, e) => {
      const k = e.toLowerCase();
      if (NAMED[k] != null) return NAMED[k];
      const n = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return n > 31 && n < 1114112 && !(n >= 55296 && n <= 57343) ? String.fromCodePoint(n) : all;
    });
  }
  return s;
}
var normName2 = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
function codesOf(text2) {
  const marks = [];
  const quality = [];
  for (const t of String(text2).split(/[\s/,+&-]+/)) {
    if (!t) continue;
    const k = t.toLowerCase();
    if (COUNTRY[k]) marks.push(COUNTRY[k]);
    else if (REGION[k]) marks.push(REGION[k]);
    else if (QUALITY2[k]) quality.push(QUALITY2[k]);
    else return null;
  }
  return marks.length || quality.length ? { marks, quality } : null;
}
var hasWord = (s, w) => (" " + s.toUpperCase().replace(/[^A-Z0-9]+/g, " ") + " ").includes(" " + w + " ");
var MEMO_MAX = 2e4;
var memo2 = /* @__PURE__ */ new Map();
function cleanChannelTitle(raw) {
  const key = String(raw == null ? "" : raw);
  let out = memo2.get(key);
  if (!out) {
    if (memo2.size >= MEMO_MAX) memo2.clear();
    out = clean(key);
    memo2.set(key, out);
  }
  return { title: out.title, marks: out.marks.slice() };
}
function clean(raw) {
  const original = decodeEntities(raw).replace(/\s+/g, " ").trim();
  if (!MAYBE_DECORATED.test(original)) return { title: original, marks: [] };
  let s = original;
  const marks = [];
  const quality = [];
  const take = (codes) => {
    marks.push(...codes.marks);
    quality.push(...codes.quality);
  };
  const trimmed = (t, re) => {
    const x = t.replace(re, "");
    return HAS_TEXT.test(x) ? x : t;
  };
  for (let i = 0; i < 6; i++) {
    const m = s.match(LEAD_BRACKET) || (s = trimmed(s, LEAD_JUNK)).match(LEAD_SEP);
    const codes = m && codesOf(m[1]);
    const rest = m ? s.slice(m[0].length) : "";
    if (!codes) {
      const n = s.match(LEAD_NAME);
      const key = n && countryNamed(n[1] || n[2]);
      const after = n ? s.slice(n[0].length) : "";
      if (key && LATIN_TWO.test(after) && !startsWithCountry(after)) {
        marks.push(key);
        s = after;
        continue;
      }
    }
    if (m && !codes && PANEL_BAR.test(m[0]) && GROUP.test(m[1]) && !NOT_GROUP.has(m[1]) && TWO_LETTERS.test(rest) && !OPENS_WRAP.test(rest) && !codesOf(rest.replace(TRAIL_JUNK, ""))) {
      marks.push("=" + m[1]);
      s = rest;
      continue;
    }
    if (!codes || !HAS_TEXT.test(rest)) break;
    take(codes);
    s = rest;
  }
  for (let i = 0; i < 6; i++) {
    const m = s.match(TRAIL_BRACKET) || (s = trimmed(s, TRAIL_JUNK)).match(TRAIL_SEP);
    const codes = m && codesOf(m[1]);
    const front = m ? s.slice(0, m.index) : "";
    if (!codes || !HAS_TEXT.test(front)) break;
    take(codes);
    s = front;
  }
  s = s.replace(MID_BRACKET, (all, text2, at, whole) => {
    const codes = codesOf(text2);
    if (!codes || !HAS_TEXT.test(whole.slice(0, at)) || !HAS_TEXT.test(whole.slice(at + all.length))) return all;
    take(codes);
    return " ";
  });
  s = trimmed(trimmed(s.replace(BARS_LEFT, " \xB7 "), LEAD_JUNK), TRAIL_JUNK).replace(/\s+/g, " ").trim();
  for (const q of quality) if (!hasWord(s, q)) s += " " + q;
  if (!HAS_TEXT.test(s)) return { title: original, marks: [] };
  return { title: s, marks: [...new Set(marks)] };
}
function channelTitles(names, { cat = "", lang = "es" } = {}) {
  const list = Array.isArray(names) ? names : [];
  const parsed = list.map(cleanChannelTitle);
  const out = parsed.map((p) => p.title);
  const groups = /* @__PURE__ */ new Map();
  parsed.forEach((p, i) => {
    const k = normName2(p.title);
    const g = groups.get(k);
    if (g) g.push(i);
    else groups.set(k, [i]);
  });
  const own = String(cat || "").toLowerCase();
  for (const g of groups.values()) {
    if (g.length < 2 || new Set(g.map((i) => normName2(list[i]))).size < 2) continue;
    const common = new Set(parsed[g[0]].marks.filter((k) => g.every((i) => parsed[i].marks.includes(k))));
    const extra = (i) => parsed[i].marks.filter((k) => k !== own && !common.has(k));
    if (new Set(g.map((i) => extra(i).join("+"))).size < 2) continue;
    for (const i of g) {
      const e = extra(i);
      if (e.length) out[i] = parsed[i].title + " \xB7 " + e.map((k) => labelOf(k, lang)).join(" \xB7 ");
    }
  }
  return out;
}
var categoryKey = (name) => normCategory(name).cc;
function cleanCards(cards, opts) {
  if (!Array.isArray(cards) || !cards.length) return cards;
  const titles = channelTitles(cards.map((c) => c && typeof c.title === "string" ? c.title : ""), opts);
  return cards.map((c, i) => c && typeof c.title === "string" && titles[i] !== c.title ? { ...c, title: titles[i] } : c);
}
function cleanRails(rails, lang) {
  if (!Array.isArray(rails)) return rails;
  return rails.map((r) => r && Array.isArray(r.items) ? { ...r, items: cleanCards(r.items, { cat: categoryKey(r.title), lang }) } : r);
}

// src/catalog.js
var BOOTSTRAP_URL = "http://vegetatvv2.duckdns.org/bootstrap.php";
var VEGETA_VERSION_CODE = "21";
var CACHE_TTL_MS = 6 * 60 * 60 * 1e3;
var SRVS_V = 2;
var PROBE = "get_live_categories";
var SRVCHOSEN_KEY = "srvChosen:v1";
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
async function fetchServerList(opts) {
  const t = opts && opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {};
  let code = readVersionCode();
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await kino.fetch(BOOTSTRAP_URL + "?v=" + Date.now(), { headers: { ...vegetaHeaders(code), "Accept": "application/json" }, ...t });
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
      const r2 = await kino.fetch(data.servers_url, { headers: { ...vegetaHeaders(code), "Accept": "text/plain" }, ...t });
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
function migrate(st) {
  if (!st || !Array.isArray(st.list) || st.mig === 1) return st;
  let flag = null;
  try {
    flag = kino.storage.get(SRVCHOSEN_KEY);
  } catch (_) {
    flag = null;
  }
  if (st.chosen === void 0 && (st.pin || flag === "1") && st.list[st.idx]) st.chosen = keyOf(st.list[st.idx]);
  delete st.pin;
  st.mig = 1;
  writeSrvs(st);
  return st;
}
function carryOver(prev, st) {
  if (!prev) {
    st.idx = homeIdx(st);
    return st;
  }
  const keys = st.list.map(keyOf);
  const at = (k) => k ? keys.indexOf(k) : -1;
  if (prev.chosen) st.chosen = prev.chosen;
  if (prev.mig) st.mig = prev.mig;
  const c = at(prev.chosen);
  const a = at(keyOf(prev.list[prev.idx]));
  st.idx = c >= 0 && usable(st.list[c]) ? c : a >= 0 ? a : homeIdx(st);
  if (st.idx === a) {
    st.ok = !!prev.ok;
    st.okAt = prev.okAt;
    st.homeAt = prev.homeAt;
  }
  return st;
}
var SRVS_STALE_MS = 24 * 60 * 60 * 1e3;
async function loadServers(force, opts) {
  const cached = migrate(readSrvs());
  const usableList = cached && Array.isArray(cached.list) && cached.list.length;
  const ttl = opts && opts.stale ? SRVS_STALE_MS : CACHE_TTL_MS;
  if (!force && usableList && cached.ts && cached.v === SRVS_V && Date.now() - cached.ts < ttl) return cached;
  try {
    const list = await fetchServerList(opts);
    const st = carryOver(usableList ? cached : null, { ts: Date.now(), list, idx: 0, ok: false, v: SRVS_V });
    writeSrvs(st);
    return st;
  } catch (e) {
    lastErr = "lista: " + errText(e);
    if (usableList) return cached;
    throw e;
  }
}
function hasChosenServer() {
  const st = migrate(readSrvs());
  return !!(st && st.chosen);
}
function badAnswer(action3, data) {
  if (data === null || typeof data !== "object") return true;
  if (!Array.isArray(data)) {
    const auth = data.user_info && data.user_info.auth;
    return auth !== void 0 && String(auth) === "0";
  }
  return data.length === 0 && action3.endsWith("_categories");
}
var hostnameOf2 = (srv) => {
  try {
    return new URL(srv.url).hostname;
  } catch (_) {
    return "";
  }
};
async function callServer(srv, action3, extra, opts) {
  const params = new URLSearchParams({ username: srv.username, password: srv.password, ...action3 ? { action: action3 } : {}, ...extra });
  let r;
  try {
    r = await kino.fetch(`${srv.url}/player_api.php?${params}`, {
      headers: {
        "Accept": "application/json,text/plain,*/*",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "User-Agent": "Mozilla/5.0 (compatible; VegetaTVCache/2.0)"
      },
      ...opts && opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}
    });
  } catch (e) {
    if (e && e.code === "host_not_allowed" && e.host && e.host === hostnameOf2(srv)) noteBlocked(srv);
    throw e;
  }
  if (!r.ok) throw new Error("API " + r.status);
  let data;
  try {
    data = r.json();
  } catch (_) {
    throw new Error("respuesta inv\xE1lida");
  }
  if (accountVerdict(data) === "dead") {
    noteDead(srv);
    throw Object.assign(new Error("cuenta no v\xE1lida"), { dead: true });
  }
  if (action3 ? badAnswer(action3, data) : !(data && typeof data === "object" && data.user_info && typeof data.user_info === "object")) throw new Error("respuesta inv\xE1lida");
  noteAlive(srv);
  return data;
}
function rememberLiveCats(srv, data) {
  const k = keyOf(srv);
  if (!k || !Array.isArray(data) || !data.length) return;
  const list = data.map((c) => ({ category_id: String(c.category_id || ""), category_name: String(c.category_name || "").trim() }));
  if (serverKey() === k) catMemo.live = { key: k, ts: Date.now(), list };
  put("cats:live:" + k, JSON.stringify({ ts: Date.now(), l: list.map((c) => [c.category_id, c.category_name]) }));
}
function homeIdx(_st) {
  return 0;
}
function backTarget(st) {
  if (st.chosen) {
    const i = st.list.findIndex((s) => keyOf(s) === st.chosen);
    if (i >= 0) return i;
  }
  return homeIdx(st);
}
async function backHome(opts) {
  const st = await loadServers(false, opts);
  const target = backTarget(st);
  if (st.idx === target || Date.now() - (st.homeAt || 0) < 3e5 || !usable(st.list[target])) return;
  st.homeAt = Date.now();
  try {
    const data = await callServer(st.list[target], PROBE, {}, opts);
    st.idx = target;
    st.ok = true;
    st.okAt = Date.now();
    rememberLiveCats(st.list[target], data);
  } catch (_) {
  }
  writeSrvs(st);
}
function walkOrder(st) {
  const n = st.list.length;
  const map = readPanels();
  const p = panelOf(keyOf(st.list[st.idx]), map);
  const ring = Array.from({ length: n }, (_, j) => (st.idx + j) % n);
  const same = p ? ring.filter((i) => i !== st.idx && panelOf(keyOf(st.list[i]), map) === p) : [];
  return [st.idx, ...same, ...ring.filter((i) => i !== st.idx && !same.includes(i))].filter((i) => usable(st.list[i]));
}
async function api(action3, extra = {}) {
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
    for (const i of walkOrder(st)) {
      try {
        const data = await callServer(st.list[i], action3, extra);
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
  throw kino.error("unavailable", "ning\xFAn servidor respondi\xF3 (" + action3 + "): " + last, { userMessage: "Error al contactar el servidor." });
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
var labelOf2 = (srv) => srv && srv.name ? srv.name : hostOf(srv);
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
  const fi = flagInfo(labelOf2(srv));
  return fi ? fi.code ? `${fi.code.toUpperCase()} \xB7 ${fi.name}` : fi.name : labelOf2(srv);
};
async function serverStatus() {
  const cached = readSrvs();
  if (cached && cached.ok && cached.list && cached.list[cached.idx] && Date.now() - (cached.okAt || 0) < 2e4) return { ok: true, host: hostOf(cached.list[cached.idx]), index: cached.idx + 1, total: cached.list.length, at: cached.okAt };
  try {
    await api(PROBE);
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
    if (!usable(st.list[i])) continue;
    try {
      const data = await callServer(st.list[i], PROBE, {});
      st.idx = i;
      st.ok = true;
      st.okAt = Date.now();
      st.chosen = keyOf(st.list[i]);
      writeSrvs(st);
      rememberLiveCats(st.list[i], data);
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
var flagOf = (srv) => {
  const fi = flagInfo(labelOf2(srv));
  return fi ? fi.code : "";
};
var priorityOf = (srv) => srvPriority({ flag: flagOf(srv), label: niceLabel(srv) });
async function serverList() {
  const st = await loadServers(false);
  const { items, checked } = listItems(st);
  return { current: st.idx, items, checked };
}
function cachedServerList() {
  const st = migrate(readSrvs());
  if (!st || !Array.isArray(st.list) || !st.list.length) return null;
  const { items, checked } = listItems(st);
  return { current: st.idx, items, checked };
}
function listItems(st) {
  const h = onlineNow();
  const online = h ? new Set(h.online) : null;
  let items = (st.list || []).map((s, i) => ({ s, i })).filter(({ s }) => usable(s)).map(({ s, i }) => {
    const fi = flagInfo(labelOf2(s));
    const flag = fi ? fi.code : "";
    const label = niceLabel(s);
    return { i, label, host: hostOf(s), https: String(s.url).startsWith("https://"), flag, es: srvPriority({ flag, label }) <= 1, online: online ? online.has(s.url) : true };
  });
  if (online && online.size > 0) items = items.filter((x) => x.online);
  items.sort((a, b) => srvPriority(a) - srvPriority(b) || a.i - b.i);
  return { items, checked: !!h };
}
var RACE_LANES = 3;
var RACE_TRY_MS = 2500;
var RACE_MIN_TRY_MS = 1500;
var RACE_MS = 9e3;
var HOST_DOWN = /* @__PURE__ */ new Set(["timeout", "network", "host_not_allowed"]);
var NO_MORE = /* @__PURE__ */ new Set(["rate_limited", "invalid_request"]);
function raceAccounts(cands, deadline, later) {
  return new Promise((resolve3) => {
    const queue = cands.slice();
    const busy = /* @__PURE__ */ new Set();
    const gone = /* @__PURE__ */ new Set();
    let flying = 0, flyingEs = 0, reserve = null, stop = false, done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve3(v);
      }
    };
    if (later) later.then((keys) => {
      if (!done) queue.splice(0, queue.length, ...feedFirst(queue, keys));
    }, () => {
    });
    const settle = (c, data, e) => {
      flying--;
      if (c.es) flyingEs--;
      busy.delete(c.host);
      if (done) return;
      if (data) {
        if (c.es) {
          finish({ srv: c.srv, data });
          return;
        }
        if (!reserve) reserve = { srv: c.srv, data };
      } else {
        lastErr = errText(e);
        const code = e && e.code;
        if (HOST_DOWN.has(code)) gone.add(c.host);
        if (NO_MORE.has(code)) stop = true;
      }
      pump();
    };
    const start = (c, timeoutMs) => {
      flying++;
      if (c.es) flyingEs++;
      busy.add(c.host);
      callServer(c.srv, PROBE, {}, { timeoutMs }).then(
        (data) => Array.isArray(data) && data.length ? settle(c, data, null) : settle(c, null, new Error("respuesta inv\xE1lida")),
        (e) => settle(c, null, e)
      );
    };
    function pump() {
      while (!stop && !reserve && flying < RACE_LANES) {
        const left = deadline - Date.now();
        if (left < RACE_MIN_TRY_MS) break;
        const at = queue.findIndex((c) => !busy.has(c.host) && !gone.has(c.host));
        if (at < 0) break;
        start(queue.splice(at, 1)[0], Math.min(RACE_TRY_MS, left));
      }
      if (reserve ? !flyingEs : !flying) finish(reserve);
    }
    pump();
  });
}
function choose(srv, data) {
  const cur = readSrvs();
  const k = keyOf(srv);
  const i = cur && Array.isArray(cur.list) ? cur.list.findIndex((s) => keyOf(s) === k) : -1;
  if (i < 0 || cur.chosen) return false;
  cur.idx = i;
  cur.ok = true;
  cur.okAt = Date.now();
  cur.chosen = k;
  writeSrvs(cur);
  rememberLiveCats(srv, data);
  return true;
}
function feedFirst(cands, keys) {
  if (!(keys instanceof Set) || !keys.size) return cands;
  const rank = (c) => (c.es ? 0 : 2) + (keys.has(keyOf(c.srv)) ? 0 : 1);
  return cands.map((c, n) => ({ c, n, r: rank(c) })).sort((a, b) => a.r - b.r || a.n - b.n).map((x) => x.c);
}
async function autoPickServer({ until = Date.now() + 13500, feedKeys: feedKeys2 = null } = {}) {
  const stored = migrate(readSrvs());
  let feeds = null;
  if (typeof feedKeys2 === "function" && !(stored && stored.chosen)) {
    try {
      feeds = Promise.resolve(feedKeys2());
    } catch (_) {
      feeds = null;
    }
  }
  let keys = null;
  if (feeds) feeds.then((k) => {
    keys = k;
  }, () => {
  });
  try {
    const st = await loadServers(false, { timeoutMs: LIST_TIMEOUT_MS });
    if (st.chosen) {
      const cur = st.list[st.idx];
      return { ok: true, kept: true, host: hostOf(cur), label: labelOf2(cur) };
    }
    const cands = listItems(st).items.map((x) => ({ srv: st.list[x.i], es: x.es, host: hostnameOf2(st.list[x.i]) }));
    const win = await raceAccounts(feedFirst(cands, keys), Math.min(Date.now() + RACE_MS, until), keys ? null : feeds);
    if (!win || !choose(win.srv, win.data)) return { ok: false };
    return { ok: true, host: hostOf(win.srv), label: labelOf2(win.srv) };
  } catch (e) {
    lastErr = errText(e);
    return { ok: false };
  }
}
async function selectServer(i) {
  const st = await loadServers(false);
  const n = st.list.length;
  const start = parseInt(i, 10);
  if (!(start >= 0 && start < n)) return { ok: false };
  const wantLabel = labelOf2(st.list[start]);
  const all = Array.from({ length: n }, (_, k) => k);
  const order = [start, ...all.filter((k) => k !== start && labelOf2(st.list[k]) === wantLabel && usable(st.list[k]))].slice(0, 5);
  for (const idx of order) {
    try {
      const data = await callServer(st.list[idx], PROBE, {});
      st.idx = idx;
      st.ok = true;
      st.okAt = Date.now();
      st.chosen = keyOf(st.list[idx]);
      writeSrvs(st);
      rememberLiveCats(st.list[idx], data);
      return { ok: true, host: hostOf(st.list[idx]), label: labelOf2(st.list[idx]), index: idx + 1, total: n, exact: idx === start };
    } catch (e) {
      lastErr = errText(e);
    }
  }
  return { ok: false, host: hostOf(st.list[start]), label: labelOf2(st.list[start]), index: start + 1, total: n };
}
var HEALTH_KEY = "health:v1";
var HEALTH_TTL_MS = 6 * 60 * 60 * 1e3;
var FULL_EVERY_MS = 18 * 60 * 60 * 1e3;
var FULL_RETRY_MS = 30 * 60 * 1e3;
var healthRunning = false;
var fullRetry = null;
function readHealth() {
  try {
    const o = JSON.parse(kino.storage.get(HEALTH_KEY) || "null");
    return o && Array.isArray(o.online) && typeof o.ts === "number" ? o : null;
  } catch (_) {
    return null;
  }
}
var resultWithin = (ms) => {
  const h = readHealth();
  return h && Date.now() - h.ts >= 0 && Date.now() - h.ts < ms ? h : null;
};
var healthFresh = () => resultWithin(HEALTH_TTL_MS);
var ONLINE_TRUST_MS = 30 * 60 * 1e3;
var onlineNow = () => resultWithin(ONLINE_TRUST_MS);
function fullDue(now = Date.now()) {
  if (fullRetry && fullRetry.of === globalThis.kino && now >= fullRetry.until - FULL_RETRY_MS && now < fullRetry.until) return false;
  const p = readPanels();
  const age = p ? now - (Number(p.at) || 0) : NaN;
  return !(age >= 0 && age < FULL_EVERY_MS);
}
var healthReady = () => !!healthFresh() && !fullDue();
var HEALTH_TIMEOUT_MS = 1e4;
var HEALTH_DEADLINE_MS = 15e3;
var HEALTH_PARALLEL = 6;
var LIST_TIMEOUT_MS = 4e3;
var STEP_ACCOUNTS = 6;
var PING_TIMEOUT_MS = 3e3;
var STEP_FULL_TIMEOUT_MS = 5e3;
var ROUND_MAX_MS = 30 * 60 * 1e3;
async function pool(list, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) await fn(list[next++]);
  }));
}
function healthOrder(st) {
  const list = st.list || [];
  const first = new Set([keyOf(list[st.idx]), st.chosen].filter(Boolean));
  return [...list.filter((s) => first.has(keyOf(s))), ...list.filter((s) => !first.has(keyOf(s)))];
}
function finishHealth({ st, answered, unprobed, sets, best }) {
  const list = st.list || [];
  const online = list.filter((s) => answered.has(s.url)).map((s) => s.url);
  const now = Date.now();
  put(HEALTH_KEY, JSON.stringify({ ts: now, online: list.filter((s) => answered.has(s.url) || unprobed.has(s.url)).map((s) => s.url) }));
  if (sets) fullRetry = { of: globalThis.kino, until: now + FULL_RETRY_MS };
  const map = sets && sets.size ? groupPanels(sets, readPanels(), now) : readPanels();
  if (sets && sets.size) writePanels(map);
  if (best) choose(best.s, best.data);
  const fresh = readSrvs() || st;
  const cur = fresh.list && fresh.list[fresh.idx];
  if (cur && online.length && !online.includes(cur.url)) {
    const p = panelOf(keyOf(cur), map);
    const flag = flagOf(cur);
    const score = (s) => [p && panelOf(keyOf(s), map) === p ? 0 : 1, flagOf(s) === flag ? 0 : 1, priorityOf(s)];
    const cands = fresh.list.map((s, i) => ({ s, i, sc: score(s) })).filter((x) => online.includes(x.s.url)).sort((a, b) => a.sc[0] - b.sc[0] || a.sc[1] - b.sc[1] || a.sc[2] - b.sc[2] || a.i - b.i);
    if (cands.length) {
      fresh.idx = cands[0].i;
      fresh.ok = true;
      fresh.okAt = now;
      writeSrvs(fresh);
    }
  }
  return online.length;
}
async function healthCheck({ until: limit = Infinity, pick = false } = {}) {
  if (healthRunning) return 0;
  healthRunning = true;
  const until = Math.min(Date.now() + HEALTH_DEADLINE_MS, limit);
  try {
    const st = await loadServers(false, { timeoutMs: LIST_TIMEOUT_MS });
    const list = st.list || [];
    const sets = /* @__PURE__ */ new Map();
    const answered = /* @__PURE__ */ new Set();
    const unprobed = /* @__PURE__ */ new Set();
    const rank = new Map(list.map((s, i) => [s, priorityOf(s) * 1e3 + i]));
    const order = pick ? list.slice().sort((a, b) => rank.get(a) - rank.get(b)) : healthOrder(st);
    let best = null;
    await pool(order, HEALTH_PARALLEL, async (s) => {
      if (!usable(s)) return;
      const left = until - Date.now();
      if (left < 1500) {
        unprobed.add(s.url);
        return;
      }
      try {
        const data = await callServer(s, PROBE, {}, { timeoutMs: Math.min(HEALTH_TIMEOUT_MS, left - 500) });
        sets.set(keyOf(s), pairHashes(data));
        answered.add(s.url);
        if (pick && Array.isArray(data) && data.length && (!best || rank.get(s) < rank.get(best.s))) best = { s, data };
      } catch (_) {
      }
    });
    return finishHealth({ st, answered, unprobed, sets, best });
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
var round = null;
async function healthStep() {
  if (healthRunning) return;
  healthRunning = true;
  try {
    const now = Date.now();
    if (!round || round.of !== globalThis.kino || !(now - round.at >= 0 && now - round.at < ROUND_MAX_MS)) {
      const st = await loadServers(false, { timeoutMs: LIST_TIMEOUT_MS });
      const full = fullDue(now);
      round = { of: globalThis.kino, at: now, st, full, order: healthOrder(st), next: 0, answered: /* @__PURE__ */ new Set(), sets: full ? /* @__PURE__ */ new Map() : null };
    }
    const r = round;
    const slice = [];
    while (r.next < r.order.length && slice.length < STEP_ACCOUNTS) {
      const s = r.order[r.next++];
      if (usable(s)) slice.push(s);
    }
    await pool(slice, STEP_ACCOUNTS, async (s) => {
      try {
        if (r.full) r.sets.set(keyOf(s), pairHashes(await callServer(s, PROBE, {}, { timeoutMs: STEP_FULL_TIMEOUT_MS })));
        else await callServer(s, null, {}, { timeoutMs: PING_TIMEOUT_MS });
        r.answered.add(s.url);
      } catch (_) {
      }
    });
    if (r.next >= r.order.length && round === r) {
      round = null;
      finishHealth({ st: r.st, answered: r.answered, unprobed: /* @__PURE__ */ new Set(), sets: r.sets, best: null });
    }
  } catch (_) {
    round = null;
    fullRetry = { of: globalThis.kino, until: Date.now() + FULL_RETRY_MS };
    try {
      put(HEALTH_KEY, JSON.stringify({ ts: Date.now(), online: [] }));
    } catch (__) {
    }
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
      await api(PROBE);
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
var LIST_MEMO_MS = 3 * 60 * 1e3;
var LIST_MEMO_MAX = 8;
var listMemo = /* @__PURE__ */ new Map();
var listMemoOf = null;
var slimStream = (s) => ({ stream_id: s && s.stream_id, name: s && s.name, stream_icon: s && s.stream_icon, num: s && s.num, category_id: s && s.category_id });
var memoFor = () => {
  if (listMemoOf !== globalThis.kino) {
    listMemo.clear();
    for (const k of Object.keys(catMemo)) delete catMemo[k];
    liveCatsMemo = null;
    listMemoOf = globalThis.kino;
  }
  return listMemo;
};
function memoList(k, catId) {
  const m = k ? memoFor().get(k + "|" + catId) : null;
  return m && Date.now() - m.ts >= 0 && Date.now() - m.ts < LIST_MEMO_MS ? m : null;
}
function keepList(k, catId, data) {
  if (!k || !Array.isArray(data)) return data;
  memoFor();
  const list = data.map(slimStream);
  const key = k + "|" + catId;
  listMemo.delete(key);
  listMemo.set(key, { ts: Date.now(), list });
  while (listMemo.size > LIST_MEMO_MAX) listMemo.delete(listMemo.keys().next().value);
  return list;
}
async function callServerMemo(srv, action3, extra, opts) {
  const catId = action3 === "get_live_streams" && extra && extra.category_id !== void 0 ? String(extra.category_id) : null;
  if (catId === null) return callServer(srv, action3, extra, opts);
  const m = memoList(keyOf(srv), catId);
  if (m) return m.list;
  return keepList(keyOf(srv), catId, await callServer(srv, action3, extra, opts));
}
async function fetchCategory(action3, categoryId) {
  const id = String(categoryId);
  const live = action3 === "get_live_streams";
  if (live) {
    const m = memoList(serverKey(), id);
    if (m) return m.list;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await api(action3, { category_id: id });
      if (!Array.isArray(data)) throw new Error("respuesta que no es lista");
      return live ? keepList(serverKey(), id, data) : data;
    } catch (e) {
      if (attempt >= 1 || e && e.code === "rate_limited") throw e;
    }
  }
}
var CAT_ACTIONS = { vod: "get_vod_categories", series: "get_series_categories", live: "get_live_categories" };
var catMemo = {};
async function categoryList(kind) {
  memoFor();
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
var LIVE_PAGE = 500;
var LIVE_CATS_TTL_MS = 10 * 60 * 1e3;
var liveCatsMemo = null;
async function liveCats() {
  memoFor();
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
  const all = await categoryItems(catId);
  const items = all.slice(start, start + PER_PAGE).map((i) => ({ id: i.id, ref: i.ref, title: i.title, kind: "live", poster: i.logo, ...i.adult ? { adult: true } : {} }));
  return { items, next: all.length > start + PER_PAGE ? String(page + 1) : void 0 };
}
var catNames = { list: null, map: null };
function catNameOf(catId) {
  const m = catMemo.live;
  if (!m || !Array.isArray(m.list)) return "";
  if (catNames.list !== m.list) catNames = { list: m.list, map: new Map(m.list.map((c) => [String(c.category_id), c.category_name])) };
  return catNames.map.get(String(catId)) || "";
}
function liveItem(s, categoryId, adult, shown2) {
  const id = String(s.stream_id || "");
  const raw = String(s.name || "").trim();
  if (!id || !raw) return null;
  const catId = String(categoryId || s.category_id || "");
  return {
    id: "live-" + id,
    title: shown2 || raw,
    ref: liveRef(id, catId, categoryTok(catNameOf(catId)), channelTok(raw)),
    logo: img(s.stream_icon),
    number: parseInt(s.num, 10) || void 0,
    categoryId: String(categoryId || s.category_id || ""),
    ...adult ? { adult: true } : {}
  };
}
async function categoryItems(categoryId) {
  const id = String(categoryId || "");
  const c = (await liveCats().catch(() => [])).find((x) => x.id === id);
  const adult = !!(c && c.adult);
  if (adult && !showAdult()) return [];
  const all = await fetchCategory("get_live_streams", id);
  const m = memoList(serverKey(), id);
  const tag = langNow() + (adult ? "|a" : "") + "|" + catNameOf(id);
  if (m && m.list === all && m.items && m.items.tag === tag) return m.items.list;
  const shown2 = shownTitles(all, categoryKey(catNameOf(id)));
  const items = [];
  for (let i = 0; i < all.length; i++) {
    const it = liveItem(all[i], id, adult, shown2[i]);
    if (it) items.push(it);
  }
  if (m && m.list === all) m.items = { tag, list: items };
  return items;
}
async function liveChannels({ categoryId, cursor }) {
  const items = await categoryItems(categoryId);
  const start = Math.max(0, parseInt(cursor, 10) || 0);
  return { items: items.slice(start, start + LIVE_PAGE), next: items.length > start + LIVE_PAGE ? String(start + LIVE_PAGE) : void 0 };
}
var shownTitles = (streams, catKey) => channelTitles(streams.map((s) => s && s.name || ""), { cat: catKey, lang: langNow() });
var SHOWN_ONLY = /·|\b(?:4k|8k|uhd|fhd|hd|sd|hevc)\b/;
var nameHas = (s, q) => {
  const raw = String(s && s.name || "");
  return raw.toLowerCase().replace(/\s+/g, " ").includes(q) || SHOWN_ONLY.test(q) && cleanChannelTitle(raw).title.toLowerCase().includes(q);
};
async function liveSearchDetailed({ query }, { budgetMs = 11e3 } = {}) {
  const q = String(query || "").trim().toLowerCase().replace(/\s+/g, " ");
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
        return data.filter((s) => nameHas(s, q)).map((s) => liveItem(s, cat.id, cat.adult)).filter(Boolean).map((it) => ({ ...it, adult: cat.adult === true }));
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
  const shown2 = shownTitles(items.map((it) => ({ name: it.title })), "");
  const asked = normName2(query);
  items.forEach((it, i) => {
    if (normName2(it.title) !== asked) it.title = shown2[i];
  });
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
var GUIDE_MAX = 50;
var GUIDE_LANES = 4;
var GUIDE_TRY_MS = 2500;
var GUIDE_MS = 3500;
var GUIDE_MIN_TRY_MS = 500;
async function guide({ channelIds, from, to }) {
  const ids = (Array.isArray(channelIds) ? channelIds : []).map((cid) => [String(cid), String(cid).replace(/^live-/, "")]).filter(([, streamId]) => /^\d+$/.test(streamId)).slice(0, GUIDE_MAX);
  if (!ids.length) return [];
  const until = Date.now() + GUIDE_MS;
  if (readSrvs()) {
    try {
      await backHome({ timeoutMs: GUIDE_TRY_MS, stale: true });
    } catch (_) {
    }
  }
  const st = readSrvs();
  const srv = st && Array.isArray(st.list) ? st.list[st.idx] : null;
  if (!srv || !usable(srv)) return [];
  const out = [];
  let answered = false;
  let silent = false;
  await pool(ids, GUIDE_LANES, async ([cid, streamId]) => {
    const left = until - Date.now();
    if (left < GUIDE_MIN_TRY_MS || silent) return;
    let data;
    try {
      data = await callServer(srv, "get_short_epg", { stream_id: streamId, limit: "20" }, { timeoutMs: Math.min(GUIDE_TRY_MS, left) });
      answered = true;
    } catch (e) {
      if (!answered && e && HOST_DOWN.has(e.code)) silent = true;
      return;
    }
    try {
      const rows = Array.isArray(data) ? data : data && (data.epg_listings || data.listings || data.epg) || [];
      for (const e of rows) {
        const p = {
          channelId: cid,
          title: decodeEntities(b64text(e.title)),
          description: decodeEntities(b64text(e.description || e.descr)),
          start: (parseInt(e.start_timestamp, 10) || 0) * 1e3,
          end: (parseInt(e.stop_timestamp || e.end_timestamp, 10) || 0) * 1e3
        };
        if (p.title && p.end > p.start && p.end > from && p.start < to) out.push(p);
      }
    } catch (_) {
    }
  });
  return out;
}
function cachedLive(srv) {
  const k = keyOf(srv);
  if (!k) return null;
  const m = catMemo.live;
  if (m && m.key === k && Array.isArray(m.list)) return { ts: m.ts, list: m.list };
  try {
    const o = JSON.parse(kino.storage.get("cats:live:" + k) || "null");
    if (o && Array.isArray(o.l)) return { ts: o.ts, list: o.l.map(([category_id, category_name]) => ({ category_id: String(category_id), category_name: String(category_name) })) };
  } catch (_) {
  }
  return null;
}
var cachedCats = (srv) => {
  const c = cachedLive(srv);
  return c ? c.list : null;
};
var cachedCatsAt = (srv) => {
  const c = cachedLive(srv);
  return c && typeof c.ts === "number" ? c.ts : null;
};
function liveCatNamer() {
  const st = readSrvs();
  const srv = st && Array.isArray(st.list) ? st.list[st.idx] : null;
  const list = srv && cachedCats(srv) || [];
  const names = new Map(list.map((c) => [String(c.category_id), String(c.category_name || "")]));
  return (catId) => names.get(String(catId)) || "";
}
async function liveServers() {
  const st = readSrvs();
  if (st && Array.isArray(st.list) && st.list.length) return st;
  return loadServers(false, { timeoutMs: 4e3 });
}
var seedMemo = "";
function installSeed() {
  if (seedMemo) return seedMemo;
  let v = null;
  try {
    v = kino.storage.get("seed:v1");
  } catch (_) {
    v = null;
  }
  if (!v || !/^\d+$/.test(v)) {
    v = String(Math.floor(Math.random() * 1e9));
    put("seed:v1", v);
  }
  seedMemo = v;
  return v;
}
var langNow = () => {
  try {
    return /^en/i.test(String(kino.lang || "")) ? "en" : "es";
  } catch (_) {
    return "es";
  }
};
var failover = createLiveFailover({
  servers: liveServers,
  cachedCats,
  catsAt: cachedCatsAt,
  storeCats: rememberLiveCats,
  callServer: callServerMemo,
  playUrl: (srv, id, format) => `${srv.url}/live/${srv.username}/${srv.password}/${id}.${format || liveFormat()}`,
  label: niceLabel,
  host: hostOf,
  online: () => {
    const h = onlineNow();
    return h ? new Set(h.online) : null;
  },
  flag: flagOf,
  priority: priorityOf,
  seed: installSeed,
  now: () => Date.now(),
  unavailable: () => kino.error("unavailable", "no account plays this channel now", { userMessage: say("liveNoServer", langNow()) }),
  notFound: () => kino.error("not_found", "channel not found")
});
async function resolve(ref) {
  const s = String(ref || "");
  if (s.startsWith("at:")) {
    const segs = s.slice(3).split("~");
    const srv = serverByKey(segs[0]);
    const id = segs[2] || "";
    if (!srv || segs[1] !== "l" || !/^\d+$/.test(id)) throw kino.error("not_found", "fuente desconocida");
    return { url: `${srv.url}/live/${srv.username}/${srv.password}/${id}.${liveFormat()}` };
  }
  if (s.startsWith("live:")) return failover.resolve(s);
  throw kino.error("not_found", "ref desconocido: " + s.slice(0, 30));
}

// src/logo.js
var LOGO_DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAABmJLR0QA/wD/AP+gvaeTAAAOqUlEQVR4nO2de3RV1Z3HP/vcPCEJJISIpYN2hCBQH8t2IcURgl2ra5URreOSaanSpfUxtsjgE4vOTBwGediKU5yOOrVFLUVCWyVo63RaeaizumxnLA7h4YpWUYGkQSCBPO85v/kjucm5595z7snNveGcm/39I+vuk9/e+7f353f32fvsc84FLS0tLS0tLS0tLa2RJTUstdSKMbOo5wLDYq6IMQMl1YiaBFY5wmiBgn5b6f9j/zjwQWyHAGQgldremTmWJ/GgzYO4PJKkjN5DcUYp7Putu4HTCJ8AH4qSd5SoBrHY1fDo2LdBOXNmXNkLgFoxLs2PzlWGWozIAoFxDnJJYPb/GQnwHfbiaAMtCtmOsp7dW1K5m1plkQVlPAC+/H0pPH7aulGJ3CvIX4ITTl9Cw/eC77CXd8F4pLunfGPjBtVFBpW5ABBRX1hr3iDCaoRPJYfZl9DwBwF/wF4hH4vi/n2PjtuUqdNDRgJg5sNSrZT5HwrmuMPsS2j4acF39NFOQ1m3NKyvamSIGnIAXLo6ei2KHyphrIY/LPBjahPktgOPjd/MEGSknVNEzVrd810FP9Pwhx0+IKVK+OnUZX9eC5L2FzmtjDW1ktdRaD6tYLEPRzV8h88ZgB/fTCXPTBg7/uadtSrKIDX4EUBEdRaZT2n4XvbDCB9A1DeOftK8MZ2RYNABMGtN9BGEG9Nz1M1ew3c47fwY57yziN42qq9PXdqyxvmvVBpUxMxaE12IsCUtRzX8LMK3Z1fXH9wwfpPTzE2+A2Dmw1JtKPMPQKmGH1T4ANKaZ6rPNfzA3xLR3ylARBmG+QQaftDhA5SZhjyNz/mArwCYtdpcjDBPww88/NixOVOWNH3NmS2ZUkZJTa0UdRaa76Iv74YCvi3PR5Zqndy4YYrn3kHKEaCzyLpRww8dfEA+bZili51FOOUdALViKEvu0fCd9oGH35tQ3EeKuYBnAMwsjNboLV2nfUjg92rylG8fudxZnF2eAWCgbvDtqIYfNPi9g4DgeRpwDwARhSVXDif8SeNg/aICfnlXEY8uKmDCGJUks4bvyJYs0d9HglqAx2nA9R+zV3VfbCr11nDBv7za4N75+YwauDuQPR9a3LUpfhKr4cdlS5ZI6KOIoS488PiE/3NWAZCX7CCApWI3d3g4mgH4hoJvzomwcGYeyhGO086OH6A0/LhsyRJJ+8iKylxgcAEglvHZgbuOsgM/LwL3fTmPK6ZHkvqw/7DlyKPhDxY+AqZihrOamNwDQEm1cnM0A/AL8+Efr8rn0vOST0M+aBHWvdxty6PhpwNfAIVV7awqJtcAUKhzwMoK/PwIrLwmn0vOTQ7/tYMm617upr1bw3dkS5bw0UfqXGd1MbkGAFhl2YBvGLBiQXL4IvCj3T1s/l0UET8Nw9ERGn68SX8flTmrjMk9AISSTMMHWPalPC6vToRvWfC9V3p45e2oLU9uwDcQrm57g2tbdzGt+0MA9hf8BVvL5lI/+gtYKEeejMIHKMVF7nOALDyudc3nIsy/MHHCFzVh5bZuXn/HtOXJDfgFEuWxo49T074nLvslnY1c0tnIl0b9D8uqbqdL5WULPkAhLkq9HZwh+NMnKm6tSYw3S2DNS7kJH2D5sc0J8O2a1/5H7vlkazbhJ7hvl3cAZAh+WTHUXp1PfpLV3uP/1cOO/e7wJ45VrL++iP+8bxSPXV/Ud3UwVkew4U+IHmPhyZ2k0qK2HUyIHnO0IWkiPfhOe5s8LgUPlDQU+CDUnG9QUZJ40fEXf4iy7X/dz/nTzjbY8I0iLppkUJAHF02KcP+VhX32wYYPwmXtDURI/UxnRExmd+6ztcFWQRbhg+cqIDPw3bT3I4snd/S4Ojp7coQHv1JIUX58vmkTI6GAj0CF2YpfVZqtww4fUpwCMgJfYMd+i6aTA3ZNJ4WHXugmarrDf+jaRPgA+z42k8AJHnwBjkVcV18JajHKhh0+eK8CMgJfgNYO4e+e6aJmau8kYOcBk9YOSerotLMNHvxKIZEkoXn4uMXa7Y47nAIKH+CN4hmYKkJEzMTG2GSqCK8Xx67WZgG+RyykmAPEV5IO/FiitV2ofytK/VtRV/gTxypWLUz+zd//scm3NnZw5ITtnBpg+ABH8yp4vnRuYmMc2lRSQ1OkHGcBmYIvCQ0bUIplYGbgO+t3c/Sevy5k7KjEyeLv3zO58yednDgd39ogw4+Vsa7ib3l11MUJbYrpt8UXs658Ic4ChgM++JgEDhd8AaZ9KjEeDxw2+YetnXT2hA8+QLfKY8lZS1jQ9juuO7Wb6V0fANBQcA51pXN4afSlveuEMwAfPAOAxIZl+Tau/YdNLpo0cLHg8HGL+7eEF37MXESxrWQW20pm2bORJJEd+B5x4DkHGE74AGu2d7HnkEl3FPYcMrl7UziH/cTszjYkTQw7fEi1CuhPZB8+AkdPCMue63SBqeFnGj742gsYHvgD/9Lw402GDj/9VYCGnxvwPUYCr9vCHZU6Stfw+8tIzB4O+JBqFYCzPeGAf/1f9W4YbX6jC9PS8L00xL2A4MEHKCtWLL+qmBfuLuWyqfkavodcAyCs8O2Jz1RFeOLmEv7tphImVhge9jkO3yMY0twLCD58u+ZOz6f+3jLunF/MqELlsM99+BneCwg6/OTNLcxXfPOKIrYvH8PVny+034Y5YuGDZwCEGL5Hm88aY/Dw10az+e/LuPCcvBENH3zcE5hL8O26YFIem5aOYc2iEipKYt2Qo/A9+sTnXkBuwY/JUHDV5wv51Yqx3PzFIvKNkQUfUq0C4j324agtZ8Dh21VarLjrytG8uLycOdNtz6fnDHz3zkk9CQwl/PSi4TNVEZ68tYx/v6WMSeMGuibs8L16w3sSGEb4Pm+G9FLNjAJeXlHBir8pYXSRCj98jy7xcR0glaM24wDAHzr+XuVF4Ia5xfxyRQULZxdhxC4f5BB88Pmm0JEG366qMQb//NVSttxdzsXn5ucUfPARAKGEn4VIuGBSPpvvLGfdDWVUliqfMG3OBBA++NoM0vBjUgqunlnEb2oruWN+CQV5KhzwPeZFKTaDwgg/ixHQp+ICxZL5o9n+wDjmzSiI/2cA4Xv1iK8bQgYqttUQYPjZD4FenTs+wpO3l7Pxjgomn50XOvjg+/cCNHwvzT6/gPrvVPLgdWWUFNl9sn0MIHzw+YKIUME/ExFA77Jx8bxR/PqfqvjqZaP6l41Bhg++N4M0fL8aP8Zg5dfH8MB1ZcGB79EvXi+JCjH8MxcJfz5p8f2X2tjyRnuA4Lv3R4oHQ0IK/wzwj5rw092nWV/fRlunhAI++Hw4ND1HRw78/z7Qxcq6VhqPRAM27Md9jZMq5cOh6Tl65uAPJ//3m6Os2trKzr1dNp8CCN+jUzznAOk5mvvw27uEp39zmideOUV31O5TuOCDrwdDNHybW2x7s4O1L7TSctLPm8yDAt+9dzwDQMMf0Nsf9LCy7iR//FMPCc0PKXzwXAWEFH4Gbgixq/mkxXdfbOPFN9t7iw4jfI8u8TUH8HY0N+H3RIXNr3Xw6PY2TndaNp/s7oUDvlevpJwDeDsaTPhDDYMde7v4l7pWDrWY2Dsy3r3wwwc/ARBG+GlGwJ+aoqz6eRu793bZPchZ+ODrJVFhhD+4CGjtsHjq16f58avt9PSI3YPcgO9xakyxF5Db8C2B+t93sPYXbRxrs/88zsiAD6lWAQmO5g78t9/vYeXWVva832OvBntHxpefe/DB5xwgztWQw286YfG9+ja2vdkxUEyOw/fqmSHuBQQQvktrO3uEZ3e284NfnaK9K94+5+F7RMAQ9gKCCT9ZW3fs7WLl1jY+aok6yhvZ8CHtvYBwwH+vKcqqn7Xx2v5uF5i2MnIavnsUpLEXEHT4wolTFg/VtbHl9XaiVnz+ePuRDR8GvRcQfPgIPLer3Wav4XvFgO+HQ8MCP95ew0/arzb5fC5Aw89F+ODzZdEavv1jGOG7h0HKl0Vr+PaPIYXvMQx4Phuo4ds/5h588PWSKAbfMA0/FPDB+xTQbS9bw/djH0z4Ao4fWxyQVwCc0vBzAj4IbU4XYnI/BVi0xorQ8FPZBxo+IK4/YuwaAErxgYbvxz7w8FGo952uxOQ+Aig5qOGnsg8+/L4jB53uxOQ+Aohq0PC97MMCHxDZ53QpJo8RgN3xBzT8cMIHk8hOp1sxJf5S80BONePu481ApYZvtw8XfBGaj9ZNmQAqwT3wXAYqUch2Dd9uHzL4gBhqmxt8SPWiSLGe0/DjrEMFH8DAes7pnl2eAdBQVrkL5F2nZxp+7HCw4YM0Hnm++nWni3Z57wbWKguMRzR8ktgHHj4Ca72Gf/BxP0B3T/lGhXycrD4NP76MIMFH5FClFX3W6aZTKQOgcYPqsoTvaPixw2GAD6LU8oatM7qdrjrlsQyM1/nLWn6r4Iq4SpxGGn4g4IPsOlo3dV6q4R/83hMIRJR1G9Cq4ceXETz4nBTTuMkPfBhEADSsr2pUYt2s4cc54vwY5/MZgI+gbm/6efV7Tnfd5DsAAPb9a9VWS7Eu7qCGHxj4ClY31VVvdrrrJd9zAFvtatrSYz8UJTdp+PFlxLdhoIwkWV3sh/LN5ydNddWL/Q79MQ1qBOiVkrMqxt2GyDPpODpgquFnCj7Ij5uaD984WPiQ1gjQX6maurRlDch9Gj7OZg4bfAWrj9RVP5AO/L78Q1P10qZrlPAjYKyXo30pDT/BPm34raK4rWnL1Oed7g5GQw4AgBnfap4cjfAUIvM0/GGB/6qY6pbBzPbdlJEA6JWoqXc0LxJhDcinNfxU9unAl0Oi1PKhfuvtSmMS6CYlBzectSm/suU8LG4F3gUNP0PwGwVuGSfmlEzCh4yOAE6JmvLtI5crYbGgFgBVvYc1fF/whWalVD3KerZ3Sze9SV4qZTEA7BJ1/pKmz5omNRYyXWFVgzEJkQqgBCgYofC7EdoEOW6gDgnyjhJpMInsbNpyXkO2oGtpaWlpaWlpaWlpjWT9P3bIRL+UhUqQAAAAAElFTkSuQmCC";

// src/screenView.js
var TAB_IDS = ["all", "premium", "paises", "deportes", "radio"];
var TAB_KEYS = { all: "tabAll", premium: "tabPremium", paises: "tabCountries", deportes: "tabSports", radio: "tabRadio" };
var POLL_MS = 1e3;
var GRID_CAP = 60;
var RAILS_SHOWN = 13;
var CARDS_SHOWN = 12;
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
    { type: "SingleChildScrollView", key: key + "Scroll", direction: "horizontal", children: [{ type: "Row", gap: 24, children: items.slice(0, CARDS_SHOWN).map((c, i) => roundChannel(c, key + "-" + i)) }] }
  ]
});
var barButton = (key, icon, labelKey, onPressed) => ({ type: "IconButton", key, icon, ...twin(labelKey, "labelText"), ...twin(labelKey, "tooltip"), onPressed });
function browseView({ tab, data, loading, failed, device = "phone" }) {
  const tv = device === "tv";
  const active = TAB_IDS.includes(tab) ? tab : TAB_IDS[0];
  const body = [];
  if (data) {
    for (const r of data.rails.slice(0, RAILS_SHOWN)) {
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
var REPO = "https://raw.githubusercontent.com/xuper-plugin/kino-plugin-supertv/";
var DIR = "home/";
var DATA_MISS_KEY = "feedData:v1";
var DATA_MISS_MS = 6 * 60 * 60 * 1e3;
var MAX_AGE_MS = 3 * 24 * 60 * 60 * 1e3;
var FEED_TIMEOUT_MS = 8e3;
var dataMissAt = null;
function dataMissing(now) {
  if (dataMissAt === null) {
    let v = null;
    try {
      v = kino.storage.get(DATA_MISS_KEY);
    } catch (_) {
      v = null;
    }
    dataMissAt = /^\d+$/.test(String(v || "")) ? Number(v) : 0;
  }
  const age = now - dataMissAt;
  return dataMissAt > 0 && age >= 0 && age < DATA_MISS_MS;
}
function noteDataMissing(now) {
  dataMissAt = now;
  try {
    put(DATA_MISS_KEY, String(now));
  } catch (_) {
  }
}
var canGunzip = () => {
  try {
    return typeof kino.crypto.gunzip === "function";
  } catch (_) {
    return false;
  }
};
function openBox(box) {
  if (!box || typeof box !== "object" || box.v !== 1 && box.v !== 2 || typeof box.iv !== "string" || typeof box.data !== "string") return null;
  try {
    const opts = { key: kino.secret("feedKey"), iv: box.iv, ivEncoding: "base64", data: box.data };
    if (box.v === 1) return JSON.parse(kino.crypto.decrypt("aes-256-gcm", opts));
    if (!canGunzip()) return null;
    return JSON.parse(kino.crypto.gunzip(kino.crypto.decrypt("aes-256-gcm", { ...opts, outputEncoding: "base64" })));
  } catch (_) {
    return null;
  }
}
function railsOf(rails) {
  if (!Array.isArray(rails)) return null;
  const r = rails.filter((x) => x && typeof x.id === "string" && typeof x.title === "string" && Array.isArray(x.items) && x.items.length);
  return r.length ? r : null;
}
function feedOf(box, serverKey2) {
  const d = openBox(box);
  if (!d || d.v !== 1 || d.serverKey !== serverKey2 || !d.tabs || typeof d.tabs !== "object") return null;
  if (typeof d.at === "number" && Date.now() - d.at > MAX_AGE_MS) return null;
  const tabs = {};
  for (const k of Object.keys(d.tabs)) {
    const t = railsOf(d.tabs[k]);
    if (t) tabs[k] = t;
  }
  return Object.keys(tabs).length ? { tabs } : null;
}
async function fetchCopy(branch, serverKey2, opts, v2 = false) {
  let init = { headers: { Accept: "application/json" } };
  if (opts && typeof opts.until === "number") {
    const left = opts.until - Date.now() - 300;
    if (left < 1e3) return { net: true };
    init = { ...init, timeoutMs: Math.min(FEED_TIMEOUT_MS, left) };
  }
  let r;
  try {
    r = await kino.fetch(`${REPO}${branch}/${DIR}${encodeURIComponent(serverKey2)}${v2 ? ".v2" : ""}.enc.json?v=${Math.floor(Date.now() / 36e5)}`, init);
  } catch (_) {
    return { net: true };
  }
  const status = r ? Number(r.status) || 0 : 0;
  if (!r || !r.ok) return { miss: true, status };
  try {
    const feed = feedOf(JSON.parse(r.text()), serverKey2);
    return feed ? { feed } : { miss: true, status };
  } catch (_) {
    return { miss: true, status };
  }
}
async function loadFeed(serverKey2, opts) {
  try {
    if (!dataMissing(Date.now())) {
      const d = await fetchCopy("data", serverKey2, opts, canGunzip());
      if (d.feed) return d;
      if (d.net) return d;
      const m2 = await fetchCopy("main", serverKey2, opts);
      if (m2.feed && d.status === 404) noteDataMissing(Date.now());
      return m2.feed || m2.net ? m2 : { miss: true };
    }
    const m = await fetchCopy("main", serverKey2, opts);
    return m.feed || m.net ? m : { miss: true };
  } catch (_) {
    return { net: true };
  }
}
var META_URL = REPO + "data/data-meta.json";
var META_TIMEOUT_MS = 2500;
var HOME_PATH = /^home\/([0-9a-z]+)(\.v2)?\.enc\.json$/;
async function feedKeys() {
  try {
    const r = await kino.fetch(`${META_URL}?v=${Math.floor(Date.now() / 36e5)}`, { headers: { Accept: "application/json" }, timeoutMs: META_TIMEOUT_MS });
    if (!r || !r.ok) return null;
    const meta = JSON.parse(r.text());
    if (!meta || meta.v !== 1 || !meta.files || typeof meta.files !== "object") return null;
    const now = Date.now();
    const keys = /* @__PURE__ */ new Set();
    for (const path of Object.keys(meta.files)) {
      const m = HOME_PATH.exec(path);
      const f = meta.files[path];
      if (m && f && typeof f.builtAt === "number" && now - f.builtAt < MAX_AGE_MS) keys.add(m[1]);
    }
    return keys;
  } catch (_) {
    return null;
  }
}
var FEED_MEMO_MS = 30 * 60 * 1e3;
var MISS_MEMO_MS = 5 * 60 * 1e3;
var feedMemo = null;
async function homeFeed(serverKey2, opts) {
  if (!serverKey2) return null;
  const now = Date.now();
  const m = feedMemo;
  const of = globalThis.kino;
  if (m && m.of === of && m.key === serverKey2 && now - m.at >= 0 && now - m.at < (m.feed ? FEED_MEMO_MS : MISS_MEMO_MS)) return m.feed;
  const r = await loadFeed(serverKey2, opts);
  if (!r.net) feedMemo = { of, key: serverKey2, at: Date.now(), feed: r.feed || null };
  return r.feed || null;
}
var BARE_REF = /^live:(\d+)$/;
function upgradeBareRefs(rails, { catName, rawTitles = false } = {}) {
  if (!Array.isArray(rails)) return rails;
  return rails.map((r) => {
    if (!r || !Array.isArray(r.items) || !/^\d+$/.test(String(r.catId || ""))) return r;
    const catId = String(r.catId);
    let catTok = null;
    let changed = false;
    const items = r.items.map((it) => {
      const m = it && typeof it.ref === "string" ? BARE_REF.exec(it.ref) : null;
      if (!m) return it;
      if (catTok === null) {
        let name = "";
        try {
          name = String(typeof catName === "function" && catName(catId) || "");
        } catch (_) {
          name = "";
        }
        catTok = categoryTok(name);
      }
      changed = true;
      const tok = rawTitles && typeof it.title === "string" ? channelTok(it.title) : "";
      return { ...it, ref: liveRef(m[1], catId, catTok, tok) };
    });
    return changed ? { ...r, items } : r;
  });
}

// src/screen.js
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
var autoPickTried = false;
var rescueTried = false;
var homeFeedData = /* @__PURE__ */ new Map();
var homeFeedTried = false;
var eventsRow = null;
var eventsTried = false;
var SRVCHOSEN_KEY2 = "srvChosen:v1";
var markServerChosen = () => {
  try {
    put(SRVCHOSEN_KEY2, "1");
  } catch (_) {
  }
};
function serverChosen() {
  if (getStored(SRVCHOSEN_KEY2) === "1") return true;
  if (!hasChosenServer()) return false;
  markServerChosen();
  return true;
}
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
    return o && o.v === 1 && Array.isArray(o.e) ? cleanCards(o.e.filter((c) => c && typeof c.id === "string" && typeof c.ref === "string").slice(0, HIST_MAX), { lang: langNow() }) : [];
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
var SNAP_V = 3;
var SNAP_TAB_MAX = 9 * 1024;
var SNAP_MAX = 36 * 1024;
var SNAP_TAB_OVERHEAD = 16;
var SNAP_STEPS = [
  ...[Infinity, 10, 8, 6].flatMap((rails) => [10, 8, 6].map((per) => [rails, per, true])),
  [6, 4, true],
  [4, 4, true],
  [6, 4, false],
  [4, 3, false]
];
var SNAP_ID = /^live:(\d+)(?:~|$)/;
var snapKey = () => "homeSnap:v" + SNAP_V + ":" + serverKey();
var oldSnapKey = (tab) => "homeSnap:v1:" + serverKey() + ":" + tab;
var snapMemo = null;
function logoBase(items) {
  const logos = items.map((c) => c.poster).filter((p) => typeof p === "string" && p !== "");
  if (logos.length < 2) return "";
  let base = logos[0];
  for (const p of logos) {
    let i = 0;
    while (i < base.length && i < p.length && base[i] === p[i]) i++;
    base = base.slice(0, i);
  }
  return base.slice(0, base.lastIndexOf("/") + 1);
}
function packCard(c, base, logos) {
  const m = typeof c.ref === "string" ? SNAP_ID.exec(c.ref) : null;
  const poster = logos && typeof c.poster === "string" ? c.poster : "";
  const plain = m && c.id === "live-" + m[1] && typeof c.title === "string" && (!c.kind || c.kind === "live") && c.adult !== true && (!poster || poster.startsWith(base) && poster.length > base.length);
  if (!plain) return { id: c.id, ref: c.ref, title: c.title, ...c.kind ? { kind: c.kind } : {}, ...poster ? { poster } : {}, ...c.adult === true ? { adult: true } : {} };
  return poster ? [c.ref, c.title, poster.slice(base.length)] : [c.ref, c.title];
}
function packRail(r, per, logos) {
  const items = (r.items || []).slice(0, per);
  const base = logos ? logoBase(items) : "";
  return { ...r.id !== "lcat-" + r.catId ? { id: r.id } : {}, c: r.catId, t: r.title, ...base ? { p: base } : {}, i: items.map((c) => packCard(c, base, logos)) };
}
function unpackRail(r) {
  if (!r || typeof r !== "object" || !Array.isArray(r.i)) return null;
  const base = typeof r.p === "string" ? r.p : "";
  const items = [];
  for (const x of r.i) {
    if (Array.isArray(x)) {
      const m = typeof x[0] === "string" ? SNAP_ID.exec(x[0]) : null;
      if (m && typeof x[1] === "string") items.push({ id: "live-" + m[1], ref: x[0], title: x[1], kind: "live", ...typeof x[2] === "string" && x[2] ? { poster: base + x[2] } : {} });
    } else if (x && typeof x.id === "string" && typeof x.ref === "string") items.push(x);
  }
  return items.length ? { id: typeof r.id === "string" ? r.id : "lcat-" + r.c, catId: r.c, title: typeof r.t === "string" ? r.t : "", items } : null;
}
function unpackTabs(tabs) {
  const out = {};
  for (const tab of Object.keys(tabs || {})) {
    const rails = Array.isArray(tabs[tab]) ? tabs[tab].map(unpackRail).filter(Boolean) : [];
    if (rails.length) out[tab] = rails;
  }
  return out;
}
function snapTab(rails, max) {
  const tried = /* @__PURE__ */ new Set();
  for (const [maxRails, per, logos] of SNAP_STEPS) {
    const n = Math.min(maxRails, rails.length);
    const step = n + "," + per + "," + logos;
    if (tried.has(step)) continue;
    tried.add(step);
    const packed = rails.slice(0, n).map((r) => packRail(r, per, logos));
    const bytes = jsonLen(JSON.stringify(packed));
    if (bytes <= max) return { packed, bytes };
  }
  return null;
}
function writeSnap(tabsRails) {
  try {
    const tabs = {};
    let left = SNAP_MAX;
    const order = [storedTab() || TAB_IDS[0], ...TAB_IDS].filter((t, i, a) => a.indexOf(t) === i && (tabsRails.get(t) || []).length);
    order.forEach((tab, i) => {
      const cut = snapTab(tabsRails.get(tab), Math.min(SNAP_TAB_MAX, Math.floor(left / (order.length - i)) - SNAP_TAB_OVERHEAD));
      if (!cut) return;
      tabs[tab] = cut.packed;
      left -= cut.bytes + SNAP_TAB_OVERHEAD;
    });
    if (!Object.keys(tabs).length) return;
    const key = snapKey();
    if (put(key, JSON.stringify({ v: SNAP_V, at: Date.now(), tabs }))) snapMemo = { key, tabs: unpackTabs(tabs) };
  } catch (_) {
  }
}
function storedSnapRails(tab) {
  const key = snapKey();
  if (!snapMemo || snapMemo.key !== key) {
    let tabs = {};
    try {
      const o = JSON.parse(kino.storage.get(key) || "null");
      if (o && o.v === SNAP_V && o.tabs && typeof o.tabs === "object") tabs = unpackTabs(o.tabs);
    } catch (_) {
      tabs = {};
    }
    snapMemo = { key, tabs };
  }
  const rails = snapMemo.tabs[tab];
  if (Array.isArray(rails) && rails.length) return rails;
  try {
    const o = JSON.parse(kino.storage.get(oldSnapKey(tab)) || "null");
    return o && o.v === 1 && Array.isArray(o.rails) && o.rails.length ? o.rails : null;
  } catch (_) {
    return null;
  }
}
function catNames2() {
  let names = null;
  return (catId) => (names || (names = liveCatNamer()))(catId);
}
var feedRails = (rails, catName = catNames2()) => cleanRails(upgradeBareRefs(rails, { catName, rawTitles: true }), langNow());
function readSnap(tab) {
  try {
    const rails = storedSnapRails(tab);
    if (!rails) return null;
    return { rails: cleanRails(upgradeBareRefs(rails, { catName: catNames2() }), langNow()) };
  } catch (_) {
    return null;
  }
}
var FIRST_RUN_TICK_MS = 16e3;
var FEED_MIN_MS = 2500;
async function autoPick() {
  autoPickTried = true;
  const until = Date.now() + FIRST_RUN_TICK_MS;
  let r = null;
  try {
    r = await autoPickServer({ until: until - FEED_MIN_MS, feedKeys });
  } catch (_) {
    r = null;
  }
  if (r && r.ok) await picked(until);
}
async function rescue() {
  rescueTried = true;
  const until = Date.now() + FIRST_RUN_TICK_MS;
  try {
    await healthCheck({ until: until - FEED_MIN_MS, pick: true });
  } catch (_) {
  }
  if (hasChosenServer()) {
    await picked(until);
    return;
  }
  try {
    pickServers = cachedServerList();
  } catch (_) {
    pickServers = null;
  }
}
async function picked(until) {
  markServerChosen();
  cacheKey = serverKey();
  if (until - Date.now() >= FEED_MIN_MS) await loadHomeFeed({ until });
}
async function loadHomeFeed(opts) {
  homeFeedTried = true;
  let feed = null;
  try {
    feed = await homeFeed(serverKey(), opts);
  } catch (_) {
    feed = null;
  }
  if (!feed || !feed.tabs) return;
  const names = catNames2();
  for (const tab of Object.keys(feed.tabs)) {
    homeFeedData.set(tab, feedRails(feed.tabs[tab], names));
  }
  writeSnap(homeFeedData);
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
var TAB_LANES = 4;
async function loadGroupTab(tab) {
  const cats = (liveCatsAll || []).filter((c) => inGroup(tab, c)).slice(0, RAILS_PER_TAB);
  let failed = 0;
  const results = new Array(cats.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(TAB_LANES, cats.length) }, async () => {
    while (next < cats.length) {
      const i = next++;
      const c = cats[i];
      try {
        results[i] = { c, page: await liveChannels({ categoryId: c.id }) };
      } catch (_) {
        failed++;
      }
    }
  }));
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
  if (!serverChosen()) return autoPickTried ? ["rescue", "pick"] : ["autopick"];
  const base = homeFeedData.has(tab) ? ["hfeed"] : !homeFeedTried ? ["hfeed", "cats", "tab:" + tab] : ["cats", "tab:" + tab];
  if (tab === TAB_IDS[0] && eventsOn() && !eventsTried) base.push("events");
  base.push("health");
  return base;
}
function isDone(unit) {
  if (unit === "autopick") return autoPickTried;
  if (unit === "rescue") return rescueTried;
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
  if (unit === "autopick") {
    await autoPick();
    return;
  }
  if (unit === "rescue") {
    await rescue();
    return;
  }
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
    await healthStep();
    return;
  }
  if (unit === "pick") {
    pickServers = await serverList();
    return;
  }
  const [, tab] = unit.split(":");
  await loadGroupTab(tab);
}
var TICK_BUDGET_MS = 1200;
var HEAVY = (unit) => unit === "health" || unit.startsWith("tab:");
var ALONE = /* @__PURE__ */ new Set(["autopick", "rescue", "pick"]);
function shown(tab) {
  const g = groupRails.get(tab);
  return [homeFeedData.has(tab) ? 1 : 0, g ? g.rails.length : -1, eventsRow ? eventsRow.items.length : 0, pickServers ? 1 : 0].join(",");
}
var hasContent = (tab) => homeFeedData.has(tab) || groupRails.has(tab) || !!storedSnapRails(tab);
async function runUnits(tab, failed) {
  const t0 = Date.now();
  let ran = 0;
  let changed = false;
  for (; ; ) {
    const unit = pendingUnit({ failed }, tab);
    if (!unit) break;
    if (ran && (ALONE.has(unit) || Date.now() - t0 >= TICK_BUDGET_MS || changed && HEAVY(unit))) break;
    const before = shown(tab);
    const had = hasContent(tab);
    try {
      await runUnit(unit);
    } catch (_) {
      failed[unit] = true;
    }
    ran++;
    cacheKey = serverKey();
    if (ALONE.has(unit) || HEAVY(unit) || !had && hasContent(tab)) break;
    if (shown(tab) !== before) changed = true;
  }
  return ran;
}
function mainView(ctx) {
  const state = ctx.state || {};
  if (!serverChosen()) {
    if (!autoPickTried) return verifyingView({ device: ctx.device });
    if (!rescueTried && !(state.failed && state.failed.rescue)) return verifyingView({ device: ctx.device });
    return firstPickView({ servers: pickServers, failed: !!(state.failed && state.failed.pick), device: ctx.device });
  }
  const tab = tabOf(state, ctx.route);
  const feedRails2 = homeFeedData.get(tab);
  const live = groupRails.get(tab) || null;
  const snap = !feedRails2 && !live ? readSnap(tab) : null;
  let data = feedRails2 ? { rails: feedRails2, partial: false } : live || (snap ? { rails: snap.rails, partial: false, stale: true } : null);
  if (data && Array.isArray(data.rails)) data = { ...data, rails: randomizeRows(data.rails, homeSeed) };
  if (tab === TAB_IDS[0] && eventsRow) {
    const rest = (data && data.rails || []).filter((r) => r.id !== eventsRow.id);
    data = { ...data || { partial: false }, rails: [eventsRow, ...rest] };
  }
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
  // Runs the pending units in order, several in one tick while it is cheap to (see runUnits).
  async tick({ state }) {
    const tab = tabOf(state);
    const failed = { ...state.failed || {} };
    const ran = await runUnits(tab, failed);
    return ran ? { state: { ...bump(state), failed } } : null;
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
  const tabs = SECTION_TABS.map((t) => ({ id: t.id, label: english ? t.en : t.label }));
  try {
    if (!serverKey()) {
      try {
        await serverList();
      } catch (_) {
      }
    }
    const feed = await homeFeed(serverKey());
    const fr = feed && feed.tabs && feed.tabs[tab] && upgradeBareRefs(feed.tabs[tab], { catName: catNames2(), rawTitles: true });
    if (fr && fr.length) return { tabs, tab, rows: fr.map((r) => ({ id: r.id, title: r.title, ref: "lcat:" + r.catId, items: r.items })) };
  } catch (_) {
  }
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
  return { tabs, tab, rows };
}

// src/plugin.js
var call = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } finally {
    flushIndex();
  }
};
var home2 = call(home);
var search2 = call(search);
var liveCategories2 = call(liveCategories);
var liveChannels2 = call(liveChannels);
var liveSearch2 = call(liveSearch);
var browse2 = call(browse);
var guide2 = call(guide);
var resolve2 = call(resolve);
var settingsStatus2 = call(settingsStatus);
var action2 = call(action);
var screen2 = call(screen);
var screenEvent2 = call(screenEvent);
var section3 = call(section2);
export {
  action2 as action,
  browse2 as browse,
  guide2 as guide,
  home2 as home,
  liveCategories2 as liveCategories,
  liveChannels2 as liveChannels,
  liveSearch2 as liveSearch,
  resolve2 as resolve,
  screen2 as screen,
  screenEvent2 as screenEvent,
  search2 as search,
  section3 as section,
  settingsStatus2 as settingsStatus
};
