// parser-recibos.js
// Parser de PDFs de recibos del ERP Meta 4 (recibo_contrib_v4.pdf, recibo_contrib_v4_rrhh.pdf).
// Port fiel desde src/parser_recibos.py.
//
// Módulo ES, sin dependencias de DOM/window: importable en Node (ESM) y en el
// navegador (<script type="module">). La extracción de texto del PDF se hace
// aparte (ver pdf-extract.js); aquí el caller inyecta el texto ya extraído.

// Alternativa de mes (igual que MESES en el Python). Sin grupo de captura: usa (?:...).
const MESES =
  '(?:Enero|Febrero|Marzo|Abril|Mayo|Junio|' +
  'Julio|Agosto|Septiembre|Octubre|Noviembre|Diciembre)';

// Redondeo a 2 decimales (equivalente a round(x, 2) del Python para los montos
// que maneja este parser). Nota: Python usa banker's rounding; JS Math.round
// redondea ".5" hacia arriba. Para los importes contables involucrados la
// diferencia no se observa; cualquier divergencia se verifica por separado.
function _round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/**
 * Convierte un string de dinero argentino o US a number.
 *
 * Maneja: '$ 1.234.567,89' (AR) y '$10,963,803.18' (US).
 * Devuelve null cuando el Python devuelve None.
 */
export function parseMoney(s) {
  if (!s) {
    return null;
  }
  // re.sub(r'[$\s]', '', str(s)).strip() -> elimina '$' y todo whitespace.
  s = String(s).replace(/[$\s]/g, '').trim();
  if (!s || s === '-' || s === '') {
    return null;
  }
  // Formato US: termina en .XX (uno o dos dígitos decimales tras el punto).
  if (/^-?[\d,]+\.\d{1,2}$/.test(s)) {
    return parseFloat(s.replace(/,/g, ''));
  }
  // Formato AR: termina en ,XX.
  if (/^-?[\d.]+,\d{1,2}$/.test(s)) {
    return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  }
  // Entero plano.
  if (/^-?\d+$/.test(s)) {
    return parseFloat(s);
  }
  return null;
}

/**
 * Parsea 'CODE Description [UNIT] $ AMOUNT' -> Concepto, o null.
 * @returns {{codigo:string, descripcion:string, monto:number, columna:string}|null}
 */
function _parseConceptoLine(line) {
  // re.match -> anclado al inicio. El patrón ya incluía '^' y '$'.
  const m = line.trim().match(/^(-?\d{3,6})\s+(.+?)\s+\$\s*(-?[\d.,]+)\s*$/);
  if (!m) {
    return null;
  }
  const code = m[1];
  const rawDesc = m[2].trim();
  const amountStr = m[3];
  // Quita números de unidad/base al final de la descripción (ej. "Jubilación 11,00").
  const desc = rawDesc.replace(/\s+\d{1,3}(?:,\d+)?\s*$/, '').trim();
  const amount = parseMoney(amountStr);
  if (amount === null) {
    return null;
  }
  return { codigo: code, descripcion: desc, monto: amount, columna: '' };
}

// Crea un ReciboEmpleado con los defaults del dataclass del Python.
function _nuevoRecibo(pageNum) {
  return {
    legajo: '',
    nombre: '',
    bruto: null,
    neto: null,
    total_contribuciones: null,
    costo_empleador: null,
    composicion_rem: null,
    composicion_no_rem: null,
    composicion_desc: null,
    conceptos: [],
    contribuciones: [],
    porcentajes_torta: [],
    // Una entrada por recibo con gráfico de torta. Un empleado puede tener VARIOS recibos en
    // el mismo PDF (el del mes más los ajustes de meses anteriores), y cada uno trae su propia
    // torta que debe sumar ~100%. Acumular todos los porcentajes en una sola lista daba
    // N×100% y disparaba un TORTA_NO_SUMA falso.
    tortas: [],
    // Códigos que aparecen DOS VECES en la misma página del recibo: eso es un recibo mal
    // armado. Se detecta acá porque los conceptos de varios recibos del mismo empleado se
    // consolidan después (_consolidarPorCodigo) y ahí ya no se distingue un duplicado real
    // de un mismo concepto que viene en dos recibos distintos.
    codigos_duplicados: [],
    paginas: [pageNum],
    n_paginas: 1,
    errores_parse: [],
  };
}

