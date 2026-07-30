// parser-liquidacion-pdf.js
// Parser de PDFs de pre-liquidación del ERP Meta 4 (reporte "CONTROL DE LIQUIDACIÓN").
// Sirve para cualquier cliente liquidado con Meta 4 (no es específico de un cliente).
//
// Traducción fiel 1:1 del Python src/parser_liquidacion.py.
// Parser basado en líneas de texto — no necesita detección de coordenadas.
// Los bloques de empleado empiezan con 'Legajo: XXXX' y terminan en el próximo
// 'Legajo:' o al final de la página.
//
// Totales extraídos de:
//   'Total Haberes: X  Total Descuentos: X  ...  Total Netos: X'
//   'Total Imponible: X  ...  Costo Laboral: X'   <- Costo Laboral = Total Contribuciones
//
// Módulo ES, sin dependencias de DOM/window. Importable en Node (ESM) y navegador.
// A diferencia del Python (que abre los PDF con pdfplumber), esta versión recibe el
// texto ya extraído: pagesByFile = Array<Array<string>> (un array por archivo PDF,
// texto de cada página en orden). El caller usa pdf-extract.js para obtener el texto.

// Códigos de concepto internos — nunca requeridos en recibos
const INTERNAL_CODES = new Set(['5911', '5921', '7100']);

// Palabras clave que marcan conceptos de provisión/internos (case-insensitive)
const PROVISION_KEYWORDS = [
  'provision', 'provisión', 'prov.', 'reversion', 'reversión',
  'rev. prov', 'rever.', 'bonus prov', 'prov ccss',
];

// Conceptos que la liquidación marca explícitamente como COSTO DEL EMPLEADOR
// ("Dif plan prepaga a c/empresa <prepaga>"). Son costo de la empresa, no un concepto del
// trabajador: el recibo del trabajador no los muestra ni en haberes ni en la sección
// patronal, y tampoco integran el Total Contribuciones (verificado: la suma de las
// contribuciones cierra exacta sin ellos). Exigirlos generaba un CONCEPTO_FALTANTE en
// casi todos los empleados del lote.
//
// Se distinguen por el marcador explícito, NO por el nombre del concepto: hay plantillas
// con un "Diferencia Plan" / "Diferencia plan prepaga" que SÍ figura en los haberes del
// recibo y debe seguir exigiéndose. Sin el "a c/empresa" no entra por acá.
const _A_CARGO_EMPRESA_RE = /\bc\/\s*empresa\b|\ba\s+cargo\s+de\s+la\s+empresa\b/i;

// Línea de concepto: CODE [espacio] descripción [unidad opcional como "11,00"] monto
// pdfplumber a veces pega code+descripción sin espacio (ej. "3025Comp. gastos").
// Python: re.compile(r'^(-?\d{3,6})\s*(.+?)\s+(?:\d{1,4},\d{2}\s+)?(-?(?:\d{1,3}\.)*\d{1,3},\d{2})\s*$')
// El '.' de JS no matchea newline (como Python sin DOTALL); operamos línea por línea.
const _CONCEPTO_RE =
  /^(-?\d{3,6})\s*(.+?)\s+(?:\d{1,4},\d{2}\s+)?(-?(?:\d{1,3}\.)*\d{1,3},\d{2})\s*$/;

// Línea de encabezado de empleado: 'Legajo: NNNN Empleado: <nombre> <ETIQUETA>: ...'
// El nombre termina en la siguiente etiqueta de campo, que varía según el reporte Meta 4 y
// puede caer en la misma línea o en la siguiente si el bloque se parte en dos líneas:
// 'Categoría:' (Marval), 'Convenio:' (Copetro), 'Ingreso:' (Carrier Fueguina), etc.
// Se acota el nombre (lazy) hasta el primer token que termine en ':' (una etiqueta de
// campo), en vez de exigir una etiqueta puntual.
const _LEGAJO_RE = /Legajo:\s*(\d+)\s+Empleado:\s*(.+?)\s+[^\s:]+:/;

// Líneas de totales
const _TOTAL_HABERES_RE = /Total Haberes:\s*([\d.,]+)/;
const _TOTAL_DESC_RE    = /Total Descuentos:\s*([\d.,]+)/;
const _TOTAL_NETOS_RE   = /Total Netos:\s*([\d.,]+)/;
// Costo Laboral = Total Contribuciones (confiable, sin el bug de merge de pdfplumber)
const _COSTO_LABORAL_RE = /Costo Laboral:\s*([\d.,]+)/;
// Fuente alternativa del total de contribuciones: no todas las plantillas Meta 4 imprimen
// el rótulo 'Costo Laboral:'; algunas sólo traen 'Total Contribuciones:'. Sin este fallback
// total_contrib quedaba en null y el validador reportaba "Total Contribuciones ... (uno es N/D)"
// para TODOS los empleados. Cuando ambos rótulos están, gana 'Costo Laboral:'.
const _TOTAL_CONTRIB_RE = /Total Contribuciones:\s*([\d.,]+)/;

