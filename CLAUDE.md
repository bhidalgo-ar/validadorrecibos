# Validador de Recibos vs Liquidación — Hidalgo & Asociados

Herramienta web que cruza una **liquidación de sueldos** (PDF o Excel) contra los
**recibos de haberes** (PDF, uno por empleado o todos en un archivo) y reporta
diferencias de conceptos, totales, contribuciones y gráfico de torta.

**Cliente original de los datos de prueba:** Marval & O'Farrell (junio 2026).
**ERP de origen del formato:** **Meta 4**. Los parsers están calibrados al formato de
reporte de Meta 4 (banner `"<Empresa> SUELDOS Y JORNALES"`, "CONTROL DE LIQUIDACIÓN"),
**no** a un cliente puntual — sirve para cualquier cliente liquidado con Meta 4. El skip
del banner se hace por el rótulo estable `SUELDOS Y JORNALES`, no por el nombre del cliente.
Un cliente con **otro ERP** (otro formato de PDF) requeriría adaptar los parsers.
**Desarrollado por:** Hidalgo & Asociados — Payroll, IT & Implementation.

---

## Decisión de arquitectura (IMPORTANTE)

La herramienta es una **página estática 100% client-side**, pensada para hostearse en
**GitHub Pages**. Todo el procesamiento (lectura de PDF/Excel, parseo, validación,
reporte) ocurre **dentro del navegador del usuario**.

**Por qué:**
1. **Privacidad:** los recibos y la liquidación contienen datos personales de empleados.
   Al procesar todo en el navegador, **ningún archivo se sube a internet ni a un servidor** —
   nunca salen de la PC de quien usa la herramienta. Esto es lo correcto para payroll.
2. **GitHub Pages no corre backend:** sólo sirve archivos estáticos. No puede ejecutar
   Python. Por eso el motor (originalmente Python) se reescribió en JavaScript.

**Stack elegido (Opción B):**
- **pdf.js** (Mozilla) para extraer texto de los PDF en el navegador. Se reconstruyen
  las líneas a partir de las coordenadas (x,y) de cada fragmento, insertando espacios
  por gap horizontal — esto separa columnas que un extractor de sólo-texto pegaría.
- **SheetJS (xlsx)** para leer la liquidación en Excel.
- Lógica de parseo y validación en JS puro (ES modules), sin dependencias de backend.
- Librerías **vendoreadas** en `docs/vendor/` (self-hosted, sin CDN en runtime).

Se descartó la Opción A (Pyodide / Python-en-WASM) porque: pesa ~20 MB de descarga,
`pdfplumber` no instala en WASM (lo bloquea Pillow), hay que fijar versiones frágiles, y
el parser cambiaba igual. La Opción B pesa ~2 MB y es más robusta para un sitio estático.

---

## Decisión de despliegue: GitHub Pages

> **Decisión (2026-06-26):** la app se publica con **GitHub Pages** sirviendo la carpeta
> **`/docs`**. El repo es `github.com/willyesposito/validadorrecibos`; la URL pública
> queda en `https://willyesposito.github.io/validadorrecibos/`.

**Cómo activarlo (una sola vez, en GitHub):**
1. Settings → Pages.
2. Source: **Deploy from a branch**.
3. Branch: **`main`** · carpeta **`/docs`** · Save.
4. Esperar ~1 min y abrir `https://willyesposito.github.io/validadorrecibos/`.

(También se puede publicar desde la rama de trabajo para probar antes de mergear:
Branch = la rama actual, carpeta `/docs`.)

El archivo `docs/.nojekyll` evita que GitHub procese el sitio con Jekyll.

