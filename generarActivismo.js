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
// v3 (31 jul 2026) — FIX + PESOS: calcularVeredictoActivismo() ahora usa
// neutral.peso / a_favor.peso en vez de neutral.cantidad / a_favor.cantidad
// cuando esos campos vienen presentes en resumenHorizontes (ver
// calcularResumenHorizontes() en generarDatosGrafo.js v2 — suma ponderada
// por los pesos de criterios de /admin/pesos, en vez de contar enlaces
// crudos). Con fallback a .cantidad si algún llamador todavía pasa un
// resumenHorizontes sin .peso, para no romper nada. De paso: se descubrió
// (31 jul 2026) que generarPresentacionPDF.js llamaba a esta función
// pasando SIEMPRE un resumenHorizontes con total=0 (por un bug ajeno a
// este archivo — ver el fix en generarPresentacionPDF.js v2.5 y
// worker.js v3.12), lo cual hacía que el veredicto fuera RECHAZO TOTAL en
// el 100% de las Presentaciones generadas hasta hoy, sin importar el
// documento. Esta función en sí nunca tuvo el bug — solo recibía datos
// vacíos de su llamador.
//
// v5 (4 ago 2026) — ESTILO EDITABLE DESDE ADMIN, DATOS Y SEGURIDAD
// PROTEGIDOS: generarIdeasActivismoTotal() ahora acepta estiloPersona y
// reglasGeneracion opcionales (worker.js los lee de prompts_productos,
// claves "presentacion_activismo_estilo" y "presentacion_activismo_reglas").
// Solo se expusieron dos fragmentos genuinamente de estilo, sin dato y sin
// riesgo — la frase de apertura y las reglas de generación no relacionadas
// con seguridad. A propósito NO se expusieron: el menú de 14 tácticas
// (MENU_TACTICAS_ACTIVISMO, acoplado al enum de CATEGORIAS_ACTIVISMO en el
// schema — editarlo sin tocar el código desincronizaría ambos), ni las dos
// reglas de seguridad de contenido (no violencia, no testimonios
// fabricados) — esas siguen siempre fijas, en la misma posición, sin
// importar qué haya guardado en la base de datos. Mismo patrón de
// TEXTO_..._RESPALDO que ya usan generarDatosGrafo.js y
// generarGuionPresentacion.js.
//

// v4 (4 ago 2026) — obtenerContactosApoyo() PASA A SER RESPALDO, NO FUENTE
// PRINCIPAL: la lista real y curada ahora vive en la tabla contactos_apoyo
// (worker.js: /contactos-apoyo/*, pantalla /admin/contactos-apoyo).
// generarPresentacionPDF.js recibe esa lista real como parámetro y solo
// llama a esta función si la tabla todavía no tiene ningún contacto activo
// — sin cambios de código acá, solo de rol: esto sigue siendo la red de
// seguridad ("nunca mostrar una lámina de contacto completamente vacía"),
// no la fuente de verdad. Se deja intacta, DUMMY, hasta que se decida si
// vale la pena borrarla una vez la tabla esté sembrada de forma
// confiable.
//
// v6 (10 ago 2026) — CASO HÍBRIDO, PRIMERA VERSIÓN REAL: la primera
// auditoría real que cayó en la banda híbrida (20%-80%) expuso el hueco
// documentado desde julio — la Presentación mostraba un texto de relleno
// ("[PENDIENTE...]") en vez de una idea real, criterio por criterio.
// Decisión de Moisés (10 ago 2026): en vez de cubrir los ~24 criterios
// aplicables típicos de un documento híbrido (demasiado, la Presentación
// "no debe ser exhaustiva — son solo ideas para impulsar el activismo"),
// se genera UNA idea real por cada una de las 7 categorías doctrinales
// (de las 12) con más criterios — dentro de cada una, el criterio de
// mayor peso entre los que aplican a este documento. El "dato de
// gravedad/severidad" que faltaba en julio para hacer esta selección ya
// existe: es el peso de /admin/pesos, agregado esta semana para el
// tamaño de esferas del Mapa Mental — la misma pieza sirve para las dos
// cosas. Nuevo: seleccionarCriteriosHibridos() (puro, sin Claude) y
// generarIdeaActivismoCriterio() (un llamado a Claude por criterio
// seleccionado, mismo menú de tácticas y mismas reglas de seguridad
// protegidas que generarIdeasActivismoTotal() — nunca editables). Ver el
// changelog completo del lado de generarPresentacionPDF.js (v3.0) para
// cómo se conecta esto a las láminas reales.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const UMBRAL_RECHAZO_TOTAL   = 0.20;
const UMBRAL_PROMOCION_TOTAL = 0.80;

