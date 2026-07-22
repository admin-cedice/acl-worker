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

// Menú completo de tácticas por categoría — se le pasa a Claude como
// referencia en el prompt, para que elija acciones concretas de un
// catálogo curado en vez de inventar desde cero. Texto de Moisés (vía
// ChatGPT, 22 jul 2026), sin alterar su contenido.
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

MENÚ DE TÁCTICAS DE ACTIVISMO (catálogo curado, en la tradición de Gene Sharp adaptada al contexto actual — elige de aquí, no inventes tácticas fuera de este menú):
${MENU_TACTICAS_ACTIVISMO}

Genera de 3 a 5 ideas concretas de activismo cívico no violento para que un ciudadano actúe sobre este veredicto — ${esRechazo ? 'orientadas a rechazar y frenar este instrumento' : 'orientadas a promover y defender este instrumento'}. Basa cada idea en una o más tácticas concretas del menú de arriba, adaptadas específicamente a este documento (referenciando su tema, artículos o país cuando ayude a que no suene genérica) — no un consejo que serviría igual para cualquier ley. Usa categorías variadas entre las ideas (evita repetir la misma categoría más de una vez salvo que el contexto realmente lo amerite) — cada categoría tiene su propia ilustración, y la variedad hace la presentación más rica visualmente. Nunca sugieras violencia, daño a personas o propiedad, ni acciones ilegales. Nunca sugieras fabricar testimonios, relatos personales o citas atribuidas a personas que no sean reales y presentarlos como si lo fueran — el contenido debe ser siempre veraz y transparente sobre su origen, aunque se use IA para producirlo (videos explicativos, infografías o resúmenes son apropiados; testimonios inventados o "compuestos" presentados como reales no lo son).`;

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