// generarDatosGrafo.js — ACL Worker
// Umbusk LLC · Auditoría Cívica Liberal
//
// v2 (28 jul 2026): reemplazado el mecanismo de identificación de artículos.
// [... changelog anterior sin cambios, ver versión previa del archivo ...]
//
// v4 (4 ago 2026) — PROMPT EDITABLE DESDE ADMIN:
// generarGrafoConClaude() ahora acepta un cuarto parámetro opcional
// `promptPersonalizado`. Si viene lleno (worker.js lo lee de
// prompts_productos, clave "mapa_articulos"), se usa en vez del texto fijo
// del código. PROMPT_GRAFO se renombra a PROMPT_GRAFO_RESPALDO y queda
// como red de seguridad — mismo patrón exacto que ya usa
// PROMPT_ADMISIBILIDAD_RESPALDO en worker.js: si la tabla está vacía o el
// campo no existe todavía, el comportamiento es idéntico al de hoy.
//
// v5 (9 ago 2026) — PESO POR CRITERIO EN EL GRAFO (tamaño de esfera):
// calcularDatosGrafo() acepta un cuarto parámetro opcional
// `pesosCriterios` — el mismo objeto {id: peso} que ya usa
// generarReportePDF.js. Cada nodo tipo "criterio" ahora trae su propio
// campo `peso` (1 por defecto, igual criterio de siempre) — lo usa
// app/auditoria/[id]/grafo/page.js para calcular el radio de cada esfera.
// La función pesoDeCriterio() que antes vivía escondida dentro de
// calcularResumenHorizontes() se saca a nivel de módulo, para que ambas
// funciones lean el peso de la misma forma exacta, sin duplicar la lógica.
//
// v6 (10 ago 2026) — FIX: primera auditoría real bajo el Test de 40
// criterios (Ley de Reforma de la Ley Orgánica de Hidrocarburos) falló en
// este paso con "respuesta cortada por max_tokens (8000)". Con 40
// criterios en vez de 28, la respuesta que arma el grafo (identificar
// artículos + mapear qué criterio cita cada uno) necesita más espacio.
// Subido a 16000 — mismo patrón ya usado antes en analizarConClaude()
// (worker.js) y generarGuion() (generarGuionPresentacion.js) cuando se
// toparon con este mismo límite.
//
// v6.1 (10 ago 2026) — 16000 TAMPOCO ALCANZÓ: el mismo documento
// (Hidrocarburos — ya conocido en este proyecto como uno de los más
// exigentes, es una ley de reforma con muchos artículos citados) volvió a
// cortar la respuesta, esta vez en 16000. Subido directo a 32000 — el
// mismo tope que ya usa analizarConClaude() para el análisis completo de
// los 40 criterios, el paso más pesado de todo el pipeline. Se prefirió
// saltar a ese techo ya probado en vez de subir a un número intermedio
// que quizás tampoco alcanzara, para no gastar un tercer ciclo de prueba
// con el mismo documento.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// ── SUPERADO (28 jul 2026) — normalizarComponentes() ─────────────────────
const PATRON_ARTICULO  = /^art[íi]culo\s+(\d+)\s*[°ºo]?\s*(\(\s*disposici[oó]n(?:es)?\s+(finales?|transitorias?)[^)]*\))?\s*$/i;
const PATRON_PARAGRAFO = /^par[áa]grafo\s+\S+\s+del\s+art[íi]culo\s+(\d+)\s*[°ºo]?\s*$/i;

function normalizarComponentes(articulosCrudo) {
  if (!articulosCrudo || !articulosCrudo.trim()) return [];
  return articulosCrudo
    .split(';')
    .map(pieza => pieza.trim())
    .filter(Boolean)
    .map(pieza => {
      const matchArticulo = PATRON_ARTICULO.exec(pieza);
      if (matchArticulo) {
        const numero = matchArticulo[1];
        const tipoSeccion = matchArticulo[3];
        const seccion = tipoSeccion
          ? (/^finales?/i.test(tipoSeccion) ? ' (Disposiciones Finales)' : ' (Disposiciones Transitorias)')
          : '';
        return `Art. ${numero}${seccion}`;
      }
      const matchParagrafo = PATRON_PARAGRAFO.exec(pieza);
      if (matchParagrafo) return `Art. ${matchParagrafo[1]}`;
      return null;
    })
    .filter(Boolean)
    .filter((valor, i, arr) => arr.indexOf(valor) === i);
}