> **⚠️ PENDIENTE para dejar el sitio LIVE (estado al 2026-06-26):**
> 1. **Mergear `claude/relaxed-cerf-6io2vw` → `main`.** Todo el código (motor JS verificado
>    531/518/13, UI H&A, parsers, vendor) está en esa rama; `main` todavía es sólo el commit
>    inicial. Hay un **PR abierto** para hacerlo en un click. *(El push directo a `main` lo
>    bloquea el guardrail de auto-mode; se mergea por el PR, no por push directo.)*
> 2. **Corregir la carpeta de Pages a `/docs`.** El usuario dejó Pages en Source=`main` ·
>    carpeta **`/(root)`** — pero el `index.html` vive en `/docs`, así que con `/(root)` el
>    sitio sale roto. Debe quedar **`main` · `/docs`**. (Se intentó corregir por la API de
>    Pages; si no quedó aplicado, cambiarlo a mano en Settings → Pages.)
>
> Con esos dos pasos hechos, `https://willyesposito.github.io/validadorrecibos/` queda usable.

**Regla de privacidad de datos:** los PDF/Excel reales **NUNCA** se versionan. El
`.gitignore` excluye `Archivos/`, `data/*.pdf`, `**/*.xlsx`, etc. Sólo se versiona el
código y las librerías de `docs/`.

---

## Estructura del proyecto

```
/
├── docs/                         ← LA APP (raíz de GitHub Pages)
│   ├── index.html                ← UI (carga de archivos + reporte), branding H&A
│   ├── styles.css                ← tema H&A (paleta digital navy + celeste)
│   ├── app.js                    ← orquestación: carga → extracción → parseo → validación → reporte
│   ├── package.json              ← { "type": "module" } (para Node al testear)
│   ├── .nojekyll
│   ├── parsers/
│   │   ├── pdf-extract.js         ← pdf.js → texto por página (reconstrucción por coordenadas)
│   │   ├── parser-recibos.js      ← recibos PDF → ReciboEmpleado[]
│   │   ├── parser-liquidacion-pdf.js  ← liquidación PDF → LiquidacionEmpleado[]
│   │   └── parser-liquidacion-xlsx.js ← liquidación Excel → LiquidacionEmpleado[]
│   ├── core/
│   │   └── validador.js           ← cruce liquidación↔recibos + reglas de negocio
│   └── vendor/                    ← pdf.min.js, pdf.worker.min.js, xlsx.full.min.js (self-hosted)
├── data/                          ← PDFs/Excel de prueba (gitignored, no se suben)
├── archivos anteriores/
│   ├── chat anterior/             ← implementación original de Claude.ai (referencia)
│   └── python-referencia/         ← motor Python original (genera la "referencia dorada")
│       ├── src/                    ← parsers + validador Python (parser_recibos, models, …)
│       └── comparar_versiones.py   ← utilidad: compara recibos v4 vs v6 legajo×legajo (usa src/)
├── .claude/launch.json            ← server local para previsualizar (python http.server)
├── CLAUDE.md  ·  README.md  ·  .gitignore
```

El **motor Python** (`archivos anteriores/python-referencia/`) ya **no es el código
canónico**: quedó como referencia y como generador de la "referencia dorada" para verificar
la versión JS. La versión canónica es la de `docs/` (JavaScript).

---

## Reglas de negocio (acordadas, NO cambiar sin consultar)

- **Dirección de validación:** liquidación → recibo. Cada concepto del trabajador de la
  liquidación debe estar en el recibo con el mismo importe. (Si está en el recibo y no en la
  liquidación: advertencia, no error.)
- **Match por código** de concepto (3-6 dígitos). Nunca por nombre (difieren entre liq y recibo).
  El concepto se busca primero entre los **haberes** del recibo y, si no está, en la **sección
  patronal** (arriba del `SUB TOTAL CONTRIBUCIONES EMPLEADOR`). Hace falta porque hay conceptos
  que la liquidación lista en la columna CONTRIBUCIONES con un código **fuera** del rango
  6050–7099 (p. ej. el seguro de vida obligatorio, cód. 1033) y que en el recibo figuran en el
  bloque del empleador: sin ese respaldo se reportaban como `CONCEPTO_FALTANTE` estando presentes.