/**
 * Parsea una página (texto) -> ReciboEmpleado o null.
 */
function _parsePage(text, pageNum) {
  const lines = text.split('\n').map((ln) => ln.trim());

  const rp = _nuevoRecibo(pageNum);

  // Máquina de estados.
  let state = 'HEADER';

  for (const line of lines) {
    if (!line) {
      continue;
    }

    // --- HEADER: busca legajo + nombre + bruto ---
    if (state === 'HEADER') {
      // El legajo no tiene largo fijo: hay clientes con 3-4 dígitos, otros con legajos
      // largos (7+, ej. los del padrón de la empresa usuaria) y otros que numeran desde 1
      // (legajos de 1 y 2 dígitos). Cualquier mínimo o máximo hacía que el header NO
      // matcheara y la página entera se descartara por "no se detectó legajo" -> el recibo
      // quedaba SIN_PAR contra la liquidación. Lo que delimita el legajo no es su largo sino
      // la posición: en la fila 'MES AÑO APELLIDO Y NOMBRE LEGAJO SUELDO BRUTO' es el número
      // que va pegado antes del importe del bruto ('$ ...'), y eso es lo que exige el patrón.
      const reHeader = new RegExp(
        MESES + '\\s+\\d{4}\\s+(.+?)\\s+(\\d{1,12})\\s+\\$\\s*([\\d.,]+)'
      );
      const m = line.match(reHeader);
      if (m) {
        rp.nombre = m[1].trim();
        // Normalizar legajo igual que la liquidación (sin ceros a la
        // izquierda) para que '0826' (recibo) matchee '826' (liqui).
        rp.legajo = m[2].trim().replace(/^0+/, '') || '0';
        state = 'PRE_CONTRIB';
        continue;
      }
    }

    // --- COSTO TOTAL EMPLEADOR (puede aparecer en cualquier lugar antes de contribuciones) ---
    if (state === 'HEADER' || state === 'PRE_CONTRIB' || state === 'CONTRIB') {
      const m = line.match(/COSTO TOTAL EMPLEADOR\s+\$\s*([\d.,]+)/);
      if (m) {
        rp.costo_empleador = parseMoney(m[1]);
      }
    }

    // --- Inicio del primer bloque CONCEPTO = sección de contribuciones ---
    if (state === 'PRE_CONTRIB' && line === 'CONCEPTO UNIDAD BASE MONTO') {
      state = 'CONTRIB';
      continue;
    }

    if (state === 'CONTRIB') {
      const m = line.match(/SUB TOTAL CONTRIBUCIONES EMPLEADOR\s+\$\s*([\d.,]+)/);
      if (m) {
        rp.total_contribuciones = parseMoney(m[1]);
        state = 'PRE_CONCEPTOS';
        continue;
      }
      const c = _parseConceptoLine(line);
      if (c) {
        rp.contribuciones.push(c);
      }
    }

    // --- Entre contribuciones y conceptos: obtener SUELDO BRUTO ---
    if (state === 'PRE_CONCEPTOS') {
      const m = line.match(/^SUELDO BRUTO\s+\$\s*([\d.,]+)/);
      if (m) {
        rp.bruto = parseMoney(m[1]);
        continue;
      }
      if (line === 'CONCEPTO UNIDAD BASE MONTO') {
        state = 'CONCEPTOS';
        continue;
      }
    }

    // --- Sección Haberes / Descuentos ---
    if (state === 'CONCEPTOS') {
      // COMPOSICION SALARIAL marca el fin de los conceptos.
      const m = line.match(
        /Remunerativo:\s*\$\s*([\d,.]+)\s+No Remunerativo:\s*\$\s*([\d,.]+)\s+Descuentos:\s*\$\s*([\d,.]+)/
      );
      if (m) {
        rp.composicion_rem = parseMoney(m[1]);
        rp.composicion_no_rem = parseMoney(m[2]);
        rp.composicion_desc = parseMoney(m[3]);
        state = 'POST_CONCEPTOS';
        continue;
      }
      const c = _parseConceptoLine(line);
      if (c) {
        rp.conceptos.push(c);
      }
    }

    // --- Después de COMPOSICION SALARIAL: buscar SUELDO NETO ---
    if (state === 'POST_CONCEPTOS') {
      const m = line.match(/^SUELDO NETO\s+\$\s*([\d.,]+)/);
      if (m) {
        rp.neto = parseMoney(m[1]);
        state = 'PIE';
        continue;
      }
    }

    // --- Porcentajes del gráfico de torta ---
    if (state === 'PIE') {
      // El separador decimal del porcentaje varía según la plantilla del recibo:
      // '1.27%' (US) o '1,27%' (AR). Aceptamos ambos y normalizamos a punto.
      const matches = line.matchAll(/(\d{1,2}[.,]\d{2})%/g);
      for (const pct of matches) {
        rp.porcentajes_torta.push(parseFloat(pct[1].replace(',', '.')));
      }
    }
  }

  if (!rp.legajo) {
    rp.errores_parse.push(`Página ${pageNum}: no se detectó legajo`);
    return null;
  }

  // La torta de esta página es una unidad: se guarda aparte para poder validarla sola
  // cuando el empleado tiene más de un recibo.
  if (rp.porcentajes_torta.length) {
    rp.tortas.push(rp.porcentajes_torta.slice());
  }

  // Códigos repetidos dentro de esta misma página (ver el comentario del campo).
  const vistos = new Set();
  for (const c of rp.conceptos) {
    if (vistos.has(c.codigo)) {
      rp.codigos_duplicados.push({ codigo: c.codigo, descripcion: c.descripcion });
    } else {
      vistos.add(c.codigo);
    }
  }

  return rp;
}