function componentesUnicos(datos) {
  const criterios = datos.categorias.flatMap(cat => cat.criterios);
  const set = new Set();
  criterios.forEach(c => normalizarComponentes(c.articulos).forEach(comp => set.add(comp)));
  return [...set];
}

// ── En uso — etiqueta corta para los nodos del grafo ─────────────────────
function etiquetaCortaComponente(componente) {
  const m = /^Art\.\s+(\d+)(?:\s+\(Disposiciones (Transitorias|Finales)\))?$/.exec(componente);
  if (!m) return componente.slice(0, 6);
  const numero = m[1].padStart(2, '0');
  const suf = m[2] ? (m[2] === 'Transitorias' ? 'T' : 'F') : '';
  return `A-${numero}${suf}`;
}

function extraerTextoRespuestaLocal(response) {
  const bloqueTexto = response.content.find(b => b.type === 'text');
  if (!bloqueTexto) {
    throw new Error('generarDatosGrafo: la respuesta de Claude no incluyó ningún bloque de texto');
  }
  return bloqueTexto.text;
}

// ── SUPERADO (28 jul 2026) — generarTitulosArticulos() ────────────────────
const SCHEMA_TITULOS_ARTICULOS = {
  type: 'object',
  properties: {
    articulos: {
      type: 'array',
      description: 'Un título corto para cada artículo de la lista dada.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'El identificador exactamente como fue dado (ej. "Art. 63", "Art. 64 (Disposiciones Finales)").' },
          titulo: { type: 'string', description: 'Título corto (6 a 10 palabras) de qué establece este artículo específico, en lenguaje llano, basado en el texto real del documento.' },
        },
        required: ['id', 'titulo'],
        additionalProperties: false,
      },
    },
  },
  required: ['articulos'],
  additionalProperties: false,
};

