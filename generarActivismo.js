// generarActivismo.js — ACL Worker
// Umbusk LLC · Auditoría Cívica Liberal
//
// v2 (22 jul 2026) — primera generación real de contenido.
// v3 (31 jul 2026) — FIX + PESOS.
// v5 (4 ago 2026) — ESTILO EDITABLE DESDE ADMIN, DATOS Y SEGURIDAD PROTEGIDOS.
// v4 (4 ago 2026) — obtenerContactosApoyo() PASA A SER RESPALDO.
// v6 (10 ago 2026) — CASO HÍBRIDO, PRIMERA VERSIÓN REAL.
// v7 (13 ago 2026) — FIX max_tokens generarIdeasActivismoTotal().
// [... ver versiones previas del archivo para el detalle completo de cada
// una de las entradas de arriba, sin cambios ...]
//
// v8 (16 ago 2026) — HORIZONTES DESCARTADOS, SELECCIÓN PROPORCIONAL ÚNICA
// PARA PODCAST Y PRESENTACIÓN:
//
// Contexto del cambio: el diseño de "3 horizontes" (en_contra/neutral/
// a_favor, calcularResumenHorizontes() en generarDatosGrafo.js) quedó
// descartado como concepto — ningún producto lo usa ya. Además, el
// veredicto de la Presentación (calcularVeredictoActivismo(), 3 modos:
// rechazo_total/promocion_total/hibrido, umbral 20%/80%) dependía por
// completo de grafo_datos/enlaces — lo cual produjo un bug real:
// grafo_datos.enlaces vacío (por una causa AJENA a este archivo — ver el
// fix en generarDatosGrafo.js v7) hacía que total=0, y total=0 caía
// siempre en "rechazo_total" por defecto, sin haber analizado nada. Caso
// real: un programa de gobierno con 87% de alineación en el Reporte
// mostró "RECHAZAR 100%" en la Presentación.
//
// Decisión de Moisés (16 ago 2026): en vez de parchear ese caso límite,
// se rediseña el mecanismo de fondo. Nueva función,
// seleccionarPuntosDestacados() — reemplaza tanto calcularVeredictoActivismo()
// (Presentación) como seleccionarEscenas() (Podcast, en
// generarGuionPresentacion.js), y pasa a ser la ÚNICA fuente de selección
// para ambos productos:
//
// - Selecciona siempre TOTAL_PUNTOS_DESTACADOS (10 por defecto) criterios
//   — positivos y negativos — en la MISMA proporción que la alineación
//   general del documento. Ej.: 87% de alineación → 9 positivos, 1
//   negativo. 42% → 4 positivos, 6 negativos.
// - La fuente de la alineación es SIEMPRE datos.puntaje — el mismo número
//   que ya calcula y muestra el Reporte — nunca grafo_datos/enlaces. Esto
//   hace que el bug de raíz (grafo_datos vacío) ya no pueda volver a
//   producir un resultado como el del caso real: ni el Podcast ni la
//   Presentación dependen de que Claude haya reconocido bien la
//   estructura del documento (eso sigue siendo trabajo exclusivo del Mapa
//   Mental, que es descriptivo, no una decisión de contenido).
// - Relevancia dentro de cada bolsa: el peso del criterio (/admin/pesos)
//   — decisión explícita de Moisés. Un SÍ con matiz cuenta como positivo
//   (mitad de relevancia que un SÍ pleno del mismo peso — puede seguir
//   ganándole a un SÍ pleno si su peso doctrinal es mucho mayor).
// - Piso: si una bolsa tiene al menos un criterio real disponible pero la
//   proporción redondeó a 0, se fuerza a 1 — nunca se oculta por completo
//   lo positivo ni lo negativo si existe. Pedido explícito del Ala
//   Doctrinal (vía Moisés): las auditorías se sentían "demasiado
//   estrictas" — un documento con buen puntaje debe verse reflejado como
//   tal, no quedar invisible.
// - Se usan TODOS los puntos seleccionados (hasta 10), sin reducir la
//   cantidad para ahorrar llamados — decisión explícita de Moisés:
//   reducir la cantidad de criterios comentados dejaría ocultos muchos
//   aspectos reales, exactamente lo que se busca evitar.
//
// SUPERADAS por este cambio, dejadas intactas sin llamarse desde ningún
// punto activo del pipeline (mismo criterio que ya usa este proyecto con
// otro código superado — no se borran, por si hace falta retomarlas o
// compararlas más adelante):
// - calcularVeredictoActivismo() y sus umbrales UMBRAL_RECHAZO_TOTAL /
//   UMBRAL_PROMOCION_TOTAL.
// - seleccionarCriteriosHibridos() (selección por "1 criterio por cada
//   una de las 7 categorías con más criterios" — reemplazada por
//   selección pura por peso, sin ese paso de diversidad por categoría).
// - generarIdeasActivismoTotal() y construirPromptIdeasActivismo() (el
//   llamado único que generaba 3-5 ideas agrupadas para el caso "total")
//   — reemplazado por generarIdeaActivismoCriterio() (sin cambios en su
//   propia lógica), llamado una vez por cada punto seleccionado, para
//   TODOS los casos, no solo el híbrido.
//
// SIN CAMBIOS: generarIdeaActivismoCriterio(), construirPromptIdeaActivismoCriterio(),
// CATEGORIAS_ACTIVISMO, MENU_TACTICAS_ACTIVISMO, los textos de respaldo de
// estilo, y obtenerContactosApoyo() — toda esta maquinaria sigue siendo la
// que genera cada idea individual; lo único que cambió es CUÁNTOS
// criterios se seleccionan y CÓMO se decide cuáles.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const UMBRAL_RECHAZO_TOTAL   = 0.20;
const UMBRAL_PROMOCION_TOTAL = 0.80;