- **Emparejamiento empleado↔recibo: por legajo, con respaldo por apellido y nombre.** El legajo
  sigue siendo la regla principal. Pero hay clientes donde el legajo del **recibo** (el de la
  empresa de servicios eventuales que emite) no es el mismo que el de la **liquidación** (el del
  padrón de la empresa usuaria). Cuando un legajo queda huérfano de un solo lado se intenta
  emparejar por nombre, en dos pasadas (`_emparejar` en `core/validador.js`):
  1. **nombre normalizado exacto** — sin tildes, en mayúsculas, sin puntuación (`'X , Y'` =
     `'X, Y'`) y con los tokens ordenados alfabéticamente, así `APELLIDO NOMBRE` matchea
     `NOMBRE APELLIDO`;
  2. **por prefijo** (mín. 12 caracteres) — los reportes truncan el nombre a un ancho fijo, así
     que un lado puede venir cortado.
  Reglas duras del respaldo: **nunca** sobrescribe un par armado por legajo, y **sólo** empareja
  candidatos **únicos en ambas direcciones** — con homónimos o cualquier ambigüedad los deja
  `SIN_PAR` (en payroll no se adivina). El campo `legajo_recibo` del reporte lleva el legajo del
  recibo (igual a `legajo` cuando el par fue por legajo) y la fila muestra los dos.
- **Cómo se avisa el legajo distinto: por lote o por fila, según sea la regla o la excepción**
  (decidido 2026-07-30). Si **todos** los pares se armaron por nombre, el legajo distinto no es
  una anomalía por empleado sino **un solo hecho del lote** (la liquidación usa el padrón de la
  empresa usuaria y el recibo el de la empresa de servicios eventuales): se informa **una vez**
  en el veredicto (`resumen.emparejamiento.todos_por_nombre` → `.v-nota` en la UI) y las filas
  quedan `OK`. Marcarlo 72 veces convertía la columna de advertencias en ruido y tapaba lo que sí
  es excepcional. Si el emparejamiento por nombre afecta **sólo a una parte** del lote, ahí sí es
  raro y cada fila lleva el hallazgo `LEGAJO_DIFIERE` (**advertencia**, no error) para revisión
  individual. En los dos casos el legajo del recibo queda visible en la fila con el prefijo `rec.`;
  la confirmación de que es la misma persona siempre es humana.
- **Comparación por valor absoluto** del monto (el recibo muestra descuentos en negativo).
- **Contribuciones:** sólo por total, no línea por línea. Se saltean los códigos del rango
  6050–7099 y los marcados `columna='CONTRIB'` (el Excel marca así las de la derecha del NETO,
  que incluyen provisiones con códigos fuera de ese rango).
- **El total de contribuciones de la liquidación se lee de `Total Contribuciones:`, NO de
  `Costo Laboral:`** (corregido 2026-08-04, invierte la prioridad anterior). Las plantillas Meta 4
  imprimen los dos rótulos y **no son sinónimos**: cuando el convenio tiene aportes a terceros
  (seguro de sepelio "La Estrella", INACAP, contribución extraordinaria del CCT, capacitación y
  profesión de Camioneros, contribución solidaria) el recibo los suma en su `SUB TOTAL
  CONTRIBUCIONES EMPLEADOR` y `Costo Laboral` los deja afuera — sólo trae las contribuciones de
  seguridad social. `Total Contribuciones` es el que coincide peso a peso con el subtotal del
  recibo, que es el número que se compara. `Costo Laboral:` queda como **respaldo** para las
  plantillas que no imprimen el otro rótulo.
  Por qué el error pasó desapercibido hasta ahora: en las plantillas sin aportes a terceros los
  dos rótulos dan **idéntico** (en Marval coinciden en 541 de 542 empleados), así que tomar uno u
  otro no cambiaba nada. En el primer lote con convenio de Comercio y Camioneros la diferencia era
  de $55.000 a $60.000 por empleado y disparaba un `TOTAL_DIFIERE` en **550 de 631** recibos, todos
  falsos positivos.