async function generarTitulosArticulos(textoPDF, articulosUnicos, auditoria_id = 'N/A') {
  if (!articulosUnicos || articulosUnicos.length === 0) return {};

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const listaTexto = articulosUnicos.map(a => `- ${a}`).join('\n');

  const prompt = `Eres un asistente que resume artículos legales para el grafo visual de una auditoría cívica liberal (liberalmente.app).

A continuación tienes el texto completo de un documento normativo y una lista de artículos específicos de ESE documento que fueron citados en el análisis. Para cada uno, escribe un título corto (6 a 10 palabras) que resuma en lenguaje llano qué establece ese artículo específico, basándote en el texto real del documento — no inventes ni generalices.

Nota sobre los identificadores: cuando un artículo trae la anotación "(Disposiciones Finales)" o "(Disposiciones Transitorias)", es un artículo dentro de esa sección específica del documento (que suele tener su propia numeración, distinta del cuerpo principal) — resume el artículo de esa sección, no el del cuerpo principal que comparta el mismo número.

ARTÍCULOS A TITULAR:
${listaTexto}

TEXTO DEL DOCUMENTO:
${textoPDF}

Responde con un título por cada artículo de la lista, usando exactamente el mismo identificador que se te dio.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
    output_config: {
      format: { type: 'json_schema', schema: SCHEMA_TITULOS_ARTICULOS },
    },
  });

  if (response.stop_reason === 'max_tokens') {
    throw new Error(`generarTitulosArticulos [${auditoria_id}]: respuesta cortada por max_tokens (4000) — subir el límite.`);
  }
  if (response.stop_reason === 'refusal') {
    throw new Error(`generarTitulosArticulos [${auditoria_id}]: Claude rehusó generar los títulos (stop_reason: refusal).`);
  }

  const textoRespuesta = extraerTextoRespuestaLocal(response);
  const datos = JSON.parse(textoRespuesta);

  const mapa = {};
  datos.articulos.forEach(a => { mapa[a.id] = a.titulo; });

  const faltantes = articulosUnicos.filter(a => !mapa[a]);
  if (faltantes.length > 0) {
    console.warn(`   ⚠️ [${auditoria_id}] generarTitulosArticulos: faltaron títulos para: ${faltantes.join(', ')}`);
  }

  return mapa;
}

// ── EN USO — identificación, clasificación y citas ───────────────────────
// FIX (4 ago 2026): PROMPT_GRAFO renombrado a PROMPT_GRAFO_RESPALDO — sigue
// siendo el texto por defecto si prompts_productos no tiene todavía la
// clave "mapa_articulos", pero ahora generarGrafoConClaude() puede recibir
// un texto personalizado desde /admin/productos-comunicacionales.
const SCHEMA_GRAFO = {
  type: 'object',
  properties: {
    articulos: {
      type: 'array',
      description: 'Cada artículo, numeral fusionado con su padre, o disposición (Final/Transitoria) real de ESTE documento que fue citado en al menos un criterio del análisis.',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Identificador corto, ej. "Art. 7" o "Art. 64 (Disposiciones Finales)". Siempre el número DE ESTE documento, nunca el de una ley externa que mencione.',
          },
          titulo: {
            type: 'string',
            description: 'Título corto (6-10 palabras) de qué establece este artículo, en lenguaje llano, basado en el texto real del documento. Si accion no es "ninguna", el título debe reflejarlo explícitamente (ej. "Modifica el artículo 14 sobre requisitos de contratos", "Suprime el artículo 13").',
          },
          accion: {
            type: 'string',
            enum: ['modifica', 'suprime', 'agrega', 'ninguna'],
            description: '"modifica" si reforma un artículo de una ley ya vigente, "suprime" si lo elimina por completo, "agrega" si introduce contenido nuevo sin artículo previo equivalente, "ninguna" si el documento no es una reforma o este artículo en particular no cambia nada de otra ley (ej. un artículo de cierre o vigencia).',
          },
          articulo_referido: {
            type: 'string',
            description: 'Si accion es "modifica" o "suprime", el número del artículo de la ley vigente afectado (ej. "14"). Cadena vacía en cualquier otro caso.',
          },
        },
        required: ['id', 'titulo', 'accion', 'articulo_referido'],
        additionalProperties: false,
      },
    },
    citas: {
      type: 'array',
      description: 'Para cada criterio de la lista dada, qué artículos (de los identificados arriba) lo respaldan. Un criterio puede no citar ningún artículo real — en ese caso su lista queda vacía, es información real (ej. si solo citaba la Exposición de Motivos o una ley externa), no un caso a corregir.',
      items: {
        type: 'object',
        properties: {
          criterio_id: { type: 'string', description: 'Exactamente como se dio en la lista de criterios, ej. "C-04".' },
          articulos_citados: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids de la lista "articulos" de arriba que este criterio cita. Arreglo vacío si no cita ninguno.',
          },
        },
        required: ['criterio_id', 'articulos_citados'],
        additionalProperties: false,
      },
    },
  },
  required: ['articulos', 'citas'],
  additionalProperties: false,
};

const PROMPT_GRAFO_RESPALDO = `Eres un asistente que prepara los datos de un grafo visual para una auditoría cívica liberal (liberalmente.app). Tu tarea tiene dos partes: identificar los artículos reales de ESTE documento que fueron citados en el análisis, y mapear qué criterios cita cada uno.

REGLA 1 — Qué SÍ es un artículo real de este documento:
Un artículo, o una disposición (Final o Transitoria) del propio documento que se está auditando. Usa como id "Art. N" (ej. "Art. 7"), o "Art. N (Disposiciones Finales)" / "Art. N (Disposiciones Transitorias)" si la disposición pertenece a esa sección específica — esas secciones suelen reiniciar su propia numeración, así que "Art. 64 (Disposiciones Finales)" y "Art. 64 (Disposiciones Transitorias)" son DOS artículos distintos que comparten número, no se fusionan entre sí.

REGLA 2 — Qué NO es un artículo (no le asignes id, no aparece en la lista):
- La Exposición de Motivos (es el preámbulo explicativo, no establece reglas de juego).
- Citas a leyes o artículos externos a este documento (ej. "artículo 82 de la Constitución").

REGLA 3 — Numerales: si una cita menciona un numeral específico de un artículo (ej. "numeral 8"), el nodo sigue siendo el artículo completo — el numeral es contexto para escribir mejor el título, nunca crea un nodo aparte.

REGLA 4 — Leyes de reforma: si el documento modifica, suprime o agrega artículos a una ley ya vigente, el id del nodo es SIEMPRE el número del artículo DE ESTE documento de reforma — nunca el número del artículo de la ley vigente que menciona (ese va en "articulo_referido"). Marca "accion" y "articulo_referido" según corresponda para cada artículo. Si el documento no es una reforma de nada, todos los artículos llevan accion "ninguna" y articulo_referido vacío.

Para cada artículo real identificado, escribe un título corto (6 a 10 palabras) que resuma en lenguaje llano qué establece, basándote en el texto real del documento — no inventes ni generalices. Si accion no es "ninguna", el título debe decirlo explícitamente.

Luego, para cada criterio de la lista de abajo, indica cuáles de los artículos que identificaste lo respaldan, usando exactamente los mismos ids que les asignaste arriba.`;

async function generarGrafoConClaude(textoPDF, datos, auditoria_id = 'N/A', promptPersonalizado = null) {
  const criterios = datos.categorias.flatMap(cat => cat.criterios);

  const citasCrudas = criterios
    .map(c => `${c.id}: "${(c.articulos || '').trim()}"`)
    .join('\n');

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const promptBase = (promptPersonalizado && promptPersonalizado.trim())
    ? promptPersonalizado.trim()
    : PROMPT_GRAFO_RESPALDO;

  const prompt = `${promptBase}

TEXTO COMPLETO DEL DOCUMENTO:
${textoPDF}

CITAS ORIGINALES POR CRITERIO (tal como las escribió el análisis — pueden mencionar artículos de este documento, la Exposición de Motivos, o leyes externas):
${citasCrudas}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 32000,
    messages: [{ role: 'user', content: prompt }],
    output_config: {
      format: { type: 'json_schema', schema: SCHEMA_GRAFO },
    },
  });

  if (response.stop_reason === 'max_tokens') {
    throw new Error(`generarGrafoConClaude [${auditoria_id}]: respuesta cortada por max_tokens (32000) — subir el límite.`);
  }
  if (response.stop_reason === 'refusal') {
    throw new Error(`generarGrafoConClaude [${auditoria_id}]: Claude rehusó generar el grafo (stop_reason: refusal).`);
  }

  const textoRespuesta = extraerTextoRespuestaLocal(response);
  const resultado = JSON.parse(textoRespuesta);

  const idsConCita = new Set(resultado.citas.map(c => c.criterio_id));
  const faltantes = criterios.map(c => c.id).filter(id => !idsConCita.has(id));
  if (faltantes.length > 0) {
    console.warn(`   ⚠️ [${auditoria_id}] generarGrafoConClaude: faltó mapeo de citas para: ${faltantes.join(', ')} (quedarán sin artículos citados)`);
  }

  return resultado;
}

