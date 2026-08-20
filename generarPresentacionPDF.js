// generarPresentacionPDF.js — ACL Worker
// Umbusk LLC · Auditoría Cívica Liberal
//
// [... changelog anterior sin cambios, ver versiones previas del archivo ...]
//
// v2.7 (4 ago 2026) — CONTACTOS DE APOYO REALES.
// v2.9 (9 ago 2026) — SE ELIMINAN LOS DESCALIFICADORES.
// v3.0 (10 ago 2026) — CASO HÍBRIDO CON IDEAS REALES.
//
// v4.0 (16 ago 2026) — SE RETIRA EL VEREDICTO BINARIO, SELECCIÓN
// PROPORCIONAL PARA TODOS LOS CASOS:
//
// Motivo: un caso real (programa de gobierno, 87% de alineación en el
// Reporte) mostró "RECHAZAR 100%" en la portada de esta Presentación. La
// causa inmediata fue un fallo en el reconocimiento de artículos (ver
// generarDatosGrafo.js v7) — pero la causa de fondo era de diseño: el
// veredicto (rechazo_total/promocion_total/hibrido, calcularVeredictoActivismo())
// dependía enteramente de grafo_datos/enlaces, así que CUALQUIER fallo en
// ese reconocimiento (pasado o futuro) podía producir una recomendación
// que no reflejara ningún análisis real. Además, el concepto de
// "horizontes" (en_contra/neutral/a_favor) que alimentaba ese cálculo
// quedó descartado como diseño — ningún producto lo usa ya.
//
// Rediseño (decisión de Moisés, 16 ago 2026): la Presentación deja de
// calcular un veredicto binario. En su lugar, usa
// seleccionarPuntosDestacados() (generarActivismo.js) — la misma función
// que ahora también usa el Podcast — para elegir siempre 10 puntos
// (positivos y negativos), en la misma proporción que la alineación
// general del documento (el mismo datos.puntaje que ya muestra el
// Reporte, NUNCA grafo_datos/enlaces). Se genera una idea de activismo
// real por cada punto (generarIdeaActivismoCriterio(), sin cambios en su
// propia lógica) — hacia el rechazo si el criterio dio NO, hacia la
// mejora si dio SÍ con matiz, hacia la promoción si dio SÍ pleno. Un
// documento con 87% de alineación ahora muestra 9 ideas para defender lo
// que funciona y 1 para corregir lo que no — nunca "RECHAZAR 100%".
//
// Portada: el título ya no dice "RECHAZAR/APOYAR 100%" — dice
// "Alineación Liberal: XX%. Ideas de Activismo" (texto aprobado por
// Moisés), con el mismo color semántico de siempre (rojo/dorado/verde)
// según el rango del porcentaje, ya sin ninguna decisión de contenido
// atada a ese color.
//
// Parámetro `grafoDatos` (quinto, sin cambios de posición): se sigue
// aceptando por compatibilidad con worker.js (procesarAuditoria y
// /regenerar-presentacion lo siguen pasando tal cual), pero ya NO se usa
// para nada — queda reservado por si más adelante se decide mostrar, como
// enriquecimiento opcional, qué artículos respaldan cada punto. Ningún
// llamador necesita cambiar.
//
// SUPERADAS por este cambio, dejadas intactas sin llamarse (mismo
// criterio que ya usa este proyecto con otro código superado):
// calcularVeredictoActivismo(), calcularResumenHorizontes(),
// generarIdeasActivismoTotal(), seleccionarCriteriosHibridos() — ver el
// changelog completo en generarActivismo.js v8 y generarDatosGrafo.js.
// Dentro de este archivo: generarTituloRecomendacionGeneral(),
// generarLaminasVeredictoTotalHTML(), generarSeccionActivismoHTML() y
// generarLaminasHibridoHTML() se retiran (no eran parte de la superficie
// pública del módulo, no hay nada externo que dependa de ellas) — su
// lógica se unifica en la nueva generarLaminasIdeasHTML(), que cubre
// todos los casos por igual. HORIZONTES, AREA_POR_RESULTADO y
// calcularSeccionesHorizonte() (dead code ya desde antes de este cambio,
// solo usado por generarLaminasHallazgosHTML(), que tampoco se llama
// desde generarHTML()) quedan intactos sin tocar.
//
// v4.1 (20 ago 2026) — DISCLAIMER DE PORTADA: generarPresentacionPDF()
// acepta un noveno parámetro opcional `disclaimer` (texto plano, ej.
// desde prompts_productos, clave "disclaimer_presentacion") — mismo
// mecanismo que generarReportePDF.js: se inyecta literal (escapado con
// esc(), sin pasar por Claude), centrado bajo la portada. Si llega null
// (la clave todavía no existe), no se muestra nada — no bloquea la
// generación de la presentación.