// Rótulos que delatan que una página SIN encabezado es la CONTINUACIÓN del recibo
// anterior, y no una página ajena. Hay plantillas que parten el recibo en dos hojas:
// los conceptos en la primera y los totales + la torta en la segunda, que ya no repite
// la fila 'MES AÑO APELLIDO Y NOMBRE LEGAJO'.
const _MARCAS_CONTINUACION = [
  'COMPOSICION SALARIAL',
  'SUELDO NETO',
  'Detalle composición laboral',
  'Firma del Empleado',
];

function _esContinuacion(text) {
  return _MARCAS_CONTINUACION.some((m) => text.includes(m));
}

/**
 * Extrae de una página sin encabezado lo que se pueda atribuir al recibo anterior.
 * A diferencia de _parsePage no exige legajo y no interpreta líneas de concepto: en una
 * continuación no hay forma segura de saber si una línea suelta es haber o contribución,
 * así que se toman sólo los datos rotulados, que son inequívocos.
 */
function _parseContinuacion(text) {
  const out = {
    neto: null,
    composicion_rem: null,
    composicion_no_rem: null,
    composicion_desc: null,
    porcentajes_torta: [],
  };
  let enPie = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const mComp = line.match(
      /Remunerativo:\s*\$\s*([\d,.]+)\s+No Remunerativo:\s*\$\s*([\d,.]+)\s+Descuentos:\s*\$\s*([\d,.]+)/
    );
    if (mComp) {
      out.composicion_rem = parseMoney(mComp[1]);
      out.composicion_no_rem = parseMoney(mComp[2]);
      out.composicion_desc = parseMoney(mComp[3]);
      continue;
    }
    const mNeto = line.match(/^SUELDO NETO\s+\$\s*([\d.,]+)/);
    if (mNeto) {
      out.neto = parseMoney(mNeto[1]);
      enPie = true;
      continue;
    }
    // Los porcentajes de la torta se cuentan sólo después del neto, igual que en
    // _parsePage (estado PIE), para no confundirlos con alícuotas de los conceptos.
    if (enPie) {
      for (const pct of line.matchAll(/(\d{1,2}[.,]\d{2})%/g)) {
        out.porcentajes_torta.push(parseFloat(pct[1].replace(',', '.')));
      }
    }
  }
  return out;
}

/**
 * Vuelca una continuación sobre el recibo anterior. NO suma: una continuación es la
 * segunda hoja del MISMO recibo, así que sólo completa lo que falta. (Sumar es correcto
 * para un empleado con dos recibos distintos — eso lo hace _mergePages.)
 */