// ── SUPERADA (16 ago 2026) — veredicto general por horizontes ────────────
// Ver el changelog v8 arriba. Se deja intacta, sin llamarse.
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

// ── Ideas de activismo — SUPERADO (16 ago 2026), caso "total" agrupado ───
// Ver changelog v8. Se deja intacto, sin llamarse.
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

// ── Ideas de activismo — UNA idea por criterio (EN USO desde el 10 ago
// 2026 para el caso híbrido; desde el 16 ago 2026, para TODOS los casos —
// ver seleccionarPuntosDestacados() más abajo) ──
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

// ── SUPERADO (16 ago 2026) — construirPromptIdeasActivismo() y
// generarIdeasActivismoTotal() — ver changelog v8. Se dejan intactos, sin
// llamarse desde ningún punto activo del pipeline.
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
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
    output_config: {
      format: { type: 'json_schema', schema: SCHEMA_IDEAS_ACTIVISMO_TOTAL },
    },
  });

  if (response.stop_reason === 'max_tokens') {
    throw new Error(`generarIdeasActivismoTotal [${auditoria_id}]: respuesta cortada por max_tokens (4000) — subir el límite.`);
  }
  if (response.stop_reason === 'refusal') {
    throw new Error(`generarIdeasActivismoTotal [${auditoria_id}]: Claude rehusó generar las ideas (stop_reason: refusal).`);
  }

  const texto = extraerTextoRespuesta(response);
  const datosRespuesta = JSON.parse(texto);
  return datosRespuesta.ideas;
}

// ── SUPERADA (16 ago 2026) — selección del caso híbrido por categoría ────
// Ver changelog v8. Se deja intacta, sin llamarse.
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

// ══════════════════════════════════════════════════════════════════════
// ── EN USO (16 ago 2026) — selección proporcional, Podcast + Presentación
// ══════════════════════════════════════════════════════════════════════
// Ver el changelog v8 completo al inicio del archivo para el porqué.
// Reemplaza a seleccionarCriteriosHibridos() (arriba) y a
// seleccionarEscenas() (generarGuionPresentacion.js). Es la única función
// de selección que usan hoy tanto el Podcast como la Presentación — así,
// cuando ambos productos hablan del "mismo" hallazgo, es literalmente el
// mismo criterio, no una selección independiente que podría no coincidir.

const TOTAL_PUNTOS_DESTACADOS = 10;

// Valor de un criterio dentro de la bolsa "positivos": un SÍ pleno vale el
// doble que un SÍ con matiz del mismo peso doctrinal — decisión explícita
// de Moisés (16 ago 2026): "interpretemos los SI_MATIZ como positivos,
// pero su relevancia es menor si hay SI completo". Un SÍ con matiz de
// mucho más peso igual puede superar a un SÍ pleno de poco peso.
function valorPositivoCriterio(criterio) {
  if (criterio.resultado === 'SI') return 1;
  if (criterio.resultado === 'SI_MATIZ') return 0.5;
  return 0;
}

// Alineación general del documento, para decidir la proporción 0-100.
// SIEMPRE datos.puntaje (el mismo número que ya ve el ciudadano en el
// Reporte) cuando existe — nunca grafo_datos/enlaces, a propósito: esto
// es lo que hace que el bug de raíz (reconocimiento de artículos fallido)
// ya no pueda volver a afectar ni al Podcast ni a la Presentación. Solo
// si datos.puntaje viene null (caso raro: documento sin ningún SÍ pleno,
// la fórmula del Reporte lo exige) se recalcula acá con el mismo criterio
// de ponderación pero sin esa restricción, para que la selección nunca se
// quede sin base.
function calcularAlineacionParaSeleccion(datos, pesosCriterios) {
  if (datos.puntaje !== null && datos.puntaje !== undefined) return Number(datos.puntaje);
  const criterios = datos.categorias.flatMap(cat => cat.criterios).filter(c => c.resultado !== 'NA');
  if (criterios.length === 0) return 0;
  let sumaPeso = 0, sumaPonderada = 0;
  criterios.forEach(c => {
    const peso = pesoDeCriterioActivismo(c.id, pesosCriterios);
    sumaPeso += peso;
    sumaPonderada += peso * valorPositivoCriterio(c);
  });
  return sumaPeso > 0 ? Math.round((sumaPonderada / sumaPeso) * 100) : 0;
}

