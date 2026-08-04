// generarGuionPresentacion.js — ACL Worker
// Umbusk LLC · Auditoría Cívica Liberal
//
// [... changelog anterior sin cambios, ver versión previa del archivo ...]
//
// v2 (4 ago 2026) — ESTILO EDITABLE DESDE ADMIN, DATOS PROTEGIDOS:
// El prompt del generador mezclaba, en el mismo bloque de texto, reglas de
// estilo (voces, tono, metáforas) CON datos reales inyectados a mitad del
// texto (cifras exactas de "RESULTADO GENERAL", que existen específicamente
// para evitar que Claude invente números — bug real corregido el 17 jul
// 2026). Volver todo ese bloque libremente editable desde Admin arriesgaba
// reabrir ese mismo bug si alguien borraba sin querer la sección de datos
// al editar el estilo.
//
// Solución: se separan en piezas propias SOLO las secciones que son
// puramente de estilo — "LAS VOCES" y "REGLAS DE ESCRITURA" en el
// generador, la lista de criterios de revisión en el revisor — cada una
// con su propio texto de respaldo (TEXTO_VOCES_RESPALDO,
// TEXTO_REGLAS_RESPALDO, TEXTO_CRITERIOS_REVISOR_RESPALDO). worker.js las
// lee de prompts_productos (claves "podcast_generador_voces",
// "podcast_generador_reglas", "podcast_revisor_criterios") y las pasa como
// parámetros opcionales. El resto del prompt —cifras reales, material
// seleccionado, formato de salida ANITA:/ERICK: que necesita
// generarAudioPodcast.js para asignar voces— sigue armado en código, no
// editable, en la misma posición exacta que ya tenía. Sin ediciones desde
// Admin, el resultado es idéntico byte a byte al de antes de este cambio.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// ── Extraer texto de la respuesta (mismo patrón que worker.js) ──────────────
function extraerTextoRespuesta(response) {
  const bloqueTexto = response.content.find(b => b.type === 'text');
  if (!bloqueTexto) {
    throw new Error('La respuesta de Claude no incluyó ningún bloque de texto (revisar response.content completo)');
  }
  return bloqueTexto.text;
}

// ── Paso 1: selección de escenas (código, no Claude) ─────────────────────────

const RANGO_GRAVEDAD = { ALTA: 4, 'MODERADA-ALTA': 3, MODERADA: 2, BAJA: 1 };
const MAX_ESCENAS_NUCLEO = 4;

function seleccionarEscenas(datos) {
  const todos       = datos.categorias.flatMap(c => c.criterios);
  const aplicables   = datos.siPlenos + datos.siMatiz + datos.noCount;
  const proporcionPositiva = aplicables > 0 ? (datos.siPlenos + datos.siMatiz) / aplicables : 0;

  let nucleo;
  if (datos.alertas.length > 0) {
    nucleo = [...datos.alertas]
      .sort((a, b) => (RANGO_GRAVEDAD[b.gravedad] || 0) - (RANGO_GRAVEDAD[a.gravedad] || 0))
      .slice(0, MAX_ESCENAS_NUCLEO)
      .map(alerta => ({ tipo: 'alerta', alerta }));
  } else {
    nucleo = todos
      .filter(c => c.resultado === 'NO')
      .slice(0, MAX_ESCENAS_NUCLEO)
      .map(criterio => ({ tipo: 'criterio', criterio }));
  }

  const balance = todos.find(c => c.resultado === 'SI')
                || todos.find(c => c.resultado === 'SI_MATIZ')
                || null;

  return {
    nucleo,
    balance,
    tonoGeneral: proporcionPositiva >= 0.65 ? 'mayoritariamente_alineado' : 'mayoritariamente_alertas',
    hayPocoPositivo: !balance,
  };
}

// ── Formatear las escenas seleccionadas como contexto legible para el prompt ─

function formatearEscena(item, idx) {
  if (item.tipo === 'alerta') {
    const a = item.alerta;
    return `ESCENA ${idx + 1} (de una alerta — gravedad ${a.gravedad}):
Título: ${a.titulo}
Descripción: ${a.descripcion}
Criterios relacionados: ${(a.criterios || []).join(', ')}`;
  }
  const c = item.criterio;
  return `ESCENA ${idx + 1} (de un criterio individual — NO se cumple):
Criterio ${c.id}: ${c.pregunta}
Análisis: ${c.analisis}`;
}

function formatearBalance(balance) {
  if (!balance) return null;
  return `Criterio ${balance.id} (${balance.resultado === 'SI' ? 'SÍ pleno' : 'SÍ con matiz'}): ${balance.pregunta}
Análisis: ${balance.analisis}`;
}

// ── Bloques de ESTILO — editables desde /admin/productos-comunicacionales ──
// Texto de respaldo idéntico al que ya vivía fijo en el prompt. Si
// prompts_productos no tiene todavía la clave correspondiente, el
// comportamiento es exactamente el de antes de este cambio.