// Equivalente a Python str.lstrip('0') con fallback a '0'.
function _lstripZeros(s) {
  return String(s).replace(/^0+/, '') || '0';
}

// Equivalente a Python str.lstrip('-').
function _lstripMinus(s) {
  return String(s).replace(/^-+/, '');
}

// Construye un LiquidacionEmpleado con el contrato de datos del proyecto.
function _nuevoEmpleado(legajo, nombre) {
  return {
    legajo,
    nombre,
    bruto: null,
    neto: null,
    total_rem: null,
    total_desc: null,
    total_no_rem: null,
    total_contrib: null,
    conceptos: [],
    n_bloques: 1,
    errores_parse: [],
  };
}

export function isInternal(codigo, descripcion) {
  if (INTERNAL_CODES.has(_lstripMinus(codigo))) {
    return true;
  }
  if (_A_CARGO_EMPRESA_RE.test(descripcion)) {
    return true;
  }
  const descLower = descripcion.toLowerCase();
  return PROVISION_KEYWORDS.some((kw) => descLower.includes(kw));
}

// Convierte un string de monto en formato AR (puntos=miles, coma=decimal) a number.
// Devuelve null cuando el Python devuelve None.
export function parseMoney(s) {
  if (!s) {
    return null;
  }
  // Python: re.sub(r'[$\s]', '', str(s)).strip()
  s = String(s).replace(/[$\s]/g, '').trim();
  if (!s) {
    return null;
  }
  // Formato AR: 1.234.567,89
  if (/^-?(?:\d{1,3}\.)*\d{1,3},\d{2}$/.test(s)) {
    return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  }
  // Formato US (fallback): 1,234,567.89
  if (/^-?[\d,]+\.\d{1,2}$/.test(s)) {
    return parseFloat(s.replace(/,/g, ''));
  }
  if (/^-?\d+$/.test(s)) {
    return parseFloat(s);
  }
  return null;
}

function _flushEmployee(current, results) {
  if (!current.legajo) {
    return;
  }
  if (!(current.legajo in results)) {
    results[current.legajo] = [];
  }
  results[current.legajo].push(current);
}

// Parsea el texto de una página, acumulando bloques de empleado en results.
// currentHolder es un array mutable que mantiene estado entre líneas/páginas:
//   [0] = empleado en curso (o null)
//   [1] = true si ya se leyó alguna línea de totales del bloque en curso
//   [2] = true si total_contrib vino de 'Costo Laboral:' (fuente autoritativa)
function _parseText(text, results, currentHolder) {
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line) {
      continue;
    }

    // --- Nuevo bloque de empleado ---
    const m = _LEGAJO_RE.exec(line);
    if (m) {
      if (currentHolder[0] !== null) {
        _flushEmployee(currentHolder[0], results);
      }
      const legajo = _lstripZeros(m[1]);
      // Python: m.group(2).strip().rstrip(',').strip()
      const nombre = m[2].trim().replace(/,+$/, '').trim();
      currentHolder[0] = _nuevoEmpleado(legajo, nombre);
      currentHolder[1] = false;
      currentHolder[2] = false;
      continue;
    }

    const emp = currentHolder[0];
    if (emp === null) {
      continue;
    }

    // --- Saltar filas de encabezado ---
    // El banner del reporte Meta 4 es "<Empresa> SUELDOS Y JORNALES": el nombre de la empresa
    // varía por cliente, pero el rótulo "SUELDOS Y JORNALES" es del formato Meta 4 y es estable.
    // Por eso skipeamos por el rótulo, no por el nombre del cliente (antes estaba hardcodeado).
    if (line.startsWith('CONCEPTO') || line.includes('SUELDOS Y JORNALES')
        || line.startsWith('CONTROL') || line.startsWith('Mes y Año')
        || line.startsWith('Ingreso:')) {
      continue;
    }

    // --- Líneas de totales ---
    const mHab = _TOTAL_HABERES_RE.exec(line);
    if (mHab) {
      emp.bruto = parseMoney(mHab[1]);
      const mDesc = _TOTAL_DESC_RE.exec(line);
      if (mDesc) {
        emp.total_desc = parseMoney(mDesc[1]);
      }
      const mNet = _TOTAL_NETOS_RE.exec(line);
      if (mNet) {
        emp.neto = parseMoney(mNet[1]);
      }
      currentHolder[1] = true;
      continue;
    }

    const mCl = _COSTO_LABORAL_RE.exec(line);
    if (mCl) {
      emp.total_contrib = parseMoney(mCl[1]);
      currentHolder[1] = true;
      currentHolder[2] = true;
      continue;
    }

    const mTc = _TOTAL_CONTRIB_RE.exec(line);
    if (mTc) {
      // Sólo si 'Costo Laboral:' no lo definió: ese rótulo es el autoritativo.
      if (!currentHolder[2]) {
        emp.total_contrib = parseMoney(mTc[1]);
      }
      currentHolder[1] = true;
      continue;
    }

    // --- Línea de concepto ---
    const mC = _CONCEPTO_RE.exec(line);
    if (mC) {
      // Un concepto DESPUÉS de los totales del bloque significa que el bloque del
      // empleado ya terminó: el reporte Meta 4 cierra cada empleado con sus totales.
      // Lo que sigue es la página de TOTALES GENERALES de la empresa (misma grilla de
      // conceptos, sin línea 'Legajo:'), que no pertenece a ningún empleado. Si no se
      // cerrara acá, esos importes acumulados de toda la empresa se sumaban al último
      // empleado del reporte y lo dejaban con un bruto/neto absurdo.
      if (currentHolder[1]) {
        _flushEmployee(emp, results);
        currentHolder[0] = null;
        currentHolder[1] = false;
        currentHolder[2] = false;
        continue;
      }
      const code = _lstripMinus(mC[1]);  // quitar el signo del código para el lookup
      const desc = mC[2].trim();
      const amountStr = mC[3];
      if (isInternal(code, desc)) {
        continue;
      }
      const amount = parseMoney(amountStr);
      if (amount !== null) {
        emp.conceptos.push({
          codigo: code,
          descripcion: desc,
          monto: Math.abs(amount),
          columna: '',
        });
      }
    }
  }
}

