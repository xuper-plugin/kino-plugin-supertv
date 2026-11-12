// SuperTV — entrada del plugin: canales en vivo y pantalla propia.
// La pantalla responde al instante a un toque aunque haya peticiones en vuelo (p. ej. abrir el selector mientras el Home carga).
globalThis.__kinoDropPendingFetches = true;
export { home, search, liveCategories, liveChannels, liveSearch, browse, guide, resolve, settingsStatus, action } from "./catalog.js";
export { screen, screenEvent, section } from "./screen.js";