const TEXTO_VOCES_RESPALDO = `LAS VOCES:
- ANITA: la analista. Seria, precisa, pero cálida — explica sin condescendencia.
- ERICK: el ciudadano curioso. Hace las preguntas que haría cualquier oyente — sorpresa, ironía, alivio, incredulidad genuina. No es ingenuo, es alguien que no ha leído la ley y quiere entender.`;

const TEXTO_REGLAS_RESPALDO = `REGLAS DE ESCRITURA:

1. ESTRUCTURA: Apertura (una frase que plantee qué está en juego para alguien como el oyente — nunca empieces con el porcentaje ni con "esta ley regula...") → una escena por cada hallazgo del material seleccionado → escena de balance (si existe) → cierre (menciona la alineación general aquí, como remate, no como titular, usando exactamente los números de arriba; termina con "Defiende la libertad. Audita el poder.").

2. METÁFORAS — ECONOMÍA, NO DECORACIÓN: usa como máximo 2-3 metáforas distintas en TODO el guion, nunca una por escena. Antes de usar una metáfora en una escena, pregúntate: ¿esto se entiende solo, en lenguaje llano, o de verdad hace falta una imagen para aterrizarlo? Si se entiende solo (por ejemplo, "el precio lo fija una oficina, no el mercado"), no le pongas metáfora encima. Resérvalas para lo estructural o abstracto (poder discrecional, efecto comadreja, ese tipo de cosas). Si reusas una metáfora en más de una escena, que sea una extensión natural de la misma imagen, no una repetición forzada — y verifica que la comparación sea lógicamente correcta: no le atribuyas a la metáfora algo que no le corresponde (ej. no compares un privilegio otorgado por el poder con algo que alguien elige voluntariamente, ni le agregues un matiz temporal o de otro tipo que no esté en el hecho real que describe).

3. TONO CONVERSACIONAL: diálogo real, con interjecciones, pausas, alguna interrupción — no un monólogo de Anita cortado artificialmente en dos. Erick pregunta, reacciona, a veces bromea con algo de ironía. Nada de humor cruel ni sarcasmo hacia las personas — el blanco es el poder mal ejercido, nunca un grupo de personas.

4. FILTRO DOCTRINAL: la línea que separa lo aceptable de lo problemático es liberal-democrático vs. populista/autoritario/totalitario — nunca izquierda vs. derecha. No conviertas esto en un panfleto partidista.

5. FIDELIDAD — SIN EXCEPCIONES: cada afirmación del guion debe corresponder a algo real del material seleccionado arriba o a los números de "RESULTADO GENERAL". Esto incluye cifras, conteos, totales y porcentajes, no solo artículos o hechos narrativos — no inventes ni redondees ningún número que no esté explícitamente dado arriba, aunque te parezca plausible o "razonable" para un caso como este.`;

const TEXTO_CRITERIOS_REVISOR_RESPALDO = `- Si alguna metáfora describe mal lo que compara — le atribuye algo que no corresponde, o confunde en vez de aclarar.
- Si hay demasiadas metáforas distintas, o si se usa una metáfora donde el concepto ya se entendía solo.
- Si el tono entre las dos voces se siente natural o forzado.
- Si el balance final es honesto (ni exagera lo positivo si casi no lo hay, ni omite lo poco positivo que sí exista).
- Si el guion se mantiene fiel al material real, sin inventar ni exagerar.
- Que la línea entre lo aceptable y lo problemático sea liberal-democrático vs. populista/autoritario — nunca izquierda vs. derecha.`;

// ── Paso 2: prompt del generador ─────────────────────────────────────────────
// textoVoces / textoReglas: opcionales — si vienen null o vacíos, se usa el
// texto de respaldo de arriba. worker.js los lee de prompts_productos antes
// de llamar a generarGuion().