- **Conceptos internos** (provisiones/reversiones, mínimos no imponibles, valor del plan): no
  se exigen en el recibo. Incluye el código **5700 `Base Maternidad LSD`**: es la base que se
  informa en el Libro de Sueldos Digital mientras la empleada está de licencia por maternidad —
  un dato para AFIP, no un importe que se pague. El recibo de esos meses tiene bruto y neto en 0 y
  no lo muestra ni puede mostrarlo; exigirlo daba un `CONCEPTO_FALTANTE` de más de un millón de
  pesos en cada empleada con maternidad.
- **Conceptos a cargo del empleador tampoco se exigen** (decidido 2026-07-30). Cuando la
  descripción de la liquidación dice explícitamente **`a c/empresa`** (o `a cargo de la empresa`)
  el concepto es costo de la empresa, no un concepto del trabajador: el recibo no lo muestra ni
  en haberes ni en la sección patronal, y **tampoco integra el `Total Contribuciones`** (verificado:
  la suma de las contribuciones cierra exacta sin él). Exigirlo producía un `CONCEPTO_FALTANTE`
  sistémico — en el lote que lo destapó, 70 de 72 empleados. El filtro es `_A_CARGO_EMPRESA_RE`
  en `isInternal` (`parsers/liquidacion-pdf`).
  **Se distingue por el marcador, NO por el nombre del concepto:** hay plantillas con un
  `Diferencia Plan` / `Diferencia plan prepaga` que **sí** figura en los haberes del recibo y debe
  seguir exigiéndose; sin el `a c/empresa` no entra por esta regla. En la ruta **Excel** no hace
  falta: esos conceptos caen a la derecha del NETO y ya se saltean por `columna='CONTRIB'`.
- **Totales validados:** Neto, Bruto, Descuentos, Contribuciones, Costo Laboral (= Bruto +
  Contribuciones del recibo).
- **Tolerancias:** ±$0,01 por concepto, ±$1,00 por total, ±1 punto para la suma de la torta.
- **Torta con bruto 0: no se valida.** Si el bruto del recibo es 0 y los porcentajes suman 0, no
  hay nada que repartir y el recibo imprime todas las porciones en 0,00%: exigir ~100% ahí es un
  falso positivo. Pasa con empleados de **licencia sin goce**, donde el descuento cancela los
  haberes y sólo quedan contribuciones patronales. Se piden **las dos** condiciones (suma 0 **y**
  bruto 0) para no perder el chequeo cuando el bruto es real y la torta igual da 0.
- **Empleados multi-bloque / multi-fecha:** se consolidan sumando **de los dos lados**
  (completado 2026-08-04). Un empleado puede tener en un mismo PDF **varios recibos**: el del mes
  más los ajustes retroactivos de meses anteriores (`Aj Mayo 2026`, `Aj Junio 2026`, `Mens. Julio
  2026`). La liquidación ya venía consolidando los códigos repetidos entre bloques
  (`_consolidate`), pero el recibo sólo concatenaba: el validador comparaba el total de la
  liquidación contra el importe de **un solo** recibo y devolvía un `MONTO_DIFIERE` por cada
  concepto más un `CONCEPTO_DUPLICADO` por cada código repetido, cuando la suma cierra peso a peso.
  Ahora `_mergePages` suma por código (`_consolidarPorCodigo` en `parsers/parser-recibos`).
  Un código repetido **dentro de una misma página** sigue siendo `CONCEPTO_DUPLICADO`: ahí sí es
  un recibo mal armado.
- **La torta se valida por recibo, no sobre el acumulado** (2026-08-04). Cada recibo trae su
  propio gráfico que reparte su propio 100%; con tres recibos la suma daba 300% y un
  `TORTA_NO_SUMA` falso. El recibo lleva `tortas` (una entrada por recibo) y el validador recorre
  cada una. La columna "Torta" de la UI muestra la que **más se aleja** de 100 — la que hay que
  mirar — en vez de la suma de todas.