// ── Veredicto general del instrumento ────────────────────────────────────
function calcularVeredictoActivismo(resumenHorizontes) {
  const { total, neutral, a_favor } = resumenHorizontes;
  const pesoNeutral = neutral.peso !== undefined ? neutral.peso : neutral.cantidad;
  const pesoAFavor  = a_favor.peso  !== undefined ? a_favor.peso  : a_favor.cantidad;
  const alineacionFraccion = total > 0
    ? (pesoNeutral + pesoAFavor) / total
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
function extraerTextoRespuesta(response) {
  const bloqueTexto = response.content.find(b => b.type === 'text');
  if (!bloqueTexto) {
    throw new Error('generarActivismo: la respuesta de Claude no incluyó ningún bloque de texto');
  }
  return bloqueTexto.text;
}

// ── Taxonomía de 14 categorías de activismo (Moisés, vía ChatGPT, 22 jul
// 2026) — reemplaza las 5 categorías improvisadas de la versión anterior.
// Cada categoría corresponde a UNA ilustración genérica reutilizable
// (activismo-{slug}.png en public/presentacion/ del repo
// auditoria-civica-liberal) — hoy solo existe 'redes_sociales'.
const CATEGORIAS_ACTIVISMO = [
  { slug: 'redes_sociales',            nombre: 'Redes sociales y plataformas digitales' },
  { slug: 'contacto_representantes',   nombre: 'Contacto directo con representantes públicos' },
  { slug: 'deliberacion_publica',      nombre: 'Participación en espacios públicos de deliberación' },
  { slug: 'prensa_medios',             nombre: 'Prensa y medios de comunicación' },
  { slug: 'movilizacion_ciudadana',    nombre: 'Movilización ciudadana' },
  { slug: 'peticiones_adhesiones',     nombre: 'Peticiones y adhesiones públicas' },
  { slug: 'evidencia_argumentos',      nombre: 'Producción de evidencia y argumentos' },
  { slug: 'comunitario_territorial',   nombre: 'Activismo comunitario y territorial' },
  { slug: 'electoral',                 nombre: 'Activismo electoral' },
  { slug: 'accion_juridica',           nombre: 'Acción jurídica e institucional' },
  { slug: 'economico',                 nombre: 'Activismo económico' },
  { slug: 'educacion_multiplicadores', nombre: 'Educación y formación de multiplicadores' },
  { slug: 'creativo_cultural',         nombre: 'Acciones creativas y culturales' },
  { slug: 'coaliciones',               nombre: 'Construcción de coaliciones' },
];

const MENU_TACTICAS_ACTIVISMO = `
1. Redes sociales y plataformas digitales: publicar infografías breves y visuales; crear videos cortos (Reels/TikTok/Shorts) o más largos en YouTube; publicar hilos en X/Threads/Bluesky; diseñar carruseles con datos y preguntas frecuentes; compartir testimonios reales de personas afectadas; transmisiones en vivo con especialistas; podcasts; campañas con hashtags; memes o piezas de humor político; micrositio con documentos descargables; boletines por correo; grupos de difusión (WhatsApp/Telegram/Signal); responder públicamente a desinformación.
2. Contacto directo con representantes públicos: cartas o correos personalizados a congresistas/diputados/concejales; llamadas a sus oficinas; solicitar reuniones; entregar documentos técnicos; proponer modificaciones a un proyecto de ley; participar en consultas públicas; intervenir en audiencias legislativas; coordinar campañas de contacto masivo en un periodo determinado; pedir rendición de cuentas sobre una votación.
3. Participación en espacios públicos de deliberación: foros ciudadanos; mesas redondas; conversatorios en universidades o centros culturales; cabildos abiertos; asambleas vecinales; debates públicos entre posiciones distintas; grupos de estudio; talleres de formación ciudadana; invitar a funcionarios a responder preguntas públicamente.
4. Prensa y medios de comunicación: cartas al director; artículos de opinión o columnas; comunicados de prensa; proponer entrevistas u ofrecer voceros especializados; programas de radio o TV; ruedas de prensa; sala de prensa digital con datos y gráficos; responder a editoriales o declaraciones oficiales.
5. Movilización ciudadana: marchas o concentraciones pacíficas; vigilias; cadenas humanas; plantones frente a instituciones; caravanas; cacerolazos u otras expresiones públicas no violentas; intervenciones artísticas en espacios públicos; eventos musicales o culturales relacionados con la causa.
6. Peticiones y adhesiones públicas: peticiones en línea o firmas físicas; declaraciones públicas de apoyo o rechazo; adhesiones de académicos, artistas o asociaciones; cartas abiertas; manifiestos; compromisos públicos para candidatos.
7. Producción de evidencia y argumentos: informes técnicos y resúmenes ejecutivos; análisis de impacto económico/social/jurídico; visualizaciones de datos; comparación de experiencias internacionales; documentar casos concretos; encuestas; observatorios ciudadanos; verificar afirmaciones de autoridades.
8. Activismo comunitario y territorial: visitas y reuniones casa por casa; volantes y afiches autorizados; jornadas informativas en mercados o plazas; comités locales; capacitar líderes vecinales; campañas puerta a puerta adaptadas a cada comunidad.
9. Activismo electoral: preguntar a candidatos su posición; comparar programas electorales; guías de votación; debates entre candidatos; promover el registro electoral; informar fechas y requisitos para votar; observación electoral; monitorear promesas de campaña.
10. Acción jurídica e institucional: solicitudes de información pública; recursos administrativos; observaciones formales a reglamentos; solicitar revisiones de constitucionalidad; litigios estratégicos; denuncias ante organismos de control; defensorías o contralorías; amicus curiae en casos relevantes.
11. Activismo económico: boicots legales y no violentos; campañas de compra responsable; apoyar empresas alineadas con la causa; fondos para investigación o comunicación educativa; transparencia en donaciones políticas; pedir a empresas una posición pública.
12. Educación y formación de multiplicadores: manuales breves y kits de activismo; capacitar voceros; escuelas de liderazgo cívico; guías para hablar con familiares o vecinos; equipos de verificación de información; materiales para docentes y estudiantes.
13. Acciones creativas y culturales: ilustraciones, historietas o animaciones; cortometrajes; exposiciones; canciones, poesía o teatro; performances; murales autorizados; campañas fotográficas; narrativas personales; concursos de diseño o video.
14. Construcción de coaliciones: reunir organizaciones con intereses comunes; coordinar mensajes entre grupos distintos; plataforma compartida; dividir responsabilidades (investigación, vocería, movilización); acordar demandas mínimas comunes; alianzas entre sectores sociales, empresariales, académicos y comunitarios.
`.trim();

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
          categoria: {
            type: 'string',
            enum: CATEGORIAS_ACTIVISMO.map(c => c.slug),
            description: 'La categoría del menú de tácticas de activismo (ver MENÚ DE TÁCTICAS en el prompt) a la que pertenece la acción principal de esta idea.',
          },
        },
        required: ['titulo', 'descripcion', 'categoria'],
        additionalProperties: false,
      },
    },
  },
  required: ['ideas'],
  additionalProperties: false,
};

