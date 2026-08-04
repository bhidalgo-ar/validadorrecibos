#!/usr/bin/env node
// diag-totales.mjs — diagnóstico LOCAL de los rótulos de totales de una liquidación PDF
// y del cruce de totales contra los recibos. Pensado para responder "¿por qué me da
// TOTAL DIFIERE en todo el lote?" SIN que los archivos salgan de la máquina.
//
// La salida es AGREGADA y SIN PII: no imprime nombres, ni legajos individuales salvo
// contados ejemplos, ni importes por empleado más allá de unas pocas muestras. Está
// hecha para poder pegarse en un ticket o en el chat sin exponer datos de empleados.
//
// Uso:
//   node tools/diag-totales.mjs --liq <liquidacion.pdf> [--liq <otra.pdf>] \
//                               [--rec <recibos.pdf> [--rec <otro.pdf>]]
//
// Requiere pdfjs-dist (el build vendoreado de docs/vendor es para el navegador y no
// corre en Node). Instalación de una sola vez, en la raíz del repo:
//   npm install --no-save pdfjs-dist@3.11.174

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------- pdf.js (Node)
function loadPdfjs() {
  const candidatos = [
    path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.js'),
    path.join(ROOT, 'docs/node_modules/pdfjs-dist/legacy/build/pdf.js'),
  ];
  for (const p of candidatos) {
    if (fs.existsSync(p)) {
      // pdf.js avisa por consola que no puede polyfillear DOMMatrix/Path2D sin el
      // paquete `canvas`. Sólo afecta al renderizado a imagen; acá únicamente
      // extraemos texto, así que el aviso es ruido.
      const { warn, log } = console;
      console.warn = () => {};
      console.log = () => {};
      try {
        const mod = require(p);
        return mod.default || mod;
      } finally {
        console.warn = warn;
        console.log = log;
      }
    }
  }
  console.error(
    'No encontré pdfjs-dist. Instalalo (una sola vez, en la raíz del repo):\n' +
      '  npm install --no-save pdfjs-dist@3.11.174\n' +
      '(el build de docs/vendor es para el navegador y no corre en Node)'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------- helpers
function parseArgs(argv) {
  const liq = [];
  const rec = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--liq') liq.push(argv[++i]);
    else if (a === '--rec') rec.push(argv[++i]);
    else if (a === '-h' || a === '--help') return null;
    else {
      console.error(`Argumento no reconocido: ${a}`);
      return null;
    }
  }
  if (!liq.length) return null;
  return { liq, rec };
}

const fmt = (n) =>
  n === null || n === undefined
    ? 'N/D'
    : n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function stats(vals) {
  const s = [...vals].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  const suma = s.reduce((a, b) => a + b, 0);
  return {
    n,
    min: s[0],
    p50: s[Math.floor(n / 2)],
    max: s[n - 1],
    prom: suma / n,
    suma,
  };
}

// ------------------------------------------------------------------------- main
const args = parseArgs(process.argv.slice(2));
if (!args) {
  console.log(
    'Uso: node tools/diag-totales.mjs --liq <liquidacion.pdf> [--rec <recibos.pdf>]\n' +
      'Salida agregada y sin PII. Los archivos no salen de esta máquina.'
  );
  process.exit(args === null && process.argv.length > 2 ? 1 : 0);
}

const pdfjsLib = loadPdfjs();
const { extractPagesText } = await import(path.join(ROOT, 'docs/parsers/pdf-extract.js'));
const { parseLiquidacionPdf, parseMoney } = await import(
  path.join(ROOT, 'docs/parsers/parser-liquidacion-pdf.js')
);
const { parseRecibos } = await import(path.join(ROOT, 'docs/parsers/parser-recibos.js'));

async function paginas(file) {
  const data = new Uint8Array(fs.readFileSync(file));
  return extractPagesText(data, pdfjsLib);
}

const liqPages = [];
for (const f of args.liq) liqPages.push(await paginas(f));

console.log('='.repeat(72));
console.log('DIAGNÓSTICO DE TOTALES — liquidación');
console.log('='.repeat(72));

// --- 1. ¿Qué rótulos de totales trae el PDF, y cuántas veces? -----------------
// Ésta es la pregunta central: si la plantilla imprime `Costo Laboral:` Y
// `Total Contribuciones:`, el parser prioriza el primero, y en algunas plantillas
// ese rótulo NO es el total de contribuciones.
const ROTULOS = [
  ['Costo Laboral:', /Costo Laboral:\s*([\d.,]+)/],
  ['Total Contribuciones:', /Total Contribuciones:\s*([\d.,]+)/],
  ['Reducciones de Contrib.:', /Reducciones de Contrib\.?:\s*([\d.,]+)/],
  ['Total Imp. Contrib:', /Total Imp\. Contrib:\s*([\d.,]+)/],
  ['Total Imponible:', /Total Imponible:\s*([\d.,]+)/],
  ['Total Haberes:', /Total Haberes:\s*([\d.,]+)/],
];

const conteo = new Map(ROTULOS.map(([k]) => [k, 0]));
// Pares (costo laboral, total contribuciones) vistos dentro del mismo bloque de
// empleado, para medir si difieren de forma sistemática.
const pares = [];
let clActual = null;

for (const pages of liqPages) {
  for (const page of pages) {
    for (const line of page.split('\n')) {
      for (const [rot, re] of ROTULOS) {
        const m = re.exec(line);
        if (!m) continue;
        conteo.set(rot, conteo.get(rot) + 1);
        if (rot === 'Costo Laboral:') clActual = parseMoney(m[1]);
        else if (rot === 'Total Contribuciones:') {
          pares.push({ cl: clActual, tc: parseMoney(m[1]) });
          clActual = null;
        }
      }
    }
  }
}

console.log('\n[1] Rótulos de totales presentes en el PDF (ocurrencias):');
for (const [rot, n] of conteo) {
  console.log(`    ${n === 0 ? '  —  ' : String(n).padStart(5)}  ${rot}`);
}

const conAmbos = pares.filter((p) => p.cl !== null);
console.log(`\n[2] Bloques con AMBOS rótulos (Costo Laboral + Total Contribuciones): ${conAmbos.length}`);
if (conAmbos.length) {
  const distintos = conAmbos.filter((p) => Math.abs(p.cl - p.tc) > 0.01);
  console.log(`    de esos, con valores DISTINTOS: ${distintos.length}`);
  if (distintos.length) {
    const difs = distintos.map((p) => p.tc - p.cl);
    const st = stats(difs);
    const mayores = difs.filter((d) => d > 0).length;
    console.log(
      `    dif (Total Contribuciones − Costo Laboral):  min ${fmt(st.min)}  ` +
        `mediana ${fmt(st.p50)}  max ${fmt(st.max)}`
    );
    console.log(
      `    Total Contribuciones > Costo Laboral en ${mayores} de ${distintos.length} bloques`
    );
    console.log(
      '    >>> Si este número es alto, el parser está leyendo el rótulo equivocado:\n' +
        "        prioriza 'Costo Laboral:' y en esta plantilla no es el total de contribuciones."
    );
  } else {
    console.log('    los dos rótulos coinciden siempre: el orden de prioridad no cambia nada.');
  }
}

// --- 3. ¿Cierra la liquidación consigo misma? --------------------------------
// Suma de las líneas de la columna CONTRIBUCIONES vs el total que imprime.
// Los parsers devuelven objetos planos; los envolvemos en Map para iterar cómodo.
const liqMap = new Map(Object.entries(parseLiquidacionPdf(liqPages)));
console.log(`\n[3] Empleados parseados en la liquidación: ${liqMap.size}`);

const sinContrib = [];
for (const [legajo, emp] of liqMap) {
  if (emp.total_contrib === null || emp.total_contrib === undefined) sinContrib.push(legajo);
}
if (sinContrib.length) {
  console.log(`    sin total_contrib (quedaría N/D en el reporte): ${sinContrib.length}`);
}

// --- 4. Cruce de totales contra los recibos ----------------------------------
if (args.rec.length) {
  const recPages = [];
  for (const f of args.rec) recPages.push(await paginas(f));
  const recMap = new Map(Object.entries(parseRecibos(recPages)));

  console.log('\n' + '='.repeat(72));
  console.log('CRUCE DE TOTALES — liquidación vs recibos');
  console.log('='.repeat(72));
  console.log(`\n[4] Empleados en recibos: ${recMap.size}`);

  const comunes = [...liqMap.keys()].filter((k) => recMap.has(k));
  console.log(
    `    legajos en ambos: ${comunes.length}  ·  ` +
      `sólo en liquidación: ${liqMap.size - comunes.length}  ·  ` +
      `sólo en recibos: ${recMap.size - comunes.length}`
  );

  // Para cada total, cuántos difieren por más de $1 y qué tan grande es la brecha.
  const CAMPOS = [
    ['Bruto', (l) => l.bruto, (r) => r.bruto],
    ['Neto', (l) => l.neto, (r) => r.neto],
    ['Descuentos', (l) => l.total_desc, (r) => r.composicion_desc],
    ['Contribuciones', (l) => l.total_contrib, (r) => r.total_contribuciones],
  ];

  console.log('\n[5] Diferencias por total (tolerancia ±$1,00):');
  for (const [nombre, fl, fr] of CAMPOS) {
    let nd = 0;
    let ok = 0;
    const difs = [];
    for (const legajo of comunes) {
      const a = fl(liqMap.get(legajo));
      const b = fr(recMap.get(legajo));
      if (a === null || a === undefined || b === null || b === undefined) {
        nd++;
        continue;
      }
      const d = Math.round((a - b) * 100) / 100;
      if (Math.abs(d) <= 1) ok++;
      else difs.push(d);
    }
    const st = stats(difs.map(Math.abs));
    const negativos = difs.filter((d) => d < 0).length;
    console.log(
      `    ${nombre.padEnd(16)} coinciden ${String(ok).padStart(4)}  ` +
        `difieren ${String(difs.length).padStart(4)}  N/D ${String(nd).padStart(4)}`
    );
    if (difs.length) {
      console.log(
        `${' '.repeat(22)}|dif|  min ${fmt(st.min)}  mediana ${fmt(st.p50)}  max ${fmt(st.max)}` +
          `  ·  liq < recibo en ${negativos}/${difs.length}`
      );
    }
  }

  // Muestra acotada: 3 legajos con la diferencia de contribuciones más grande.
  // Sirve para revisar a mano en Meta 4. Sin nombres.
  const muestras = comunes
    .map((legajo) => {
      const l = liqMap.get(legajo);
      const r = recMap.get(legajo);
      if (l.total_contrib == null || r.total_contribuciones == null) return null;
      return { legajo, dif: l.total_contrib - r.total_contribuciones, l, r };
    })
    .filter(Boolean)
    .filter((x) => Math.abs(x.dif) > 1)
    .sort((a, b) => Math.abs(b.dif) - Math.abs(a.dif))
    .slice(0, 3);

  if (muestras.length) {
    console.log('\n[6] Muestra para revisar en Meta 4 (mayores difs de contribuciones, sin nombres):');
    for (const m of muestras) {
      console.log(
        `    legajo ${m.legajo}: liq ${fmt(m.l.total_contrib)} vs ` +
          `recibo ${fmt(m.r.total_contribuciones)}  (dif ${fmt(m.dif)})`
      );
    }
  }

  // --- 7. Reporte completo: hallazgos por tipo -------------------------------
  const { validar } = await import(path.join(ROOT, 'docs/core/validador.js'));
  const liqObj = Object.fromEntries(liqMap);
  const recObj = Object.fromEntries(recMap);
  const rep = validar(liqObj, recObj);

  console.log('\n' + '='.repeat(72));
  console.log('REPORTE COMPLETO — igual al de la web');
  console.log('='.repeat(72));
  const r = rep.resumen;
  console.log(
    `\n[7] ${r.total} empleados  ·  ${r.ok} OK  ·  ${r.errores} error  ·  ` +
      `${r.advertencias} advertencia  ·  ${r.sin_par} sin par`
  );
  console.log(
    `    pares por legajo: ${r.emparejamiento.por_legajo}  ·  ` +
      `por nombre: ${r.emparejamiento.por_nombre}  ·  ` +
      `todos por nombre: ${r.emparejamiento.todos_por_nombre}`
  );

  const porTipo = new Map();
  const faltantes = new Map(); // código -> cantidad de empleados
  const totalesQueFallan = new Map(); // etiqueta del total -> cantidad
  for (const e of rep.empleados) {
    for (const h of e.hallazgos || []) {
      porTipo.set(h.tipo, (porTipo.get(h.tipo) || 0) + 1);
      if (h.tipo === 'CONCEPTO_FALTANTE' && h.codigo) {
        faltantes.set(h.codigo, (faltantes.get(h.codigo) || 0) + 1);
      }
      if (h.tipo === 'TOTAL_DIFIERE') {
        const label = (h.mensaje || '').split(':')[0].trim();
        totalesQueFallan.set(label, (totalesQueFallan.get(label) || 0) + 1);
      }
    }
  }

  console.log('\n[8] Hallazgos por tipo:');
  for (const [tipo, n] of [...porTipo].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)}  ${tipo}`);
  }

  if (totalesQueFallan.size) {
    console.log('\n[9] ¿Qué total es el que falla? (clave para saber si es UNA causa o varias)');
    for (const [label, n] of [...totalesQueFallan].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(5)}  ${label}`);
    }
  }

  if (faltantes.size) {
    console.log('\n[10] Conceptos faltantes más frecuentes (sólo códigos, sin importes):');
    for (const [cod, n] of [...faltantes].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`    ${String(n).padStart(5)} empl.  cód. ${cod}`);
    }
  }

  // --- 11. Simulación de la opción B ----------------------------------------
  // ¿Cuántas diferencias de contribuciones desaparecen si se toma
  // 'Total Contribuciones:' en lugar de 'Costo Laboral:'?
  const tcPorLegajo = totalContribPorLegajo(liqPages);
  let mejoran = 0;
  let siguen = 0;
  let empeoran = 0;
  const restantes = [];
  for (const legajo of comunes) {
    const rv = recMap.get(legajo).total_contribuciones;
    const actual = liqMap.get(legajo).total_contrib;
    const nuevo = tcPorLegajo.get(legajo);
    if (rv == null || nuevo == null || actual == null) continue;
    const dAntes = Math.abs(actual - rv);
    const dDespues = Math.abs(nuevo - rv);
    if (dAntes > 1 && dDespues <= 1) mejoran++;
    else if (dAntes > 1 && dDespues > 1) {
      siguen++;
      restantes.push(nuevo - rv);
    } else if (dAntes <= 1 && dDespues > 1) empeoran++;
  }

  console.log("\n[11] Simulación opción B (usar 'Total Contribuciones:' en vez de 'Costo Laboral:'):");
  console.log(`    pasan a coincidir: ${mejoran}`);
  console.log(`    siguen difiriendo: ${siguen}`);
  console.log(`    se rompen (hoy coinciden y pasarían a diferir): ${empeoran}`);
  if (restantes.length) {
    const st = stats(restantes.map(Math.abs));
    console.log(
      `    de los que siguen difiriendo:  |dif| min ${fmt(st.min)}  ` +
        `mediana ${fmt(st.p50)}  max ${fmt(st.max)}`
    );
    console.log('    >>> ésos ya no son bug nuestro: son diferencias reales para revisar en Meta 4.');
  }
}

