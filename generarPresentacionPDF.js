// generarPresentacionPDF.js — ACL Worker
// Umbusk LLC · Auditoría Cívica Liberal
//
// Presentación v1 (20 jul 2026) — construida desde cero, no reactiva el
// código viejo de generarPresentacion()/extraerEstructura()/PPTX en
// worker.js: ese código organizaba por las 7 categorías (superado por la
// decisión del 17 de julio de organizar por horizonte) y generaba .pptx
// editable (superado por "Presentación (PDF)", el mismo patrón HTML→PDF
// que ya usa el Reporte). Ese código viejo queda intacto pero sin usarse.
//
// Alcance de esta v1 (decisión de Moisés, 20 jul 2026): Portada + las 3
// secciones por horizonte (En Contra / Neutral / A Favor, con la pregunta
// y el análisis completo de cada criterio — ya existen en el schema, no
// hace falta ningún llamado nuevo a Claude) + el Mapa Mental como lámina
// de cierre. Las acciones de activismo quedan para una siguiente versión
// — esa pieza todavía tiene una decisión doctrinal pendiente (quién las
// redacta, con qué tono).
//
// Landscape en vez de portrait (a diferencia del Reporte): esto es una
// "presentación", no un documento de lectura corrida — y el Mapa Mental
// que se embebe al final ya es una imagen ancha, landscape le queda mejor.

'use strict';

const fs = require('fs');

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const HORIZONTES = [
  { key: 'en_contra', nombre: 'EN CONTRA', color: '#C41230', fondo: '#FEF0F0' },
  { key: 'neutral',   nombre: 'NEUTRAL',   color: '#B8860B', fondo: '#F8F3E6' },
  { key: 'a_favor',   nombre: 'A FAVOR',   color: '#2E7D32', fondo: '#EBF5EE' },
];
const AREA_POR_RESULTADO = { NO: 'en_contra', SI_MATIZ: 'neutral', SI: 'a_favor' };