- **Multi-archivo (liquidación Y recibos):** ambos lados aceptan **varios archivos** y se
  cruzan contra un conjunto **unificado** (consolidado por legajo). Sirve para anexos o
  archivos confidenciales que se entregan aparte. Los PDF de liquidación se parsean juntos
  (cada archivo = una "parte"); si un legajo aparece en más de un archivo, se consolida igual
  que multi-bloque (conceptos concatenados, totales sumados — `mergeLiquiMaps` en `app.js`).
  La liquidación puede mezclar PDF y Excel en el mismo lote.

---

## Verificación (referencia dorada)

La versión JS se verifica contra la salida del motor Python sobre los mismos PDF reales
("golden"). El golden original (junio 2026, motor Python) era **531 empleados · 518 OK · 13 con
error · 0 sin par**, y la versión JS lo reproducía exactamente.

> **Golden vigente (verificado 2026-08-04): 531 empleados · 519 OK · 12 con error · 0 sin par.**
> Se corre con la liquidación `01- Preliquidación mensual 06-2026 V2.pdf` y **los dos** PDF de
> recibos (`recibo_contrib v4.pdf` + `recibo_contrib v4 rrhh.pdf`); con uno solo quedan 15 `SIN_PAR`.
> Legajos con ERROR: 1338, 3170, 3261, 3848, 4184, 4529, 4530, 5136, 5163, 6851, 6886, 7183.

El error que dejó de contarse es el del **legajo 7269**, que quedó `OK`: era el caso documentado
como "parsea a valores absurdos". La causa era la página de TOTALES GENERALES de la empresa, que se
le imputaba al último empleado del reporte; el fix de julio 2026 (punto 2 de la lista de abajo) lo
resolvió y ahora parsea bien.
Es exactamente la "vía 1" que se había anticipado como posible mejora del conteo, y **cierra el
`/verify-golden` que estaba pendiente desde julio**.

**Otra mejora ya incorporada:** legajo 6851 — pdf.js lee la torta completa (suma 100%)
donde pdfplumber se comía una porción (daba 85,76% → falso `TORTA_NO_SUMA`). El JS elimina ese
falso positivo. Sigue marcado ERROR por una diferencia real (Bruto−Desc ≠ Neto impreso).

### Variantes de formato Meta 4 soportadas (julio 2026)

Un segundo cliente (liquidado también con Meta 4, pero con otra plantilla) destapó cuatro
supuestos que estaban de más en los parsers. Los cuatro se corrigieron; los cuatro afectaban a
CUALQUIER cliente con esa variante, no sólo a ese lote:

1. **Legajos de más de 6 dígitos.** El header del recibo se matcheaba con `\d{3,6}`: con legajos
   de 7 dígitos el header no matcheaba, la página se descartaba por "no se detectó legajo" y el
   recibo entero desaparecía → **todos** los empleados salían `SIN_PAR`. Ahora `\d{3,12}`.
2. **Página de TOTALES GENERALES de la empresa.** El reporte cierra con una página que repite la
   grilla de conceptos con los acumulados de toda la empresa y **sin** línea `Legajo:`. Esos
   importes se le sumaban al último empleado del reporte y lo dejaban con un bruto/neto absurdo.
   Ahora el bloque del empleado se **cierra** al aparecer un concepto después de sus totales
   (Meta 4 siempre termina cada empleado con sus totales), así que la página de totales no se
   imputa a nadie.
3. **`Total Contribuciones:` como fuente del total.** No todas las plantillas imprimen el
   rótulo `Costo Laboral:`; sin este otro rótulo `total_contrib` quedaba `null` y el validador
   reportaba `Total Contribuciones … (uno es N/D)` para **todos** los empleados.
   *(Corregido en agosto 2026: cuando están los dos rótulos gana `Total Contribuciones:`, no
   `Costo Laboral:` — ver el punto 1 de la lista de agosto.)*
4. **Porcentajes de la torta con coma decimal.** Se leían sólo como `1.27%`; con `1,27%` la lista
   quedaba vacía y la validación de la torta no corría (columna en `—`). Ahora acepta ambos.
