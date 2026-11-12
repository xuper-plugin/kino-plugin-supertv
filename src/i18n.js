// Textos propios del plugin: [español, inglés]. Lo que viene del servidor (títulos, categorías) no se traduce.
export const TEXTS = Object.freeze({
  tabAll: ["Todo", "All"],
  tabPremium: ["Premium", "Premium"],
  tabCountries: ["Países", "Countries"],
  tabSports: ["Deportes", "Sports"],
  tabRadio: ["Radio", "Radio"],
  search: ["Buscar", "Search"],
  searchTitle: ["Buscar canales", "Search channels"],
  searchHint: ["Nombre del canal", "Channel name"],
  searchFailed: ["La búsqueda falló.", "The search failed."],
  noResults: ["No encontramos ningún canal con esas palabras.", "No channel found for those words."],
  searchedBefore: ["Buscado antes", "Searched before"],
  retry: ["Reintentar", "Retry"],
  seeAll: ["Ver todos", "See all"],
  back: ["Atrás", "Back"],
  close: ["Cerrar", "Close"],
  settings: ["Ajustes", "Settings"],
  live: ["En vivo", "Live"],
  liveCategory: ["Categoría", "Category"],
  liveEmpty: ["No hay canales para mostrar.", "No channels to show."],
  liveMore: ["Se muestran los primeros {n}. Usa la búsqueda para encontrar otros.", "Showing the first {n}. Use search to find others."],
  partial: ["Algunas filas no cargaron.", "Some rows did not load."],
  searchPartial: ["Resultados parciales: no se revisaron todas las categorías (el servidor limita las peticiones).", "Partial results: not every category was checked (the server limits requests)."],
  empty: ["Todavía no hay canales para mostrar.", "No channels to show yet."],
  failed: ["No se pudo cargar. Revisa tu conexión.", "Could not load. Check your connection."],
  setTitle: ["Ajustes de SuperTV", "SuperTV settings"],
  setConnection: ["Conexión", "Connection"],
  setConnectionHint: ["Los servidores se obtienen solos. Aquí puedes cambiar de uno si va mal.", "Servers are picked automatically. Switch here if one misbehaves."],
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
  setAdultHint: ["Apagado, las categorías para adultos no aparecen. Encendido, salen marcadas y Kino las muestra solo con tu código 18+.", "Off, adult categories are hidden. On, they appear marked and Kino shows them only with your 18+ code."],
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
  checking: ["Comprobando…", "Checking…"],
});

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : "")) : s);

export function twin(key, prop = "text", vars) {
  const [es, en] = TEXTS[key] || [key, key];
  return { [prop]: fill(es, vars), [prop + "En"]: fill(en, vars) };
}

export const say = (key, lang, vars) => {
  const [es, en] = TEXTS[key] || [key, key];
  return fill(lang === "en" ? en : es, vars);
};