// ── Ideas de activismo — caso híbrido, UNA idea por criterio (10 ago 2026) ──
// Mismas 3 propiedades que el caso total, pero para un solo criterio a la
// vez — no envueltas en un arreglo, porque cada llamado genera una sola
// idea (ver generarIdeaActivismoCriterio()).
const SCHEMA_IDEA_ACTIVISMO_UNICA = {
  type: 'object',
  properties: {
    titulo: {
      type: 'string',
      description: 'Nombre corto de la acción, 4 a 8 palabras (ej. "Campaña de etiquetado en redes").',
    },
    descripcion: {
      type: 'string',
      description: '1 a 3 oraciones concretas y accionables, específicas a este criterio y a este documento.',
    },
    categoria: {
      type: 'string',
      enum: CATEGORIAS_ACTIVISMO.map(c => c.slug),
      description: 'La categoría del menú de tácticas de activismo (ver MENÚ DE TÁCTICAS en el prompt) a la que pertenece la acción principal de esta idea.',
    },
  },
  required: ['titulo', 'descripcion', 'categoria'],
  additionalProperties: false,
};

// ── Bloques de ESTILO — editables desde /admin/productos-comunicacionales ──
// Texto de respaldo idéntico al que ya vivía fijo en el prompt. A propósito
// NO se exponen aquí: el menú de tácticas (MENU_TACTICAS_ACTIVISMO, acoplado
// al enum del schema vía CATEGORIAS_ACTIVISMO) ni las dos reglas de
// seguridad de contenido (no violencia, no testimonios fabricados) — esas
// se quedan siempre fijas en construirPromptIdeasActivismo() y
// construirPromptIdeaActivismoCriterio(), sin excepción, sin importar qué
// se guarde en prompts_productos.
const TEXTO_PERSONA_ACTIVISMO_RESPALDO = `Eres un asistente de activismo cívico no violento para liberalmente.app, una plataforma de auditoría ciudadana de leyes y políticas públicas desde una perspectiva liberal.`;

