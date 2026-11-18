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
- **Servidores:** guarda una lista, prefiere HTTPS, recuerda el que elegiste (también al renovar la
  lista cada 6 horas) y pasa a otro cuando falla. Las cuentas muertas ("Invalid username or
  password") se recuerdan un día y no gastan peticiones.
- **Paneles y canal caído:** muchos servidores son cuentas del MISMO panel (mismas categorías y
  mismos ids de canal). El chequeo de salud los agrupa sin peticiones extra (`src/panels.js`). Si la
  cuenta que reproduce un canal lo rechaza (407, 509, una respuesta muerta) o Kino lo reabre dos
  veces seguidas, el canal pasa a otra cuenta del mismo panel con el mismo id y, si no hay, al mismo
  canal buscado POR NOMBRE en otro panel (`src/liveFailover.js`, `src/channelMatch.js`); nunca el
  mismo id en un panel ajeno. No cambia el servidor elegido, y solo ese canal se mueve: los demás
  siguen en tu cuenta salvo que una prueba muestre que la cuenta los rechaza (407, 509).
- **Nombres de canal limpios:** lo que el panel le pone alrededor al nombre (`┃ES┃ M+ DEPORTES`,
  `ES ▎DAZN 1`, `|MX| ESPN`, `[ES] …`, `ES: …`, `MULTI ▎ VIAPLAY`, `ESPN ┃MX┃`) no se muestra
  (`src/channelTitle.js`, idéntico en kino-plugin-ultrahd). La calidad se queda (`4K ▎DAZN 1` →
  `DAZN 1 4K`). Si dos canales de una misma lista quedarían iguales, vuelve el país al final
  (`ESPN · México`), salvo el país de la propia categoría. Solo cambia el título: el id, el ref y el
  emparejamiento por nombre entre paneles siguen leyendo el nombre original del panel.
- **Hosts declarados:** Kino solo deja HTTP con hosts declarados en el manifiesto, así que un
  workflow (`.github/workflows/hosts.yml`, `scripts/health-hosts.mjs`) mantiene `hosts`: conserva
  los declarados mientras el servicio los liste y agrega uno nuevo solo si respondió en esa corrida
  y el plugin lo usa (está entre sus 30 servidores); el tope de 50 nunca quita uno declarado.
  `hosts-state.json` solo guarda cuántas corridas lleva sin listarse un host declarado, así que una
  corrida con las mismas respuestas no cambia nada ni hace commit. **No sube la versión:** la firma
  del autor no cubre `hosts`, así que el job no necesita la llave. Las instalaciones nuevas reciben
  la lista al instante; las instaladas, con la próxima versión firmada (`npm run release`).
- **Ojo con el job entre dos versiones:** si una corrida agrega hosts, la siguiente versión firmada
  le pide a CADA persona que apruebe esos hosts antes de actualizar (Kino retiene la actualización);
  `npm run release` se niega sin `--allow-new-hosts`. Por eso el workflow corre solo a mano
  (`workflow_dispatch`) hasta que salga la versión que lo trae; después se le puede devolver el
  `schedule` diario.
- **Hosts:** el servicio de arranque va por HTTP (`insecureHttp`) y el video puede salir de otros
  hosts (`streamHosts: any`, aviso en rojo al instalar).

Requiere Kino **0.9.74 o posterior** (apiVersion 13). Sin VOD ni índice de títulos: no usa
`kino.catalog`.

## Construir y probar

```bash
npm install
npm run build        # empaqueta src/plugin.js en plugin.js con esbuild
npm run validate     # build + node sdk/validate.mjs . + chequeo QuickJS
npm test             # node --test test/*.test.mjs (kino falso, sin red)
npm run hosts        # revisa los servidores y actualiza "hosts" en el manifiesto (--dry para no escribir)
git pull --ff-only && npm run release -- 0.4.1   # la versión siguiente: los archivos de versión quedan en la última
                                                 # publicada; release la sube, compila, firma con la llave del autor
                                                 # (solo en la máquina del dueño), verifica, valida y prueba
node sdk/run.mjs . liveCategories
node sdk/run.mjs . home
node sdk/run.mjs . search '{"q":"news"}'
```

## Estructura

- `src/catalog.js` — servicio: arranque, lista de servidores, API Xtream, categorías y canales en
  vivo, búsqueda, EPG y resolución del stream.
- `src/panels.js` / `src/liveFailover.js` / `src/channelMatch.js` — paneles, cuentas muertas o
  bloqueadas, y el cambio de cuenta de un canal en vivo (idénticos en kino-plugin-ultrahd).
- `src/channelTitle.js` — el título que se muestra de cada canal, sin los adornos del panel
  (idéntico en kino-plugin-ultrahd).
- `src/screen.js` / `src/screenView.js` — la pantalla propia (pestañas por grupo, buscador, ajustes).
- `src/categories.js` / `src/categoryRules.js` / `src/categoryTable.js` / `src/names.js` —
  clasificación y nombres limpios de las categorías en vivo.
- `src/i18n.js` — textos del plugin en español e inglés.
