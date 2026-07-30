// Logica de validacion cruzada: liquidacion vs recibos.
// Traduccion fiel de src/validador.py a ESM. Sin dependencias de DOM/window:
// importable tanto en Node (ESM) como en navegador (<script type="module">).

// Tolerancia para comparacion de conceptos individuales (±$0.01)
const TOLS_CONCEPTO = 0.01;
// Tolerancia para comparaciones de totales (±$1.00 cubre redondeos acumulados)
const TOL_TOTAL = 1.0;
// Tolerancia para suma del grafico de torta (±1 punto porcentual)
const TOL_TORTA = 1.0;

// Codigos de conceptos de contribucion (validados solo por total, no linea por linea).
// Codigos 6050-6999 y 7015 son contribuciones patronales del encabezado del recibo.
// _CONTRIB_RANGE = range(6050, 7100) en Python => enteros 6050..7099 inclusive.
const _CONTRIB_MIN = 6050;
const _CONTRIB_MAX = 7099; // range(6050, 7100) -> ultimo valor 7099

function _enContribRange(n) {
  return n >= _CONTRIB_MIN && n <= _CONTRIB_MAX;
}

function _is_contrib(codigo) {
  // Replica int(codigo.lstrip('-')) in _CONTRIB_RANGE con manejo de ValueError.
  // lstrip('-') elimina los guiones del inicio; el resto debe ser entero valido.
  const s = String(codigo).replace(/^-+/, '');
  // Python int() acepta espacios alrededor y signo opcional; tras lstrip('-')
  // no quedan guiones iniciales. Reproducimos un parseo estricto de entero.
  const trimmed = s.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    return false; // ValueError -> False
  }
  const n = parseInt(trimmed, 10);
  if (Number.isNaN(n)) {
    return false;
  }
  return _enContribRange(n);
}

// Formatea un monto al estilo AR '1.234.567,89'. Replica _fmt de Python.
// Devuelve 'N/D' cuando el valor es null/undefined (None en Python).
export function _fmt(v) {
  if (v === null || v === undefined) {
    return 'N/D';
  }
  // Python: f'{v:,.2f}'.replace(',', 'X').replace('.', ',').replace('X', '.')
  // f'{v:,.2f}' produce separador de miles ',' y decimal '.', con 2 decimales.
  const usFmt = _formatThousandsUS(v);
  return usFmt.replace(/,/g, 'X').replace(/\./g, ',').replace(/X/g, '.');
}

// Reproduce f'{v:,.2f}' de Python: 2 decimales, separador de miles ',' y
// decimal '.'. Maneja el signo negativo igual que Python (signo al frente).
function _formatThousandsUS(v) {
  const neg = v < 0;
  const abs = Math.abs(v);
  const fixed = abs.toFixed(2); // redondeo a 2 decimales
  const [intPart, decPart] = fixed.split('.');
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + withSep + '.' + decPart;
}

// round() de Python (banker's rounding) vs Math.round de JS difieren en .5,
// pero el Python original usa round(x, 2) sobre diferencias de floats donde el
// caso .5 exacto es practicamente inexistente. Replicamos round(x, 2) con un
// redondeo a 2 decimales estandar (suficiente para la logica de tolerancias).
function _round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function _diff_ok(a, b, tol) {
  if (a === null || a === undefined || b === null || b === undefined) {
    return false;
  }
  return Math.abs(a - b) <= tol;
}

// Tipos de hallazgo que NO invalidan el recibo: son advertencias para revisión humana.
const _TIPOS_ADVERTENCIA = new Set(['TORTA_NO_SUMA', 'LEGAJO_DIFIERE']);

function _crearResultado({
  legajo = '',
  legajo_recibo = '',
  nombre_liqui = '',
  nombre_recibo = '',
  resultado = 'OK',
  match_via = 'legajo',
  n_bloques_liqui = 1,
  n_paginas_recibo = 1,
} = {}) {
  return {
    legajo,
    // Legajo con el que figura el empleado en el recibo. Coincide con `legajo`
    // salvo cuando el par se armó por nombre (ver _emparejar).
    legajo_recibo: legajo_recibo || legajo,
    nombre_liqui,
    nombre_recibo,
    resultado,
    match_via,
    hallazgos: [],
    n_bloques_liqui,
    n_paginas_recibo,
  };
}

