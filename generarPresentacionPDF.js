// generarPresentacionPDF.js — ACL Worker
// Umbusk LLC · Auditoría Cívica Liberal
//
// Presentación v2.2 (22 jul 2026) — reenfoque grande, decidido con
// Moisés: la Presentación deja de repetir la relación criterio/artículo
// (eso ya lo hace el Reporte) y pasa a ser 100% sobre qué hacer al
// respecto.
//   1. Se retira la lámina de hallazgos ilustrados (generarLaminasHallazgosHTML
//      y generarTarjetaCriterioHTML quedan definidas pero SIN LLAMARSE —
//      no se borran, mismo criterio que ya usan con el diseño radial
//      viejo del mapa mental en worker.js, por si se retoman las 35
//      piezas más adelante).
//   2. La lámina de Activismo del caso TOTAL (rechazo_total /
//      promocion_total) ahora muestra las ideas reales generadas por
//      generarIdeasActivismoTotal() (generarActivismo.js), no texto de
//      marcador de posición.
//   3. Nueva lámina final, común a todas las presentaciones: contactos
//      de apoyo ante abuso de poder. Usa obtenerContactosApoyo()
//      (generarActivismo.js) — HOY SON DATOS DUMMY, marcados con un
//      aviso visible en el propio PDF para que nadie los confunda con
//      contactos reales mientras se prueba.
//   4. El caso HÍBRIDO (20%-80%) sigue con texto de marcador de posición
//      por ahora — la selección de hasta 3 artículos por horizonte más
//      sus ideas es la siguiente pieza a construir.
//
// SIN CAMBIOS: el mecanismo de conversión HTML→PDF (convertirHTMLaPDF,
// CloudConvert), el mapa temporal de HTMLs, y la firma pública de
// generarPresentacionPDF() (datos, metadatos, rutaSalida, auditoria_id).

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
// hallazgos, hoy sin llamarse (ver nota de cabecera) ────────────────────
const RUTA_BASE_IMAGENES = 'https://liberalmente.app/presentacion';

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

// ── Texto de marcador de posición — SOLO para el caso híbrido, que
// todavía no genera ideas reales (ver nota de cabecera) ─────────────────
function textoPlaceholderCriterio(tipo) {
  const etiquetas = { rechazo: 'rechazo', mejora: 'mejora', promocion: 'promoción' };
  return `[PENDIENTE — recomendación de ${etiquetas[tipo]} para este criterio, generada con Claude]`;
}

// Texto de acción de la portada — mismo veredicto que gobierna Activismo.
function generarTextoAccionPortada(veredicto) {
  if (veredicto.modo === 'rechazo_total') return 'Recomendación: Rechazar totalmente este instrumento normativo.';
  if (veredicto.modo === 'promocion_total') return 'Recomendación: Promover activamente este instrumento normativo.';
  // PENDIENTE DE CONFIRMAR — Moisés no dio el texto exacto para el caso híbrido.
  return 'Recomendación: acción mixta — ver el detalle en las láminas de Activismo.';
}