// Recorre el texto crudo y devuelve, por legajo, la suma de los valores del rótulo
// 'Total Contribuciones:'. Replica el cierre de bloque del parser (un concepto después
// de los totales cierra el empleado) para no imputarle a nadie la página de TOTALES
// GENERALES de la empresa, que repite la grilla sin línea 'Legajo:'.
function totalContribPorLegajo(pagesByFile) {
  const RE_LEGAJO = /Legajo:\s*(\d{3,12})/;
  const RE_TC = /Total Contribuciones:\s*([\d.,]+)/;
  const RE_CONCEPTO = /^\s*(\d{3,6})\s+\S/;
  const out = new Map();
  for (const pages of pagesByFile) {
    let actual = null;
    let cerrado = false;
    for (const page of pages) {
      for (const line of (page || '').split('\n')) {
        const mL = RE_LEGAJO.exec(line);
        if (mL) {
          actual = mL[1];
          cerrado = false;
          continue;
        }
        const mT = RE_TC.exec(line);
        if (mT) {
          if (actual !== null && !cerrado) {
            out.set(actual, (out.get(actual) || 0) + parseMoney(mT[1]));
            cerrado = true;
          }
          continue;
        }
        if (cerrado && RE_CONCEPTO.test(line)) actual = null;
      }
    }
  }
  return out;
}

console.log('\nListo. Esta salida no contiene nombres ni datos personales.');