function _crearHallazgo({
  tipo,
  mensaje,
  codigo = '',
  descripcion = '',
  monto_liqui = null,
  monto_recibo = null,
  diferencia = null,
}) {
  return { tipo, mensaje, codigo, descripcion, monto_liqui, monto_recibo, diferencia };
}

function _validar_empleado(liqui, recibo, match_via = 'legajo') {
  const resultado = _crearResultado({
    legajo: liqui.legajo,
    legajo_recibo: recibo.legajo,
    nombre_liqui: liqui.nombre,
    nombre_recibo: recibo.nombre,
    match_via,
    n_bloques_liqui: liqui.n_bloques,
    n_paginas_recibo: recibo.n_paginas,
  });
  const hallazgos = resultado.hallazgos;

  // Construir lookup de conceptos del recibo (no-contribucion) por codigo.
  const recibo_conceptos = {};
  for (const c of recibo.conceptos) {
    if (Object.prototype.hasOwnProperty.call(recibo_conceptos, c.codigo)) {
      hallazgos.push(_crearHallazgo({
        tipo: 'CONCEPTO_DUPLICADO',
        mensaje: `Recibo: código ${c.codigo} (${c.descripcion}) duplicado`,
        codigo: c.codigo,
        descripcion: c.descripcion,
      }));
    } else {
      recibo_conceptos[c.codigo] = c;
    }
  }

  // Lookup de la seccion patronal del recibo (lo que esta arriba del
  // 'SUB TOTAL CONTRIBUCIONES EMPLEADOR'). Se usa solo como respaldo: hay conceptos
  // que la liquidacion lista en la columna CONTRIBUCIONES con un codigo FUERA del
  // rango 6050-7099 (ej. 1033 Seguro Obligatorio / SCVO) y que en el recibo aparecen
  // en el bloque del empleador, no entre los haberes. Sin este respaldo se reportaban
  // como CONCEPTO_FALTANTE aunque estan en el recibo con el importe correcto.
  const recibo_contribs = {};
  for (const c of recibo.contribuciones) {
    if (!Object.prototype.hasOwnProperty.call(recibo_contribs, c.codigo)) {
      recibo_contribs[c.codigo] = c;
    }
  }

  // --- 1. Verificar que cada concepto de liquidacion exista en el recibo ---
  for (const c of liqui.conceptos) {
    // Saltear conceptos del rango de contribucion (validados por total).
    // Tambien se saltean los marcados explicitamente columna='CONTRIB': el parser
    // de Excel marca asi las contribuciones/provisiones (a la derecha del NETO),
    // que pueden tener codigos fuera del rango 6050-7099 (ej. provisiones 3570).
    // En la ruta PDF columna es siempre '' => esta condicion no altera su resultado.
    if (_is_contrib(c.codigo) || c.columna === 'CONTRIB') {
      continue;
    }

    let rc = Object.prototype.hasOwnProperty.call(recibo_conceptos, c.codigo)
      ? recibo_conceptos[c.codigo]
      : undefined;
    let enSeccionPatronal = false;
    if (rc === undefined &&
        Object.prototype.hasOwnProperty.call(recibo_contribs, c.codigo)) {
      rc = recibo_contribs[c.codigo];
      enSeccionPatronal = true;
    }
    if (rc === undefined) {
      hallazgos.push(_crearHallazgo({
        tipo: 'CONCEPTO_FALTANTE',
        mensaje: `Código ${c.codigo} (${c.descripcion}) en liquidación [${c.columna}] ` +
          `no encontrado en recibo. Monto: $${_fmt(c.monto)}`,
        codigo: c.codigo,
        descripcion: c.descripcion,
        monto_liqui: c.monto,
      }));
    } else {
      // El recibo muestra los descuentos en negativo y la liquidacion los
      // lista como magnitud. La diferencia de signo es convencion de
      // presentacion, no una diferencia de monto: comparamos por valor absoluto.
      const monto_recibo_abs = Math.abs(rc.monto);
      if (!_diff_ok(c.monto, monto_recibo_abs, TOLS_CONCEPTO)) {
        const diff = _round2(c.monto - monto_recibo_abs);
        const donde = enSeccionPatronal ? ' [en la sección del empleador del recibo]' : '';
        hallazgos.push(_crearHallazgo({
          tipo: 'MONTO_DIFIERE',
          mensaje: `Código ${c.codigo} (${c.descripcion})${donde}: ` +
            `liquidación $${_fmt(c.monto)} ≠ recibo $${_fmt(monto_recibo_abs)} ` +
            `(dif $${_fmt(diff)})`,
          codigo: c.codigo,
          descripcion: c.descripcion,
          monto_liqui: c.monto,
          monto_recibo: monto_recibo_abs,
          diferencia: diff,
        }));
      }
    }
  }

  // --- 2. Verificar totales ---
  const _check_total = (label, lv, rv) => {
    const lvNull = lv === null || lv === undefined;
    const rvNull = rv === null || rv === undefined;
    if (lvNull && rvNull) {
      return;
    }
    if (lvNull || rvNull) {
      hallazgos.push(_crearHallazgo({
        tipo: 'TOTAL_DIFIERE',
        mensaje: `${label}: liquidación=${_fmt(lv)} recibo=${_fmt(rv)} (uno es N/D)`,
      }));
      return;
    }
    if (!_diff_ok(lv, rv, TOL_TOTAL)) {
      const diff = _round2(lv - rv);
      hallazgos.push(_crearHallazgo({
        tipo: 'TOTAL_DIFIERE',
        mensaje: `${label}: liquidación $${_fmt(lv)} ≠ recibo $${_fmt(rv)} (dif $${_fmt(diff)})`,
        diferencia: diff,
      }));
    }
  };

  _check_total('Neto', liqui.neto, recibo.neto);
  _check_total('Bruto', liqui.bruto, recibo.bruto);
  _check_total('Total Descuentos', liqui.total_desc, recibo.composicion_desc);
  _check_total('Total Contribuciones', liqui.total_contrib, recibo.total_contribuciones);

  // Costo Laboral = Bruto + Contribuciones
  if (recibo.bruto !== null && recibo.bruto !== undefined &&
      recibo.total_contribuciones !== null && recibo.total_contribuciones !== undefined) {
    const costo_calc = _round2(recibo.bruto + recibo.total_contribuciones);
    if (recibo.costo_empleador !== null && recibo.costo_empleador !== undefined &&
        !_diff_ok(costo_calc, recibo.costo_empleador, TOL_TOTAL)) {
      const diff = _round2(costo_calc - recibo.costo_empleador);
      hallazgos.push(_crearHallazgo({
        tipo: 'TOTAL_DIFIERE',
        mensaje: `Costo Laboral recibo: Bruto+Contrib=$${_fmt(costo_calc)} ≠ ` +
          `impreso=$${_fmt(recibo.costo_empleador)} (dif=$${_fmt(diff)})`,
        diferencia: diff,
      }));
    }
  }

  // --- 3. Validacion de suma del grafico de torta (por pagina del recibo) ---
  // Cuando el bruto es 0 no hay nada que repartir: el recibo imprime todas las porciones
  // en 0,00% y la suma da 0 legitimamente. Pasa con empleados de licencia sin goce, donde
  // el descuento cancela los haberes y solo quedan contribuciones patronales. Exigir ~100%
  // ahi es un falso positivo. Se pide que se cumplan LAS DOS condiciones (suma 0 y bruto 0)
  // para no perder el chequeo cuando el bruto es real y la torta igual da 0.
  const _tortaVacia = (recibo.bruto === 0 || recibo.bruto === null || recibo.bruto === undefined);
  if (recibo.porcentajes_torta && recibo.porcentajes_torta.length > 0 &&
      !(_tortaVacia && _round2(recibo.porcentajes_torta.reduce((a, b) => a + b, 0)) === 0)) {
    const total_pct = _round2(recibo.porcentajes_torta.reduce((a, b) => a + b, 0));
    if (Math.abs(total_pct - 100.0) > TOL_TORTA) {
      hallazgos.push(_crearHallazgo({
        tipo: 'TORTA_NO_SUMA',
        mensaje: `Gráfico de torta: suma de porcentajes = ${total_pct}% (esperado ~100%)`,
        diferencia: _round2(total_pct - 100.0),
      }));
    }
  }

  // --- 4. Chequeos de consistencia interna ---
  // Neto = Bruto - Descuentos (del recibo)
  if (recibo.bruto !== null && recibo.bruto !== undefined &&
      recibo.composicion_desc !== null && recibo.composicion_desc !== undefined &&
      recibo.neto !== null && recibo.neto !== undefined) {
    const neto_calc = _round2(recibo.bruto - recibo.composicion_desc);
    if (!_diff_ok(neto_calc, recibo.neto, TOL_TOTAL)) {
      const diff = _round2(neto_calc - recibo.neto);
      hallazgos.push(_crearHallazgo({
        tipo: 'TOTAL_DIFIERE',
        mensaje: `Recibo: Bruto-Desc=$${_fmt(neto_calc)} ≠ Neto impreso=$${_fmt(recibo.neto)} ` +
          `(dif=$${_fmt(diff)})`,
        diferencia: diff,
      }));
    }
  }

  // Determinar nivel de resultado general
  const errores = hallazgos.filter((h) => !_TIPOS_ADVERTENCIA.has(h.tipo));
  const advertencias = hallazgos.filter((h) => _TIPOS_ADVERTENCIA.has(h.tipo));

  if (errores.length > 0) {
    resultado.resultado = 'ERROR';
  } else if (advertencias.length > 0) {
    resultado.resultado = 'ADVERTENCIA';
  } else {
    resultado.resultado = 'OK';
  }

  return resultado;
}

