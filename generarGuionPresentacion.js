// generarGuionPresentacion.js — ACL Worker
// Umbusk LLC · Auditoría Cívica Liberal
//
// [... changelog anterior sin cambios, ver versión previa del archivo ...]
//
// v2 (4 ago 2026) — ESTILO EDITABLE DESDE ADMIN, DATOS PROTEGIDOS.
//
// v3 (16 ago 2026) — SELECCIÓN PROPORCIONAL, COMPARTIDA CON LA PRESENTACIÓN:
// seleccionarEscenas() (código propio de este archivo, basado en
// datos.alertas + "hasta 4 del núcleo + 1 de balance", sin relación
// directa con el % de alineación) se reemplaza por
// seleccionarPuntosDestacados() de generarActivismo.js — la misma función
// que ahora también usa la Presentación. Motivo: el Ala Doctrinal venía
// señalando que las auditorías se sentían "demasiado estrictas" —
// documentos con buen puntaje no se veían reflejados como tal en el
// Podcast. La nueva selección destaca siempre 10 puntos (configurable en
// generarActivismo.js), positivos y negativos, en la misma proporción que
// la alineación general del documento (ej. 87% → 9 positivos, 1
// negativo) — nunca un número fijo de alertas sin relación con el
// puntaje real.
//
// generarGuion() / generarYRevisarGuion() ahora reciben `pesosCriterios`
// como tercer parámetro (worker.js ya lo calculaba antes de llamar a
// estas funciones para otros pasos del pipeline — solo hacía falta
// pasarlo también aquí). Sin él, pesosCriterios cae a `{}` (todos los
// criterios con peso 1, mismo comportamiento que en el resto del
// pipeline cuando no hay pesos configurados).
//
// formatearEscena()/formatearBalance() se reemplazan por formatearPuntos()
// — mismo propósito (dar contexto legible al prompt), formato nuevo
// (negativos primero, luego positivos, en vez de "núcleo + balance").
// tonoGeneral (el umbral fijo de 65% que decidía "mayoritariamente
// alineado") se reemplaza por una nota de enfoque derivada directamente
// del conteo real de puntos negativos vs. positivos ya seleccionados —
// no hace falta un segundo umbral independiente del que ya decidió la
// selección.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { seleccionarPuntosDestacados } = require('./generarActivismo');

// ── Extraer texto de la respuesta (mismo patrón que worker.js) ──────────────
function extraerTextoRespuesta(response) {
  const bloqueTexto = response.content.find(b => b.type === 'text');
  if (!bloqueTexto) {
    throw new Error('La respuesta de Claude no incluyó ningún bloque de texto (revisar response.content completo)');
  }
  return bloqueTexto.text;
}

// ── Formatear los puntos seleccionados como contexto legible para el prompt ─
// item: { criterio, categoriaDoctrinal: {num, nombre} } — mismo formato
// que devuelve seleccionarPuntosDestacados().
function formatearPuntos(lista, etiquetaTipo) {
  return lista.map((item, idx) => {
    const c = item.criterio;
    const resultadoTexto = c.resultado === 'SI' ? 'SÍ pleno' : c.resultado === 'SI_MATIZ' ? 'SÍ con matiz' : 'NO se cumple';
    return `PUNTO ${etiquetaTipo} ${idx + 1} — Criterio ${c.id} [${resultadoTexto}] (Categoría ${item.categoriaDoctrinal.num} — ${item.categoriaDoctrinal.nombre}):
${c.pregunta}
Análisis: ${c.analisis}`;
  }).join('\n\n');
}

// ── Bloques de ESTILO — editables desde /admin/productos-comunicacionales ──
// Texto de respaldo idéntico al que ya vivía fijo en el prompt. Si
// prompts_productos no tiene todavía la clave correspondiente, el
// comportamiento es exactamente el de antes de este cambio.

const TEXTO_VOCES_RESPALDO = `LAS VOCES:
- ANITA: la analista. Seria, precisa, pero cálida — explica sin condescendencia.
- ERICK: el ciudadano curioso. Hace las preguntas que haría cualquier oyente — sorpresa, ironía, alivio, incredulidad genuina. No es ingenuo, es alguien que no ha leído la ley y quiere entender.`;

