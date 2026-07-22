// generarActivismo.js — ACL Worker
// Umbusk LLC · Auditoría Cívica Liberal
//
// v2 (22 jul 2026) — primera generación real de contenido. Hasta ahora
// este archivo solo calculaba el veredicto (puro, sin llamados a Claude);
// generarIdeasActivismoTotal() es la primera pieza que sí le pide algo a
// Claude — mismo patrón de aislamiento que generarTitulosArticulos() en
// generarDatosGrafo.js: un llamado chico y separado del análisis
// principal, para que un fallo acá no tumbe el resto del pipeline.
//
// Alcance de esta v2 (decidido con Moisés, 22 jul 2026): solo el caso
// TOTAL (rechazo_total / promocion_total — fuera de la banda 20%-80%).
// El caso híbrido (artículo por artículo: hasta 3 "En contra" a
// rechazar, hasta 3 "Neutros" a mejorar, hasta 3 "A favor" a promover,
// cada uno con 3-5 ideas) queda para una siguiente sesión — es un
// llamado más grande porque primero hay que seleccionar cuáles artículos
// importan más, y hoy no hay ningún campo de gravedad/severidad en el
// schema para guiar esa selección (era del pptx viejo, superado) — sería
// puro criterio de Claude leyendo el análisis de cada uno.
//
// Lámina de contacto (obtenerContactosApoyo): a propósito NO se genera
// con Claude — decisión de Moisés, 22 jul 2026: un dato de contacto
// equivocado podría usarse en una situación real y urgente, así que debe
// ser contenido fijo, curado y verificado a mano, igual en todas las
// presentaciones. Por ahora son datos DUMMY (marcados "[DUMMY]" en cada
// campo para que nadie los confunda con contactos reales) — reemplazar
// cuando exista la lista real. Si más adelante se quiere poder editarla
// sin desplegar código, el patrón ya existe en el proyecto:
// fuentes_doctrinales (tabla + endpoints en worker.js).

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const UMBRAL_RECHAZO_TOTAL   = 0.20;
const UMBRAL_PROMOCION_TOTAL = 0.80;

// ── Veredicto general del instrumento (sin cambios respecto a v1) ───────
function calcularVeredictoActivismo(resumenHorizontes) {
  const { total, neutral, a_favor } = resumenHorizontes;
  const alineacionFraccion = total > 0
    ? (neutral.cantidad + a_favor.cantidad) / total
    : 0;
  const alineacionPorcentaje = Math.round(alineacionFraccion * 100);

  let modo;
  if (alineacionFraccion < UMBRAL_RECHAZO_TOTAL) {
    modo = 'rechazo_total';
  } else if (alineacionFraccion > UMBRAL_PROMOCION_TOTAL) {
    modo = 'promocion_total';
  } else {
    modo = 'hibrido';
  }

  return { modo, alineacionPorcentaje };
}

// ── Utilidad: extraer el bloque de texto de una respuesta de Claude ─────
// Mismo motivo que en worker.js y generarDatosGrafo.js: el pensamiento
// adaptativo puede anteponer un bloque 'thinking' al de 'text'.
function extraerTextoRespuesta(response) {
  const bloqueTexto = response.content.find(b => b.type === 'text');
  if (!bloqueTexto) {
    throw new Error('generarActivismo: la respuesta de Claude no incluyó ningún bloque de texto');
  }
  return bloqueTexto.text;
}

// ── Ideas de activismo — caso total (rechazo o promoción) ───────────────
const SCHEMA_IDEAS_ACTIVISMO_TOTAL = {
  type: 'object',
  properties: {
    ideas: {
      type: 'array',
      description: 'Un array con entre 3 y 5 ideas concretas de activismo cívico no violento — ni menos de 3 ni más de 5.',
      items: {
        type: 'object',
        properties: {
          titulo: {
            type: 'string',
            description: 'Nombre corto de la acción, 4 a 8 palabras (ej. "Campaña de etiquetado en redes").',
          },
          descripcion: {
            type: 'string',
            description: '1 a 3 oraciones concretas y accionables, específicas a este documento.',
          },
        },
        required: ['titulo', 'descripcion'],
        additionalProperties: false,
      },
    },
  },
  required: ['ideas'],
  additionalProperties: false,
};

