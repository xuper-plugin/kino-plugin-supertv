// SuperTV — entrada del plugin: canales en vivo y pantalla propia.
import * as cat from "./catalog.js";
import * as scr from "./screen.js";
import { flushIndex } from "./store.js";

// Each export writes the storage index once, when its call ends (store.js): one rewrite of Kino's store per call, never
// one per stored value.
const call = (fn) => async (...args) => {
  try { return await fn(...args); } finally { flushIndex(); }
};

export const home = call(cat.home);
export const search = call(cat.search);
export const liveCategories = call(cat.liveCategories);
export const liveChannels = call(cat.liveChannels);
export const liveSearch = call(cat.liveSearch);
export const browse = call(cat.browse);
export const guide = call(cat.guide);
export const resolve = call(cat.resolve);
export const settingsStatus = call(cat.settingsStatus);
export const action = call(cat.action);
export const screen = call(scr.screen);
export const screenEvent = call(scr.screenEvent);
export const section = call(scr.section);
