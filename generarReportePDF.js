// generarReportePDF.js — ACL Worker v3.0
// Genera el reporte de auditoría en HTML y lo convierte a PDF con CloudConvert
// Umbusk LLC · Auditoría Cívica Liberal
//
// CAMBIOS v2-v2.6 (jun-jul 2026): ver versiones anteriores del archivo.
//   Resumen ejecutivo por Claude, detección de criterios en tabla markdown,
//   Manual/Ficha reordenados, Indicador General reemplazado por puntos
//   clave, fondo crema de borde a borde, salto de página solo antes de la
//   primera categoría, leyenda SÍ/SÍ*/NO, cuadro resumen por categoría.
//
// CAMBIOS v2.7-v2.9 (7 jul 2026):
//   Fix del párrafo de cierre pegado al último criterio + inconsistencia
//   de nivel de riesgo (CRÍTICO reconocido). Cuadro resumen duplicado en
//   portada, espaciado de bullets reducido, numeración de páginas, nota de
//   "efecto comadreja", leyenda de niveles de riesgo (rangos confirmados:
//   Bajo 85-100% / Moderado 65-84% / Alto 40-64% / Crítico 0-39% — "MUY
//   ALTO" nunca existió en la doctrina real). Cuadro/leyenda duplicados al
//   final del Análisis por Criterio eliminados (quedaban redundantes con
//   la portada). Ficha movida a después de la última categoría.
//
// CAMBIOS v3.0 (7 jul 2026):
//  34. FIX DE RAÍZ (puntos clave vacíos + resumen ejecutivo reducido a una
//      línea): generarResumenEjecutivo() pedía la respuesta en JSON con el
//      resumen de 3 párrafos embebido en un campo de texto. Un texto largo
//      con saltos de línea dentro de un string JSON es frágil — basta que
//      Claude use un salto de línea real en vez de "\n" escapado para que
//      JSON.parse() falle, y eso es exactamente lo que estaba pasando: al
//      fallar, la función caía al texto mecánico de respaldo (una sola
//      oración) y devolvía puntosClave vacío. Se dejó de usar JSON — ahora
//      se pide un formato de texto plano con marcadores ("PUNTOS_CLAVE:" /
//      "RESUMEN:") que no tiene sintaxis que romper con un salto de línea.
//  35. El link al Manual de Liberalismo ya NO depende de que Claude escriba
//      literalmente "efecto comadreja" en su análisis (frase que varía de
//      una corrida a otra). Ahora aparece SIEMPRE en dos lugares que se
//      renderizan en todo reporte: la fila "Marco doctrinal" de la Ficha,
//      y la leyenda de niveles de riesgo en la portada. La nota dinámica
//      cuando sí aparece "efecto comadreja" en el texto se conserva como
//      complemento, no como única vía.

'use strict';

const fs      = require('fs');
const path    = require('path');
const Anthropic = require('@anthropic-ai/sdk');

// ── Constantes doctrinales ──────────────────────────────────────────────────

const URL_MANUAL = 'https://liberalmente.app/manual-de-liberalismo.pdf';

const RANGOS_RIESGO = [
  { nivel: 'BAJO',     rango: '85–100%', desc: 'Alineación sólida con los principios del liberalismo clásico.' },
  { nivel: 'MODERADO', rango: '65–84%',  desc: 'Alineación mayoritaria, con debilidades puntuales que no son estructurales.' },
  { nivel: 'ALTO',     rango: '40–64%',  desc: 'Debilidades significativas frente al marco doctrinal liberal.' },
  { nivel: 'CRÍTICO',  rango: '0–39%',   desc: 'Configuración normativa que contradice de forma extensa y estructural los principios del liberalismo clásico.' },
];

const LEYENDA_RIESGO_LISTA = true;

// ── Helpers de HTML ──────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Como esc(), pero además inserta la nota doctrinal cuando el texto
// menciona "efecto comadreja". Complementa (no reemplaza) el link fijo que
// ahora vive en la Ficha y en la leyenda de riesgo — ver changelog v3.0 #35.
function conNotaComadreja(textoPlano) {
  const escapado = esc(textoPlano);
  return escapado.replace(
    /efecto comadreja/gi,
    (match) => `${match} <a href="${URL_MANUAL}" class="nota-doctrinal">(consultar el Manual de Liberalismo)</a>`
  );
}

function badgeResultado(resultado) {
  if (!resultado) return '';
  if (resultado === 'SI_MATIZ')
    return `<span class="criterio-resultado si-matiz">! SÍ*</span>`;
  if (resultado === 'SI')
    return `<span class="criterio-resultado si">✓ SÍ</span>`;
  if (resultado === 'NO')
    return `<span class="criterio-resultado no">✗ NO</span>`;
  return `<span class="criterio-resultado na">— N/A</span>`;
}

function colorAlerta(gravedad) {
  const g = (gravedad || '').toUpperCase();
  if (g === 'ALTA')                   return { fondo: '#FEF0F0', borde: '#EDAAAA', badge: '#C41230' };
  if (g.includes('MODERADA'))         return { fondo: '#F8F3E6', borde: '#D4C080', badge: '#B8860B' };
  return                                     { fondo: '#E8F0F7', borde: '#B5CDE0', badge: '#2A6496' };
}

function normalizarResultadoTabla(texto) {
  const t = (texto || '').toUpperCase().trim();
  if (/CON RESERVA|CON MATIZ|PARCIAL|MIXTO/.test(t)) return 'SI_MATIZ';
  if (/^NO\b/.test(t))       return 'NO';
  if (/^N\/A|^NA\b/.test(t)) return 'NA';
  if (/^S[IÍ]\b/.test(t))    return 'SI';
  return 'SI';
}

function extraerNotaFinalDeTexto(texto) {
  const m = texto.match(/(Resultados\s+(?:SÍ|SI|NO|N\/A)\s*:\s*\d+[\s\S]{0,150}?NIVEL DE RIESGO(?:\s+LIBERAL)?[^:]*:\s*\**\s*(BAJO|MODERADO|ALTO|MUY ALTO|CR[IÍ]TICO)\**\s*(?:\([^)]*\))?\s*)([\s\S]*)$/i);
  if (!m) return null;
  const idx = texto.indexOf(m[0]);
  return {
    textoLimpio:  texto.slice(0, idx).trim(),
    nivelRiesgo:  m[2].toUpperCase(),
    parrafoFinal: m[3].trim(),
  };
}