const TEXTO_REGLAS_ACTIVISMO_RESPALDO = `Basa cada idea en una o más tácticas concretas del menú de arriba, adaptadas específicamente a este documento (referenciando su tema, artículos o país cuando ayude a que no suene genérica) — no un consejo que serviría igual para cualquier ley. Usa categorías variadas entre las ideas (evita repetir la misma categoría más de una vez salvo que el contexto realmente lo amerite) — cada categoría tiene su propia ilustración, y la variedad hace la presentación más rica visualmente.`;

// Construye el prompt completo. estiloPersona / reglasGeneracion: opcionales
// — si vienen null o vacíos, se usa el texto de respaldo de arriba.
// worker.js los lee de prompts_productos antes de llamar a
// generarIdeasActivismoTotal(). El resto del prompt —datos reales, menú de
// tácticas, reglas de seguridad— siempre se arma igual, en código, en la
// misma posición exacta que ya tenía.
function construirPromptIdeasActivismo(datos, metadatos, veredicto, estiloPersona = null, reglasGeneracion = null) {
  const esRechazo = veredicto.modo === 'rechazo_total';

  const criterios = datos.categorias.flatMap(cat => cat.criterios).filter(c => c.resultado !== 'NA');
  const listaCriterios = criterios
    .map(c => `- ${c.id} [${c.resultado}]: ${c.analisis}`)
    .join('\n');

  const persona = (estiloPersona && estiloPersona.trim()) ? estiloPersona.trim() : TEXTO_PERSONA_ACTIVISMO_RESPALDO;
  const reglas  = (reglasGeneracion && reglasGeneracion.trim()) ? reglasGeneracion.trim() : TEXTO_REGLAS_ACTIVISMO_RESPALDO;

  return `${persona}

Este instrumento normativo obtuvo ${veredicto.alineacionPorcentaje}% de impacto liberal, lo cual amerita una recomendación de ${esRechazo ? 'RECHAZO TOTAL' : 'PROMOCIÓN TOTAL'}.

DOCUMENTO: ${metadatos.titulo}${metadatos.pais ? ` (${metadatos.pais})` : ''}

RESULTADOS POR CRITERIO:
${listaCriterios}

MENÚ DE TÁCTICAS DE ACTIVISMO (catálogo curado, en la tradición de Gene Sharp adaptada al contexto actual — elige de aquí, no inventes tácticas fuera de este menú):
${MENU_TACTICAS_ACTIVISMO}

Genera de 3 a 5 ideas concretas de activismo cívico no violento para que un ciudadano actúe sobre este veredicto — ${esRechazo ? 'orientadas a rechazar y frenar este instrumento' : 'orientadas a promover y defender este instrumento'}. ${reglas}

Nunca sugieras violencia, daño a personas o propiedad, ni acciones ilegales. Nunca sugieras fabricar testimonios, relatos personales o citas atribuidas a personas que no sean reales y presentarlos como si lo fueran — el contenido debe ser siempre veraz y transparente sobre su origen, aunque se use IA para producirlo (videos explicativos, infografías o resúmenes son apropiados; testimonios inventados o "compuestos" presentados como reales no lo son).`;
}

