// Baja el Home pre-armado que el Action publica 2x/día en home/<serverKey>.json. Si existe y es reciente, el plugin pinta su
// Home al instante (sin recorrer el servidor IPTV); si falta, está viejo o el fetch falla, se usa la carga en vivo normal.
// Solo trae canales ESTABLES (los eventos del momento NO se cachean: se cargan en vivo).
const BASE = "https://raw.githubusercontent.com/xuper-plugin/kino-plugin-supertv/main/home/";
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // tolera varias corridas perdidas; más viejo que esto -> se ignora y se carga en vivo

// Deja una lista de filas de un tab solo con filas válidas (id/title/items), o null si no sirve.
function railsOf(rails) {
  if (!Array.isArray(rails)) return null;
  const r = rails.filter((x) => x && typeof x.id === "string" && typeof x.title === "string" && Array.isArray(x.items) && x.items.length);
  return r.length ? r : null;
}

/** El Home pre-armado del servidor, o null (sin feed, viejo, no coincide, o falló): `{ tabs: { all:[rails], premium:[rails], ... } }`. */
export async function fetchHomeFeed(serverKey) {
  if (!serverKey) return null;
  try {
    // El `v` por hora evita una caché de CDN demasiado pegajosa sin pedir siempre de nuevo.
    const r = await kino.fetch(`${BASE}${encodeURIComponent(serverKey)}.json?v=${Math.floor(Date.now() / 3600000)}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const d = r.json();
    if (!d || d.v !== 1 || d.serverKey !== serverKey || !d.tabs || typeof d.tabs !== "object") return null;
    if (typeof d.at === "number" && Date.now() - d.at > MAX_AGE_MS) return null;
    const tabs = {};
    for (const k of Object.keys(d.tabs)) { const t = railsOf(d.tabs[k]); if (t) tabs[k] = t; }
    return Object.keys(tabs).length ? { tabs } : null;
  } catch (_) { return null; }
}
