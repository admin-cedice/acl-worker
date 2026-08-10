// generarPresentacionPDF.js — ACL Worker
// Umbusk LLC · Auditoría Cívica Liberal
//
// [... changelog anterior sin cambios, ver versiones previas del archivo ...]
//
// v2.7 (4 ago 2026) — CONTACTOS DE APOYO REALES:
// generarPresentacionPDF() acepta ahora un séptimo parámetro opcional
// `contactosApoyo` — el arreglo real que worker.js lee de la tabla nueva
// contactos_apoyo (vía obtenerContactosApoyoActivos()), la misma que
// alimenta /admin/contactos-apoyo. Si llega con al menos un contacto, se
// usa tal cual. Si no llega, o llega vacío (tabla recién creada, sin
// sembrar todavía), se cae a obtenerContactosApoyo() de generarActivismo.js
// —los datos DUMMY que ya existían— con una advertencia explícita en el
// log, para que nunca se generen Presentaciones con datos de prueba sin
// que quede rastro de que pasó.
//
// v2.9 (9 ago 2026) — SE ELIMINAN LOS DESCALIFICADORES: quitado el bloque
// que forzaba `veredicto` a { modo: 'rechazo_total', alineacionPorcentaje: 0 }
// cuando `datos.descalificado` venía en true (campo que ya no existe en el
// objeto que devuelve generarReportePDF.js v4.6). El veredicto de esta
// Presentación ahora sale siempre y únicamente de
// calcularVeredictoActivismo(resumenHorizontes) — mismo criterio acordado
// con Roberto y Moisés para el puntaje del Reporte. `veredicto` pasa de
// `let` a `const`, ya que no vuelve a reasignarse en ningún punto.

'use strict';

const fs = require('fs');
const { calcularDatosGrafo, calcularResumenHorizontes, etiquetaCortaComponente } = require('./generarDatosGrafo');
const { calcularVeredictoActivismo, generarIdeasActivismoTotal, seleccionarCriteriosHibridos, generarIdeaActivismoCriterio, obtenerContactosApoyo } = require('./generarActivismo');

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const RUTA_BASE_IMAGENES = 'https://liberalmente.app/presentacion';

const ILUSTRACION_POR_CATEGORIA = {
  redes_sociales:            'activismo-redes-sociales.png',
  contacto_representantes:   'activismo-contacto-representantes.png',
  deliberacion_publica:      'activismo-deliberacion-publica.png',
  prensa_medios:             'activismo-prensa-medios.png',
  movilizacion_ciudadana:    'activismo-movilizacion-ciudadana.png',
  peticiones_adhesiones:     'activismo-peticiones-adhesiones.png',
  evidencia_argumentos:      'activismo-evidencia-argumentos.png',
  comunitario_territorial:   'activismo-comunitario-territorial.png',
  electoral:                 'activismo-electoral.png',
  accion_juridica:           'activismo-accion-juridica.png',
  economico:                 'activismo-economico.png',
  educacion_multiplicadores: 'activismo-educacion-multiplicadores.png',
  creativo_cultural:         'activismo-creativo-cultural.png',
  coaliciones:               'activismo-coaliciones.png',
};

const HORIZONTES = [
  { key: 'en_contra', nombre: 'EN CONTRA', color: '#C41230', colorTexto: '#791F1F', fondo: '#FFF5F6' },
  { key: 'neutral',   nombre: 'NEUTRAL',   color: '#B8860B', colorTexto: '#633806', fondo: '#F8F3E6' },
  { key: 'a_favor',   nombre: 'A FAVOR',   color: '#2E7D32', colorTexto: '#27500A', fondo: '#F4FAF4' },
];
const AREA_POR_RESULTADO = { NO: 'en_contra', SI_MATIZ: 'neutral', SI: 'a_favor' };