// Suma múltiples bloques del mismo legajo (empleados con >1 corrida de liquidación).
function _consolidate(blocks) {
  if (blocks.length === 1) {
    const b = blocks[0];
    b.n_bloques = 1;
    return b;
  }

  const base = _nuevoEmpleado(blocks[0].legajo, blocks[0].nombre);
  base.n_bloques = blocks.length;

  for (const b of blocks) {
    for (const attr of ['bruto', 'neto', 'total_desc', 'total_contrib']) {
      const bv = base[attr];
      const ev = b[attr];
      if (ev !== null) {
        base[attr] = _round2((bv || 0.0) + ev);
      }
    }
    for (const c of b.conceptos) {
      base.conceptos.push(c);
    }
  }

  // Mergear conceptos: sumar códigos repetidos.
  // Usamos Map para preservar el orden de inserción (como dict de Python).
  const merged = new Map();
  for (const c of base.conceptos) {
    if (merged.has(c.codigo)) {
      const prev = merged.get(c.codigo);
      merged.set(c.codigo, {
        codigo: c.codigo,
        descripcion: c.descripcion,
        monto: _round2(prev.monto + c.monto),
        columna: '',
      });
    } else {
      merged.set(c.codigo, c);
    }
  }
  base.conceptos = Array.from(merged.values());
  return base;
}

// Replica round(x, 2) de Python (redondeo bancario / half-to-even) para fidelidad.
function _round2(x) {
  // Python usa round-half-to-even. JS Math.round es half-up. Para mantener fidelidad
  // en montos a 2 decimales, replicamos half-to-even sobre la 3a posición decimal.
  const scaled = x * 100;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded;
  const EPS = 1e-9;
  if (Math.abs(diff - 0.5) < EPS) {
    // exactamente .5 -> al par
    rounded = (floor % 2 === 0) ? floor : floor + 1;
  } else {
    rounded = Math.round(scaled);
  }
  return rounded / 100;
}

// Función principal: parsea uno o más PDF de liquidación (ya extraídos a texto).
// pagesByFile: Array<Array<string>> — un array por archivo PDF, texto de cada página.
// Devuelve un objeto-mapa { [legajo]: LiquidacionEmpleado } ya consolidado.
export function parseLiquidacionPdf(pagesByFile) {
  const raw = {};
  const currentHolder = [null, false, false];  // estado entre páginas de la misma parte

  for (const pages of pagesByFile) {
    // reset entre partes (cada parte es independiente)
    currentHolder[0] = null;
    currentHolder[1] = false;
    currentHolder[2] = false;
    for (const page of pages) {
      const text = page || '';
      _parseText(text, raw, currentHolder);
    }
    // Flush del último empleado de cada parte
    if (currentHolder[0] !== null) {
      _flushEmployee(currentHolder[0], raw);
    }
  }

  const results = {};
  for (const legajo of Object.keys(raw)) {
    results[legajo] = _consolidate(raw[legajo]);
  }

  return results;
}