// ── CSS del reporte ──────────────────────────────────────────────────────────

const CSS = `
  @page {
    size: A4;
    margin: 18mm 18mm 22mm 18mm;
    @bottom-right {
      content: counter(page) " / " counter(pages);
      font-family: Arial, Helvetica, sans-serif;
      font-size: 9px;
      color: #8A8478;
    }
  }

  @page portada {
    margin: 0;
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:            #F7F5F0;
    --bg-alt:        #EDEBE4;
    --bg-card:       #FFFFFF;
    --border:        #D4CFC4;
    --border-subtle: #E8E4DC;
    --text:          #1A1A1A;
    --text-mid:      #4A4A4A;
    --text-muted:    #8A8478;
    --accent:        #C41230;
    --teal:          #2A6496;
    --gold:          #B8860B;
    --gold-soft:     #F8F3E6;
    --green:         #1A6B3C;
    --green-soft:    #EBF5EE;
    --serif:         Georgia, 'Times New Roman', serif;
    --sans:          Arial, Helvetica, sans-serif;
  }

  html {
    background: var(--bg);
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  body {
    font-family: var(--sans);
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
    line-height: 1.6;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    orphans: 3;
    widows: 3;
  }

  .portada {
    page: portada;
    break-after: page;
    background: var(--bg);
    width: 100%;
    min-height: 250mm;
    display: flex;
    flex-direction: column;
  }

  .portada-cinta { height: 5px; background: var(--accent); flex-shrink: 0; }

  .portada-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 28px 52px 24px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .portada-logo { font-family: var(--serif); font-size: 22px; letter-spacing: -0.02em; }
  .portada-logo strong { font-weight: 700; }
  .portada-logo span   { font-weight: 400; }

  .portada-meta-header {
    font-size: 11px; color: var(--text-muted);
    text-align: right; line-height: 1.5;
  }

  .portada-body {
    flex: 1;
    padding: 40px 52px 0;
    display: flex;
    flex-direction: column;
  }

  .portada-etiqueta {
    font-size: 10px; font-weight: 600;
    letter-spacing: 0.12em; text-transform: uppercase;
    color: var(--accent); margin-bottom: 16px;
  }

  .portada-titulo {
    font-family: var(--serif);
    font-size: 28px; font-weight: 700;
    line-height: 1.2; letter-spacing: -0.02em;
    color: var(--text); max-width: 560px; margin-bottom: 10px;
  }

  .portada-subtitulo {
    font-size: 13px; color: var(--text-mid);
    font-style: italic; font-family: var(--serif); margin-bottom: 20px;
  }

  .puntos-clave {
    list-style: none;
    margin: 0 0 16px 0;
    padding: 0;
  }

  .puntos-clave li {
    position: relative;
    padding-left: 16px;
    margin-bottom: 4px;
    font-size: 12px;
    color: var(--text-mid);
    line-height: 1.35;
    font-weight: 400;
  }

  .puntos-clave li::before {
    content: '';
    position: absolute;
    left: 0;
    top: 6px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
  }

  .resumen-portada-bloque {
    margin-top: 6px;
  }

  .resumen-categorias-tabla--compacta th,
  .resumen-categorias-tabla--compacta td {
    padding: 4px 6px;
    font-size: 9.5px;
  }

  .nota-final-texto {
    margin-top: 12px;
    font-size: 11px;
    color: var(--text-mid);
    line-height: 1.55;
    font-weight: 300;
  }

  .nota-doctrinal {
    color: var(--accent);
    text-decoration: underline;
  }

  .seccion-cabecera {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 28px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
    page-break-after: avoid;
  }

  .seccion-label {
    font-size: 10px; font-weight: 600;
    letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent);
  }

  .seccion-referencia {
    font-size: 11px; color: var(--text-muted);
  }

  .seccion-titulo-principal {
    font-family: var(--serif);
    font-size: 17px; font-weight: 700;
    letter-spacing: -0.01em; color: var(--text);
    margin-bottom: 24px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border-subtle);
    line-height: 1.3;
    page-break-after: avoid;
  }

  .resumen-bloque {
    break-before: page;
  }

  .resumen-texto {
    font-size: 12.5px; color: var(--text-mid);
    line-height: 1.8; font-weight: 300;
  }

  .resumen-texto p { margin-bottom: 10px; }
  .resumen-texto p:last-child { margin-bottom: 0; }

  .ficha-bloque {
    break-before: page;
  }

  .ficha-tabla { width: 100%; border-collapse: collapse; margin-top: 8px; }
  .ficha-tabla tr { border-bottom: 1px solid var(--border-subtle); }
  .ficha-tabla tr:last-child { border-bottom: none; }
  .ficha-tabla td { padding: 10px 12px; font-size: 12.5px; vertical-align: top; }
  .ficha-tabla td:first-child {
    width: 180px; font-size: 10px; font-weight: 600;
    letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--text-muted); padding-top: 12px;
  }
  .ficha-tabla td:last-child { color: var(--text); }

  .categoria-bloque-primera {
    break-before: page;
  }

  .categoria-titulo {
    font-family: var(--serif);
    font-size: 14px; font-weight: 700;
    letter-spacing: -0.01em; color: var(--text);
    padding: 12px 0 10px;
    border-top: 2px solid var(--accent);
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 4px;
    page-break-after: avoid;
  }

  .categoria-num-roman {
    font-size: 10px; font-weight: 400;
    color: var(--accent); letter-spacing: 0.06em; text-transform: uppercase;
    flex-shrink: 0;
  }

  .criterio {
    padding: 14px 0;
    border-bottom: 1px solid var(--border-subtle);
    page-break-inside: avoid;
  }
  .criterio:last-child { border-bottom: none; }

  .criterio-header {
    display: flex;
    align-items: flex-start;
    gap: 12px; margin-bottom: 7px;
  }

  .criterio-codigo {
    font-size: 10px; font-weight: 700;
    letter-spacing: 0.08em; color: var(--text-muted);
    flex-shrink: 0; margin-top: 2px; min-width: 30px;
  }

  .criterio-pregunta {
    font-size: 12px; font-weight: 600;
    color: var(--text); line-height: 1.4; flex: 1;
  }

  .criterio-resultado {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10.5px; font-weight: 700;
    letter-spacing: 0.04em;
    padding: 3px 9px; border-radius: 2px;
    white-space: nowrap;
  }
  .criterio-resultado.si       { background: var(--green-soft); color: var(--green); border: 1px solid #A8D5BA; }
  .criterio-resultado.si-matiz { background: var(--gold-soft);  color: var(--gold);  border: 1px solid #D4C080; }
  .criterio-resultado.no       { background: #FEF0F0; color: var(--accent); border: 1px solid #EDAAAA; }
  .criterio-resultado.na       { background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); }

  .leyenda-resultados {
    background: var(--bg-alt);
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 16px 18px;
    margin-bottom: 24px;
    page-break-inside: avoid;
  }

  .leyenda-titulo {
    font-size: 10px; font-weight: 700;
    letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--text-muted); margin-bottom: 10px;
  }

  .leyenda-item {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 6px;
    font-size: 11.5px;
    color: var(--text-mid);
    line-height: 1.5;
  }
  .leyenda-item:last-child { margin-bottom: 0; }

  .leyenda-riesgo {
    background: var(--bg-alt);
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 14px 16px;
    margin-top: 16px;
    page-break-inside: avoid;
  }
  .leyenda-riesgo .leyenda-titulo {
    font-size: 9.5px; font-weight: 700;
    letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--text-muted); margin-bottom: 8px;
  }
  .leyenda-riesgo .leyenda-item-riesgo {
    font-size: 11px;
    color: var(--text-mid);
    line-height: 1.5;
    margin-bottom: 5px;
  }
  .leyenda-riesgo .leyenda-item-riesgo:last-child { margin-bottom: 0; }
  .leyenda-riesgo .leyenda-item-riesgo strong { color: var(--text); }

  .criterio-analisis {
    margin-left: 42px;
    font-size: 12px; color: var(--text-mid);
    line-height: 1.65; font-weight: 300;
  }

  .resumen-categorias-tabla {
    width: 100%;
    border-collapse: collapse;
    font-size: 11.5px;
  }
  .resumen-categorias-tabla th {
    text-align: left;
    font-size: 9.5px; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--text-muted);
    padding: 8px 10px;
    border-bottom: 2px solid var(--accent);
  }
  .resumen-categorias-tabla th:not(:first-child),
  .resumen-categorias-tabla td:not(:first-child) {
    text-align: center;
  }
  .resumen-categorias-tabla td {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-mid);
  }
  .resumen-categorias-tabla tfoot td {
    font-weight: 700;
    color: var(--text);
    border-top: 2px solid var(--accent);
    border-bottom: none;
  }

  .alertas-bloque {
    break-before: page;
  }

  .alertas-titulo {
    font-family: var(--serif);
    font-size: 17px; font-weight: 700;
    color: var(--text); margin-bottom: 22px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border-subtle);
    page-break-after: avoid;
  }

  .alerta {
    margin-bottom: 18px;
    border-radius: 2px;
    overflow: hidden;
    border: 1px solid var(--border);
    page-break-inside: avoid;
  }

  .alerta-header {
    display: flex; align-items: center;
    gap: 10px; padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }

  .alerta-num {
    font-size: 10px; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-muted);
    flex-shrink: 0;
  }

  .alerta-titulo-texto {
    font-family: var(--serif);
    font-size: 13px; font-weight: 700;
    flex: 1; line-height: 1.3; color: var(--text);
  }

  .alerta-gravedad {
    font-size: 10px; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase;
    padding: 3px 8px; border-radius: 2px; color: white;
    flex-shrink: 0;
  }

  .alerta-cuerpo {
    padding: 14px 16px;
    font-size: 12px; line-height: 1.65;
    color: var(--text-mid); background: white; font-weight: 300;
  }

  .alerta-criterios { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }

  .alerta-c-tag {
    font-size: 10px; font-weight: 600;
    padding: 2px 7px; border-radius: 2px;
    background: var(--bg); color: var(--text-muted);
    border: 1px solid var(--border); letter-spacing: 0.04em;
  }

  .pie-pagina {
    margin-top: 28px;
    padding-top: 12px;
    border-top: 1px solid var(--border-subtle);
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 10px;
    color: var(--text-muted);
    page-break-inside: avoid;
    page-break-before: avoid;
  }

  .pie-logo {
    font-family: var(--serif); font-size: 11px;
    font-weight: 700; color: var(--text-muted);
  }
`;

