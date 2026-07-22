// generarPresentacionPDF.js — ACL Worker
// Umbusk LLC · Auditoría Cívica Liberal
//
// Presentación v2.4 (22 jul 2026) — pensada de verdad como diapositivas
// para pantalla, no como documento impreso reducido:
//   1. Cada idea de Activismo (caso total) pasa a ser SU PROPIA lámina —
//      no una lista de 3-5 ideas apretadas en una página. Cada una trae
//      una ilustración grande a un lado, según su `categoria`
//      (redes_sociales/carta/foro/monitoreo/medios) — 5 ilustraciones
//      GENÉRICAS reutilizables por categoría, no una distinta por idea
//      individual. HOY SOLO EXISTE LA DE 'redes_sociales' (la que subió
//      Moisés, 22 jul) — se espera en
//      public/presentacion/activismo-redes-sociales.png del repo
//      auditoria-civica-liberal. Las otras 4 (activismo-carta.png,
//      activismo-foro.png, activismo-monitoreo.png, activismo-medios.png)
//      todavía no existen — mientras tanto esas láminas muestran un
//      rectángulo de color liso en vez de imagen rota (ver
//      .idea-ilustracion, background-image con fallback de color, no
//      <img> — así no se ve un ícono de "imagen rota" si el archivo
//      todavía no está).
//   2. Tipografía subida en todo el documento — pensada para proyectarse
//      o leerse en pantalla, no para imprimirse de cerca. El único bloque
//      que NO se agrandó a propósito es el masthead de portada (logo/
//      créditos/etiqueta), porque ese sí debía replicar exactamente al
//      Reporte, por pedido explícito de Moisés.
//   3. Como consecuencia esperada y aceptada: el caso híbrido y el caso
//      total ya no intentan caber en una sola página — el documento
//      fluye en tantas láminas como haga falta.
//
// SIN CAMBIOS: mecanismo HTML→PDF (CloudConvert), mapa temporal de
// HTMLs, firma pública de generarPresentacionPDF(). La lámina de
// hallazgos ilustrados sigue definida pero sin llamarse (ver v2.2).

'use strict';

const fs = require('fs');
const { calcularDatosGrafo, calcularResumenHorizontes, etiquetaCortaComponente } = require('./generarDatosGrafo');
const { calcularVeredictoActivismo, generarIdeasActivismoTotal, obtenerContactosApoyo } = require('./generarActivismo');

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Asunción sin confirmar del todo — solo usada por la lámina de
// hallazgos, hoy sin llamarse ──────────────────────────────────────────
const RUTA_BASE_IMAGENES = 'https://liberalmente.app/presentacion';

// Una ilustración genérica por categoría de canal — NO una por idea.
// Solo 'redes_sociales' existe hoy (ver nota de cabecera).
const ILUSTRACION_POR_CATEGORIA = {
  redes_sociales: 'activismo-redes-sociales.png',
  carta:          'activismo-carta.png',
  foro:           'activismo-foro.png',
  monitoreo:      'activismo-monitoreo.png',
  medios:         'activismo-medios.png',
};

const HORIZONTES = [
  { key: 'en_contra', nombre: 'EN CONTRA', color: '#C41230', colorTexto: '#791F1F', fondo: '#FFF5F6' },
  { key: 'neutral',   nombre: 'NEUTRAL',   color: '#B8860B', colorTexto: '#633806', fondo: '#F8F3E6' },
  { key: 'a_favor',   nombre: 'A FAVOR',   color: '#2E7D32', colorTexto: '#27500A', fondo: '#F4FAF4' },
];
const AREA_POR_RESULTADO = { NO: 'en_contra', SI_MATIZ: 'neutral', SI: 'a_favor' };

// Mismo agrupamiento que ya usa (y sigue usando) generarSVGGrafoPorHorizonte()
// en worker.js — los criterios NA quedan fuera, no aplican al documento.
function calcularSeccionesHorizonte(datos) {
  const criterios = datos.categorias.flatMap(cat => cat.criterios).filter(c => c.resultado !== 'NA');
  const secciones = { en_contra: [], neutral: [], a_favor: [] };
  criterios.forEach(c => {
    const area = AREA_POR_RESULTADO[c.resultado];
    if (area) secciones[area].push(c);
  });
  return secciones;
}