const CSS = `
  @page { size: A4 landscape; margin: 14mm 16mm; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { background: #F7F5F0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: Arial, Helvetica, sans-serif; color: #1A1A1A; background: #F7F5F0;
    font-size: 13px; line-height: 1.6;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }

  /* ── Portada ─────────────────────────────────────────────────────── */
  .portada-pres { break-after: page; height: 178mm; display: flex; flex-direction: column; }
  .portada-cinta { height: 5px; background: #C41230; flex: 0 0 auto; }

  .portada-header { flex: 0 0 auto; padding: 8mm 6mm 0; }
  .logo-liberalmente { font-family: Georgia, 'Times New Roman', serif; font-size: 17px; color: #1A1A1A; margin-bottom: 6px; }
  .logo-bold { font-weight: 700; }
  .portada-titulo { font-family: Georgia, 'Times New Roman', serif; font-size: 23px; font-weight: 700; max-width: 720px; line-height: 1.25; color: #1A1A1A; }

  .portada-hero { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; }
  .portada-barras { display: flex; align-items: flex-end; gap: 60px; height: 210px; }
  .barra-col { display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .barra-valor { font-size: 22px; font-weight: 700; }
  .barra-rect { width: 76px; border-radius: 5px 5px 0 0; }
  .barra-etiqueta { font-size: 12px; font-weight: 600; color: #1A1A1A; }

  .portada-recomendacion { text-align: center; }
  .recomendacion-pct { font-family: Georgia, 'Times New Roman', serif; font-size: 19px; font-weight: 700; color: #1A1A1A; margin-bottom: 4px; }
  .recomendacion-texto { font-family: Georgia, 'Times New Roman', serif; font-size: 15px; font-style: italic; }

  .portada-pie { flex: 0 0 auto; padding: 0 6mm 6mm; font-size: 10.5px; color: #8A8478; text-align: center; }

  /* ── Hallazgos (SUPERADA — sin llamarse, ver nota de cabecera) ──────── */
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

  /* ── Activismo ───────────────────────────────────────────────────── */
  .lamina-activismo-total { break-before: page; min-height: 178mm; display: flex; flex-direction: column; justify-content: center; }
  .activismo-eyebrow { font-size: 11px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: #8A8478; margin-bottom: 10px; }
  .activismo-veredicto { font-family: Georgia, 'Times New Roman', serif; font-size: 32px; font-weight: 700; margin-bottom: 8px; }
  .activismo-alineacion { font-size: 13px; color: #4A4A4A; margin-bottom: 24px; }

  .activismo-ideas { display: flex; flex-direction: column; gap: 14px; max-width: 720px; text-align: left; }
  .activismo-idea { border-left: 3px solid; padding-left: 14px; page-break-inside: avoid; }
  .activismo-idea-titulo { font-size: 13.5px; font-weight: 700; margin-bottom: 3px; }
  .activismo-idea-descripcion { font-size: 11.5px; color: #4A4A4A; line-height: 1.5; }

  .lamina-activismo-horizonte { break-before: page; min-height: 178mm; }
  .activismo-header { display: flex; align-items: baseline; gap: 10px; border-bottom: 3px solid; padding-bottom: 10px; margin-bottom: 18px; }
  .activismo-titulo { font-family: Georgia, 'Times New Roman', serif; font-size: 24px; font-weight: 700; }

  .activismo-item { display: flex; gap: 14px; padding: 12px 0; border-bottom: 1px solid #E5E1D8; page-break-inside: avoid; }
  .activismo-item-etiquetas { flex: 0 0 150px; }
  .activismo-item-id { font-size: 12px; font-weight: 700; }
  .activismo-item-articulos { font-size: 10.5px; color: #8A8478; margin-top: 3px; }
  .activismo-item-recomendacion {
    flex: 1; font-size: 11.5px; color: #4A4A4A; font-style: italic;
    border: 1px dashed #C7C2B6; border-radius: 3px; padding: 8px 10px; background: #FBFAF7;
  }

  /* ── Lámina de contacto (nueva) ──────────────────────────────────── */
  .lamina-contacto { break-before: page; min-height: 178mm; }
  .contacto-aviso-dummy {
    background: #FFF3CD; border: 1px solid #E0B34D; color: #7A5C00;
    font-size: 11px; font-weight: 700; padding: 8px 12px; border-radius: 4px; margin-bottom: 18px;
  }
  .contacto-item { padding: 12px 0; border-bottom: 1px solid #E5E1D8; }
  .contacto-nombre { font-size: 13px; font-weight: 700; }
  .contacto-datos { font-size: 11.5px; color: #4A4A4A; margin-top: 2px; }
  .contacto-descripcion { font-size: 11px; color: #8A8478; margin-top: 4px; }
`;

// ── Portada ────────────────────────────────────────────────────────────
function generarPortadaHTML(titulo, pais, generadoEl, resumenHorizontes, veredicto) {
  const barrasHTML = HORIZONTES.map(h => {
    const d = resumenHorizontes[h.key];
    const alturaPx = Math.round((d.porcentaje / 100) * 210);
    const etiqueta = h.key === 'en_contra' ? 'En contra' : h.key === 'neutral' ? 'Neutral' : 'A favor';
    return `
    <div class="barra-col">
      <span class="barra-valor" style="color:${h.colorTexto}">${d.porcentaje}%</span>
      <div class="barra-rect" style="height:${alturaPx}px; background:${h.color};"></div>
      <span class="barra-etiqueta">${etiqueta}</span>
    </div>`;
  }).join('');

  const colorRecomendacion = veredicto.modo === 'rechazo_total' ? '#C41230'
    : veredicto.modo === 'promocion_total' ? '#2E7D32'
    : '#B8860B';

  return `
<div class="portada-pres">
  <div class="portada-cinta"></div>
  <div class="portada-header">
    <div class="logo-liberalmente"><span class="logo-bold">Liberal</span>mente</div>
    <h1 class="portada-titulo">${esc(titulo)}</h1>
  </div>
  <div class="portada-hero">
    <div class="portada-barras">${barrasHTML}</div>
    <div class="portada-recomendacion">
      <div class="recomendacion-pct">${veredicto.alineacionPorcentaje}% de impacto liberal.</div>
      <div class="recomendacion-texto" style="color:${colorRecomendacion}">${esc(generarTextoAccionPortada(veredicto))}</div>
    </div>
  </div>
  <div class="portada-pie">${esc([pais, generadoEl].filter(Boolean).join(' · '))}</div>
</div>`;
}