// ── Parsear el reporte de texto plano ────────────────────────────────────────

function parsearReporte(reporteTexto, auditoria_id = 'N/A') {
  const datos = {
    puntaje:     null,
    nivelRiesgo: 'MODERADO',
    siPlenos:    0,
    siMatiz:     0,
    noCount:     0,
    naCount:     0,
    resumenEjecutivo: '',
    puntosClave: [],
    notaFinal:   null,
    categorias:  [],
    alertas:     [],
  };

  const lineas = reporteTexto.split('\n');

  for (const linea of lineas) {
    const matchPct = linea.match(/([\d.]+)%/);
    if (matchPct && !datos.puntaje) {
      const v = parseFloat(matchPct[1]);
      if (v > 10 && v <= 100) { datos.puntaje = Math.round(v); }
    }
  }

  const matchRiesgo = reporteTexto.match(/NIVEL DE RIESGO(?:\s+LIBERAL)?[^:]*:\s*\**\s*(BAJO|MODERADO|ALTO|MUY ALTO|CR[IÍ]TICO)/i);
  if (matchRiesgo) datos.nivelRiesgo = matchRiesgo[1].toUpperCase();

  const CATEGORIAS_NOMBRES = {
    'I':   'Dignidad y Autonomía Individual',
    'II':  'Estado de Derecho e Instituciones',
    'III': 'Propiedad Privada y Libre Empresa',
    'IV':  'Competencia y Rechazo al Rentismo',
    'V':   'Límites al Estado y Subsidiariedad',
    'VI':  'Igualdad de Oportunidades y Política Social',
    'VII': 'Integridad Semántica y Soberanía',
  };

  let categoriaActual = null;
  let criterioActual  = null;
  let bufferAnalisis  = [];
  let enAlertas       = false;
  let alertaActual    = null;
  let bufferAlerta    = [];

  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i];

    if (/^#{1,4}\s*\d+\.\s*ALERTAS?|^##\s*ALERTAS|ALERTAS? PRINCIPALES/i.test(linea)) {
      enAlertas = true;
      if (criterioActual) {
        criterioActual.analisis = bufferAnalisis.join(' ').trim();
        bufferAnalisis = []; criterioActual = null;
      }
      if (alertaActual) {
        alertaActual.descripcion = bufferAlerta.join(' ').trim();
        bufferAlerta = []; datos.alertas.push(alertaActual); alertaActual = null;
      }
      continue;
    }

    if (/conclusi[oó]n|resumen ejecutivo|valoraci[oó]n final/i.test(linea) && linea.startsWith('#')) {
      if (criterioActual) {
        criterioActual.analisis = bufferAnalisis.join(' ').trim();
        bufferAnalisis = []; criterioActual = null;
      }
      enAlertas = false;
      continue;
    }

    const matchCat = linea.match(/^#{0,4}\s*CATEGOR[IÍ]A\s+(I{1,3}V?|VI{0,3}|IV)\s*[—–-]+\s*(.*)/i);
    if (matchCat) {
      if (criterioActual) {
        criterioActual.analisis = bufferAnalisis.join(' ').trim();
        bufferAnalisis = []; criterioActual = null;
      }
      enAlertas = false;
      const numRom  = matchCat[1].toUpperCase();
      const nombre  = matchCat[2].trim() || CATEGORIAS_NOMBRES[numRom] || `Categoría ${numRom}`;
      const nombreFmt = nombre === nombre.toUpperCase()
        ? (CATEGORIAS_NOMBRES[numRom] || nombre.charAt(0) + nombre.slice(1).toLowerCase())
        : nombre;
      categoriaActual = { num: numRom, nombre: nombreFmt, criterios: [] };
      datos.categorias.push(categoriaActual);
      continue;
    }

    const matchCritTabla = linea.match(/^\|\s*(C-\d{2})\s*\|\s*\*{0,2}([^|*]+?)\*{0,2}\s*\|\s*(.+?)\s*\|?\s*$/i);
    if (matchCritTabla && categoriaActual) {
      categoriaActual.criterios.push({
        id:        matchCritTabla[1].toUpperCase(),
        pregunta:  '',
        resultado: normalizarResultadoTabla(matchCritTabla[2]),
        analisis:  matchCritTabla[3].replace(/\*\*/g, '').trim(),
      });
      criterioActual = null;
      continue;
    }

    const matchCrit = linea.match(/^[#>\-\s]*\*{0,2}(?:criterio\s+)?(C-\d{2})\*{0,2}[.\s:]*(.*)/i);
    if (matchCrit && categoriaActual) {
      const esNotaMetodologica = /se computa|se compute|computa como|por tanto|N\/A aplicado|los criterios con|se pondera/i.test(linea);
      if (esNotaMetodologica) {
        if (criterioActual) {
          const limpia = linea.replace(/\*\*/g, '').replace(/^[\s>*-]+/, '').trim();
          if (limpia) bufferAnalisis.push(limpia);
        }
        continue;
      }
      if (criterioActual) {
        criterioActual.analisis = bufferAnalisis.join(' ').trim();
        bufferAnalisis = [];
      }
      const pregunta = matchCrit[2].replace(/\*\*/g, '').trim();
      criterioActual = { id: matchCrit[1].toUpperCase(), pregunta, resultado: 'SI', analisis: '' };
      categoriaActual.criterios.push(criterioActual);
      continue;
    }

    if (criterioActual) {
      const matchResultadoB = linea.match(/RESULTADO[:\s*:]+([^\n*]+)/i);
      if (matchResultadoB) {
        const texto = matchResultadoB[1].toUpperCase().trim();
        if      (/^NO\b|MIXTO.*NO|ALERTA MAYOR/.test(texto))        criterioActual.resultado = 'NO';
        else if (/^N\/A|^NA\b/.test(texto))                          criterioActual.resultado = 'NA';
        else if (/CON RESERVA|CON MATIZ|PARCIAL|MIXTO/.test(texto)) criterioActual.resultado = 'SI_MATIZ';
        else if (/^SÍ|^SI/.test(texto))                              criterioActual.resultado = 'SI';
        continue;
      }

      if      (/✅\s*SÍ\s*\*|✓\s*SÍ\s*\*|SÍ\s*con\s*matiz/i.test(linea))         criterioActual.resultado = 'SI_MATIZ';
      else if (/✅\s*SÍ|✓\s*SÍ|'\s*\*\*SÍ\*\*/i.test(linea) && !linea.includes('*')) criterioActual.resultado = 'SI';
      else if (/✗\s*NO|❌\s*NO/i.test(linea))                                         criterioActual.resultado = 'NO';

      if (linea.trim() && !linea.startsWith('#') && !linea.startsWith('---')
          && !linea.startsWith('**RESULTADO') && !linea.startsWith('|')
          && !/^\*\*Cálculo|Criterios aplicables|Resultados SÍ|Porcentaje de alineación/i.test(linea)) {
        const limpia = linea.replace(/\*\*/g, '').replace(/^[\s>*-]+/, '').trim();
        if (limpia) bufferAnalisis.push(limpia);
      }
      continue;
    }

    if (enAlertas) {
      const matchAlerta = linea.match(/^#{1,4}\s*ALERTA\s*\d+[^:]*[:\s]*(.*)/i);
      if (matchAlerta) {
        if (alertaActual) {
          alertaActual.descripcion = bufferAlerta.join(' ').trim();
          datos.alertas.push(alertaActual); bufferAlerta = [];
        }
        alertaActual = {
          titulo:      matchAlerta[1].replace(/\*\*/g, '').trim(),
          gravedad:    'MODERADA',
          descripcion: '',
          criterios:   [],
        };
        if      (/CRÍT|CRÍTICA|CRÍTICO/i.test(alertaActual.titulo))   alertaActual.gravedad = 'ALTA';
        else if (/ALTA/i.test(alertaActual.titulo))                    alertaActual.gravedad = 'ALTA';
        else if (/MODERADA?[- ]ALTA/i.test(alertaActual.titulo))      alertaActual.gravedad = 'MODERADA-ALTA';
        else if (/MODERADA?/i.test(alertaActual.titulo))               alertaActual.gravedad = 'MODERADA';
        continue;
      }
      if (alertaActual) {
        const matchGrav = linea.match(/Gravedad[:\s]+\**(ALTA|MODERADA[- ]ALTA|MODERADA|BAJA)\**/i);
        if (matchGrav) { alertaActual.gravedad = matchGrav[1].toUpperCase(); continue; }
        const matchCrits = linea.match(/C-\d{2}/g);
        if (matchCrits) alertaActual.criterios.push(...matchCrits.filter(c => !alertaActual.criterios.includes(c)));
        const limpia = linea.replace(/\*\*/g, '').replace(/^[>\s*#-]+/, '').trim();
        if (limpia && !linea.startsWith('#')) bufferAlerta.push(limpia);
      }
    }
  }

  if (criterioActual && bufferAnalisis.length > 0) criterioActual.analisis = bufferAnalisis.join(' ').trim();
  if (alertaActual) { alertaActual.descripcion = bufferAlerta.join(' ').trim(); datos.alertas.push(alertaActual); }

  for (const cat of datos.categorias) {
    for (const crit of cat.criterios) {
      const extra = extraerNotaFinalDeTexto(crit.analisis || '');
      if (extra) {
        crit.analisis     = extra.textoLimpio;
        datos.nivelRiesgo  = extra.nivelRiesgo;
        datos.notaFinal    = extra.parrafoFinal;
      }
    }
  }

  const todos = datos.categorias.flatMap(c => c.criterios);
  const siPlenosReal = todos.filter(c => c.resultado === 'SI').length;
  const siMatizReal  = todos.filter(c => c.resultado === 'SI_MATIZ').length;
  const noReal       = todos.filter(c => c.resultado === 'NO').length;
  const naReal       = todos.filter(c => c.resultado === 'NA').length;

  console.log(`\n   ╔══════════════════════════════════════════════════`);
  console.log(`   ║ DIAGNÓSTICO PARSER [${auditoria_id}]`);
  console.log(`   ╠══════════════════════════════════════════════════`);
  console.log(`   ║ Categorías encontradas : ${datos.categorias.length}`);
  console.log(`   ║ Total criterios        : ${todos.length}`);
  console.log(`   ╠──────────────────────────────────────────────────`);
  console.log(`   ║ SÍ plenos  : ${siPlenosReal}`);
  console.log(`   ║ SÍ con *   : ${siMatizReal}`);
  console.log(`   ║ NO         : ${noReal}`);
  console.log(`   ║ N/A        : ${naReal}`);
  console.log(`   ╠──────────────────────────────────────────────────`);
  console.log(`   ║ Puntaje detectado en texto : ${datos.puntaje === null ? 'null (se calculará desde conteos)' : datos.puntaje + '%'}`);
  console.log(`   ║ Riesgo detectado  : ${datos.nivelRiesgo}`);
  console.log(`   ║ Nota final        : ${datos.notaFinal ? 'sí (' + datos.notaFinal.length + ' chars)' : 'no encontrada'}`);
  console.log(`   ║ Alertas           : ${datos.alertas.length}`);
  if (datos.categorias.length > 0) {
    console.log(`   ╠── Distribución de resultados por criterio:`);
    todos.forEach(c => console.log(`   ║   ${c.id} → ${c.resultado}`));
  }
  console.log(`   ╚══════════════════════════════════════════════════\n`);

  if (siPlenosReal + siMatizReal + noReal > 0) {
    datos.siPlenos = siPlenosReal;
    datos.siMatiz  = siMatizReal;
    datos.noCount  = noReal;
    datos.naCount  = naReal;
  }

  if (datos.puntaje === null) {
    const aplicables = datos.siPlenos + datos.siMatiz + datos.noCount;
    if (aplicables > 0) {
      datos.puntaje = Math.round(((datos.siPlenos + datos.siMatiz) / aplicables) * 100);
      console.log(`   [parsearReporte] Puntaje calculado desde conteos reales: ${datos.puntaje}%`);
    } else {
      datos.puntaje = 0;
      console.log(`   [parsearReporte] ⚠️  No se pudo calcular puntaje (sin criterios aplicables) — usando 0%`);
    }
  }

  return datos;
}

// ── Generar resumen ejecutivo + puntos clave con Claude ──────────────────────
// v3.0: formato de texto plano con marcadores, NO JSON. Un texto largo con
// saltos de línea dentro de un string JSON es frágil (basta un salto de
// línea sin escapar para romper JSON.parse) — este formato no tiene
// sintaxis que se pueda romper así.

async function generarResumenEjecutivo(reporteTexto, datos, metadatos) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const { puntaje, nivelRiesgo, siPlenos, siMatiz, noCount, naCount, alertas } = datos;
  const totalCriterios = datos.categorias.reduce((acc, c) => acc + c.criterios.length, 0);
  const { titulo, pais, fecha } = metadatos;

  const prompt = `Eres el redactor institucional de la plataforma Auditoría Cívica Liberal (liberalmente.app), operada por CEDICE y la Fundación Friedrich Naumann. Tu tarea es escribir el RESUMEN EJECUTIVO y los PUNTOS CLAVE del reporte de auditoría de un documento jurídico o de política pública venezolana/latinoamericana.

DATOS DEL ANÁLISIS:
- Documento auditado: ${titulo}${pais ? ` (${pais})` : ''}${fecha ? `, ${fecha}` : ''}
- Puntaje de alineación liberal: ${puntaje}%
- Nivel de riesgo liberal: ${nivelRiesgo}
- Criterios evaluados: ${totalCriterios} (${siPlenos} SÍ plenos, ${siMatiz} SÍ con reserva, ${noCount} NO, ${naCount} N/A)
${alertas.length > 0 ? `- Alertas principales: ${alertas.map(a => a.titulo).join('; ')}` : ''}

REPORTE COMPLETO (del cual debes extraer las ideas más importantes):
${reporteTexto.slice(0, 6000)}

INSTRUCCIONES:
Responde ÚNICAMENTE con el siguiente formato de texto plano — NO uses JSON, ni backticks, ni markdown. Empieza directamente con "PUNTOS_CLAVE:", sin nada antes:

PUNTOS_CLAVE:
- frase 1
- frase 2
- frase 3

RESUMEN:
párrafo 1

párrafo 2

párrafo 3

Reglas:
- PUNTOS_CLAVE: entre 3 y 5 frases muy breves (máximo 14 palabras cada una), cada una en su propia línea empezando con "- ". Cada una debe aportar un dato o hallazgo distinto — no repitas la misma idea con otras palabras.
- RESUMEN: exactamente 3 párrafos, separados entre sí por una línea completamente en blanco. Sin títulos, sin viñetas, sin asteriscos ni markdown dentro de los párrafos.
  Párrafo 1 (2-3 oraciones): qué es el documento, su alcance y contexto político-jurídico.
  Párrafo 2 (3-4 oraciones): qué encontró el análisis — fortalezas liberales, debilidades y las alertas más graves con criterios específicos.
  Párrafo 3 (2-3 oraciones): valoración final del riesgo liberal y recomendación al ciudadano.
- No escribas nada antes de "PUNTOS_CLAVE:" ni nada después del último párrafo del resumen.

Tono: institucional, riguroso, combativo desde la dignidad. Sin eufemismos con el poder. Lenguaje propio del liberalismo clásico (propiedad privada, Estado de derecho, separación de poderes, subsidiariedad).`;

  try {
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-5',
      max_tokens: 1200,
      messages:   [{ role: 'user', content: prompt }],
    });

    const textoRespuesta = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    const matchResumen = textoRespuesta.match(/RESUMEN:\s*([\s\S]*)$/i);
    const resumen = matchResumen ? matchResumen[1].trim() : textoRespuesta;

    const matchBullets = textoRespuesta.match(/PUNTOS_CLAVE:\s*([\s\S]*?)(?=RESUMEN:|$)/i);
    const puntosClave = matchBullets
      ? matchBullets[1]
          .split('\n')
          .map(l => l.replace(/^[\s\-•*]+/, '').trim())
          .filter(Boolean)
          .slice(0, 5)
      : [];

    console.log(`   [generarResumenEjecutivo] Resumen generado (${resumen.length} chars) · ${puntosClave.length} puntos clave`);
    return { puntosClave, resumen };

  } catch (err) {
    console.error(`   [generarResumenEjecutivo] Error llamando a Claude:`, err.message);
    const totalSI    = siPlenos + siMatiz;
    const aplicables = siPlenos + siMatiz + noCount;
    let resumen = `El documento obtuvo un ${puntaje}% de alineación con los criterios del liberalismo clásico. `;
    resumen += `De ${aplicables} criterios aplicables: ${totalSI} SÍ (${siPlenos} plenos, ${siMatiz} con reserva)`;
    if (noCount > 0) resumen += `, ${noCount} NO`;
    if (naCount > 0) resumen += `, ${naCount} N/A`;
    resumen += `. Nivel de riesgo liberal: ${nivelRiesgo}.`;
    if (alertas.length > 0) resumen += ` Alerta principal: ${alertas[0].titulo}.`;
    return { puntosClave: [], resumen };
  }
}

// ── Generar HTML ─────────────────────────────────────────────────────────────

function generarHTML(datos, metadatos) {
  const {
    puntaje: puntajeRaw,
    nivelRiesgo      = 'BAJO',
    siPlenos         = 0,
    siMatiz          = 0,
    noCount          = 0,
    naCount          = 0,
    resumenEjecutivo = '',
    puntosClave      = [],
    notaFinal        = null,
    categorias       = [],
    alertas          = [],
  } = datos;

  const puntaje = puntajeRaw ?? 0;

  const {
    titulo        = 'Documento auditado',
    subtitulo     = '',
    pais          = '',
    fecha         = '',
    paginas       = '',
    marcaDoctrinal = 'Manual Cívico Liberal — CEDICE / Friedrich Naumann, 2026',
    generadoEl    = new Date().toLocaleDateString('es-VE', { year: 'numeric', month: 'long', day: 'numeric' }),
  } = metadatos;

  const criteriosParseados  = categorias.reduce((acc, cat) => acc + cat.criterios.length, 0);
  const totalCriterios      = criteriosParseados || 28;
  const criteriosDetectados = criteriosParseados > 0;

  const desgloseFicha = criteriosDetectados
    ? ` · ${siPlenos} SÍ plenos · ${siMatiz} SÍ con matiz · ${noCount} NO${naCount > 0 ? ` · ${naCount} N/A` : ''}`
    : '';

  const tallyPorCategoria = categorias.map(cat => ({
    num:     cat.num,
    nombre:  cat.nombre,
    si:      cat.criterios.filter(c => c.resultado === 'SI').length,
    siMatiz: cat.criterios.filter(c => c.resultado === 'SI_MATIZ').length,
    no:      cat.criterios.filter(c => c.resultado === 'NO').length,
    na:      cat.criterios.filter(c => c.resultado === 'NA').length,
    total:   cat.criterios.length,
  }));

  const puntosClaveHTML = (puntosClave && puntosClave.length > 0)
    ? `<ul class="puntos-clave">${puntosClave.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`
    : '';

  const resumenHTML = resumenEjecutivo
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${conNotaComadreja(p)}</p>`)
    .join('');

  // v3.0: el link al Manual ahora es fijo (última línea), no depende de
  // que aparezca la frase "efecto comadreja".
  const htmlLeyendaRiesgo = LEYENDA_RIESGO_LISTA ? `
<div class="leyenda-riesgo">
  <div class="leyenda-titulo">Niveles de riesgo liberal</div>
  ${RANGOS_RIESGO.map(r => `
  <div class="leyenda-item-riesgo"><strong>${esc(r.nivel)} (${esc(r.rango)})</strong> — ${esc(r.desc)}</div>`).join('')}
  <div class="leyenda-item-riesgo">Consulta el <a href="${URL_MANUAL}" class="nota-doctrinal">Manual de Liberalismo completo</a> para el marco doctrinal detrás de este Test.</div>
</div>` : '';

  const filasTabla = tallyPorCategoria.map(t => `
      <tr>
        <td>CAT. ${esc(t.num)} — ${esc(t.nombre)}</td>
        <td>${t.si}</td>
        <td>${t.siMatiz}</td>
        <td>${t.no}</td>
        <td>${t.na}</td>
        <td>${t.total}</td>
      </tr>`).join('');

  const filaTotalTabla = `
      <tr>
        <td>Total general</td>
        <td>${siPlenos}</td>
        <td>${siMatiz}</td>
        <td>${noCount}</td>
        <td>${naCount}</td>
        <td>${totalCriterios}</td>
      </tr>`;

  const htmlResumenCompacto = criteriosDetectados ? `
<div class="resumen-portada-bloque">
  <table class="resumen-categorias-tabla resumen-categorias-tabla--compacta">
    <thead>
      <tr><th>Categoría</th><th>SÍ</th><th>SÍ*</th><th>NO</th><th>N/A</th><th>Total</th></tr>
    </thead>
    <tbody>${filasTabla}</tbody>
    <tfoot>${filaTotalTabla}</tfoot>
  </table>
  ${htmlLeyendaRiesgo}
  ${notaFinal ? `<div class="nota-final-texto">${conNotaComadreja(notaFinal)}</div>` : ''}
</div>` : '';

  const htmlPortada = `
<div class="portada">
  <div class="portada-cinta"></div>
  <div class="portada-header">
    <div class="portada-logo"><strong>Liberal</strong><span>mente</span></div>
    <div class="portada-meta-header">
      Auditoría Cívica Liberal<br>
      liberalmente.app · CEDICE / Fundación Friedrich Naumann
    </div>
  </div>
  <div class="portada-body">
    <div class="portada-etiqueta">Reporte de Auditoría · Test de Libertad · Generado el ${esc(generadoEl)}</div>
    <h1 class="portada-titulo">${esc(titulo)}</h1>
    <div class="portada-subtitulo">${esc(subtitulo || [pais, fecha].filter(Boolean).join(' · '))}</div>
    ${puntosClaveHTML}
    ${htmlResumenCompacto}
  </div>
</div>`;

  const htmlResumen = `
<div class="resumen-bloque">
  <div class="seccion-cabecera">
    <div class="seccion-label">Resumen ejecutivo</div>
    <div class="seccion-referencia">liberalmente.app</div>
  </div>
  <div class="seccion-titulo-principal">Resumen Ejecutivo</div>
  <div class="resumen-texto">
    ${resumenHTML || '<p>Ver análisis completo en las páginas siguientes.</p>'}
  </div>
</div>`;

  const htmlCategorias = categorias.map((cat, idxCat) => {
    const critHTML = cat.criterios.map(crit => `
  <div class="criterio">
    <div class="criterio-header">
      <span class="criterio-codigo">${esc(crit.id)}</span>
      <span class="criterio-pregunta">${esc(crit.pregunta)}</span>
      ${badgeResultado(crit.resultado)}
    </div>
    ${crit.analisis ? `<div class="criterio-analisis">${conNotaComadreja(crit.analisis)}</div>` : ''}
  </div>`).join('');

    const cabecera = idxCat === 0 ? `
  <div class="seccion-cabecera">
    <div class="seccion-label">Análisis por criterio</div>
    <div class="seccion-referencia">Test de Libertad — ${totalCriterios} criterios · 7 categorías</div>
  </div>
  <div class="seccion-titulo-principal">
    Reporte de Auditoría Cívica Liberal: Análisis por Criterio del Test de Libertad
  </div>
  <div class="leyenda-resultados">
    <div class="leyenda-titulo">Cómo leer los resultados</div>
    <div class="leyenda-item">
      <span class="criterio-resultado si">✓ SÍ</span>
      <span>El criterio se cumple plenamente — cuenta a favor del puntaje de alineación liberal.</span>
    </div>
    <div class="leyenda-item">
      <span class="criterio-resultado si-matiz">! SÍ*</span>
      <span>Se cumple con reservas o matices — cuenta a favor, con salvedades señaladas en el análisis.</span>
    </div>
    <div class="leyenda-item">
      <span class="criterio-resultado no">✗ NO</span>
      <span>El criterio no se cumple — resta del puntaje de alineación liberal.</span>
    </div>
  </div>` : '';

    return `
<div class="categoria-bloque${idxCat === 0 ? ' categoria-bloque-primera' : ''}">
  ${cabecera}
  <div class="categoria-titulo">
    <span class="categoria-num-roman">CAT. ${esc(cat.num)}</span>
    ${esc(cat.nombre)}
  </div>
  ${critHTML}
</div>`;
  }).join('\n');

  let htmlAlertas = '';
  if (alertas.length > 0) {
    const alertasHTML = alertas.map((alerta, i) => {
      const col = colorAlerta(alerta.gravedad);
      const criteriosHTML = (alerta.criterios || [])
        .map(c => `<span class="alerta-c-tag">${esc(c)}</span>`).join('');

      return `
  <div class="alerta">
    <div class="alerta-header" style="background:${col.fondo}; border-bottom-color:${col.borde}">
      <span class="alerta-num">Alerta ${i + 1}</span>
      <span class="alerta-titulo-texto">${esc(alerta.titulo)}</span>
      <span class="alerta-gravedad" style="background:${col.badge}">${esc(alerta.gravedad)}</span>
    </div>
    <div class="alerta-cuerpo">
      ${conNotaComadreja(alerta.descripcion)}
      ${criteriosHTML ? `<div class="alerta-criterios">${criteriosHTML}</div>` : ''}
    </div>
  </div>`;
    }).join('');

    htmlAlertas = `
<div class="alertas-bloque">
  <div class="seccion-cabecera">
    <div class="seccion-label">Alertas principales</div>
    <div class="seccion-referencia">liberalmente.app</div>
  </div>
  <div class="alertas-titulo">Alertas Principales</div>
  ${alertasHTML}
</div>`;
  }

  // v3.0: link al Manual también en la Ficha (siempre se renderiza, sin
  // condición) — segundo lugar garantizado además de la leyenda de riesgo.
  const htmlFicha = `
<div class="ficha-bloque">
  <div class="seccion-cabecera">
    <div class="seccion-label">Ficha del documento</div>
    <div class="seccion-referencia">liberalmente.app</div>
  </div>
  <div class="seccion-titulo-principal">Ficha del Documento Auditado</div>
  <table class="ficha-tabla">
    <tr><td>Título</td><td>${esc(titulo)}</td></tr>
    ${subtitulo ? `<tr><td>Subtítulo</td><td>${esc(subtitulo)}</td></tr>` : ''}
    ${pais      ? `<tr><td>País</td><td>${esc(pais)}</td></tr>` : ''}
    ${fecha     ? `<tr><td>Fecha del documento</td><td>${esc(fecha)}</td></tr>` : ''}
    ${paginas   ? `<tr><td>Extensión analizada</td><td>${esc(paginas)}</td></tr>` : ''}
    <tr><td>Marco doctrinal</td><td><a href="${URL_MANUAL}" class="nota-doctrinal">${esc(marcaDoctrinal)}</a></td></tr>
    <tr><td>Auditor</td><td>Auditor Cívico Liberal — liberalmente.app</td></tr>
    <tr><td>Generado el</td><td>${esc(generadoEl)}</td></tr>
    <tr><td>Criterios aplicados</td><td>${totalCriterios} criterios en 7 categorías del Test de Libertad</td></tr>
    <tr>
      <td>Resultado</td>
      <td>
        ${puntaje}% de alineación · Riesgo Liberal: ${esc(nivelRiesgo)}${desgloseFicha}
      </td>
    </tr>
  </table>
</div>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=794">
  <title>Reporte de Auditoría — ${esc(titulo)}</title>
  <style>${CSS}</style>
</head>
<body>
${htmlPortada}
${htmlResumen}
${htmlCategorias}
${htmlFicha}
${htmlAlertas}
</body>
</html>`;
}

// ── Mapa global de HTMLs temporales ─────────────────────────────────────────
const _htmlsTemporales = new Map();

function registrarRutaHTMLTemporal(app) {
  app.get('/reporte-temp/:id', (req, res) => {
    const html = _htmlsTemporales.get(req.params.id);
    if (!html) return res.status(404).send('No encontrado');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });
}

// ── Conversión HTML → PDF vía CloudConvert ───────────────────────────────────

async function convertirHTMLaPDF(rutaHTML, rutaPDF, auditoria_id) {
  const CLOUDCONVERT_API_KEY = process.env.CLOUDCONVERT_API_KEY;
  if (!CLOUDCONVERT_API_KEY) throw new Error('Falta la variable de entorno CLOUDCONVERT_API_KEY');

  const WORKER_URL  = process.env.WORKER_URL || 'https://acl-worker-production.up.railway.app';
  const htmlContent = fs.readFileSync(rutaHTML, 'utf8');

  _htmlsTemporales.set(auditoria_id, htmlContent);
  const urlTemporal = `${WORKER_URL}/reporte-temp/${auditoria_id}`;
  console.log(`   [${auditoria_id}] HTML disponible en: ${urlTemporal}`);

  try {
    console.log(`   [${auditoria_id}] Creando job en CloudConvert...`);
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
            filename:  'reporte.html',
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
            screen_width:     794,
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

    console.log(`   [${auditoria_id}] Esperando conversión...`);
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

    console.log(`   [${auditoria_id}] Descargando PDF...`);
    const pdfUrl = exportTask.result.files[0].url;
    const pdfRes = await fetch(pdfUrl);
    if (!pdfRes.ok) throw new Error(`Error descargando PDF: ${pdfRes.status}`);

    const buffer = Buffer.from(await pdfRes.arrayBuffer());
    fs.writeFileSync(rutaPDF, buffer);
    console.log(`   [${auditoria_id}] ✅ PDF descargado (${Math.round(buffer.length / 1024)} KB)`);

  } finally {
    _htmlsTemporales.delete(auditoria_id);
    console.log(`   [${auditoria_id}] HTML temporal eliminado de memoria`);
  }
}

// ── Función principal exportada ──────────────────────────────────────────────

async function generarReportePDF(reporteTexto, metadatos, rutaSalida, auditoria_id) {
  console.log(`\n   ▶ [${auditoria_id}] INICIO generarReportePDF v3.0`);

  console.log(`   [${auditoria_id}] Paso 1: Parseando reporte...`);
  const datos = parsearReporte(reporteTexto, auditoria_id);

  console.log(`   [${auditoria_id}] Paso 2: Generando resumen ejecutivo y puntos clave con Claude...`);
  const { puntosClave, resumen } = await generarResumenEjecutivo(reporteTexto, datos, metadatos);
  datos.resumenEjecutivo = resumen;
  datos.puntosClave      = puntosClave;

  console.log(`   [${auditoria_id}] Paso 3: Generando HTML...`);
  const html     = generarHTML(datos, metadatos);
  const rutaHTML = rutaSalida.replace('.pdf', '.html');
  fs.writeFileSync(rutaHTML, html, 'utf8');
  console.log(`   [${auditoria_id}] HTML generado (${Math.round(html.length / 1024)} KB)`);

  console.log(`   [${auditoria_id}] Paso 4: Convirtiendo a PDF...`);
  try {
    await convertirHTMLaPDF(rutaHTML, rutaSalida, auditoria_id);
  } finally {
    if (fs.existsSync(rutaHTML)) fs.unlinkSync(rutaHTML);
  }

  console.log(`   ✅ [${auditoria_id}] generarReportePDF completado`);
  return datos;
}

module.exports = {
  generarReportePDF,
  parsearReporte,
  generarHTML,
  registrarRutaHTMLTemporal,
};