// ─────────────── Emparejamiento liquidación ↔ recibo ───────────────
// La regla principal sigue siendo el LEGAJO. Pero hay clientes donde el legajo del
// recibo (el de la empresa de servicios eventuales que emite) no es el mismo que el de
// la liquidación (el del padrón de la empresa usuaria). Para no dejar esos empleados
// como SIN_PAR, cuando un legajo queda huérfano de UN SOLO lado se intenta emparejar
// por apellido y nombre. Es un RESPALDO: nunca reemplaza ni sobrescribe un par por legajo.

// Normaliza un nombre para comparar: sin tildes/diéresis, en mayúsculas, sin puntuación
// (la coma sobra: 'APELLIDO , NOMBRE' vs 'APELLIDO, NOMBRE') y con espacios colapsados.
// Con `ordenado`, además ordena los tokens alfabéticamente, para que 'APELLIDO NOMBRE'
// matchee 'NOMBRE APELLIDO' (los dos formatos aparecen según la plantilla).
export function normNombre(s, ordenado) {
  const t = String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  if (!t) {
    return '';
  }
  return ordenado ? t.split(' ').sort().join(' ') : t;
}

// Largo mínimo del nombre normalizado para aceptar un match por prefijo. Los reportes
// truncan el nombre a un ancho fijo (p. ej. el último nombre llega cortado), así
// que el prefijo es necesario; el mínimo evita emparejar por un apellido corto suelto.
const _MIN_PREFIJO = 12;