const TEXTO_REGLAS_RESPALDO = `REGLAS DE ESCRITURA:

1. ESTRUCTURA: Apertura (una frase que plantee qué está en juego para alguien como el oyente — nunca empieces con el porcentaje ni con "esta ley regula...") → primero una escena por cada punto NEGATIVO seleccionado, luego una escena por cada punto POSITIVO seleccionado → cierre (menciona la alineación general aquí, como remate, no como titular, usando exactamente los números de arriba; termina con "Defiende la libertad. Audita el poder.").

2. METÁFORAS — ECONOMÍA, NO DECORACIÓN: usa como máximo 2-3 metáforas distintas en TODO el guion, nunca una por escena. Antes de usar una metáfora en una escena, pregúntate: ¿esto se entiende solo, en lenguaje llano, o de verdad hace falta una imagen para aterrizarlo? Si se entiende solo (por ejemplo, "el precio lo fija una oficina, no el mercado"), no le pongas metáfora encima. Resérvalas para lo estructural o abstracto (poder discrecional, efecto comadreja, ese tipo de cosas). Si reusas una metáfora en más de una escena, que sea una extensión natural de la misma imagen, no una repetición forzada — y verifica que la comparación sea lógicamente correcta: no le atribuyas a la metáfora algo que no le corresponde (ej. no compares un privilegio otorgado por el poder con algo que alguien elige voluntariamente, ni le agregues un matiz temporal o de otro tipo que no esté en el hecho real que describe).

3. TONO CONVERSACIONAL: diálogo real, con interjecciones, pausas, alguna interrupción — no un monólogo de Anita cortado artificialmente en dos. Erick pregunta, reacciona, a veces bromea con algo de ironía. Nada de humor cruel ni sarcasmo hacia las personas — el blanco es el poder mal ejercido, nunca un grupo de personas.

4. FILTRO DOCTRINAL: la línea que separa lo aceptable de lo problemático es liberal-democrático vs. populista/autoritario/totalitario — nunca izquierda vs. derecha. No conviertas esto en un panfleto partidista.

5. FIDELIDAD — SIN EXCEPCIONES: cada afirmación del guion debe corresponder a algo real del material seleccionado arriba o a los números de "RESULTADO GENERAL". Esto incluye cifras, conteos, totales y porcentajes, no solo artículos o hechos narrativos — no inventes ni redondees ningún número que no esté explícitamente dado arriba, aunque te parezca plausible o "razonable" para un caso como este.`;

const TEXTO_CRITERIOS_REVISOR_RESPALDO = `- Si alguna metáfora describe mal lo que compara — le atribuye algo que no corresponde, o confunde en vez de aclarar.
- Si hay demasiadas metáforas distintas, o si se usa una metáfora donde el concepto ya se entendía solo.
- Si el tono entre las dos voces se siente natural o forzado.
- Si el balance entre puntos negativos y positivos es honesto respecto al material dado (ni exagera lo positivo, ni omite lo poco positivo que sí exista — ni al revés).
- Si el guion se mantiene fiel al material real, sin inventar ni exagerar.
- Que la línea entre lo aceptable y lo problemático sea liberal-democrático vs. populista/autoritario — nunca izquierda vs. derecha.`;

