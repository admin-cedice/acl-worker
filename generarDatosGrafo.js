// generarDatosGrafo.js — ACL Worker
// Umbusk LLC · Auditoría Cívica Liberal
//
// Módulo nuevo (20 jul 2026), separado de worker.js a propósito: contiene
// todo lo necesario para preparar los datos del grafo componentes→criterios
// que consume la página /auditoria/[id]/grafo (Next.js) — no dibuja nada
// (eso lo sigue haciendo worker.js con SVG+sharp para la versión plana),
// solo prepara el JSON.
//
// Trae su propia copia de normalizarComponentes()/etiquetaCortaComponente()
// (la misma lógica ya validada en worker.js el 20 jul, con las 3 decisiones
// doctrinales de Moisés: Exposición de Motivos y citas externas se
// descartan; "Disposiciones Finales/Transitorias" se conservan como
// artículos distintos aunque compartan número). Se duplica a propósito en
// vez de importarla de worker.js — worker.js ya es un archivo grande y en
// producción; este módulo puede vivir y probarse solo, sin tocarlo.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// ── Normalización de componentes citados ────────────────────────────────
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

function etiquetaCortaComponente(componente) {
  const m = /^Art\.\s+(\d+)(?:\s+\(Disposiciones (Transitorias|Finales)\))?$/.exec(componente);
  if (!m) return componente.slice(0, 6);
  const numero = m[1].padStart(2, '0');
  const suf = m[2] ? (m[2] === 'Transitorias' ? 'T' : 'F') : '';
  return `A-${numero}${suf}`;
}

// Lista de componentes únicos citados en toda la auditoría (las 7
// categorías) — worker.js la usa para saber a qué artículos pedirle título.
function componentesUnicos(datos) {
  const criterios = datos.categorias.flatMap(cat => cat.criterios);
  const set = new Set();
  criterios.forEach(c => normalizarComponentes(c.articulos).forEach(comp => set.add(comp)));
  return [...set];
}

function extraerTextoRespuestaLocal(response) {
  const bloqueTexto = response.content.find(b => b.type === 'text');
  if (!bloqueTexto) {
    throw new Error('generarDatosGrafo: la respuesta de Claude no incluyó ningún bloque de texto');
  }
  return bloqueTexto.text;
}

// ── Títulos de artículo con Claude ──────────────────────────────────────
// Llamado NUEVO y APARTE del análisis principal de 28 criterios, a
// propósito: esa misma sesión ya chocó dos veces con límites reales de ese
// llamado grande al agregarle un campo más (grammar demasiado compleja,
// luego max_tokens insuficiente). Este es un llamado chico y separado,
// solo para los artículos que de verdad se citaron — más barato, más fácil
// de depurar si falla, y un fallo acá no debe tumbar el resto de la
// auditoría (worker.js lo envuelve en try/catch — no bloqueante).
const SCHEMA_TITULOS_ARTICULOS = {
  type: 'object',
  properties: {
    articulos: {
      type: 'array',
      description: 'Un título corto para cada artículo de la lista dada.',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'El identificador exactamente como fue dado (ej. "Art. 63", "Art. 64 (Disposiciones Finales)").',
          },
          titulo: {
            type: 'string',
            description: 'Título corto (6 a 10 palabras) de qué establece este artículo específico, en lenguaje llano, basado en el texto real del documento.',
          },
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

// ── Construir los datos del grafo (nodos + enlaces) ──────────────────────
// Forma pensada para que /auditoria/[id]/grafo (Next.js) la consuma
// directo, sin reinterpretar nada del lado del frontend — toda la lógica
// de qué cuenta como componente vive acá una sola vez.
function calcularDatosGrafo(datos, titulosArticulos = {}) {
  const criterios = datos.categorias.flatMap(cat => cat.criterios);
  const nodos = [];
  const nodosSet = new Set();
  const enlaces = [];

  criterios.forEach(c => {
    nodos.push({
      id: c.id,
      tipo: 'criterio',
      resultado: c.resultado,
      pregunta: c.pregunta,
      analisis: c.analisis,
    });
  });

  criterios.forEach(c => {
    normalizarComponentes(c.articulos).forEach(comp => {
      if (!nodosSet.has(comp)) {
        nodosSet.add(comp);
        nodos.push({
          id: comp,
          tipo: 'articulo',
          etiquetaCorta: etiquetaCortaComponente(comp),
          titulo: titulosArticulos[comp] || null,
        });
      }
      enlaces.push({ origen: comp, destino: c.id, resultado: c.resultado });
    });
  });

  return { nodos, enlaces };
}

module.exports = {
  normalizarComponentes,
  etiquetaCortaComponente,
  componentesUnicos,
  generarTitulosArticulos,
  calcularDatosGrafo,
};