'use strict';

const fs = require('fs');
const { etiquetaCortaComponente } = require('./generarDatosGrafo');
const { seleccionarPuntosDestacados, generarIdeaActivismoCriterio, obtenerContactosApoyo } = require('./generarActivismo');

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

// ── SUPERADO / dead code, sin tocar (ver nota en el changelog de arriba) ──
// HORIZONTES y AREA_POR_RESULTADO ya no alimentan la portada ni la sección
// de Activismo desde el v4.0 — quedan porque calcularSeccionesHorizonte()
// y generarLaminasHallazgosHTML() (más abajo) los siguen usando, y esos
// dos ya eran dead code desde antes de este cambio (generarHTML() no los
// llama — ver nota histórica: "LÁMINA DE HALLAZGOS ILUSTRADOS — RETIRADA").
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

// ── EN USO (16 ago 2026) — tipo y color de idea, directo por resultado ───
// Reemplaza a TIPO_ACTIVISMO_POR_HORIZONTE/COLOR_POR_HORIZONTE/ORDEN_HORIZONTE
// del v3.0 (que pasaban por AREA_POR_RESULTADO) — ahora es un único paso,
// sin el concepto de horizonte de por medio.
const TIPO_ACTIVISMO_POR_RESULTADO  = { NO: 'rechazo', SI_MATIZ: 'mejora', SI: 'promocion' };
const COLOR_ACTIVISMO_POR_RESULTADO = { NO: '#C41230', SI_MATIZ: '#B8860B', SI: '#2E7D32' };
const ORDEN_TIPO_ACTIVISMO          = { rechazo: 0, mejora: 1, promocion: 2 };

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

  .portada-disclaimer-pres {
    flex: 0 0 auto;
    padding: 0 52px 22px;
    text-align: center;
    font-size: 11px;
    color: #8A8478;
    line-height: 1.5;
    font-style: italic;
  }

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