// Etiquetas cortas de artículo (A-12, A-64F...) por criterio.
function calcularArticulosPorCriterio(enlaces) {
  const mapa = {};
  enlaces.forEach(e => {
    if (!mapa[e.destino]) mapa[e.destino] = [];
    mapa[e.destino].push(etiquetaCortaComponente(e.origen));
  });
  return mapa;
}

function partirEnBloques(lista, tam) {
  const bloques = [];
  for (let i = 0; i < lista.length; i += tam) bloques.push(lista.slice(i, i + tam));
  return bloques;
}

// ── Texto de marcador de posición — SOLO para el caso híbrido ───────────
function textoPlaceholderCriterio(tipo) {
  const etiquetas = { rechazo: 'rechazo', mejora: 'mejora', promocion: 'promoción' };
  return `[PENDIENTE — recomendación de ${etiquetas[tipo]} para este criterio, generada con Claude]`;
}

// Título grande de la portada — "intensidad total" del veredicto. El
// "100%" en los casos rechazo_total/promocion_total es literal (la acción
// recomendada es total/completa), NO el % de impacto liberal del documento.
function generarTituloRecomendacionGeneral(veredicto) {
  if (veredicto.modo === 'rechazo_total') return 'Recomendación General: RECHAZAR 100% A ESTE INSTRUMENTO.';
  if (veredicto.modo === 'promocion_total') return 'Recomendación General: APOYAR 100% A ESTE INSTRUMENTO.';
  return 'Recomendación General: EJECUTAR ACCIONES DE RECHAZO, MEJORA O APOYO, A NIVEL DE ARTÍCULOS ESPECÍFICOS.';
}