function construirPromptGenerador(escenas, datos, metadatos, textoVoces = null, textoReglas = null) {
  const { titulo, pais } = metadatos;
  const { nucleo, balance, tonoGeneral } = escenas;
  const { puntaje, siPlenos, siMatiz, noCount, naCount } = datos;
  const aplicables = siPlenos + siMatiz + noCount;
  const totalCriterios = aplicables + naCount;

  const escenasTexto = nucleo.map(formatearEscena).join('\n\n');
  const balanceTexto = formatearBalance(balance);

  const voces  = (textoVoces && textoVoces.trim())  ? textoVoces.trim()  : TEXTO_VOCES_RESPALDO;
  const reglas = (textoReglas && textoReglas.trim()) ? textoReglas.trim() : TEXTO_REGLAS_RESPALDO;

  return `Eres el guionista de Auditoría Cívica Liberal (liberalmente.app), una plataforma de CEDICE y la Fundación Friedrich Naumann que audita leyes y políticas públicas latinoamericanas con criterios del liberalismo clásico. Tu tarea es escribir un guion de podcast a dos voces que explique los hallazgos de una auditoría real a una audiencia NO especializada — personas que no están particularmente interesadas en el liberalismo como doctrina, y que no van a leer el reporte completo.

DOCUMENTO AUDITADO: ${titulo}${pais ? ` (${pais})` : ''}

RESULTADO GENERAL DE LA AUDITORÍA — estos son los ÚNICOS números reales que existen. Si mencionas cualquier cifra o total en el guion, tiene que ser exactamente uno de estos, nunca uno inventado o redondeado distinto:
- Total de criterios evaluados: ${totalCriterios} (${aplicables} aplicables a este documento, ${naCount} no aplicables)
- SÍ pleno: ${siPlenos}
- SÍ con matiz: ${siMatiz}
- NO se cumple: ${noCount}
- Alineación general: ${puntaje !== null ? puntaje + '%' : 'no se calcula un porcentaje general (la fórmula requiere al menos un SÍ pleno, y este documento no tiene ninguno) — NO digas "cero por ciento", eso es un dato distinto y falso; di que no hay total general, o describe el desglose real de arriba'}

${voces}

MATERIAL YA SELECCIONADO PARA EL GUION (no elijas otros hallazgos, no agregues criterios que no estén aquí):

${escenasTexto}

${balanceTexto ? `ESCENA DE BALANCE (algo que sí funciona, para que el guion no sea solo denuncia):\n${balanceTexto}` : 'NO HAY UNA ESCENA DE BALANCE DISPONIBLE: este documento no tiene ningún criterio con SÍ pleno ni SÍ con matiz. No inventes una fortaleza que no existe — maneja esto con honestidad, reconociendo directamente que el documento no deja mucho margen para señalar algo positivo, sin que sea un despropósito.'}

${tonoGeneral === 'mayoritariamente_alineado' ? 'NOTA DE ENFOQUE: este documento está mayoritariamente alineado con los postulados liberales. La historia debe sentirse como "esto es lo que te protege", no como una denuncia — los hallazgos negativos (si los hay) son advertencia secundaria, no el eje central.' : ''}

${reglas}

FORMATO DE RESPUESTA — texto plano, sin JSON, sin markdown, empieza directo con la primera línea de diálogo:

ANITA: [emoción entre corchetes, ej. seria/curiosa/pausa] línea de diálogo
ERICK: [emoción] línea de diálogo
...

No escribas nada antes de la primera línea ni después de la última.`;
}

// ── Paso 3: prompt del revisor (liviano, ciego al razonamiento del generador) ─
// textoCriterios: opcional — mismo criterio que arriba.

function construirPromptRevisor(guion, escenas, textoCriterios = null) {
  const escenasTexto = escenas.nucleo.map(formatearEscena).join('\n\n');
  const balanceTexto = formatearBalance(escenas.balance);
  const criterios = (textoCriterios && textoCriterios.trim()) ? textoCriterios.trim() : TEXTO_CRITERIOS_REVISOR_RESPALDO;

  return `Eres un editor experimentado de contenido conversacional para audiencias generales. A continuación tienes un guion de podcast a dos voces (Anita y Erick) que explica los hallazgos de una auditoría cívica liberal sobre una ley o política pública, y el material real en el que se basó.

MATERIAL EN EL QUE SE BASÓ EL GUION:

${escenasTexto}

${balanceTexto ? `ESCENA DE BALANCE:\n${balanceTexto}` : '(No había escena de balance disponible para este documento.)'}

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
// generarGuion / revisarGuion / generarYRevisarGuion ahora aceptan los 3
// textos de estilo opcionales, y los pasan hacia abajo hasta los
// construirPrompt*(). worker.js es responsable de leerlos de
// prompts_productos antes de llamar — si no los manda (o manda null), el
// comportamiento es idéntico al de antes de este cambio.

async function generarGuion(datos, metadatos, textoVoces = null, textoReglas = null) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const escenas = seleccionarEscenas(datos);
  const prompt = construirPromptGenerador(escenas, datos, metadatos, textoVoces, textoReglas);

  console.log(`   [generarGuion] Escenas seleccionadas: ${escenas.nucleo.length} del núcleo, balance: ${escenas.balance ? escenas.balance.id : 'ninguno'}, tono: ${escenas.tonoGeneral}`);

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
  return { guion, escenas };
}

async function revisarGuion(guion, escenas, textoCriterios = null) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = construirPromptRevisor(guion, escenas, textoCriterios);

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
async function generarYRevisarGuion(datos, metadatos, textoVoces = null, textoReglas = null, textoCriteriosRevisor = null) {
  const { guion, escenas } = await generarGuion(datos, metadatos, textoVoces, textoReglas);
  const revision = await revisarGuion(guion, escenas, textoCriteriosRevisor);
  return {
    guionOriginal: guion,
    guionFinal: revision.guionFinal,
    veredicto: revision.veredicto,
    notasRevision: revision.notas,
    escenas,
  };
}

module.exports = {
  seleccionarEscenas,
  construirPromptGenerador,
  construirPromptRevisor,
  generarGuion,
  revisarGuion,
  generarYRevisarGuion,
};

// ── Script de prueba manual (sin cambios) ────────────────────────────────────
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