// Indexa legajos por nombre normalizado. Sólo devuelve las claves con UN candidato:
// un nombre repetido (homónimos) es ambiguo y en payroll no se adivina.
function _indexUnico(legajos, mapa, ordenado) {
  const porNombre = new Map();
  for (const legajo of legajos) {
    const k = normNombre(mapa[legajo] && mapa[legajo].nombre, ordenado);
    if (!k) {
      continue;
    }
    if (porNombre.has(k)) {
      porNombre.set(k, null); // marcar ambiguo
    } else {
      porNombre.set(k, legajo);
    }
  }
  for (const [k, v] of porNombre) {
    if (v === null) {
      porNombre.delete(k);
    }
  }
  return porNombre;
}

/**
 * Arma los pares liquidación↔recibo.
 * @returns {{pares: Array<{legajoLiqui:string, legajoRecibo:string, via:string}>,
 *            liquiSolo: string[], recibosSolo: string[]}}
 */
function _emparejar(liquidaciones, recibos) {
  const pares = [];
  const liquiLibres = [];
  const recibosLibres = new Set(Object.keys(recibos));

  // --- 1. Por legajo (regla principal) ---
  for (const legajo of Object.keys(liquidaciones)) {
    if (recibosLibres.has(legajo)) {
      pares.push({ legajoLiqui: legajo, legajoRecibo: legajo, via: 'legajo' });
      recibosLibres.delete(legajo);
    } else {
      liquiLibres.push(legajo);
    }
  }

  // --- 2. Por nombre normalizado exacto (tokens ordenados) ---
  const tomarPorNombre = (ordenado) => {
    if (!liquiLibres.length || !recibosLibres.size) {
      return;
    }
    const idxLiqui = _indexUnico(liquiLibres, liquidaciones, ordenado);
    const idxRecibo = _indexUnico(Array.from(recibosLibres), recibos, ordenado);
    for (const [k, legajoLiqui] of idxLiqui) {
      const legajoRecibo = idxRecibo.get(k);
      if (legajoRecibo === undefined || !recibosLibres.has(legajoRecibo)) {
        continue;
      }
      pares.push({ legajoLiqui, legajoRecibo, via: 'nombre' });
      recibosLibres.delete(legajoRecibo);
      liquiLibres.splice(liquiLibres.indexOf(legajoLiqui), 1);
    }
  };
  tomarPorNombre(true);

  // --- 3. Por prefijo (nombres truncados por el ERP) ---
  // Sólo se acepta si el candidato es único en AMBAS direcciones.
  if (liquiLibres.length && recibosLibres.size) {
    const recLista = Array.from(recibosLibres).map((legajo) => ({
      legajo,
      n: normNombre(recibos[legajo] && recibos[legajo].nombre, false),
    })).filter((x) => x.n.length >= _MIN_PREFIJO);

    const candidatos = new Map();  // legajoLiqui -> legajoRecibo (o null si ambiguo)
    const usos = new Map();        // legajoRecibo -> cuántos liqui lo eligieron
    for (const legajoLiqui of liquiLibres) {
      const nl = normNombre(liquidaciones[legajoLiqui].nombre, false);
      if (nl.length < _MIN_PREFIJO) {
        continue;
      }
      const hits = recLista.filter((r) => r.n.startsWith(nl) || nl.startsWith(r.n));
      if (hits.length !== 1) {
        continue; // 0 candidatos, o ambiguo
      }
      candidatos.set(legajoLiqui, hits[0].legajo);
      usos.set(hits[0].legajo, (usos.get(hits[0].legajo) || 0) + 1);
    }
    for (const [legajoLiqui, legajoRecibo] of candidatos) {
      if (usos.get(legajoRecibo) !== 1) {
        continue; // dos liquidaciones apuntan al mismo recibo -> ambiguo
      }
      pares.push({ legajoLiqui, legajoRecibo, via: 'nombre-prefijo' });
      recibosLibres.delete(legajoRecibo);
      liquiLibres.splice(liquiLibres.indexOf(legajoLiqui), 1);
    }
  }

  return { pares, liquiSolo: liquiLibres, recibosSolo: Array.from(recibosLibres) };
}