const CSS = `
  @page { size: A4 landscape; margin: 14mm 16mm; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { background: #F7F5F0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: Arial, Helvetica, sans-serif; color: #1A1A1A; background: #F7F5F0;
    font-size: 15px; line-height: 1.6;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }

  /* ── Portada ─────────────────────────────────────────────────────── */
  .portada-pres { break-after: page; height: 178mm; display: flex; flex-direction: column; }
  .portada-cinta { height: 5px; background: #C41230; flex: 0 0 auto; }

  /* Réplica del masthead del Reporte — a propósito NO se agranda, es el
     único bloque que debía calzar en tamaño con el documento impreso. */
  .portada-header {
    flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
    padding: 28px 52px 24px; border-bottom: 1px solid #D4CFC4;
  }
  .portada-logo { font-family: Georgia, 'Times New Roman', serif; font-size: 22px; letter-spacing: -0.02em; color: #1A1A1A; }
  .portada-logo strong { font-weight: 700; }
  .portada-logo span { font-weight: 400; }
  .portada-meta-header { font-size: 11px; color: #8A8478; text-align: right; line-height: 1.5; }

  .portada-body { flex: 0 0 auto; padding: 24px 52px 0; }
  .portada-etiqueta {
    font-size: 10px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase;
    color: #C41230; margin-bottom: 14px;
  }
  .portada-titulo {
    font-family: Georgia, 'Times New Roman', serif; font-size: 26px; font-weight: 700;
    line-height: 1.2; letter-spacing: -0.02em; color: #1A1A1A; max-width: 640px; margin-bottom: 8px;
  }
  .portada-subtitulo { font-size: 13px; color: #4A4A4A; font-style: italic; font-family: Georgia, 'Times New Roman', serif; }

  /* Hero de portada — este sí a escala de diapositiva. */
  .portada-hero { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 34px; text-align: center; padding: 0 16mm; }
  .recomendacion-general { font-family: Georgia, 'Times New Roman', serif; font-size: 34px; font-weight: 700; line-height: 1.35; max-width: 720px; }
  .motto-linea1 { font-family: Georgia, 'Times New Roman', serif; font-size: 25px; font-weight: 700; color: #1A1A1A; }
  .motto-linea2 { font-family: Georgia, 'Times New Roman', serif; font-size: 25px; font-style: italic; color: #C41230; }

  /* ── Hallazgos (SUPERADA — sin llamarse) ────────────────────────────── */
  .lamina-hallazgo { break-before: page; height: 178mm; display: flex; flex-direction: column; }
  .hallazgo-header { flex: 0 0 auto; display: flex; align-items: baseline; gap: 10px; border-bottom: 3px solid; padding-bottom: 10px; margin-bottom: 14px; }
  .hallazgo-titulo { font-family: Georgia, 'Times New Roman', serif; font-size: 22px; font-weight: 700; }
  .hallazgo-grid { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(3, 1fr); gap: 10px; }
  .hallazgo-card { display: flex; flex-direction: column; overflow: hidden; min-height: 0; background: #FFFFFF; border: 1px solid #D4CFC4; border-radius: 4px; padding: 8px; }
  .hallazgo-img-wrap { flex: 1 1 auto; min-height: 0; position: relative; border-radius: 3px; background: #FAFAF8; overflow: hidden; }
  .hallazgo-img { width: 100%; height: 100%; object-fit: contain; }
  .marca-rechazo { position: absolute; inset: 6%; pointer-events: none; }
  .marca-matiz {
    position: absolute; top: 4px; right: 4px; width: 18px; height: 18px; border-radius: 50%;
    background: #B8860B; color: #FFFFFF; font-size: 12px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
  }
  .hallazgo-id { flex: 0 0 auto; font-size: 11px; font-weight: 700; margin-top: 6px; }
  .hallazgo-articulos { flex: 0 0 auto; font-size: 9.5px; color: #8A8478; margin-top: 1px; }
  .hallazgo-caption {
    flex: 0 0 auto; font-size: 9.5px; color: #4A4A4A; margin-top: 2px; line-height: 1.3;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }

  /* ── Activismo — caso total: una idea por lámina ────────────────────── */
  .lamina-idea-activismo { break-before: page; height: 178mm; display: flex; align-items: center; gap: 36px; padding: 0 12mm; }
  .idea-ilustracion {
    flex: 0 0 42%; height: 140mm; border-radius: 8px;
    background-color: #EFEBE0; background-size: contain; background-position: center; background-repeat: no-repeat;
  }
  .idea-contenido { flex: 1 1 auto; }
  .idea-numero { font-size: 13px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #8A8478; margin-bottom: 14px; }
  .idea-titulo { font-family: Georgia, 'Times New Roman', serif; font-size: 28px; font-weight: 700; line-height: 1.3; margin-bottom: 18px; max-width: 480px; }
  .idea-descripcion { font-size: 17px; color: #4A4A4A; line-height: 1.6; max-width: 480px; }

  /* ── Activismo — caso híbrido (placeholder, sigue en borrador) ──────── */
  .lamina-activismo-horizonte { break-before: page; min-height: 178mm; }
  .activismo-header { display: flex; align-items: baseline; gap: 10px; border-bottom: 3px solid; padding-bottom: 12px; margin-bottom: 22px; }
  .activismo-titulo { font-family: Georgia, 'Times New Roman', serif; font-size: 28px; font-weight: 700; }

  .activismo-item { display: flex; gap: 18px; padding: 16px 0; border-bottom: 1px solid #E5E1D8; page-break-inside: avoid; }
  .activismo-item-etiquetas { flex: 0 0 170px; }
  .activismo-item-id { font-size: 15px; font-weight: 700; }
  .activismo-item-articulos { font-size: 12.5px; color: #8A8478; margin-top: 4px; }
  .activismo-item-recomendacion {
    flex: 1; font-size: 14px; color: #4A4A4A; font-style: italic;
    border: 1px dashed #C7C2B6; border-radius: 3px; padding: 10px 12px; background: #FBFAF7;
  }

  /* ── Lámina de contacto ──────────────────────────────────────────── */
  .lamina-contacto { break-before: page; min-height: 178mm; display: flex; align-items: center; }
  .contacto-cuerpo { display: flex; gap: 36px; align-items: flex-start; width: 100%; }
  .contacto-ilustracion { flex: 0 0 160px; width: 160px; height: 160px; }
  .contacto-lista { flex: 1 1 auto; }
  .contacto-eyebrow { font-size: 12px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: #8A8478; margin-bottom: 8px; }
  .contacto-titulo { font-family: Georgia, 'Times New Roman', serif; font-size: 24px; font-weight: 700; color: #1A1A1A; max-width: 600px; line-height: 1.35; margin-bottom: 16px; }
  .contacto-aviso-dummy {
    background: #FFF3CD; border: 1px solid #E0B34D; color: #7A5C00;
    font-size: 12px; font-weight: 700; padding: 9px 13px; border-radius: 4px; margin-bottom: 18px;
  }
  .contacto-item { padding: 14px 0; border-bottom: 1px solid #E5E1D8; }
  .contacto-nombre { font-size: 17px; font-weight: 700; }
  .contacto-datos { font-size: 15px; color: #4A4A4A; margin-top: 3px; }
  .contacto-descripcion { font-size: 13px; color: #8A8478; margin-top: 5px; }
`;

