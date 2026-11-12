# SuperTV

Plugin de Kino: **canales de TV en vivo**, en su propia interfaz — un plugin dedicado solo a los
canales, para que se vean y no queden escondidos entre películas y series.

No pide usuario ni contraseña: las credenciales se obtienen solas desde el servicio, y el plugin
cambia de servidor si uno falla.

- **Pantalla propia** dedicada a los canales: Home con pestañas por grupo
  (Todo, Premium, Países, Deportes, Radio) y filas de canales, buscador de canales con historial,
  drilldown de una categoría completa y página de ajustes.
- **Canales:** con logo y número, categorías agrupadas, búsqueda y guía de programación (EPG) cuando
  el servidor la publica.
- **Formato del en vivo:** HLS (m3u8) o MPEG-TS (ts); si un canal no carga, se prueba el otro.
- **Contenido 18+:** las categorías adultas se marcan y Kino las muestra solo con el código 18+
  desbloqueado; apagado el interruptor, no aparecen.
- **Servidores:** guarda una lista, prefiere HTTPS, recuerda el que funciona y pasa al siguiente
  cuando falla. Kino solo deja HTTP con hosts declarados en el manifiesto, así que un workflow diario
  (`.github/workflows/hosts.yml`, `scripts/health-hosts.mjs`) prueba cada servidor con una petición
  ligera, declara en `hosts` los que responden y retira los que fallan 3 veces seguidas (sube la
  versión de parche cuando cambia el conjunto).
- **Hosts:** el servicio de arranque va por HTTP (`insecureHttp`) y el video puede salir de otros
  hosts (`streamHosts: any`, aviso en rojo al instalar).

Requiere Kino **0.9.74 o posterior** (apiVersion 13). Sin VOD ni índice de títulos: no usa
`kino.catalog`.

## Construir y probar

```bash
npm install
npm run build        # empaqueta src/plugin.js en plugin.js con esbuild
npm run validate     # build + node sdk/validate.mjs . + chequeo QuickJS
npm run hosts        # revisa los servidores y actualiza "hosts" en el manifiesto (--dry para no escribir)
node sdk/run.mjs . liveCategories
node sdk/run.mjs . home
node sdk/run.mjs . search '{"q":"news"}'
```

## Estructura

- `src/catalog.js` — servicio: arranque, lista de servidores, API Xtream, categorías y canales en
  vivo, búsqueda, EPG y resolución del stream.
- `src/screen.js` / `src/screenView.js` — la pantalla propia (pestañas por grupo, buscador, ajustes).
- `src/categories.js` / `src/categoryRules.js` / `src/categoryTable.js` / `src/names.js` —
  clasificación y nombres limpios de las categorías en vivo.
- `src/i18n.js` — textos del plugin en español e inglés.