// ── Peso de un criterio — compartido entre calcularDatosGrafo() y
// calcularResumenHorizontes(), para que ambas lo lean exactamente igual.
// Nuevo 9 ago 2026 (v5) — antes vivía escondida solo dentro de
// calcularResumenHorizontes(). Acepta también el formato enriquecido
// {peso, descalificador} de la etapa intermedia (31 jul-9 ago 2026) por
// compatibilidad con datos ya guardados; el campo descalificador, si
// existe, se ignora — mismo criterio que generarReportePDF.js v4.6.
function pesoDeCriterio(criterioId, pesosCriterios) {
  const valor = pesosCriterios ? pesosCriterios[criterioId] : undefined;
  if (valor && typeof valor === 'object') {
    const numero = Number(valor.peso);
    return (valor.peso !== undefined && !Number.isNaN(numero)) ? numero : 1;
  }
  const numero = Number(valor);
  return (valor !== undefined && !Number.isNaN(numero)) ? numero : 1;
}

// ── Construir los datos del grafo (nodos + enlaces) ──────────────────────
// v5 (9 ago 2026): cuarto parámetro opcional `pesosCriterios` — el mismo
// objeto {id: peso} que ya usa generarReportePDF.js. Cada nodo tipo
// "criterio" ahora trae su propio campo `peso` (1 por defecto), que usa
// app/auditoria/[id]/grafo/page.js para dibujar esferas de distinto
// tamaño. Sin pesosCriterios, el resultado es idéntico al de antes de
// este cambio (todos los criterios quedan con peso 1).
function calcularDatosGrafo(datos, analisisGrafo = { articulos: [], citas: [] }, auditoria_id = 'N/A', pesosCriterios = {}) {
  const criterios = datos.categorias.flatMap(cat => cat.criterios);
  const nodos = [];
  const enlaces = [];

  criterios.forEach(c => {
    nodos.push({
      id: c.id,
      tipo: 'criterio',
      resultado: c.resultado,
      pregunta: c.pregunta,
      analisis: c.analisis,
      peso: pesoDeCriterio(c.id, pesosCriterios),
    });
  });

  const idsArticulos = new Set();
  (analisisGrafo.articulos || []).forEach(a => {
    idsArticulos.add(a.id);
    nodos.push({
      id: a.id,
      tipo: 'articulo',
      etiquetaCorta: etiquetaCortaComponente(a.id),
      titulo: a.titulo || null,
      accion: a.accion || 'ninguna',
      articulo_referido: a.articulo_referido || '',
    });
  });

  const resultadoPorCriterio = {};
  criterios.forEach(c => { resultadoPorCriterio[c.id] = c.resultado; });

  (analisisGrafo.citas || []).forEach(cita => {
    (cita.articulos_citados || []).forEach(articuloId => {
      if (!idsArticulos.has(articuloId)) {
        console.warn(`   ⚠️ [${auditoria_id}] calcularDatosGrafo: "${cita.criterio_id}" cita "${articuloId}", que no está en la lista de artículos identificados — se omite el enlace.`);
        return;
      }
      enlaces.push({
        origen: articuloId,
        destino: cita.criterio_id,
        resultado: resultadoPorCriterio[cita.criterio_id] || 'NA',
      });
    });
  });

  return { nodos, enlaces };
}