async function generarIdeasActivismoTotal(datos, metadatos, veredicto, auditoria_id = 'N/A', estiloPersona = null, reglasGeneracion = null) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = construirPromptIdeasActivismo(datos, metadatos, veredicto, estiloPersona, reglasGeneracion);

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

// ── Caso híbrido — selección de criterios (10 ago 2026) ──────────────────
// Pura, sin llamar a Claude. Decisión de Moisés: la Presentación de un
// documento híbrido no debe ser exhaustiva (cubrir los ~24 criterios
// aplicables típicos sería demasiado) — son solo ideas puntuales para
// impulsar el activismo. Selecciona hasta 7 criterios: uno por cada una
// de las 7 categorías doctrinales (de las 12 totales) con más criterios,
// y dentro de cada una, el de mayor peso entre los que aplican a este
// documento (resultado !== 'NA'). Una categoría sin ningún criterio
// aplicable en este documento en particular se omite sin más — nunca se
// fuerza una selección artificial.
function pesoDeCriterioActivismo(criterioId, pesosCriterios) {
  const valor = pesosCriterios ? pesosCriterios[criterioId] : undefined;
  if (valor && typeof valor === 'object') {
    const numero = Number(valor.peso);
    return (valor.peso !== undefined && !Number.isNaN(numero)) ? numero : 1;
  }
  const numero = Number(valor);
  return (valor !== undefined && !Number.isNaN(numero)) ? numero : 1;
}

function seleccionarCriteriosHibridos(datos, pesosCriterios = {}) {
  const categoriasOrdenadas = [...datos.categorias]
    .sort((a, b) => b.criterios.length - a.criterios.length)
    .slice(0, 7);

  const seleccion = [];
  categoriasOrdenadas.forEach(cat => {
    const aplicables = cat.criterios.filter(c => c.resultado !== 'NA');
    if (aplicables.length === 0) return;
    const elegido = aplicables.reduce(
      (mayor, c) => pesoDeCriterioActivismo(c.id, pesosCriterios) > pesoDeCriterioActivismo(mayor.id, pesosCriterios) ? c : mayor,
      aplicables[0]
    );
    seleccion.push({ criterio: elegido, categoriaDoctrinal: { num: cat.num, nombre: cat.nombre } });
  });
  return seleccion;
}