// Mismo agrupamiento por horizonte que ya usa generarSVGGrafoPorHorizonte()
// en worker.js — los criterios NA quedan fuera (no aplican, no representan
// impacto en ningún sentido).
function calcularSeccionesHorizonte(datos) {
  const criterios = datos.categorias.flatMap(cat => cat.criterios).filter(c => c.resultado !== 'NA');
  const secciones = { en_contra: [], neutral: [], a_favor: [] };
  criterios.forEach(c => {
    const area = AREA_POR_RESULTADO[c.resultado];
    if (area) secciones[area].push(c);
  });
  return secciones;
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

  .portada-pres { break-after: page; display: flex; flex-direction: column; min-height: 180mm; }
  .portada-cinta { height: 5px; background: #C41230; flex-shrink: 0; }
  .portada-cuerpo { flex: 1; display: flex; flex-direction: column; justify-content: center; padding: 0 6mm; }
  .portada-etiqueta { font-size: 11px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: #C41230; margin-bottom: 16px; }
  .portada-titulo { font-family: Georgia, 'Times New Roman', serif; font-size: 38px; font-weight: 700; max-width: 700px; line-height: 1.2; margin-bottom: 12px; color: #1A1A1A; }
  .portada-sub { font-size: 14px; color: #4A4A4A; font-style: italic; font-family: Georgia, serif; margin-bottom: 26px; }
  .portada-desc { font-size: 14px; color: #4A4A4A; max-width: 560px; line-height: 1.75; }

  .seccion-horizonte { break-before: page; min-height: 180mm; }
  .seccion-header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 3px solid; padding-bottom: 12px; margin-bottom: 20px; }
  .seccion-titulo { font-family: Georgia, 'Times New Roman', serif; font-size: 30px; font-weight: 700; letter-spacing: 0.01em; }
  .seccion-conteo { font-size: 11px; color: #8A8478; text-transform: uppercase; letter-spacing: 0.08em; }
  .seccion-vacia { font-size: 13px; color: #8A8478; font-style: italic; padding: 20px 0; }

  .tarjetas-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .tarjeta-criterio { background: #FFFFFF; border: 1px solid #D4CFC4; border-left-width: 4px; border-left-style: solid; border-radius: 2px; padding: 13px 15px; page-break-inside: avoid; }
  .tarjeta-id { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; margin-bottom: 6px; }
  .tarjeta-pregunta { font-size: 12.5px; font-weight: 600; color: #1A1A1A; line-height: 1.4; margin-bottom: 7px; }
  .tarjeta-analisis { font-size: 10.5px; color: #4A4A4A; line-height: 1.55; font-weight: 300; }

  .cierre-mapa { break-before: page; min-height: 180mm; display: flex; align-items: center; justify-content: center; }
  .cierre-imagen { width: 100%; height: auto; max-height: 180mm; object-fit: contain; }
`;

function generarHTML(datos, metadatos, imagenMapaBase64) {
  const { titulo = 'Documento auditado', pais = '', generadoEl = '' } = metadatos;
  const secciones = calcularSeccionesHorizonte(datos);

  const seccionesHTML = HORIZONTES.map(h => {
    const criterios = secciones[h.key];
    if (criterios.length === 0) {
      return `
<div class="seccion-horizonte">
  <div class="seccion-header" style="border-color:${h.color}">
    <span class="seccion-titulo" style="color:${h.color}">${h.nombre}</span>
    <span class="seccion-conteo">0 criterios</span>
  </div>
  <p class="seccion-vacia">Ningún criterio de este documento cae en este horizonte.</p>
</div>`;
    }
    const tarjetas = criterios.map(c => `
    <div class="tarjeta-criterio" style="border-left-color:${h.color}">
      <div class="tarjeta-id" style="color:${h.color}">${esc(c.id)}</div>
      <div class="tarjeta-pregunta">${esc(c.pregunta)}</div>
      <div class="tarjeta-analisis">${esc(c.analisis)}</div>
    </div>`).join('');
    return `
<div class="seccion-horizonte">
  <div class="seccion-header" style="border-color:${h.color}">
    <span class="seccion-titulo" style="color:${h.color}">${h.nombre}</span>
    <span class="seccion-conteo">${criterios.length} criterio${criterios.length === 1 ? '' : 's'}</span>
  </div>
  <div class="tarjetas-grid">${tarjetas}</div>
</div>`;
  }).join('\n');

  const cierreHTML = imagenMapaBase64 ? `
<div class="cierre-mapa">
  <img src="data:image/png;base64,${imagenMapaBase64}" class="cierre-imagen" alt="Mapa Mental" />
</div>` : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=1122">
  <title>Presentación — ${esc(titulo)}</title>
  <style>${CSS}</style>
</head>
<body>
<div class="portada-pres">
  <div class="portada-cinta"></div>
  <div class="portada-cuerpo">
    <div class="portada-etiqueta">Presentación · Auditoría Cívica Liberal</div>
    <h1 class="portada-titulo">${esc(titulo)}</h1>
    <div class="portada-sub">${esc([pais, generadoEl].filter(Boolean).join(' · '))}</div>
    <p class="portada-desc">Un recorrido visual por los hallazgos de la auditoría, organizado según su impacto en la libertad: lo que la limita, lo que avanza a medias, y lo que promueve una vida más libre.</p>
  </div>
</div>
${seccionesHTML}
${cierreHTML}
</body>
</html>`;
}

// ── Mapa temporal de HTMLs propio de la Presentación ────────────────────
// Deliberadamente separado del que ya usa generarReportePDF.js — mismo
// patrón, pero sin compartir estado entre los dos archivos.
const _htmlsTemporalesPresentacion = new Map();

function registrarRutaHTMLTemporalPresentacion(app) {
  app.get('/presentacion-temp/:id', (req, res) => {
    const html = _htmlsTemporalesPresentacion.get(req.params.id);
    if (!html) return res.status(404).send('No encontrado');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });
}

// ── Conversión HTML → PDF vía CloudConvert ───────────────────────────────
// Mismo servicio que ya usa el Reporte, pero con el ancho de pantalla de
// A4 landscape (1122px a ~96dpi) en vez de portrait (794px) — si se
// reutilizara el ancho de portrait, Chrome renderizaría el HTML angosto
// y el layout de 2 columnas no calzaría con el @page landscape del CSS.
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
// rutaImagenMapa es opcional — si no se da (o no existe el archivo), la
// Presentación sale sin la lámina de cierre, no falla.
async function generarPresentacionPDF(datos, metadatos, rutaImagenMapa, rutaSalida, auditoria_id) {
  console.log(`\n   ▶ [${auditoria_id}] INICIO generarPresentacionPDF v1`);

  let imagenMapaBase64 = null;
  if (rutaImagenMapa && fs.existsSync(rutaImagenMapa)) {
    imagenMapaBase64 = fs.readFileSync(rutaImagenMapa).toString('base64');
  } else {
    console.warn(`   ⚠️ [${auditoria_id}] Sin imagen de Mapa Mental — la presentación sale sin lámina de cierre.`);
  }

  const html     = generarHTML(datos, metadatos, imagenMapaBase64);
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