// ── En uso — resumen por horizonte (Presentación) ─────────────────────────
const HORIZONTE_POR_RESULTADO = {
  'NO': 'en_contra',
  'SI_MATIZ': 'neutral',
  'SI': 'a_favor',
};

function calcularResumenHorizontes(enlaces, pesosCriterios = {}) {
  const grupos = { en_contra: [], neutral: [], a_favor: [] };

  enlaces.forEach(enlace => {
    const horizonte = HORIZONTE_POR_RESULTADO[enlace.resultado];
    if (!horizonte) return;
    grupos[horizonte].push(enlace);
  });

  const pesoDeLista = lista => lista.reduce((acc, e) => acc + pesoDeCriterio(e.destino, pesosCriterios), 0);

  const pesoTotal = pesoDeLista(grupos.en_contra) + pesoDeLista(grupos.neutral) + pesoDeLista(grupos.a_favor);

  const conPorcentaje = lista => {
    const peso = pesoDeLista(lista);
    return {
      cantidad: lista.length,
      peso,
      porcentaje: pesoTotal > 0 ? Math.round((peso / pesoTotal) * 100) : 0,
    };
  };

  return {
    total: pesoTotal,
    en_contra: conPorcentaje(grupos.en_contra),
    neutral: conPorcentaje(grupos.neutral),
    a_favor: conPorcentaje(grupos.a_favor),
  };
}

module.exports = {
  etiquetaCortaComponente,
  generarGrafoConClaude,
  calcularDatosGrafo,
  calcularResumenHorizontes,
};