// ── Portada ────────────────────────────────────────────────────────────
function generarPortadaHTML(titulo, pais, generadoEl, veredicto) {
  const color = veredicto.modo === 'rechazo_total' ? '#C41230'
    : veredicto.modo === 'promocion_total' ? '#2E7D32'
    : '#B8860B';

  return `
<div class="portada-pres">
  <div class="portada-cinta"></div>
  <div class="portada-header">
    <div class="portada-logo"><strong>Liberal</strong><span>mente</span></div>
    <div class="portada-meta-header">
      Auditoría Cívica Liberal<br>
      liberalmente.app · CEDICE / Fundación Friedrich Naumann
    </div>
  </div>
  <div class="portada-body">
    <div class="portada-etiqueta">Ideas para el activismo · Generado el ${esc(generadoEl)}</div>
    <h1 class="portada-titulo">${esc(titulo)}</h1>
    <div class="portada-subtitulo">${esc(pais)}</div>
  </div>
  <div class="portada-hero">
    <h2 class="recomendacion-general" style="color:${color}">${esc(generarTituloRecomendacionGeneral(veredicto))}</h2>
    <div class="motto">
      <div class="motto-linea1">Defiende la libertad.</div>
      <div class="motto-linea2">Audita el poder.</div>
    </div>
  </div>
</div>`;
}

// ── Hallazgos (SUPERADA — definida pero sin llamarse) ────────────────────
function generarTarjetaCriterioHTML(c, articulos) {
  const src = `${RUTA_BASE_IMAGENES}/${esc(c.id)}.png`;
  const marcador = c.resultado === 'NO'
    ? `<svg class="marca-rechazo" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
         <circle cx="50" cy="50" r="45" fill="none" stroke="#C41230" stroke-width="6" stroke-opacity="0.85"/>
         <line x1="16" y1="16" x2="84" y2="84" stroke="#C41230" stroke-width="6" stroke-opacity="0.85"/>
       </svg>`
    : c.resultado === 'SI_MATIZ'
      ? `<span class="marca-matiz">*</span>`
      : '';
  const articulosTexto = articulos && articulos.length ? articulos.join(', ') : '—';
  return `
    <div class="hallazgo-card">
      <div class="hallazgo-img-wrap">
        <img class="hallazgo-img" src="${src}" alt="${esc(c.id)}" />
        ${marcador}
      </div>
      <div class="hallazgo-id">${esc(c.id)}</div>
      <div class="hallazgo-articulos">${esc(articulosTexto)}</div>
      <div class="hallazgo-caption">${esc(c.pregunta || '')}</div>
    </div>`;
}