export function validar(liquidaciones, recibos) {
  // Ejecuta la validacion completa. Devuelve el objeto reporte listo para serializar.
  const { pares, liquiSolo, recibosSolo } = _emparejar(liquidaciones, recibos);

  // Cuando TODOS los pares se armaron por nombre, el legajo distinto no es una anomalia
  // por empleado: es UN solo hecho del lote (la liquidacion usa el padron de la empresa
  // usuaria y el recibo el de la empresa de servicios eventuales). Marcarlo fila por fila
  // convierte la columna de advertencias en ruido y tapa lo que si es excepcional, asi que
  // se informa una vez en el resumen (`emparejamiento`) y la fila solo muestra los dos
  // legajos. Si el emparejamiento por nombre afecta a UNA PARTE del lote, ahi si es raro
  // y cada fila se marca con LEGAJO_DIFIERE para que se revise individualmente.
  const nPorNombre = pares.filter((p) => p.via !== 'legajo').length;
  const _todosPorNombre = pares.length > 0 && nPorNombre === pares.length;

  // Filas ordenadas por legajo (el de liquidacion cuando hay par). Replica el orden
  // lexicografico de Python sorted() sobre strings, igual que la version anterior.
  const filas = [
    ...pares.map((p) => ({ orden: p.legajoLiqui, par: p })),
    ...liquiSolo.map((l) => ({ orden: l, soloLiqui: l })),
    ...recibosSolo.map((r) => ({ orden: r, soloRecibo: r })),
  ];
  filas.sort((a, b) => (a.orden < b.orden ? -1 : a.orden > b.orden ? 1 : 0));

  const resultados = [];
  for (const fila of filas) {
    if (fila.soloRecibo !== undefined) {
      // Recibo sin par en liquidacion
      const legajo = fila.soloRecibo;
      const recibo = recibos[legajo];
      const r = _crearResultado({
        legajo,
        nombre_recibo: recibo ? recibo.nombre : '',
        resultado: 'SIN_PAR',
        match_via: '',
      });
      r.hallazgos.push(_crearHallazgo({
        tipo: 'LEGAJO_SIN_PAR',
        mensaje: `Legajo ${legajo} tiene recibo pero no aparece en la liquidación`,
      }));
      resultados.push(r);
      continue;
    }

    if (fila.soloLiqui !== undefined) {
      const legajo = fila.soloLiqui;
      const r = _crearResultado({
        legajo,
        nombre_liqui: liquidaciones[legajo].nombre,
        resultado: 'SIN_PAR',
        match_via: '',
      });
      r.hallazgos.push(_crearHallazgo({
        tipo: 'LEGAJO_SIN_PAR',
        mensaje: `Legajo ${legajo} aparece en liquidación pero no tiene recibo`,
      }));
      resultados.push(r);
      continue;
    }

    const { legajoLiqui, legajoRecibo, via } = fila.par;
    const r = _validar_empleado(liquidaciones[legajoLiqui], recibos[legajoRecibo], via);
    if (via !== 'legajo' && !_todosPorNombre) {
      // Emparejado por nombre: se deja constancia como ADVERTENCIA para que quede a
      // la vista que el legajo no coincide y que el par lo decidio la herramienta.
      r.hallazgos.push(_crearHallazgo({
        tipo: 'LEGAJO_DIFIERE',
        mensaje: `Emparejado por apellido y nombre: legajo ${legajoLiqui} en liquidación ` +
          `("${liquidaciones[legajoLiqui].nombre}") = legajo ${legajoRecibo} en el recibo ` +
          `("${recibos[legajoRecibo].nombre}")` +
          `${via === 'nombre-prefijo' ? ' — el nombre coincide por prefijo (aparece truncado)' : ''}. ` +
          `Verificar que sea la misma persona.`,
      }));
      // Recalcular el nivel: LEGAJO_DIFIERE es advertencia, no error.
      if (r.resultado === 'OK') {
        r.resultado = 'ADVERTENCIA';
      }
    }
    resultados.push(r);
  }

  // --- Resumen ---
  const n_ok = resultados.filter((r) => r.resultado === 'OK').length;
  const n_error = resultados.filter((r) => r.resultado === 'ERROR').length;
  const n_adv = resultados.filter((r) => r.resultado === 'ADVERTENCIA').length;
  const n_sin_par = resultados.filter((r) => r.resultado === 'SIN_PAR').length;

  const reporte = {
    resumen: {
      // total = empleados distintos en el reporte (union de legajos liqui ∪ recibos)
      total: resultados.length,
      total_empleados_liqui: Object.keys(liquidaciones).length,
      total_empleados_recibos: Object.keys(recibos).length,
      ok: n_ok,
      errores: n_error,
      advertencias: n_adv,
      sin_par: n_sin_par,
      // Como se armaron los pares. `todos_por_nombre` significa que NINGUN par salio por
      // legajo: el lote entero usa numeraciones distintas entre liquidacion y recibo. En ese
      // caso no se marca fila por fila (ver comentario en validar) y la UI lo avisa una vez.
      emparejamiento: {
        por_legajo: pares.length - nPorNombre,
        por_nombre: nPorNombre,
        todos_por_nombre: _todosPorNombre,
      },
    },
    empleados: resultados.map((r) => _resultado_to_dict(r)),
  };

  return reporte;
}

function _resultado_to_dict(r) {
  return {
    legajo: r.legajo,
    legajo_recibo: r.legajo_recibo,
    nombre_liqui: r.nombre_liqui,
    nombre_recibo: r.nombre_recibo,
    resultado: r.resultado,
    match_via: r.match_via,
    n_bloques_liqui: r.n_bloques_liqui,
    n_paginas_recibo: r.n_paginas_recibo,
    hallazgos: r.hallazgos.map((h) => ({
      tipo: h.tipo,
      mensaje: h.mensaje,
      codigo: h.codigo,
      descripcion: h.descripcion,
      monto_liqui: h.monto_liqui,
      monto_recibo: h.monto_recibo,
      diferencia: h.diferencia,
    })),
  };
}