5. **Recibos partidos en dos hojas.** Hay plantillas (p. ej. la que emite HITSS) donde el recibo
   ocupa 2 páginas: conceptos en la primera, y `COMPOSICION SALARIAL` + `SUELDO NETO` + torta en
   la segunda, que **no repite** la fila `MES AÑO APELLIDO Y NOMBRE LEGAJO`. Esa segunda hoja se
   descartaba por "no se detectó legajo", así que se perdían el **neto**, los **descuentos** y la
   **torta**, y el validador los reportaba como `N/D` en todos los empleados. Ahora una página sin
   encabezado que trae los rótulos del pie (`_MARCAS_CONTINUACION`) se **vuelca** sobre el recibo
   anterior. Ojo con la diferencia: una continuación **completa** los campos que faltan
   (`_mergeContinuacion`), mientras que un segundo recibo del mismo legajo **suma**
   (`_mergePages`) — son casos distintos y no hay que confundirlos.

**Impacto sobre el golden: verificado el 2026-08-04.** Quedó en **531 / 519 / 12 / 0** (ver arriba):
bajó un error respecto del golden original y fue por la "vía 1" que se había anticipado — el legajo
7269 estaba corrupto por la página de totales generales y ahora parsea bien.

### Variantes de formato Meta 4 soportadas (agosto 2026)

Un tercer cliente (cuatro empresas del mismo grupo, todas Meta 4, convenios de **Comercio** y
**Camioneros**) destapó cuatro problemas más. Los cuatro estaban en el motor y afectaban a
cualquier cliente con esa variante; todos daban **falsos positivos**, nunca falsos OK. Sobre 631
empleados de ese lote, los errores reportados pasaron de **550 a 5** (los 5 restantes son
diferencias reales).

1. **`Costo Laboral:` no es el total de contribuciones cuando el convenio tiene aportes a
   terceros.** Ver la regla de negocio de arriba: ahora manda `Total Contribuciones:`. Era el
   problema masivo — 550 `TOTAL_DIFIERE` de $55.000 a $60.000 por empleado.
2. **Legajos de 1 y 2 dígitos.** El header del recibo pedía `\d{3,12}`: los clientes que numeran
   desde 1 perdían la página entera por "no se detectó legajo" y esos empleados salían `SIN_PAR`
   (una empresa completa del lote, 21 de 21, más 16 empleados sueltos de las otras tres). Ahora
   `\d{1,12}`; lo que delimita el legajo no es el largo sino la posición (el número pegado antes
   del `$` del bruto).
3. **Concepto 5700 `Base Maternidad LSD`.** Ver la regla de conceptos internos.
4. **Empleados con varios recibos en el mismo PDF** (mes + ajustes retroactivos). Ver la regla de
   multi-bloque y la de la torta.

### Casos conocidos a revisar manualmente
- **Recibos con el `SUELDO BRUTO` impreso al doble.** El recibo imprime en el encabezado y en
  `SUELDO BRUTO` exactamente **2×** la suma de sus propios conceptos, mientras el neto, los
  descuentos y las contribuciones están bien. Se detecta solo porque el recibo se contradice a sí
  mismo (`Bruto − Descuentos ≠ Neto impreso`). Apareció en 2 empleados fuera de convenio de dos
  empresas distintas del lote de agosto 2026. **Es un error del recibo, no del parser:** hay que
  corregirlo en Meta 4 antes de entregarlo.
- **`Total Contribuciones` de la liquidación que no cuadra con la suma de sus propias líneas.**
  En los bloques de ajuste del mes en que se pagó SAC aparecen los conceptos `6115 Contribución
  Obra Social s/SAC` y `6146 Contribución ANSSAL s/SAC`; ahí el rótulo `Total Contribuciones` del
  bloque queda por debajo de la suma de las líneas de ese mismo bloque, y el recibo (que sí cierra
  con sus líneas, y que no lista el 6146) da un total mayor. Son diferencias **reales** entre los
  dos documentos: la herramienta las marca bien y las tiene que mirar quien liquida. 5 casos en el
  lote de agosto 2026.
- **Legajo 7269 — RESUELTO.** Parseaba a valores absurdos (un salario base de siete cifras de más)
  por la página de TOTALES GENERALES de la empresa. Con el fix de julio 2026 parsea bien
  y quedó `OK`. Se deja anotado por si reaparece con otra plantilla.