function generarLaminasHallazgosHTML(secciones, articulosPorCriterio) {
  return HORIZONTES
    .filter(h => secciones[h.key].length > 0)
    .map(h => {
      const bloques = partirEnBloques(secciones[h.key], 9);
      return bloques.map((bloque, i) => `
<div class="lamina-hallazgo">
  <div class="hallazgo-header" style="border-color:${h.color}">
    <span class="hallazgo-titulo" style="color:${h.color}">${h.nombre}${i > 0 ? ' — cont.' : ''}</span>
  </div>
  <div class="hallazgo-grid">
    ${bloque.map(c => generarTarjetaCriterioHTML(c, articulosPorCriterio[c.id])).join('\n    ')}
  </div>
</div>`).join('\n');
    }).join('\n');
}

// ── Activismo — caso total: una lámina por idea ──────────────────────────
function generarLaminaIdeaHTML(idea, numero, total, color) {
  const archivo = ILUSTRACION_POR_CATEGORIA[idea.categoria] || ILUSTRACION_POR_CATEGORIA.redes_sociales;
  const src = `${RUTA_BASE_IMAGENES}/${archivo}`;
  return `
<div class="lamina-idea-activismo">
  <div class="idea-ilustracion" style="background-image:url('${src}')"></div>
  <div class="idea-contenido" style="border-left:5px solid ${color}; padding-left:26px;">
    <div class="idea-numero">Idea ${numero} de ${total}</div>
    <div class="idea-titulo">${esc(idea.titulo)}</div>
    <div class="idea-descripcion">${esc(idea.descripcion)}</div>
  </div>
</div>`;
}

function generarLaminasVeredictoTotalHTML(veredicto, ideas) {
  const color = veredicto.modo === 'rechazo_total' ? '#C41230' : '#2E7D32';
  const lista = ideas || [];
  return lista.map((idea, i) => generarLaminaIdeaHTML(idea, i + 1, lista.length, color)).join('\n');
}

// ── Activismo — caso híbrido (placeholder, sigue en borrador) ───────────
const TIPO_ACTIVISMO_POR_HORIZONTE = { en_contra: 'rechazo', neutral: 'mejora', a_favor: 'promocion' };
const NOMBRE_ACTIVISMO_POR_HORIZONTE = { en_contra: 'RECHAZO', neutral: 'MEJORA', a_favor: 'PROMOCIÓN' };

function generarLaminaActivismoHorizonteHTML(h, criterios, articulosPorCriterio) {
  const tipo = TIPO_ACTIVISMO_POR_HORIZONTE[h.key];
  const items = criterios.map(c => {
    const articulos = articulosPorCriterio[c.id] || [];
    return `
    <div class="activismo-item">
      <div class="activismo-item-etiquetas">
        <div class="activismo-item-id">${esc(c.id)}</div>
        <div class="activismo-item-articulos">${esc(articulos.length ? articulos.join(', ') : '—')}</div>
      </div>
      <div class="activismo-item-recomendacion">${esc(textoPlaceholderCriterio(tipo))}</div>
    </div>`;
  }).join('');

  return `
<div class="lamina-activismo-horizonte">
  <div class="activismo-header" style="border-color:${h.color}">
    <span class="activismo-titulo" style="color:${h.color}">${NOMBRE_ACTIVISMO_POR_HORIZONTE[h.key]}</span>
  </div>
  ${items}
</div>`;
}

function generarSeccionActivismoHTML(veredicto, secciones, articulosPorCriterio, ideasActivismoTotal) {
  if (veredicto.modo !== 'hibrido') {
    return generarLaminasVeredictoTotalHTML(veredicto, ideasActivismoTotal);
  }
  return HORIZONTES
    .filter(h => secciones[h.key].length > 0)
    .map(h => generarLaminaActivismoHorizonteHTML(h, secciones[h.key], articulosPorCriterio))
    .join('\n');
}