// ── Caso híbrido — generación, UN llamado a Claude por criterio ──────────
// Mismo menú de tácticas y mismas reglas de seguridad de contenido que
// generarIdeasActivismoTotal() — nunca editables desde Admin, siempre
// fijas en código. `tipo` es 'rechazo' | 'mejora' | 'promocion', según el
// resultado real del criterio (NO / SI_MATIZ / SI) — lo decide el
// llamador (generarPresentacionPDF.js), que ya tiene ese mapa.
function construirPromptIdeaActivismoCriterio(criterio, categoriaDoctrinal, metadatos, tipo, estiloPersona = null, reglasGeneracion = null) {
  const persona = (estiloPersona && estiloPersona.trim()) ? estiloPersona.trim() : TEXTO_PERSONA_ACTIVISMO_RESPALDO;
  const reglas  = (reglasGeneracion && reglasGeneracion.trim()) ? reglasGeneracion.trim() : TEXTO_REGLAS_ACTIVISMO_RESPALDO;
  const accionPorTipo = { rechazo: 'rechazar y frenar', mejora: 'exigir que se corrija o aclare', promocion: 'promover y defender' };

  return `${persona}

Este documento obtuvo un resultado mixto en la auditoría — no amerita ni rechazo total ni apoyo total, sino acciones puntuales, criterio por criterio. Te toca generar UNA sola idea de activismo, enfocada exclusivamente en el siguiente criterio.

DOCUMENTO: ${metadatos.titulo}${metadatos.pais ? ` (${metadatos.pais})` : ''}

CRITERIO (Categoría ${categoriaDoctrinal.num} — ${categoriaDoctrinal.nombre}):
${criterio.id} [${criterio.resultado}]: ${criterio.pregunta}
Análisis: ${criterio.analisis}

MENÚ DE TÁCTICAS DE ACTIVISMO (catálogo curado, en la tradición de Gene Sharp adaptada al contexto actual — elige de aquí, no inventes tácticas fuera de este menú):
${MENU_TACTICAS_ACTIVISMO}

Genera UNA idea concreta de activismo cívico no violento para ${accionPorTipo[tipo]} lo que encontró este criterio específico. ${reglas}

Nunca sugieras violencia, daño a personas o propiedad, ni acciones ilegales. Nunca sugieras fabricar testimonios, relatos personales o citas atribuidas a personas que no sean reales y presentarlos como si lo fueran — el contenido debe ser siempre veraz y transparente sobre su origen, aunque se use IA para producirlo (videos explicativos, infografías o resúmenes son apropiados; testimonios inventados o "compuestos" presentados como reales no lo son).`;
}

async function generarIdeaActivismoCriterio(criterio, categoriaDoctrinal, metadatos, tipo, auditoria_id = 'N/A', estiloPersona = null, reglasGeneracion = null) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = construirPromptIdeaActivismoCriterio(criterio, categoriaDoctrinal, metadatos, tipo, estiloPersona, reglasGeneracion);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
    output_config: {
      format: { type: 'json_schema', schema: SCHEMA_IDEA_ACTIVISMO_UNICA },
    },
  });

  if (response.stop_reason === 'max_tokens') {
    throw new Error(`generarIdeaActivismoCriterio [${auditoria_id}] (${criterio.id}): respuesta cortada por max_tokens (1000) — subir el límite.`);
  }
  if (response.stop_reason === 'refusal') {
    throw new Error(`generarIdeaActivismoCriterio [${auditoria_id}] (${criterio.id}): Claude rehusó generar la idea (stop_reason: refusal).`);
  }

  const texto = extraerTextoRespuesta(response);
  const idea = JSON.parse(texto);
  return { criterioId: criterio.id, resultado: criterio.resultado, idea };
}

// ── Lámina de contacto — RESPALDO, ya no es la fuente principal ─────────
// Ver v4 en el changelog: la lista real vive en la tabla contactos_apoyo
// (worker.js), leída por obtenerContactosApoyoActivos() y pasada como
// parámetro a generarPresentacionPDF(). Esta función solo se invoca ahí
// como red de seguridad si esa tabla todavía no tiene ningún contacto
// activo — nunca se llama directo desde el pipeline principal.
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
  construirPromptIdeasActivismo,
  generarIdeasActivismoTotal,
  seleccionarCriteriosHibridos,
  generarIdeaActivismoCriterio,
  obtenerContactosApoyo,
};