### Limitación del parser de Excel
La muestra `TABU 04.xlsx` es del período **04-2026**, distinta a los recibos PDF (**06-2026**),
así que no se puede cruzar 1:1 contra la referencia dorada. Su parseo se validó por
**consistencia interna** y estructura (527 empleados, 36 multi-fecha, contribuciones/provisiones
correctamente segregadas). Para una validación cruzada completa de la ruta Excel se necesita un
Excel + recibos del **mismo** período.

---

## Cómo probar localmente

```bash
# Servidor estático en la raíz del repo (los módulos ES requieren http://, no file://)
python -m http.server 8123
# abrir: http://localhost:8123/docs/index.html
```

(O usar el preview de Claude Code: config en `.claude/launch.json`, server "validador".)

NUNCA inventar ni asumir datos de empleados: todo dato del reporte sale de lo que se parsea.

---

## Automatizaciones de Claude Code (`.claude/`)

El repo trae hooks, skills y subagents. Config en `.claude/` (no se publica en Pages).

**Hooks** (`.claude/settings.json`, ya activos):
- `PreToolUse/Bash` (`guard.mjs`): **bloquea** versionar datos reales de payroll (`git add/commit/stash`
  de `*.pdf/*.xlsx/*.csv/Archivos/`). Red de seguridad sobre el `.gitignore` (cubre `git add -f`).
- `PreToolUse/Edit|Write|MultiEdit` (`guard.mjs`): **bloquea** editar a mano `docs/vendor/**` (libs vendoreadas).
- `PostToolUse/Edit|Write|MultiEdit` (`post-edit-reminder.mjs`): **NO bloquea** (la tool ya corrió);
  tras editar el MOTOR (`docs/parsers/*` o `docs/core/validador.js`) o la UI
  (`docs/index.html|app.js|styles.css`) recuerda por stderr qué verificación corresponde
  (motor → `verify-golden` + `business-rules-reviewer`; UI → `smoke-ui` + `ui-brand-reviewer`).
  Anti-ruido: una sola vez por sesión y por categoría (marcador en el temp del SO).

**Skills — Claude las ejecuta SOLO, sin que se las pidan, cuando es conveniente:**
- `verify-golden`: **correr proactivamente** después de tocar cualquier parser
  (`docs/parsers/*`) o `docs/core/validador.js`, y antes de mergear. Compara contra la
  referencia dorada (531/519/12).
- `smoke-ui`: **correr proactivamente** tras tocar la UI (`docs/index.html`, `styles.css`, `app.js`)
  y antes de mergear. Smoke test SIN datos reales (bootea sin errores de consola, toggle dark/claro
  persiste, estructura clave). Complementa `verify-golden`, no lo reemplaza.
- `deploy-check`: **correr proactivamente** antes de cualquier commit que vaya a `main` o de
  proponer mergear el PR. Verifica que no haya datos reales versionados y que `/docs` esté apto.

**Subagents:**
- `business-rules-reviewer`: revisar diffs del MOTOR contra las reglas de negocio de arriba
  (lanzarlo cuando se modifiquen parsers/validador).
- `ui-brand-reviewer`: revisar diffs de la CAPA DE UI (marca H&A, dark mode/contraste AA en ambos
  temas, accesibilidad, flujo errores-primero). NO revisa el motor.
- `privacy-auditor`: auditar el diff/staging buscando PII real de empleados pegada INLINE
  (CUIT/CUIL, legajo+nombre+monto, montos hardcodeados) — cubre el agujero que `guard.mjs` NO ve
  (sólo bloquea archivos por ruta, no contenido). Lanzar antes de cualquier commit, sobre todo si
  se tocó `docs/`, `CLAUDE.md` o `README`.

**MCP (manual, fuera del repo):** Playwright (`claude mcp add playwright -- npx -y @playwright/mcp@latest`)
y context7 (`@upstash/context7-mcp`).