// ── Lámina de contacto (con ilustración placeholder) ─────────────────────
function generarLaminaContactoHTML(contactos) {
  const itemsHTML = (contactos || []).map(c => `
    <div class="contacto-item">
      <div class="contacto-nombre">${esc(c.nombre)}</div>
      <div class="contacto-datos">${esc(c.contacto)}</div>
      <div class="contacto-descripcion">${esc(c.descripcion)}</div>
    </div>`).join('');

  return `
<div class="lamina-contacto">
  <div class="contacto-cuerpo">
    <div class="contacto-ilustracion">
      <svg viewBox="0 0 100 100" width="100%" height="100%" fill="none" stroke="#8A8478" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M50 10 L85 25 V50 C85 70 70 85 50 92 C30 85 15 70 15 50 V25 Z"/>
        <path d="M38 50 L46 58 L64 40" stroke="#2E7D32"/>
      </svg>
    </div>
    <div class="contacto-lista">
      <div class="contacto-eyebrow">Activista</div>
      <div class="contacto-titulo">Si te encuentras ante una situación de abuso de poder, sigue las siguientes recomendaciones.</div>
      <div class="contacto-aviso-dummy">⚠ DATOS DE PRUEBA — pendientes de curar y verificar. No usar en producción real.</div>
      ${itemsHTML}
    </div>
  </div>
</div>`;
}

// ── HTML completo ──────────────────────────────────────────────────────
function generarHTML(datos, metadatos, contexto) {
  const { titulo = 'Documento auditado', pais = '', generadoEl = '' } = metadatos;
  const { veredicto, secciones, articulosPorCriterio, ideasActivismoTotal, contactosApoyo } = contexto;

  const portadaHTML   = generarPortadaHTML(titulo, pais, generadoEl, veredicto);
  const activismoHTML = generarSeccionActivismoHTML(veredicto, secciones, articulosPorCriterio, ideasActivismoTotal);
  const contactoHTML  = generarLaminaContactoHTML(contactosApoyo);

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=1122">
  <title>Presentación — ${esc(titulo)}</title>
  <style>${CSS}</style>
</head>
<body>
${portadaHTML}
${activismoHTML}
${contactoHTML}
</body>
</html>`;
}

// ── Mapa temporal de HTMLs propio de la Presentación (sin cambios) ──────
const _htmlsTemporalesPresentacion = new Map();

function registrarRutaHTMLTemporalPresentacion(app) {
  app.get('/presentacion-temp/:id', (req, res) => {
    const html = _htmlsTemporalesPresentacion.get(req.params.id);
    if (!html) return res.status(404).send('No encontrado');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });
}

// ── Conversión HTML → PDF vía CloudConvert (sin cambios) ────────────────
async function convertirHTMLaPDF(rutaHTML, rutaPDF, auditoria_id) {
  const CLOUDCONVERT_API_KEY = process.env.CLOUDCONVERT_API_KEY;
  if (!CLOUDCONVERT_API_KEY) throw new Error('Falta la variable de entorno CLOUDCONVERT_API_KEY');

  const WORKER_URL  = process.env.WORKER_URL || 'https://acl-worker-production.up.railway.app';
  const htmlContent = fs.readFileSync(rutaHTML, 'utf8');

  _htmlsTemporalesPresentacion.set(auditoria_id, htmlContent);
  const urlTemporal = `${WORKER_URL}/presentacion-temp/${auditoria_id}`;
  console.log(`   [${auditoria_id}] HTML de presentación disponible en: ${urlTemporal}`);

  try {
    console.log(`   [${auditoria_id}] Creando job en CloudConvert (presentación)...`);
    const jobRes = await fetch('https://api.cloudconvert.com/v2/jobs', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLOUDCONVERT_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        tasks: {
          'import-html': {
            operation: 'import/url',
            url:       urlTemporal,
            filename:  'presentacion.html',
          },
          'convert-to-pdf': {
            operation:        'convert',
            input:            'import-html',
            input_format:     'html',
            output_format:    'pdf',
            engine:           'chrome',
            print_background: true,
            css_page_size:    true,
            margin_top:       0,
            margin_right:     0,
            margin_bottom:    0,
            margin_left:      0,
            screen_width:     1122,
            wait_until:       'networkidle0',
            wait_time:        1500,
          },
          'export-pdf': {
            operation: 'export/url',
            input:     'convert-to-pdf',
          },
        },
      }),
    });

    if (!jobRes.ok) {
      const err = await jobRes.text();
      throw new Error(`CloudConvert error creando job: ${err}`);
    }

    const job   = await jobRes.json();
    const jobId = job.data.id;
    console.log(`   [${auditoria_id}] Job creado: ${jobId}`);

    const inicio    = Date.now();
    const MAX_ESPERA = 180_000;
    const INTERVALO  =   3_000;
    let exportTask   = null;

    while (Date.now() - inicio < MAX_ESPERA) {
      await new Promise(r => setTimeout(r, INTERVALO));
      const statusRes  = await fetch(`https://api.cloudconvert.com/v2/jobs/${jobId}`, {
        headers: { 'Authorization': `Bearer ${CLOUDCONVERT_API_KEY}` },
      });
      const statusData = await statusRes.json();
      const estado     = statusData.data.status;
      console.log(`   [${auditoria_id}] Estado: ${estado}`);

      if (estado === 'finished') {
        exportTask = statusData.data.tasks.find(t => t.name === 'export-pdf');
        break;
      }
      if (estado === 'error') {
        const fallida = statusData.data.tasks.find(t => t.status === 'error');
        throw new Error(`CloudConvert error en conversión: ${fallida?.message || 'Error desconocido'}`);
      }
    }

    if (!exportTask?.result?.files?.[0]?.url) {
      throw new Error('CloudConvert: timeout o no se encontró el PDF exportado');
    }

    console.log(`   [${auditoria_id}] Descargando PDF de presentación...`);
    const pdfUrl = exportTask.result.files[0].url;
    const pdfRes = await fetch(pdfUrl);
    if (!pdfRes.ok) throw new Error(`Error descargando PDF: ${pdfRes.status}`);

    const buffer = Buffer.from(await pdfRes.arrayBuffer());
    fs.writeFileSync(rutaPDF, buffer);
    console.log(`   [${auditoria_id}] ✅ PDF de presentación descargado (${Math.round(buffer.length / 1024)} KB)`);

  } finally {
    _htmlsTemporalesPresentacion.delete(auditoria_id);
  }
}