// ── Prompt del generador ─────────────────────────────────────────────────
// textoVoces / textoReglas: opcionales — si vienen null o vacíos, se usa el
// texto de respaldo de arriba. worker.js los lee de prompts_productos antes
// de llamar a generarGuion().
function construirPromptGenerador(seleccion, datos, metadatos, textoVoces = null, textoReglas = null) {
  const { titulo, pais } = metadatos;
  const { alineacionPorcentaje, positivos, negativos } = seleccion;
  const { puntaje, siPlenos, siMatiz, noCount, naCount } = datos;
  const aplicables = siPlenos + siMatiz + noCount;
  const totalCriterios = aplicables + naCount;

  const negativosTexto = negativos.length > 0 ? formatearPuntos(negativos, 'NEGATIVO') : null;
  const positivosTexto = positivos.length > 0 ? formatearPuntos(positivos, 'POSITIVO') : null;

  const voces  = (textoVoces && textoVoces.trim())  ? textoVoces.trim()  : TEXTO_VOCES_RESPALDO;
  const reglas = (textoReglas && textoReglas.trim()) ? textoReglas.trim() : TEXTO_REGLAS_RESPALDO;

  const notaEnfoque = positivos.length > negativos.length
    ? 'NOTA DE ENFOQUE: este documento está mayoritariamente alineado con los postulados liberales — la historia debe sentirse como algo que en gran parte protege al ciudadano, no como una denuncia. Los puntos negativos (si los hay) son advertencia puntual, no el eje central.'
    : negativos.length > positivos.length
      ? 'NOTA DE ENFOQUE: este documento está mayoritariamente alejado de los postulados liberales — la historia debe sentirse como una alerta real. Los puntos positivos (si los hay) son un matiz honesto, no el eje central.'
      : 'NOTA DE ENFOQUE: este documento está dividido de forma pareja entre aspectos alineados y no alineados — la historia debe reflejar ese equilibrio real, sin inclinarse artificialmente hacia ningún lado.';

  return `Eres el guionista de Auditoría Cívica Liberal (liberalmente.app), una plataforma de CEDICE y la Fundación Friedrich Naumann que audita leyes y políticas públicas latinoamericanas con criterios del liberalismo clásico. Tu tarea es escribir un guion de podcast a dos voces que explique los hallazgos de una auditoría real a una audiencia NO especializada — personas que no están particularmente interesadas en el liberalismo como doctrina, y que no van a leer el reporte completo.

DOCUMENTO AUDITADO: ${titulo}${pais ? ` (${pais})` : ''}

RESULTADO GENERAL DE LA AUDITORÍA — estos son los ÚNICOS números reales que existen. Si mencionas cualquier cifra o total en el guion, tiene que ser exactamente uno de estos, nunca uno inventado o redondeado distinto:
- Total de criterios evaluados: ${totalCriterios} (${aplicables} aplicables a este documento, ${naCount} no aplicables)
- SÍ pleno: ${siPlenos}
- SÍ con matiz: ${siMatiz}
- NO se cumple: ${noCount}
- Alineación general: ${puntaje !== null ? puntaje + '%' : alineacionPorcentaje + '% (estimado — la fórmula del Reporte no calcula un porcentaje general para este documento porque no tiene ningún SÍ pleno; usa esta cifra igual, no digas "cero por ciento", eso sería un dato distinto y falso)'}

${voces}

MATERIAL YA SELECCIONADO PARA EL GUION (${negativos.length} punto(s) negativo(s) y ${positivos.length} punto(s) positivo(s), en proporción a la alineación general — no elijas otros hallazgos, no agregues criterios que no estén aquí):

${negativosTexto || '(Sin puntos negativos seleccionados — este documento no tuvo ningún criterio en NO, o la proporción no incluyó ninguno.)'}

${positivosTexto || '(Sin puntos positivos seleccionados — este documento no tuvo ningún criterio en SÍ o SÍ con matiz, o la proporción no incluyó ninguno.)'}

${notaEnfoque}

${reglas}

FORMATO DE RESPUESTA — texto plano, sin JSON, sin markdown, empieza directo con la primera línea de diálogo:

ANITA: [emoción entre corchetes, ej. seria/curiosa/pausa] línea de diálogo
ERICK: [emoción] línea de diálogo
...

No escribas nada antes de la primera línea ni después de la última.`;
}

// ── Prompt del revisor (liviano, ciego al razonamiento del generador) ────
// textoCriterios: opcional — mismo criterio que arriba.
function construirPromptRevisor(guion, seleccion, textoCriterios = null) {
  const { positivos, negativos } = seleccion;
  const negativosTexto = negativos.length > 0 ? formatearPuntos(negativos, 'NEGATIVO') : '(Sin puntos negativos seleccionados para este documento.)';
  const positivosTexto = positivos.length > 0 ? formatearPuntos(positivos, 'POSITIVO') : '(Sin puntos positivos seleccionados para este documento.)';
  const criterios = (textoCriterios && textoCriterios.trim()) ? textoCriterios.trim() : TEXTO_CRITERIOS_REVISOR_RESPALDO;

  return `Eres un editor experimentado de contenido conversacional para audiencias generales. A continuación tienes un guion de podcast a dos voces (Anita y Erick) que explica los hallazgos de una auditoría cívica liberal sobre una ley o política pública, y el material real en el que se basó.

MATERIAL EN EL QUE SE BASÓ EL GUION:

${negativosTexto}

${positivosTexto}

GUION A REVISAR:

${guion}

¿Cómo te parece este guion? Revísalo con criterio, prestando especial atención a:
${criterios}

Si se te ocurre alguna mejora, aplícala directamente sobre el guion. Si el guion ya está bien así, dilo también — no cambies algo solo por cambiarlo.

Responde en este formato, texto plano, sin JSON:

VEREDICTO: SIN_CAMBIOS o AJUSTADO
NOTAS: qué cambiaste y por qué (o por qué no hizo falta ningún cambio)
GUION_FINAL:
[el guion completo — el mismo de arriba si no hiciste cambios, o la versión corregida]`;
}

// ── Parsear la respuesta del revisor ──────────────────────────────────────────