// ── Hallazgos (SUPERADA — definida pero sin llamarse, ver nota cabecera) ─
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

// ── Activismo ──────────────────────────────────────────────────────────
const TIPO_ACTIVISMO_POR_HORIZONTE = { en_contra: 'rechazo', neutral: 'mejora', a_favor: 'promocion' };
const NOMBRE_ACTIVISMO_POR_HORIZONTE = { en_contra: 'RECHAZO', neutral: 'MEJORA', a_favor: 'PROMOCIÓN' };

// Caso total — ahora con las ideas reales de generarIdeasActivismoTotal().
function generarLaminaVeredictoTotalHTML(veredicto, ideas) {
  const esRechazo = veredicto.modo === 'rechazo_total';
  const color = esRechazo ? '#C41230' : '#2E7D32';
  const titulo = esRechazo ? 'Recomendación: rechazo total' : 'Recomendación: promoción total';
  const ideasHTML = (ideas || []).map(idea => `
    <div class="activismo-idea" style="border-color:${color}">
      <div class="activismo-idea-titulo">${esc(idea.titulo)}</div>
      <div class="activismo-idea-descripcion">${esc(idea.descripcion)}</div>
    </div>`).join('');

  return `
<div class="lamina-activismo-total">
  <div class="activismo-eyebrow">Activismo · Auditoría Cívica Liberal</div>
  <h2 class="activismo-veredicto" style="color:${color}">${esc(titulo)}</h2>
  <p class="activismo-alineacion">${veredicto.alineacionPorcentaje}% de impacto liberal.</p>
  <div class="activismo-ideas">${ideasHTML}</div>
</div>`;
}

// Caso híbrido — sigue con texto de marcador de posición (ver nota cabecera).
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
    return generarLaminaVeredictoTotalHTML(veredicto, ideasActivismoTotal);
  }
  return HORIZONTES
    .filter(h => secciones[h.key].length > 0)
    .map(h => generarLaminaActivismoHorizonteHTML(h, secciones[h.key], articulosPorCriterio))
    .join('\n');
}

// ── Lámina de contacto (nueva, común a todas las presentaciones) ────────
function generarLaminaContactoHTML(contactos) {
  const itemsHTML = (contactos || []).map(c => `
    <div class="contacto-item">
      <div class="contacto-nombre">${esc(c.nombre)}</div>
      <div class="contacto-datos">${esc(c.contacto)}</div>
      <div class="contacto-descripcion">${esc(c.descripcion)}</div>
    </div>`).join('');

  return `
<div class="lamina-contacto">
  <div class="activismo-header" style="border-color:#8A8478">
    <span class="activismo-titulo" style="color:#8A8478">SI ENFRENTAS ABUSO DE PODER</span>
  </div>
  <div class="contacto-aviso-dummy">⚠ DATOS DE PRUEBA — pendientes de curar y verificar. No usar en producción real.</div>
  ${itemsHTML}
</div>`;
}

// ── HTML completo ──────────────────────────────────────────────────────
function generarHTML(datos, metadatos, contexto) {
  const { titulo = 'Documento auditado', pais = '', generadoEl = '' } = metadatos;
  const { resumenHorizontes, veredicto, secciones, articulosPorCriterio, ideasActivismoTotal, contactosApoyo } = contexto;

  const portadaHTML   = generarPortadaHTML(titulo, pais, generadoEl, resumenHorizontes, veredicto);
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
// CAMBIO DE FONDO respecto a v2.1: ahora hace un llamado real a Claude
// (generarIdeasActivismoTotal) ANTES de armar el HTML, cuando el caso es
// total — por eso el orden de pasos abajo importa: primero se calcula el
// veredicto, luego (si aplica) se piden las ideas, y solo al final se
// arma el HTML con todo ya resuelto.
async function generarPresentacionPDF(datos, metadatos, rutaSalida, auditoria_id) {
  console.log(`\n   ▶ [${auditoria_id}] INICIO generarPresentacionPDF v2.2`);

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
    resumenHorizontes, veredicto, secciones, articulosPorCriterio, ideasActivismoTotal, contactosApoyo,
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