// ── Portada (16 ago 2026, v4.0) — ya no muestra un veredicto binario ─────
// El color sigue el mismo semáforo de siempre (rojo/dorado/verde) según el
// rango del porcentaje, pero ya no está atado a ninguna decisión de
// contenido — es puramente visual, igual que en el Reporte.
// 20 ago 2026 (v4.1): quinto parámetro opcional `disclaimer` — mismo
// mecanismo que generarReportePDF.js (prompts_productos, clave
// "disclaimer_presentacion").
function generarPortadaHTML(titulo, pais, generadoEl, alineacionPorcentaje, disclaimer = null) {
  const color = alineacionPorcentaje < 20 ? '#C41230' : alineacionPorcentaje > 80 ? '#2E7D32' : '#B8860B';
  const tituloHero = `Alineación Liberal: ${alineacionPorcentaje}%. Ideas de Activismo`;

  const disclaimerHTML = disclaimer
    ? `<div class="portada-disclaimer-pres">${esc(disclaimer)}</div>`
    : '';

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
    <h2 class="recomendacion-general" style="color:${color}">${esc(tituloHero)}</h2>
    <div class="motto">
      <div class="motto-linea1">Defiende la libertad.</div>
      <div class="motto-linea2">Audita el poder.</div>
    </div>
  </div>
  ${disclaimerHTML}
</div>`;
}

// ── SUPERADO / dead code, sin tocar — no se llama desde generarHTML() ────
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

// ── EN USO (16 ago 2026) — una lámina por idea, para TODOS los casos ─────
// Reemplaza a generarLaminasVeredictoTotalHTML() + generarSeccionActivismoHTML()
// + generarLaminasHibridoHTML() del v3.0 — antes había una rama para el
// caso "total" (color único para toda la Presentación) y otra para el
// caso "híbrido" (color por criterio). Ahora solo existe este camino:
// siempre una idea por criterio, siempre coloreada según su propio
// resultado. Orden: rechazo primero, mejora, promoción al final — mismo
// criterio de urgencia que ya usaba el caso híbrido.
function generarLaminasIdeasHTML(ideasConCriterio) {
  const lista = ideasConCriterio || [];
  const ordenadas = [...lista].sort((a, b) => {
    const ta = TIPO_ACTIVISMO_POR_RESULTADO[a.resultado] || 'promocion';
    const tb = TIPO_ACTIVISMO_POR_RESULTADO[b.resultado] || 'promocion';
    return (ORDEN_TIPO_ACTIVISMO[ta] ?? 9) - (ORDEN_TIPO_ACTIVISMO[tb] ?? 9);
  });
  return ordenadas.map((item, i) => {
    const color = COLOR_ACTIVISMO_POR_RESULTADO[item.resultado] || '#8A8478';
    return generarLaminaIdeaHTML(item.idea, i + 1, ordenadas.length, color);
  }).join('\n');
}

// ── Lámina de contacto — sin cambios ──────────────────────────────────────
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
  const { alineacionPorcentaje, ideasConCriterio, contactosApoyo, contactosSonDummy, disclaimer } = contexto;

  const portadaHTML   = generarPortadaHTML(titulo, pais, generadoEl, alineacionPorcentaje, disclaimer);
  const activismoHTML = generarLaminasIdeasHTML(ideasConCriterio);
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
// Firma: se agrega un noveno parámetro opcional `disclaimer` (20 ago
// 2026, v4.1) — ningún llamador existente en worker.js necesita cambiar
// salvo para empezar a pasarlo; si no lo pasa, sigue funcionando igual
// que antes (sin disclaimer en la portada). `grafoDatos` (quinto
// parámetro) se sigue aceptando pero ya no se usa — ver el changelog v4.0
// al inicio del archivo.
async function generarPresentacionPDF(datos, metadatos, rutaSalida, auditoria_id, grafoDatos = null, pesosCriterios = {}, contactosApoyo = null, promptsActivismo = {}, disclaimer = null) {
  console.log(`\n   ▶ [${auditoria_id}] INICIO generarPresentacionPDF v4.1 (disclaimer de portada)`);

  const seleccion = seleccionarPuntosDestacados(datos, pesosCriterios);
  console.log(`   [${auditoria_id}] Alineación: ${seleccion.alineacionPorcentaje}% — puntos seleccionados: ${seleccion.negativos.length} negativo(s), ${seleccion.positivos.length} positivo(s)`);

  const todosLosPuntos = [...seleccion.negativos, ...seleccion.positivos];
  console.log(`   [${auditoria_id}] Generando ${todosLosPuntos.length} idea(s) de activismo (una por punto, en paralelo)...`);
  const ideasConCriterio = await Promise.all(
    todosLosPuntos.map(({ criterio, categoriaDoctrinal }) => {
      const tipo = TIPO_ACTIVISMO_POR_RESULTADO[criterio.resultado] || 'promocion';
      return generarIdeaActivismoCriterio(
        criterio, categoriaDoctrinal, metadatos, tipo, auditoria_id,
        promptsActivismo.estiloPersona, promptsActivismo.reglasGeneracion
      );
    })
  );
  console.log(`   [${auditoria_id}] ${ideasConCriterio.length} idea(s) generada(s)`);

  // Contactos reales si worker.js mandó al menos uno; si no, respaldo DUMMY
  // — y se deja constancia clara de cuál de los dos casos fue.
  const contactosSonDummy = !contactosApoyo || contactosApoyo.length === 0;
  const contactos = contactosSonDummy ? obtenerContactosApoyo() : contactosApoyo;
  if (contactosSonDummy) {
    console.warn(`   ⚠️ [${auditoria_id}] generarPresentacionPDF: no se recibieron contactos reales de contactos_apoyo — usando datos DUMMY de respaldo. Agrega al menos un contacto activo desde /admin/contactos-apoyo.`);
  }

  const html = generarHTML(datos, metadatos, {
    alineacionPorcentaje: seleccion.alineacionPorcentaje,
    ideasConCriterio,
    contactosApoyo: contactos,
    contactosSonDummy,
    disclaimer,
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