function parsearRevision(textoRespuesta) {
  const veredicto = /VEREDICTO:\s*(SIN_CAMBIOS|AJUSTADO)/i.exec(textoRespuesta)?.[1]?.toUpperCase() || 'AJUSTADO';
  const notasMatch = /NOTAS:\s*([\s\S]*?)(?=GUION_FINAL:)/i.exec(textoRespuesta);
  const notas = notasMatch ? notasMatch[1].trim() : '';
  const guionMatch = /GUION_FINAL:\s*([\s\S]*)$/i.exec(textoRespuesta);
  const guionFinal = guionMatch ? guionMatch[1].trim() : textoRespuesta.trim();
  return { veredicto, notas, guionFinal };
}

// ── Funciones principales exportadas ─────────────────────────────────────────
// generarGuion / revisarGuion / generarYRevisarGuion ahora reciben
// `pesosCriterios` (nuevo, 16 ago 2026 — ver changelog v3 arriba) y los 3
// textos de estilo opcionales, y los pasan hacia abajo hasta los
// construirPrompt*(). worker.js es responsable de pasar pesosCriterios (ya
// lo calculaba antes para otros pasos) y de leer los textos de estilo de
// prompts_productos — si no los manda (o manda null/{}), el comportamiento
// usa los respaldos de arriba.

async function generarGuion(datos, metadatos, pesosCriterios = {}, textoVoces = null, textoReglas = null) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const seleccion = seleccionarPuntosDestacados(datos, pesosCriterios);
  const prompt = construirPromptGenerador(seleccion, datos, metadatos, textoVoces, textoReglas);

  console.log(`   [generarGuion] Alineación: ${seleccion.alineacionPorcentaje}% — puntos seleccionados: ${seleccion.negativos.length} negativo(s), ${seleccion.positivos.length} positivo(s)`);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
  });

  if (response.stop_reason === 'max_tokens') {
    throw new Error('generarGuion: respuesta cortada por max_tokens (16000) — el guion quedó incompleto. Subir max_tokens más, o revisar si el prompt está pidiendo demasiado.');
  }

  const guion = extraerTextoRespuesta(response);
  console.log(`   [generarGuion] Guion generado (${guion.length} chars)`);
  return { guion, seleccion };
}

async function revisarGuion(guion, seleccion, textoCriterios = null) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = construirPromptRevisor(guion, seleccion, textoCriterios);

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
  });

  if (response.stop_reason === 'max_tokens') {
    throw new Error('revisarGuion: respuesta cortada por max_tokens (16000) — la revisión quedó incompleta.');
  }

  const textoRespuesta = extraerTextoRespuesta(response);
  const revision = parsearRevision(textoRespuesta);
  console.log(`   [revisarGuion] Veredicto: ${revision.veredicto}${revision.notas ? ' — ' + revision.notas.slice(0, 120) : ''}`);
  return revision;
}

// Función combinada — genera y revisa en un solo llamado a este módulo.
async function generarYRevisarGuion(datos, metadatos, pesosCriterios = {}, textoVoces = null, textoReglas = null, textoCriteriosRevisor = null) {
  const { guion, seleccion } = await generarGuion(datos, metadatos, pesosCriterios, textoVoces, textoReglas);
  const revision = await revisarGuion(guion, seleccion, textoCriteriosRevisor);
  return {
    guionOriginal: guion,
    guionFinal: revision.guionFinal,
    veredicto: revision.veredicto,
    notasRevision: revision.notas,
    seleccion,
  };
}

module.exports = {
  construirPromptGenerador,
  construirPromptRevisor,
  generarGuion,
  revisarGuion,
  generarYRevisarGuion,
};

// ── Script de prueba manual (sin cambios en su forma de invocarse) ───────────
if (require.main === module) {
  const fs = require('fs');
  const { normalizarDatosEstructurados } = require('./generarReportePDF');

  const rutaArchivo = process.argv[2];
  if (!rutaArchivo) {
    console.error('Uso: node generarGuionPresentacion.js /ruta/al/reporte_texto.json');
    process.exit(1);
  }

  const reporteTexto = fs.readFileSync(rutaArchivo, 'utf8');
  const datos = normalizarDatosEstructurados(reporteTexto, 'prueba-manual');

  const metadatos = {
    titulo: process.argv[3] || 'Documento de prueba',
    pais: process.argv[4] || '',
  };

  generarYRevisarGuion(datos, metadatos)
    .then(resultado => {
      console.log('\n══════════════ GUION ORIGINAL (Sonnet 5) ══════════════\n');
      console.log(resultado.guionOriginal);
      console.log('\n══════════════ REVISIÓN (Opus 4.8) ══════════════');
      console.log('Veredicto:', resultado.veredicto);
      console.log('Notas:', resultado.notasRevision);
      console.log('\n══════════════ GUION FINAL ══════════════\n');
      console.log(resultado.guionFinal);
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}