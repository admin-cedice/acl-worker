// generarGuionPresentacion.js — ACL Worker
// Umbusk LLC · Auditoría Cívica Liberal
//
// MÓDULO NUEVO (17 jul 2026) — primer borrador, EXPERIMENTAL.
// Genera el guion a dos voces (Janet + Roderick) para el Hemisferio
// Derecho (Presentación PDF + mp4 narrado), a partir del reporte
// estructurado que ya produce el Hemisferio Izquierdo.
//
// NO está conectado a procesarAuditoria() todavía — es intencional, mismo
// patrón que testPodcast.js. Se prueba de forma aislada primero (empezando
// con el reporte real de Hidrocarburos) antes de integrarlo al pipeline.
//
// Arquitectura: generador + revisor (patrón "reflection"):
//   1. seleccionarEscenas()   — decide QUÉ entra al guion. Es código, no
//      juicio de Claude: usa las alertas de mayor gravedad si existen, o
//      los criterios NO más señalados si no hay alertas, más una escena
//      de balance con el mejor SÍ/SÍ con matiz disponible.
//   2. generarGuion()         — Claude (claude-sonnet-5) escribe el guion
//      completo a partir de las escenas ya seleccionadas. Decide CÓMO
//      contarlas: cuándo usar metáfora (solo donde el concepto no se
//      entiende solo) y cuál — máximo 1-3 en todo el guion, nunca una por
//      escena. Eso sí es juicio de contenido, le corresponde al modelo.
//   3. revisarGuion()         — segunda pasada, ciega al razonamiento del
//      generador (no ve por qué eligió cada metáfora, para que la
//      revisión sea genuina y no una validación reflexiva). Editorial,
//      liviana — no recompara contra el texto legal criterio por
//      criterio, lee el guion completo como lo haría un editor humano.
//      Corre en claude-opus-4-8, modelo distinto al generador a propósito.
//
// Formato de salida: texto plano con marcadores (JANET:/RODERICK:), NO
// JSON — mismo criterio que generarResumenEjecutivo() en
// generarReportePDF.js desde la lección del 7 jul (un salto de línea real
// dentro de un string JSON rompe JSON.parse; texto con marcadores no tiene
// esa fragilidad).

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// ── Extraer texto de la respuesta (mismo patrón que worker.js) ──────────────
// El pensamiento adaptativo puede anteponer un bloque 'thinking' al de
// texto, en cualquier modelo que lo soporte — no asumir que el texto
// siempre está en content[0].
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

  // Núcleo del guion: alertas de mayor gravedad si existen (no todas, ya
  // se acordó no ser exhaustivos); si no hay ninguna, los criterios NO más
  // señalados directamente — el guion nunca depende únicamente de que
  // haya alertas, porque el schema las permite en 0.
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

  // Escena de balance: el mejor SÍ pleno disponible; si no hay ninguno, el
  // mejor SÍ con matiz. Si tampoco hay eso, no hay escena de balance —
  // caso real observado en Hidrocarburos, el prompt lo maneja con
  // honestidad en vez de forzarla.
  const balance = todos.find(c => c.resultado === 'SI')
                || todos.find(c => c.resultado === 'SI_MATIZ')
                || null;

  return {
    nucleo,
    balance,
    // Si el documento es mayoritariamente positivo, la historia cambia de
    // naturaleza: de "esto es lo que te quitan" a "esto es lo que te
    // protege". Umbral de 65% elegido como punto de partida razonable, no
    // probado todavía contra muchos casos reales — ajustar si hace falta.
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

// ── Paso 2: prompt del generador ─────────────────────────────────────────────

function construirPromptGenerador(escenas, metadatos, puntaje) {
  const { titulo, pais } = metadatos;
  const { nucleo, balance, tonoGeneral, hayPocoPositivo } = escenas;

  const escenasTexto = nucleo.map(formatearEscena).join('\n\n');
  const balanceTexto = formatearBalance(balance);

  return `Eres el guionista de Auditoría Cívica Liberal (liberalmente.app), una plataforma de CEDICE y la Fundación Friedrich Naumann que audita leyes y políticas públicas latinoamericanas con criterios del liberalismo clásico. Tu tarea es escribir un guion de podcast a dos voces que explique los hallazgos de una auditoría real a una audiencia NO especializada — personas que no están particularmente interesadas en el liberalismo como doctrina, y que no van a leer el reporte completo de 28 criterios.

DOCUMENTO AUDITADO: ${titulo}${pais ? ` (${pais})` : ''}
ALINEACIÓN LIBERAL: ${puntaje !== null ? puntaje + '%' : 'sin total general (ningún criterio con SÍ pleno)'}

LAS VOCES:
- JANET: la analista. Seria, precisa, pero cálida — explica sin condescendencia.
- RODERICK: el ciudadano curioso. Hace las preguntas que haría cualquier oyente — sorpresa, ironía, alivio, incredulidad genuina. No es ingenuo, es alguien que no ha leído la ley y quiere entender.

MATERIAL YA SELECCIONADO PARA EL GUION (no elijas otros hallazgos, no agregues criterios que no estén aquí):

${escenasTexto}

${balanceTexto ? `ESCENA DE BALANCE (algo que sí funciona, para que el guion no sea solo denuncia):\n${balanceTexto}` : 'NO HAY UNA ESCENA DE BALANCE DISPONIBLE: este documento no tiene ningún criterio con SÍ pleno ni SÍ con matiz. No inventes una fortaleza que no existe — maneja esto con honestidad, reconociendo directamente que el documento no deja mucho margen para señalar algo positivo, sin que sea un despropósito.'}

${tonoGeneral === 'mayoritariamente_alineado' ? 'NOTA DE ENFOQUE: este documento está mayoritariamente alineado con los postulados liberales. La historia debe sentirse como "esto es lo que te protege", no como una denuncia — los hallazgos negativos (si los hay) son advertencia secundaria, no el eje central.' : ''}

REGLAS DE ESCRITURA:

1. ESTRUCTURA: Apertura (una frase que plantee qué está en juego para alguien como el oyente — nunca empieces con el porcentaje ni con "esta ley regula...") → una escena por cada hallazgo del material seleccionado → escena de balance (si existe) → cierre (menciona el porcentaje de alineación aquí, como remate, no como titular; termina con "Defiende la libertad. Audita el poder.").

2. METÁFORAS — ECONOMÍA, NO DECORACIÓN: usa como máximo 2-3 metáforas distintas en TODO el guion, nunca una por escena. Antes de usar una metáfora en una escena, pregúntate: ¿esto se entiende solo, en lenguaje llano, o de verdad hace falta una imagen para aterrizarlo? Si se entiende solo (por ejemplo, "el precio lo fija una oficina, no el mercado"), no le pongas metáfora encima. Resérvalas para lo estructural o abstracto (poder discrecional, efecto comadreja, ese tipo de cosas). Si reusas una metáfora en más de una escena, que sea una extensión natural de la misma imagen, no una repetición forzada — y verifica que la comparación sea lógicamente correcta: no le atribuyas a la metáfora algo que no le corresponde (ej. no compares un privilegio otorgado por el poder con algo que alguien elige voluntariamente).

3. TONO CONVERSACIONAL: diálogo real, con interjecciones, pausas, alguna interrupción — no un monólogo de Janet cortado artificialmente en dos. Roderick pregunta, reacciona, a veces bromea con algo de ironía. Nada de humor cruel ni sarcasmo hacia las personas — el blanco es el poder mal ejercido, nunca un grupo de personas.

4. FILTRO DOCTRINAL: la línea que separa lo aceptable de lo problemático es liberal-democrático vs. populista/autoritario/totalitario — nunca izquierda vs. derecha. No conviertas esto en un panfleto partidista.

5. FIDELIDAD: cada afirmación del guion debe corresponder a algo real del material seleccionado arriba. No exageres, no inventes artículos ni cifras que no estén ahí.

FORMATO DE RESPUESTA — texto plano, sin JSON, sin markdown, empieza directo con la primera línea de diálogo:

JANET: [emoción entre corchetes, ej. seria/curiosa/pausa] línea de diálogo
RODERICK: [emoción] línea de diálogo
...

No escribas nada antes de la primera línea ni después de la última.`;
}

// ── Paso 3: prompt del revisor (liviano, ciego al razonamiento del generador) ─

function construirPromptRevisor(guion, escenas) {
  const escenasTexto = escenas.nucleo.map(formatearEscena).join('\n\n');
  const balanceTexto = formatearBalance(escenas.balance);

  return `Eres un editor experimentado de contenido conversacional para audiencias generales. A continuación tienes un guion de podcast a dos voces (Janet y Roderick) que explica los hallazgos de una auditoría cívica liberal sobre una ley o política pública, y el material real en el que se basó.

MATERIAL EN EL QUE SE BASÓ EL GUION:

${escenasTexto}

${balanceTexto ? `ESCENA DE BALANCE:\n${balanceTexto}` : '(No había escena de balance disponible para este documento.)'}

GUION A REVISAR:

${guion}

¿Cómo te parece este guion? Revísalo con criterio, prestando especial atención a:
- Si alguna metáfora describe mal lo que compara — le atribuye algo que no corresponde, o confunde en vez de aclarar.
- Si hay demasiadas metáforas distintas, o si se usa una metáfora donde el concepto ya se entendía solo.
- Si el tono entre las dos voces se siente natural o forzado.
- Si el balance final es honesto (ni exagera lo positivo si casi no lo hay, ni omite lo poco positivo que sí exista).
- Si el guion se mantiene fiel al material real, sin inventar ni exagerar.
- Que la línea entre lo aceptable y lo problemático sea liberal-democrático vs. populista/autoritario — nunca izquierda vs. derecha.

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

async function generarGuion(datos, metadatos) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const escenas = seleccionarEscenas(datos);
  const prompt = construirPromptGenerador(escenas, metadatos, datos.puntaje);

  console.log(`   [generarGuion] Escenas seleccionadas: ${escenas.nucleo.length} del núcleo, balance: ${escenas.balance ? escenas.balance.id : 'ninguno'}, tono: ${escenas.tonoGeneral}`);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  const guion = extraerTextoRespuesta(response);
  console.log(`   [generarGuion] Guion generado (${guion.length} chars)`);
  return { guion, escenas };
}

async function revisarGuion(guion, escenas) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = construirPromptRevisor(guion, escenas);

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  const textoRespuesta = extraerTextoRespuesta(response);
  const revision = parsearRevision(textoRespuesta);
  console.log(`   [revisarGuion] Veredicto: ${revision.veredicto}${revision.notas ? ' — ' + revision.notas.slice(0, 120) : ''}`);
  return revision;
}

// Función combinada — genera y revisa en un solo llamado a este módulo.
async function generarYRevisarGuion(datos, metadatos) {
  const { guion, escenas } = await generarGuion(datos, metadatos);
  const revision = await revisarGuion(guion, escenas);
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

// ── Script de prueba manual (no se ejecuta si el archivo solo se importa) ────
// Uso: node generarGuionPresentacion.js /ruta/al/reporte_texto.json
//
// El archivo debe contener solo el JSON de reporte_texto (categorias +
// alertas), tal como se guarda en auditorias.reporte_texto — igual al que
// se usó para probar normalizarDatosEstructurados() el 16 de julio.
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