function _mergeContinuacion(base, cont, pageNum) {
  for (const f of ['neto', 'composicion_rem', 'composicion_no_rem', 'composicion_desc']) {
    if (base[f] === null && cont[f] !== null) {
      base[f] = cont[f];
    }
  }
  if (!base.porcentajes_torta.length) {
    base.porcentajes_torta.push(...cont.porcentajes_torta);
    // Es la MISMA torta del recibo anterior (venía cortada en la hoja siguiente), no una nueva.
    if (cont.porcentajes_torta.length) {
      base.tortas.push(cont.porcentajes_torta.slice());
    }
  }
  base.paginas.push(pageNum);
  base.n_paginas += 1;
}

/**
 * Junta en una sola lista los conceptos que comparten código, sumando los importes.
 * Un empleado puede tener varios recibos en el mismo PDF (el del mes y los ajustes de meses
 * anteriores) y el mismo concepto aparece en más de uno. La liquidación ya viene consolidada
 * así (ver _consolidate en parser-liquidacion-pdf), de modo que sin esto el validador comparaba
 * el total de la liquidación contra el importe de UN solo recibo: daba MONTO_DIFIERE en casi
 * todos los conceptos y un CONCEPTO_DUPLICADO por cada código repetido, siendo que la suma
 * cierra peso a peso. Un código repetido DENTRO de una misma página sigue reportándose como
 * duplicado (ahí sí es un recibo mal armado): eso se detecta antes, en _parsePage, y viaja en
 * `codigos_duplicados`.
 */
function _consolidarPorCodigo(items) {
  const merged = new Map();
  for (const c of items) {
    const prev = merged.get(c.codigo);
    if (prev) {
      merged.set(c.codigo, { ...prev, monto: _round2(prev.monto + c.monto) });
    } else {
      merged.set(c.codigo, { ...c });
    }
  }
  return Array.from(merged.values());
}

/**
 * Suma los datos de la página extra dentro de base (empleados con más de un recibo).
 */
function _mergePages(base, extra) {
  base.conceptos = _consolidarPorCodigo([...base.conceptos, ...extra.conceptos]);
  base.contribuciones = _consolidarPorCodigo([...base.contribuciones, ...extra.contribuciones]);
  base.paginas.push(...extra.paginas);
  base.n_paginas += 1;
  base.porcentajes_torta.push(...extra.porcentajes_torta);
  base.tortas.push(...extra.tortas);
  base.codigos_duplicados.push(...extra.codigos_duplicados);

  for (const field of ['bruto', 'neto', 'total_contribuciones', 'costo_empleador']) {
    const bv = base[field];
    const ev = extra[field];
    if (bv !== null && ev !== null) {
      base[field] = _round2(bv + ev);
    } else if (ev !== null) {
      base[field] = ev;
    }
  }

  for (const field of ['composicion_rem', 'composicion_no_rem', 'composicion_desc']) {
    const bv = base[field];
    const ev = extra[field];
    if (bv !== null && ev !== null) {
      base[field] = _round2(bv + ev);
    } else if (ev !== null) {
      base[field] = ev;
    }
  }
}

/**
 * Parsea uno o más PDFs de recibos. Devuelve un objeto-mapa indexado por legajo.
 *
 * @param {string[][]} pagesByFile - un array por archivo PDF, con el texto de
 *   cada página (string) en orden.
 * @returns {Object<string, Object>} mapa { [legajo]: ReciboEmpleado }
 */
export function parseRecibos(pagesByFile) {
  const results = {};

  for (const pages of pagesByFile) {
    // page_num arranca en 1 por cada archivo (igual que enumerate(pdf.pages, 1)).
    let pageNum = 0;
    let ultimoLegajo = null;  // para atribuirle las páginas de continuación
    for (const page of pages) {
      pageNum += 1;
      const text = page || '';
      const rp = _parsePage(text, pageNum);
      if (rp === null) {
        // Sin encabezado. Si trae los rótulos del pie del recibo, es la segunda hoja
        // del recibo anterior: hay que volcarla, no descartarla (si se descarta se
        // pierden el neto y los descuentos, y el validador los reporta como N/D).
        if (ultimoLegajo !== null && _esContinuacion(text)) {
          _mergeContinuacion(results[ultimoLegajo], _parseContinuacion(text), pageNum);
        }
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(results, rp.legajo)) {
        _mergePages(results[rp.legajo], rp);
      } else {
        results[rp.legajo] = rp;
      }
      ultimoLegajo = rp.legajo;
    }
  }

  return results;
}
