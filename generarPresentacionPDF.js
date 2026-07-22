// generarPresentacionPDF.js — ACL Worker
// Umbusk LLC · Auditoría Cívica Liberal
//
// Presentación v2.1 (21 jul 2026) — ajustes sobre v2 tras la primera
// prueba real (auditoría "Proyecto de Ley de Arrendamientos Inmobiliarios"),
// decididos con Moisés:
//   1. Portada rediseñada: logo "Liberalmente" (texto, "Liberal" en negrita
//      + "mente" en peso normal, Georgia — igual que la landing, sin
//      necesidad de un archivo de imagen) arriba a la izquierda, título
//      subido para quedar cerca del logo, y el gráfico de barras pasa a
//      ser la pieza central ("hero"): más grande, centrado, con el
//      veredicto (calcularVeredictoActivismo(), calculado UNA sola vez y
//      reutilizado también en la sección de Activismo) como texto de
//      recomendación debajo — bold + porcentaje / itálica + color del
//      horizonte, ecos del propio estilo de la landing (titular negro +
//      subtitular en cursiva roja).
//   2. Cualquier horizonte sin criterios (hallazgos o Activismo híbrido)
//      se omite por completo — antes mostraba un mensaje de "vacío".
//   3. La grilla de hallazgos ya NO usa una altura de imagen fija en mm
//      (eso fue lo que obligó a recortar a mano): ahora la página se
//      reparte sola en 3 filas iguales vía flexbox/grid, así 9 caben
//      siempre sin importar cuánto texto tengan las tarjetas. Se agrega
//      un texto complementario por criterio (c.pregunta, recortado a 2
//      líneas con line-clamp) — no existía un campo más corto en el
//      schema; si se quiere algo más curado habría que agregarlo.
//   4. El subtítulo de la lámina de veredicto total (y ahora también el
//      texto de la portada) dice solo "{porcentaje}% de impacto liberal."
//      — se usa "impacto" en vez de "alineación" en todo el documento,
//      por consistencia con el término que usa Moisés.
//
// SIN CAMBIOS respecto a v2: el mecanismo de conversión HTML→PDF
// (convertirHTMLaPDF, vía CloudConvert), el mapa temporal de HTMLs
// (registrarRutaHTMLTemporalPresentacion), y la firma de
// generarPresentacionPDF() (datos, metadatos, rutaSalida, auditoria_id —
// sin rutaImagenMapa, decisión del 21 jul).

'use strict';

const fs = require('fs');
const { calcularDatosGrafo, calcularResumenHorizontes, etiquetaCortaComponente } = require('./generarDatosGrafo');
const { calcularVeredictoActivismo } = require('./generarActivismo');

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Asunción a confirmar con Moisés ──────────────────────────────────────
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

// Etiquetas cortas de artículo (A-12, A-64F...) por criterio, derivadas de
// los mismos enlaces que ya calcula calcularDatosGrafo().
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

// ── Texto de marcador de posición — reemplazar cuando el contenido real
// de Activismo esté definido ──────────────────────────────────────────
function textoPlaceholderCriterio(tipo) {
  const etiquetas = { rechazo: 'rechazo', mejora: 'mejora', promocion: 'promoción' };
  return `[PENDIENTE — recomendación de ${etiquetas[tipo]} para este criterio, generada con Claude]`;
}
function textoPlaceholderTotal(modo) {
  return modo === 'rechazo_total'
    ? '[PENDIENTE — recomendaciones de rechazo al instrumento completo, basadas en métodos de Gene Sharp, generadas con Claude]'
    : '[PENDIENTE — recomendaciones de promoción del instrumento completo, generadas con Claude]';
}

// Texto de acción de la portada — mismo veredicto que gobierna Activismo,
// una sola fuente de verdad (calcularVeredictoActivismo()).
function generarTextoAccionPortada(veredicto) {
  if (veredicto.modo === 'rechazo_total') return 'Recomendación: Rechazar totalmente este instrumento normativo.';
  if (veredicto.modo === 'promocion_total') return 'Recomendación: Promover activamente este instrumento normativo.';
  // PENDIENTE DE CONFIRMAR — Moisés no dio el texto exacto para el caso
  // híbrido (20%-80%), esto es un borrador hasta que lo ajuste.
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

  /* ── Hallazgos ───────────────────────────────────────────────────── */
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

// ── Hallazgos (láminas ilustradas por horizonte) ─────────────────────────
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

function generarLaminaVeredictoTotalHTML(veredicto) {
  const esRechazo = veredicto.modo === 'rechazo_total';
  const color = esRechazo ? '#C41230' : '#2E7D32';
  const titulo = esRechazo ? 'Recomendación: rechazo total' : 'Recomendación: promoción total';
  return `
<div class="lamina-activismo-total">
  <div class="activismo-eyebrow">Activismo · Auditoría Cívica Liberal</div>
  <h2 class="activismo-veredicto" style="color:${color}">${esc(titulo)}</h2>
  <p class="activismo-alineacion">${veredicto.alineacionPorcentaje}% de impacto liberal.</p>
  <div class="activismo-item-recomendacion" style="max-width:640px;">${esc(textoPlaceholderTotal(veredicto.modo))}</div>
</div>`;
}

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

function generarSeccionActivismoHTML(veredicto, secciones, articulosPorCriterio) {
  if (veredicto.modo !== 'hibrido') {
    return generarLaminaVeredictoTotalHTML(veredicto);
  }
  return HORIZONTES
    .filter(h => secciones[h.key].length > 0)
    .map(h => generarLaminaActivismoHorizonteHTML(h, secciones[h.key], articulosPorCriterio))
    .join('\n');
}

// ── HTML completo ──────────────────────────────────────────────────────
function generarHTML(datos, metadatos) {
  const { titulo = 'Documento auditado', pais = '', generadoEl = '' } = metadatos;

  const { enlaces } = calcularDatosGrafo(datos);
  const resumenHorizontes = calcularResumenHorizontes(enlaces);
  const veredicto = calcularVeredictoActivismo(resumenHorizontes);
  const secciones = calcularSeccionesHorizonte(datos);
  const articulosPorCriterio = calcularArticulosPorCriterio(enlaces);

  const portadaHTML   = generarPortadaHTML(titulo, pais, generadoEl, resumenHorizontes, veredicto);
  const hallazgosHTML = generarLaminasHallazgosHTML(secciones, articulosPorCriterio);
  const activismoHTML = generarSeccionActivismoHTML(veredicto, secciones, articulosPorCriterio);

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
${hallazgosHTML}
${activismoHTML}
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

// ── Conversión HTML → PDF vía CloudConvert (sin cambios respecto a v2) ──
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
  console.log(`\n   ▶ [${auditoria_id}] INICIO generarPresentacionPDF v2.1`);

  const html     = generarHTML(datos, metadatos);
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