// ── Función principal exportada ───────────────────────────────────────────
async function generarPresentacionPDF(datos, metadatos, rutaSalida, auditoria_id) {
  console.log(`\n   ▶ [${auditoria_id}] INICIO generarPresentacionPDF v2.4`);

  const { enlaces } = calcularDatosGrafo(datos);
  const resumenHorizontes = calcularResumenHorizontes(enlaces);
  const veredicto = calcularVeredictoActivismo(resumenHorizontes);
  const secciones = calcularSeccionesHorizonte(datos);
  const articulosPorCriterio = calcularArticulosPorCriterio(enlaces);

  let ideasActivismoTotal = null;
  if (veredicto.modo !== 'hibrido') {
    console.log(`   [${auditoria_id}] Generando ideas de activismo (${veredicto.modo})...`);
    ideasActivismoTotal = await generarIdeasActivismoTotal(datos, metadatos, veredicto, auditoria_id);
    console.log(`   [${auditoria_id}] ${ideasActivismoTotal.length} ideas generadas`);
  }

  const contactosApoyo = obtenerContactosApoyo();

  const html = generarHTML(datos, metadatos, {
    veredicto, secciones, articulosPorCriterio, ideasActivismoTotal, contactosApoyo,
  });
  const rutaHTML = rutaSalida.replace('.pdf', '.html');
  fs.writeFileSync(rutaHTML, html, 'utf8');
  console.log(`   [${auditoria_id}] HTML de presentación generado (${Math.round(html.length / 1024)} KB)`);

  try {
    await convertirHTMLaPDF(rutaHTML, rutaSalida, auditoria_id);
  } finally {
    if (fs.existsSync(rutaHTML)) fs.unlinkSync(rutaHTML);
  }

  console.log(`   ✅ [${auditoria_id}] generarPresentacionPDF completado`);
}

module.exports = {
  generarPresentacionPDF,
  generarHTML,
  calcularSeccionesHorizonte,
  registrarRutaHTMLTemporalPresentacion,
};