function calcularSeccionesHorizonte(datos) {
  const criterios = datos.categorias.flatMap(cat => cat.criterios).filter(c => c.resultado !== 'NA');
  const secciones = { en_contra: [], neutral: [], a_favor: [] };
  criterios.forEach(c => {
    const area = AREA_POR_RESULTADO[c.resultado];
    if (area) secciones[area].push(c);
  });
  return secciones;
}

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

  .portada-pres { break-after: page; height: 178mm; display: flex; flex-direction: column; }
  .portada-cinta { height: 5px; background: #C41230; flex: 0 0 auto; }

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

  .portada-hero { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 34px; text-align: center; padding: 0 16mm; }
  .recomendacion-general { font-family: Georgia, 'Times New Roman', serif; font-size: 34px; font-weight: 700; line-height: 1.35; max-width: 720px; }
  .motto-linea1 { font-family: Georgia, 'Times New Roman', serif; font-size: 25px; font-weight: 700; color: #1A1A1A; }
  .motto-linea2 { font-family: Georgia, 'Times New Roman', serif; font-size: 25px; font-style: italic; color: #C41230; }

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

  .lamina-idea-activismo { break-before: page; height: 178mm; display: flex; align-items: center; gap: 36px; padding: 0 12mm; }
  .idea-ilustracion {
    flex: 0 0 42%; height: 140mm; border-radius: 8px;
    background-color: #EFEBE0; background-size: contain; background-position: center; background-repeat: no-repeat;
  }
  .idea-contenido { flex: 1 1 auto; }
  .idea-numero { font-size: 13px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #8A8478; margin-bottom: 14px; }
  .idea-titulo { font-family: Georgia, 'Times New Roman', serif; font-size: 28px; font-weight: 700; line-height: 1.3; margin-bottom: 18px; max-width: 480px; }
  .idea-descripcion { font-size: 17px; color: #4A4A4A; line-height: 1.6; max-width: 480px; }

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

const TIPO_ACTIVISMO_POR_HORIZONTE = { en_contra: 'rechazo', neutral: 'mejora', a_favor: 'promocion' };

// v6.0 (10 ago 2026) — CASO HÍBRIDO CON IDEAS REALES: reemplaza a
// generarLaminaActivismoHorizonteHTML() (listaba TODOS los criterios
// aplicables de cada horizonte, con un texto de relleno en vez de una
// idea real — el hueco documentado desde el 22 de julio). Ahora recibe
// directamente la lista de ideas ya generadas por criterio (ver
// seleccionarCriteriosHibridos() y generarIdeaActivismoCriterio() en
// generarActivismo.js) y reutiliza generarLaminaIdeaHTML() — la misma
// lámina de una idea por página, con ilustración, que ya usa el caso
// total — coloreando cada una según el horizonte real de su propio
// criterio (rojo=rechazo, dorado=mejora, verde=promoción), no un solo
// color fijo para toda la Presentación como en el caso total. Orden:
// rechazo primero, mejora, promoción al final — mismo criterio de
// urgencia que ya usa el resto de la Presentación.
const COLOR_POR_HORIZONTE = { en_contra: '#C41230', neutral: '#B8860B', a_favor: '#2E7D32' };
const ORDEN_HORIZONTE = { en_contra: 0, neutral: 1, a_favor: 2 };

function generarLaminasHibridoHTML(ideasConCriterio) {
  const lista = ideasConCriterio || [];
  const ordenadas = [...lista].sort((a, b) => {
    const ha = AREA_POR_RESULTADO[a.resultado], hb = AREA_POR_RESULTADO[b.resultado];
    return (ORDEN_HORIZONTE[ha] ?? 9) - (ORDEN_HORIZONTE[hb] ?? 9);
  });
  return ordenadas.map((item, i) => {
    const horizonte = AREA_POR_RESULTADO[item.resultado];
    const color = COLOR_POR_HORIZONTE[horizonte] || '#8A8478';
    return generarLaminaIdeaHTML(item.idea, i + 1, ordenadas.length, color);
  }).join('\n');
}

function generarSeccionActivismoHTML(veredicto, ideasActivismoTotal, ideasActivismoHibrido) {
  if (veredicto.modo !== 'hibrido') {
    return generarLaminasVeredictoTotalHTML(veredicto, ideasActivismoTotal);
  }
  return generarLaminasHibridoHTML(ideasActivismoHibrido);
}

// ── Lámina de contacto ────────────────────────────────────────────────
// v2.7 (4 ago 2026): ya no asume que la lista es siempre DUMMY — el
// banner amarillo de aviso ahora solo aparece si de verdad se está usando
// el respaldo (ver la lógica en generarPresentacionPDF() más abajo, que
// decide entre datos reales y DUMMY antes de llegar aquí). Esta función
// recibe la lista ya decidida y un flag `esDummy` para saber si mostrar
// el aviso.
function generarLaminaContactoHTML(contactos, esDummy) {
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
      ${esDummy ? `<div class="contacto-aviso-dummy">⚠ DATOS DE PRUEBA — pendientes de curar y verificar. No usar en producción real.</div>` : ''}
      ${itemsHTML}
    </div>
  </div>
</div>`;
}

function generarHTML(datos, metadatos, contexto) {
  const { titulo = 'Documento auditado', pais = '', generadoEl = '' } = metadatos;
  const { veredicto, ideasActivismoTotal, ideasActivismoHibrido, contactosApoyo, contactosSonDummy } = contexto;

  const portadaHTML   = generarPortadaHTML(titulo, pais, generadoEl, veredicto);
  const activismoHTML = generarSeccionActivismoHTML(veredicto, ideasActivismoTotal, ideasActivismoHibrido);
  const contactoHTML  = generarLaminaContactoHTML(contactosApoyo, contactosSonDummy);

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

const _htmlsTemporalesPresentacion = new Map();

function registrarRutaHTMLTemporalPresentacion(app) {
  app.get('/presentacion-temp/:id', (req, res) => {
    const html = _htmlsTemporalesPresentacion.get(req.params.id);
    if (!html) return res.status(404).send('No encontrado');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });
}

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
// v2.7 (4 ago 2026): séptimo parámetro opcional `contactosApoyo` — ver
// changelog arriba. Se usa si trae al menos un contacto; si no, se cae al
// respaldo DUMMY de generarActivismo.js, con aviso explícito en el log Y
// en la propia lámina (el banner amarillo solo aparece cuando de verdad
// son datos de prueba).
// v2.8 (4 ago 2026) — ESTILO DE ACTIVISMO EDITABLE: octavo parámetro
// opcional `promptsActivismo` — objeto { estiloPersona, reglasGeneracion }
// que worker.js arma leyendo prompts_productos ("presentacion_activismo_estilo"
// y "presentacion_activismo_reglas") y pasa tal cual a
// generarIdeasActivismoTotal(). Si no llega (objeto vacío por defecto),
// generarActivismo.js usa sus propios textos de respaldo — comportamiento
// idéntico al de antes de este cambio.
// v2.9 (9 ago 2026) — ver changelog arriba: ya no se lee `datos.descalificado`
// en ningún punto de esta función.
// v3.0 (10 ago 2026) — CASO HÍBRIDO CON IDEAS REALES: hasta ahora, un
// documento híbrido (ni rechazo ni apoyo total) mostraba un texto de
// relleno ("[PENDIENTE...]") por cada criterio aplicable — hueco
// documentado desde el 22 de julio, expuesto por primera vez hoy con la
// primera auditoría real que cayó en esa banda. Se genera ahora 1 idea
// real por criterio, para hasta 7 criterios (1 por cada una de las 7
// categorías doctrinales con más criterios, el de mayor peso dentro de
// cada una — decisión de Moisés: "la Presentación no debe ser
// exhaustiva"). Ver seleccionarCriteriosHibridos() y
// generarIdeaActivismoCriterio() en generarActivismo.js (v6).
async function generarPresentacionPDF(datos, metadatos, rutaSalida, auditoria_id, grafoDatos = null, pesosCriterios = {}, contactosApoyo = null, promptsActivismo = {}) {
  console.log(`\n   ▶ [${auditoria_id}] INICIO generarPresentacionPDF v3.0`);

  let enlaces;
  if (grafoDatos && Array.isArray(grafoDatos.enlaces)) {
    enlaces = grafoDatos.enlaces;
    console.log(`   [${auditoria_id}] Usando grafo real recibido: ${enlaces.length} enlaces`);
  } else {
    console.warn(`   ⚠️ [${auditoria_id}] generarPresentacionPDF: no se recibió un grafo real (grafoDatos) — el veredicto de activismo se calculará con 0 enlaces, lo cual SIEMPRE da RECHAZO TOTAL sin importar el documento. Revisar si el Paso 6.5 falló para esta auditoría, o si el llamador todavía no pasa grafoDatos.`);
    enlaces = calcularDatosGrafo(datos).enlaces;
  }

  const resumenHorizontes = calcularResumenHorizontes(enlaces, pesosCriterios);
  const veredicto = calcularVeredictoActivismo(resumenHorizontes);

  let ideasActivismoTotal = null;
  let ideasActivismoHibrido = null;
  if (veredicto.modo !== 'hibrido') {
    console.log(`   [${auditoria_id}] Generando ideas de activismo (${veredicto.modo})...`);
    ideasActivismoTotal = await generarIdeasActivismoTotal(
      datos, metadatos, veredicto, auditoria_id,
      promptsActivismo.estiloPersona, promptsActivismo.reglasGeneracion
    );
    console.log(`   [${auditoria_id}] ${ideasActivismoTotal.length} ideas generadas`);
  } else {
    // v6.0 (10 ago 2026): caso híbrido con ideas reales — hasta 7
    // criterios (1 por cada una de las 7 categorías doctrinales con más
    // criterios, el de mayor peso dentro de cada una). Ver el changelog
    // completo en generarActivismo.js.
    const seleccionados = seleccionarCriteriosHibridos(datos, pesosCriterios);
    console.log(`   [${auditoria_id}] Caso híbrido: generando ${seleccionados.length} idea(s) puntual(es), 1 por categoría entre las 7 con más criterios...`);
    ideasActivismoHibrido = await Promise.all(
      seleccionados.map(({ criterio, categoriaDoctrinal }) => {
        const tipo = TIPO_ACTIVISMO_POR_HORIZONTE[AREA_POR_RESULTADO[criterio.resultado]];
        return generarIdeaActivismoCriterio(
          criterio, categoriaDoctrinal, metadatos, tipo, auditoria_id,
          promptsActivismo.estiloPersona, promptsActivismo.reglasGeneracion
        );
      })
    );
    console.log(`   [${auditoria_id}] ${ideasActivismoHibrido.length} idea(s) híbrida(s) generada(s)`);
  }

  // Contactos reales si worker.js mandó al menos uno; si no, respaldo DUMMY
  // — y se deja constancia clara de cuál de los dos casos fue.
  const contactosSonDummy = !contactosApoyo || contactosApoyo.length === 0;
  const contactos = contactosSonDummy ? obtenerContactosApoyo() : contactosApoyo;
  if (contactosSonDummy) {
    console.warn(`   ⚠️ [${auditoria_id}] generarPresentacionPDF: no se recibieron contactos reales de contactos_apoyo — usando datos DUMMY de respaldo. Agrega al menos un contacto activo desde /admin/contactos-apoyo.`);
  }

  const html = generarHTML(datos, metadatos, {
    veredicto, ideasActivismoTotal, ideasActivismoHibrido, contactosApoyo: contactos, contactosSonDummy,
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