// Selecciona hasta `totalPuntos` criterios (10 por defecto): positivos y
// negativos, en la misma proporción que la alineación general. Cada
// elemento devuelto trae { criterio, categoriaDoctrinal: {num, nombre} } —
// mismo formato que ya esperaba generarIdeaActivismoCriterio().
function seleccionarPuntosDestacados(datos, pesosCriterios = {}, totalPuntos = TOTAL_PUNTOS_DESTACADOS) {
  const todos = [];
  datos.categorias.forEach(cat => {
    cat.criterios.forEach(c => {
      if (c.resultado === 'NA') return;
      todos.push({ criterio: c, categoriaDoctrinal: { num: cat.num, nombre: cat.nombre } });
    });
  });

  const positivos = todos
    .filter(item => item.criterio.resultado === 'SI' || item.criterio.resultado === 'SI_MATIZ')
    .sort((a, b) =>
      (pesoDeCriterioActivismo(b.criterio.id, pesosCriterios) * valorPositivoCriterio(b.criterio)) -
      (pesoDeCriterioActivismo(a.criterio.id, pesosCriterios) * valorPositivoCriterio(a.criterio))
    );
  const negativos = todos
    .filter(item => item.criterio.resultado === 'NO')
    .sort((a, b) => pesoDeCriterioActivismo(b.criterio.id, pesosCriterios) - pesoDeCriterioActivismo(a.criterio.id, pesosCriterios));

  const alineacionPorcentaje = calcularAlineacionParaSeleccion(datos, pesosCriterios);

  let nPositivos = Math.round((alineacionPorcentaje / 100) * totalPuntos);
  let nNegativos = totalPuntos - nPositivos;

  // Piso: nunca ocultar por completo un lado que sí tiene al menos un
  // criterio real disponible — pedido explícito del Ala Doctrinal.
  if (nPositivos === 0 && positivos.length > 0) {
    nPositivos = 1;
    nNegativos = Math.max(0, nNegativos - 1);
  }
  if (nNegativos === 0 && negativos.length > 0) {
    nNegativos = 1;
    nPositivos = Math.max(0, nPositivos - 1);
  }

  // No pedir más de lo que realmente existe en cada bolsa.
  nPositivos = Math.min(nPositivos, positivos.length);
  nNegativos = Math.min(nNegativos, negativos.length);

  // Si alguna bolsa se quedó corta de candidatos reales, el cupo sobrante
  // pasa a la otra (nunca se desperdicia cupo si hay más material
  // disponible del otro lado).
  const cupoUsado = nPositivos + nNegativos;
  let cupoLibre = Math.min(totalPuntos, positivos.length + negativos.length) - cupoUsado;
  if (cupoLibre > 0) {
    const extraPositivos = Math.min(cupoLibre, positivos.length - nPositivos);
    nPositivos += extraPositivos;
    cupoLibre -= extraPositivos;
    const extraNegativos = Math.min(cupoLibre, negativos.length - nNegativos);
    nNegativos += extraNegativos;
  }

  return {
    alineacionPorcentaje,
    positivos: positivos.slice(0, nPositivos),
    negativos: negativos.slice(0, nNegativos),
  };
}

// ── Caso híbrido — generación, UN llamado a Claude por criterio (10 ago
// 2026) — SIN CAMBIOS: desde el 16 ago 2026 esta es la única forma en la
// que se genera una idea, para TODOS los puntos seleccionados por
// seleccionarPuntosDestacados(), no solo el caso híbrido de antes.
// `tipo` es 'rechazo' | 'mejora' | 'promocion', según el resultado real
// del criterio (NO / SI_MATIZ / SI) — lo decide el llamador
// (generarPresentacionPDF.js), que ya tiene ese mapa.
function construirPromptIdeaActivismoCriterio(criterio, categoriaDoctrinal, metadatos, tipo, estiloPersona = null, reglasGeneracion = null) {
  const persona = (estiloPersona && estiloPersona.trim()) ? estiloPersona.trim() : TEXTO_PERSONA_ACTIVISMO_RESPALDO;
  const reglas  = (reglasGeneracion && reglasGeneracion.trim()) ? reglasGeneracion.trim() : TEXTO_REGLAS_ACTIVISMO_RESPALDO;
  const accionPorTipo = { rechazo: 'rechazar y frenar', mejora: 'exigir que se corrija o aclare', promocion: 'promover y defender' };

  return `${persona}

Te toca generar UNA sola idea de activismo, enfocada exclusivamente en el siguiente criterio de este documento.

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
  // EN USO:
  seleccionarPuntosDestacados,
  generarIdeaActivismoCriterio,
  obtenerContactosApoyo,
  // SUPERADAS — se dejan exportadas por compatibilidad, sin llamarse desde
  // ningún punto activo del pipeline (ver changelog v8):
  calcularVeredictoActivismo,
  construirPromptIdeasActivismo,
  generarIdeasActivismoTotal,
  seleccionarCriteriosHibridos,
};