async function generarIdeasActivismoTotal(datos, metadatos, veredicto, auditoria_id = 'N/A') {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const esRechazo = veredicto.modo === 'rechazo_total';

  const criterios = datos.categorias.flatMap(cat => cat.criterios).filter(c => c.resultado !== 'NA');
  const listaCriterios = criterios
    .map(c => `- ${c.id} [${c.resultado}]: ${c.analisis}`)
    .join('\n');

  const prompt = `Eres un asistente de activismo cívico no violento para liberalmente.app, una plataforma de auditoría ciudadana de leyes y políticas públicas desde una perspectiva liberal.

Este instrumento normativo obtuvo ${veredicto.alineacionPorcentaje}% de impacto liberal, lo cual amerita una recomendación de ${esRechazo ? 'RECHAZO TOTAL' : 'PROMOCIÓN TOTAL'}.

DOCUMENTO: ${metadatos.titulo}${metadatos.pais ? ` (${metadatos.pais})` : ''}

RESULTADOS POR CRITERIO:
${listaCriterios}

Genera de 3 a 5 ideas concretas de activismo cívico no violento para que un ciudadano actúe sobre este veredicto — ${esRechazo ? 'orientadas a rechazar y frenar este instrumento' : 'orientadas a promover y defender este instrumento'}. Adapta los métodos clásicos de lucha no violenta (en la tradición de Gene Sharp) al contexto actual: redes sociales, herramientas de IA, medios digitales. Cada idea debe ser específica a este documento (referenciando su tema o país cuando ayude a que no suene genérica), no un consejo que serviría igual para cualquier ley. Nunca sugieras violencia, daño a personas o propiedad, ni acciones ilegales.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
    output_config: {
      format: { type: 'json_schema', schema: SCHEMA_IDEAS_ACTIVISMO_TOTAL },
    },
  });

  if (response.stop_reason === 'max_tokens') {
    throw new Error(`generarIdeasActivismoTotal [${auditoria_id}]: respuesta cortada por max_tokens (2000) — subir el límite.`);
  }
  if (response.stop_reason === 'refusal') {
    throw new Error(`generarIdeasActivismoTotal [${auditoria_id}]: Claude rehusó generar las ideas (stop_reason: refusal).`);
  }

  const texto = extraerTextoRespuesta(response);
  const datosRespuesta = JSON.parse(texto);
  return datosRespuesta.ideas;
}

// ── Lámina de contacto — DATOS DUMMY, PENDIENTES DE CURAR ────────────────
// Ver nota al inicio del archivo. Común a todas las presentaciones,
// independiente del veredicto.
function obtenerContactosApoyo() {
  return [
    {
      nombre: '[DUMMY] Organización de derechos civiles',
      contacto: '[DUMMY] +58 000-0000000 · contacto@dummy.org',
      descripcion: '[DUMMY] Apoyo legal y acompañamiento en casos de abuso de poder.',
    },
    {
      nombre: '[DUMMY] Red de monitoreo de derechos humanos',
      contacto: '[DUMMY] +58 000-0000000 · reportes@dummy.org',
      descripcion: '[DUMMY] Documentación y denuncia de atropellos.',
    },
    {
      nombre: '[DUMMY] Línea de asistencia legal ciudadana',
      contacto: '[DUMMY] 0-800-000-0000',
      descripcion: '[DUMMY] Orientación legal gratuita ante detenciones o intimidación.',
    },
  ];
}

module.exports = {
  calcularVeredictoActivismo,
  generarIdeasActivismoTotal,
  obtenerContactosApoyo,
};