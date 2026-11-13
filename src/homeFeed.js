// Baja el Home pre-armado que el Action publica 2x/día, SELLADO (home/<serverKey>.enc.json, AES-256-GCM con el secreto feedKey,
// igual que Xuper). El plugin lo abre con kino.secret("feedKey") — solo dentro de Kino: una copia del código fuera de Kino (un
// fork) no puede. Si existe y es reciente, pinta el Home al instante; si falta, está viejo, no abre o falla, se carga en vivo.
// Solo trae canales ESTABLES (los eventos del momento NO se cachean: se cargan en vivo).
const BASE = "https://raw.githubusercontent.com/xuper-plugin/kino-plugin-supertv/main/home/";
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // tolera varias corridas perdidas; más viejo que esto -> se ignora y se carga en vivo

// Abre el sobre sellado { v:1, iv:b64, data:b64 } con el secreto feedKey (AES-256-GCM). null si no abre. Nunca lanza.
function openBox(box) {
  if (!box || typeof box !== "object" || box.v !== 1 || typeof box.iv !== "string" || typeof box.data !== "string") return null;
  try {
    const text = kino.crypto.decrypt("aes-256-gcm", { key: kino.secret("feedKey"), iv: box.iv, ivEncoding: "base64", data: box.data });
    return JSON.parse(text);
  } catch (_) { return null; }
}

// Deja una lista de filas de un tab solo con filas válidas (id/title/items), o null si no sirve.
function railsOf(rails) {
  if (!Array.isArray(rails)) return null;
  const r = rails.filter((x) => x && typeof x.id === "string" && typeof x.title === "string" && Array.isArray(x.items) && x.items.length);
  return r.length ? r : null;
}

/** El Home pre-armado del servidor, o null (sin feed, viejo, no abre, no coincide, o falló): `{ tabs: { all:[rails], ... } }`. */
export async function fetchHomeFeed(serverKey) {
  if (!serverKey) return null;
  try {
    // El `v` por hora evita una caché de CDN demasiado pegajosa sin pedir siempre de nuevo.
    const r = await kino.fetch(`${BASE}${encodeURIComponent(serverKey)}.enc.json?v=${Math.floor(Date.now() / 3600000)}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const d = openBox(JSON.parse(r.text()));
    if (!d || d.v !== 1 || d.serverKey !== serverKey || !d.tabs || typeof d.tabs !== "object") return null;
    if (typeof d.at === "number" && Date.now() - d.at > MAX_AGE_MS) return null;
    const tabs = {};
    for (const k of Object.keys(d.tabs)) { const t = railsOf(d.tabs[k]); if (t) tabs[k] = t; }
    return Object.keys(tabs).length ? { tabs } : null;
  } catch (_) { return null; }
}
