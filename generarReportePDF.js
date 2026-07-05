// generarReportePDF.js — ACL Worker v2.2
// Genera el reporte de auditoría en HTML y lo convierte a PDF con CloudConvert
// Umbusk LLC · Auditoría Cívica Liberal
//
// CAMBIOS v2 (15 jun 2026):
//   1. Resumen ejecutivo generado por Claude (no mecánico)
//   2. Log de diagnóstico de contadores en parsearReporte()
//   3. Nueva arquitectura CSS: sin .pagina rígido, flujo natural Chrome + @page
//
// CAMBIOS v2.1 (15 jun 2026):
//   4. Fix parser: notas metodológicas (ej. "C-06 se computa como NO...") ya no
//      se parsean como criterios falsos — eliminado el "criterio 29 fantasma"
//   5. Fix CSS: break-before: page (propiedad moderna) en lugar de
//      page-break-before: always — elimina páginas en blanco entre categorías
//   6. orphans/widows: 3 en body para que Chrome no deje líneas sueltas
//
// CAMBIOS v2.2 (3 jul 2026):
//   7. Fix: si el texto de Claude no trae un porcentaje explícito, el puntaje
//      se calcula desde los conteos reales de criterios (SI/SI_MATIZ/NO) en
//      vez de quedar en null — eliminado el "null%" en la portada del PDF

'use strict';

const fs      = require('fs');
const path    = require('path');
const Anthropic = require('@anthropic-ai/sdk');

// ── Helpers de HTML ──────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

function pillRiesgo(nivel) {
  const mapa = {
    'BAJO':     { bg: '#1A6B3C', texto: 'Riesgo: BAJO' },
    'MODERADO': { bg: '#B8860B', texto: 'Riesgo: MODERADO' },
    'ALTO':     { bg: '#C41230', texto: 'Riesgo: ALTO' },
    'MUY ALTO': { bg: '#8B0000', texto: 'Riesgo: MUY ALTO' },
  };
  const n = (nivel || '').toUpperCase();
  const p = mapa[n] || mapa['MODERADO'];
  return `<span class="indicador-pill pill-riesgo" style="background:${p.bg}">${esc(p.texto)}</span>`;
}

function colorAlerta(gravedad) {
  const g = (gravedad || '').toUpperCase();
  if (g === 'ALTA')                   return { fondo: '#FEF0F0', borde: '#EDAAAA', badge: '#C41230' };
  if (g.includes('MODERADA'))         return { fondo: '#F8F3E6', borde: '#D4C080', badge: '#B8860B' };
  return                                     { fondo: '#E8F0F7', borde: '#B5CDE0', badge: '#2A6496' };
}

// ── CSS del reporte ──────────────────────────────────────────────────────────
// ARQUITECTURA v2: sin .pagina de height fija.
// Chrome corta el flujo naturalmente; usamos señales semánticas para guiarlo.
// @page define márgenes, tamaño y pie automático via margin boxes.

const CSS = `
  /* ── PÁGINA ── */
  @page {
    size: A4;
    margin: 18mm 18mm 22mm 18mm;
  }

  /* La portada ocupa toda su página */
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

  body {
    font-family: var(--sans);
    background: white;
    color: var(--text);
    font-size: 13px;
    line-height: 1.6;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    orphans: 3;
    widows: 3;
  }

  /* ═══════════════════════════════════════════════════════════
     PORTADA — página propia con margin 0
  ═══════════════════════════════════════════════════════════ */
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
    padding: 44px 52px 0;
    display: flex;
    flex-direction: column;
  }

  .portada-etiqueta {
    font-size: 10px; font-weight: 600;
    letter-spacing: 0.12em; text-transform: uppercase;
    color: var(--accent); margin-bottom: 20px;
  }

  .portada-titulo {
    font-family: var(--serif);
    font-size: 32px; font-weight: 700;
    line-height: 1.2; letter-spacing: -0.02em;
    color: var(--text); max-width: 560px; margin-bottom: 12px;
  }

  .portada-subtitulo {
    font-size: 14px; color: var(--text-mid);
    font-style: italic; font-family: var(--serif); margin-bottom: 36px;
  }

  /* ── INDICADOR GENERAL ── */
  .indicador-bloque {
    background: white;
    border: 1px solid var(--border);
    border-left: 4px solid var(--green);
    border-radius: 2px;
    padding: 20px 26px;
    margin-bottom: 22px;
    display: flex;
    align-items: center;
    gap: 26px;
  }

  .indicador-puntaje {
    font-family: var(--serif);
    font-size: 50px; font-weight: 700;
    color: var(--green); line-height: 1; flex-shrink: 0;
  }

  .indicador-texto-wrap { flex: 1; }

  .indicador-etiqueta {
    font-size: 10px; font-weight: 600;
    letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--text-muted); margin-bottom: 4px;
  }

  .indicador-desc {
    font-family: var(--serif);
    font-size: 17px; font-weight: 600;
    color: var(--text); line-height: 1.3; margin-bottom: 10px;
  }

  .indicador-pills { display: flex; gap: 8px; flex-wrap: wrap; }

  .indicador-pill {
    font-size: 11px; font-weight: 600;
    padding: 3px 10px; border-radius: 2px; letter-spacing: 0.03em;
  }
  .pill-riesgo { color: white; }
  .pill-verde  { background: var(--green-soft); color: var(--green); border: 1px solid #A8D5BA; }
  .pill-dorado { background: var(--gold-soft); color: var(--gold); border: 1px solid #D4C080; }
  .pill-muted  { background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); }
  .pill-rojo   { background: #FEF0F0; color: var(--accent); border: 1px solid #EDAAAA; }

  /* ── RESUMEN EJECUTIVO ── */
  .resumen-ejecutivo {
    border-top: 2px solid var(--accent);
    padding-top: 18px;
    margin-bottom: 0;
    flex: 1;
  }

  .resumen-titulo {
    font-size: 10px; font-weight: 700;
    letter-spacing: 0.12em; text-transform: uppercase;
    color: var(--accent); margin-bottom: 12px;
  }

  .resumen-texto {
    font-size: 12.5px; color: var(--text-mid);
    line-height: 1.8; font-weight: 300;
  }

  .resumen-texto p { margin-bottom: 10px; }
  .resumen-texto p:last-child { margin-bottom: 0; }

  .portada-footer {
    padding: 18px 52px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 32px;
    flex-shrink: 0;
  }

  .portada-footer-texto {
    font-size: 10px; color: var(--text-muted); line-height: 1.5;
  }

  /* ═══════════════════════════════════════════════════════════
     CUERPO DEL REPORTE — flujo natural, Chrome decide los cortes
  ═══════════════════════════════════════════════════════════ */

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

  /* ── CATEGORÍAS ── */
  .categoria-bloque {
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

  /* ── CRITERIOS ── */
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

  .criterio-analisis {
    margin-left: 42px;
    font-size: 12px; color: var(--text-mid);
    line-height: 1.65; font-weight: 300;
  }

  /* ── ALERTAS ── */
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

  /* ── FICHA FINAL ── */
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

  /* ── PIE DE PÁGINA ── */
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
    resumenEjecutivo: '',   // se rellena por Claude más adelante
    categorias:  [],
    alertas:     [],
  };

  const lineas = reporteTexto.split('\n');

  // ── 1. Extraer puntaje (si el texto trae uno explícito) ────────────────────
  for (const linea of lineas) {
    const matchPct = linea.match(/([\d.]+)%/);
    if (matchPct && !datos.puntaje) {
      const v = parseFloat(matchPct[1]);
      if (v > 10 && v <= 100) { datos.puntaje = Math.round(v); }
    }
  }

  // ── 2. Extraer nivel de riesgo ─────────────────────────────────────────────
  const matchRiesgo = reporteTexto.match(/NIVEL DE RIESGO LIBERAL[^:]*:\s*\**\s*(BAJO|MODERADO|ALTO|MUY ALTO)/i);
  if (matchRiesgo) datos.nivelRiesgo = matchRiesgo[1].toUpperCase();

  // ── 3. Parsear categorías y criterios ─────────────────────────────────────
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

    // ── Detectar sección de alertas
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

    // ── Ignorar sección conclusión/resumen (Claude la genera externamente)
    if (/conclusi[oó]n|resumen ejecutivo|valoraci[oó]n final/i.test(linea) && linea.startsWith('#')) {
      if (criterioActual) {
        criterioActual.analisis = bufferAnalisis.join(' ').trim();
        bufferAnalisis = []; criterioActual = null;
      }
      enAlertas = false;
      continue;
    }

    // ── Detectar categoría
    const matchCat = linea.match(/^#{1,4}\s*CATEGOR[IÍ]A\s+(I{1,3}V?|VI{0,3}|IV)\s*[—–-]+\s*(.*)/i);
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

    // ── Detectar criterio C-XX
    const matchCrit = linea.match(/^\*{0,2}(C-\d{2})\*{0,2}[.\s:]*(.*)/);
    if (matchCrit && categoriaActual) {
      // Ignorar notas metodológicas que mencionan códigos de criterio pero no son criterios
      // Ejemplo: "C-06 se computa como NO (incompatibilidad con marco constitucional vigente)"
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
      criterioActual = { id: matchCrit[1], pregunta, resultado: 'SI', analisis: '' };
      categoriaActual.criterios.push(criterioActual);
      continue;
    }

    // ── Detectar resultado dentro de criterio activo
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

    // ── Alertas
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

  // Volcar buffers finales
  if (criterioActual && bufferAnalisis.length > 0) criterioActual.analisis = bufferAnalisis.join(' ').trim();
  if (alertaActual) { alertaActual.descripcion = bufferAlerta.join(' ').trim(); datos.alertas.push(alertaActual); }

  // ── Conteos reales desde criterios parseados ───────────────────────────────
  const todos = datos.categorias.flatMap(c => c.criterios);
  const siPlenosReal = todos.filter(c => c.resultado === 'SI').length;
  const siMatizReal  = todos.filter(c => c.resultado === 'SI_MATIZ').length;
  const noReal       = todos.filter(c => c.resultado === 'NO').length;
  const naReal       = todos.filter(c => c.resultado === 'NA').length;

  // ── LOG DE DIAGNÓSTICO ────────────────────────────────────────────────────
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
  console.log(`   ║ Alertas           : ${datos.alertas.length}`);
  if (datos.categorias.length > 0) {
    console.log(`   ╠── Distribución de resultados por criterio:`);
    todos.forEach(c => console.log(`   ║   ${c.id} → ${c.resultado}`));
  }
  console.log(`   ╚══════════════════════════════════════════════════\n`);

  // Sobreescribir con conteos reales si tenemos criterios
  if (siPlenosReal + siMatizReal + noReal > 0) {
    datos.siPlenos = siPlenosReal;
    datos.siMatiz  = siMatizReal;
    datos.noCount  = noReal;
    datos.naCount  = naReal;
  }

  // ── FIX v2.2: fallback de puntaje calculado desde conteos reales ───────────
  // Si Claude no incluyó un "%" explícito en el texto (o el regex no lo detectó),
  // se calcula directamente desde los criterios ya parseados — más confiable
  // que depender de que el formato de texto libre lo mencione.
  if (datos.puntaje === null) {
    const aplicables = datos.siPlenos + datos.siMatiz + datos.noCount; // N/A no cuenta como aplicable
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

// ── Generar resumen ejecutivo con Claude ─────────────────────────────────────

async function generarResumenEjecutivo(reporteTexto, datos, metadatos) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const { puntaje, nivelRiesgo, siPlenos, siMatiz, noCount, naCount, alertas } = datos;
  const totalCriterios = datos.categorias.reduce((acc, c) => acc + c.criterios.length, 0);
  const { titulo, pais, fecha } = metadatos;

  const prompt = `Eres el redactor institucional de la plataforma Auditoría Cívica Liberal (liberalmente.app), operada por CEDICE y la Fundación Friedrich Naumann. Tu tarea es escribir el RESUMEN EJECUTIVO del reporte de auditoría de un documento jurídico o de política pública venezolana/latinoamericana.

DATOS DEL ANÁLISIS:
- Documento auditado: ${titulo}${pais ? ` (${pais})` : ''}${fecha ? `, ${fecha}` : ''}
- Puntaje de alineación liberal: ${puntaje}%
- Nivel de riesgo liberal: ${nivelRiesgo}
- Criterios evaluados: ${totalCriterios} (${siPlenos} SÍ plenos, ${siMatiz} SÍ con reserva, ${noCount} NO, ${naCount} N/A)
${alertas.length > 0 ? `- Alertas principales: ${alertas.map(a => a.titulo).join('; ')}` : ''}

REPORTE COMPLETO (del cual debes extraer las ideas más importantes):
${reporteTexto.slice(0, 6000)}

INSTRUCCIONES:
Escribe un resumen ejecutivo de 3 párrafos. Cada párrafo separado por doble salto de línea. Sin títulos ni viñetas. Sin asteriscos ni markdown.

Párrafo 1 (2-3 oraciones): Qué es el documento, su alcance y contexto político-jurídico.
Párrafo 2 (3-4 oraciones): Qué encontró el análisis — fortalezas liberales, debilidades y las alertas más graves con criterios específicos.
Párrafo 3 (2-3 oraciones): Valoración final del riesgo liberal y recomendación al ciudadano.

Tono: institucional, riguroso, combativo desde la dignidad. Sin eufemismos con el poder. Lenguaje propio del liberalismo clásico (propiedad privada, Estado de derecho, separación de poderes, subsidiariedad).`;

  try {
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-5',
      // max_tokens subido de 600 a 1200 (3 jul 2026): mismo motivo que en
      // analizarConClaude — tokenizador nuevo (+30%) y pensamiento adaptativo
      // comparten este presupuesto. El resumen ya venía generando 2000+
      // caracteres, cerca del límite anterior incluso sin estos cambios.
      max_tokens: 1200,
      messages:   [{ role: 'user', content: prompt }],
    });

    const texto = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    console.log(`   [generarResumenEjecutivo] Resumen generado (${texto.length} chars)`);
    return texto;

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
    return resumen;
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
    categorias       = [],
    alertas          = [],
  } = datos;

  // Nota: usar ?? en vez de un valor por defecto en la destructuración, porque
  // el default de destructuring NO cubre el caso `null` (solo `undefined`).
  // parsearReporte ya debería garantizar que puntaje nunca sea null, pero esto
  // es una segunda barrera de seguridad para la portada.
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

  const totalCriterios = categorias.reduce((acc, cat) => acc + cat.criterios.length, 0) || 28;

  const resumenHTML = resumenEjecutivo
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${esc(p)}</p>`)
    .join('');

  const htmlPortada = `
<div class="portada">
  <div class="portada-cinta"></div>
  <div class="portada-header">
    <div class="portada-logo"><strong>Liberal</strong><span>mente</span></div>
    <div class="portada-meta-header">
      Auditoría Cívica Liberal<br>
      liberalmente.app · CEDICE / Friedrich Naumann
    </div>
  </div>
  <div class="portada-body">
    <div class="portada-etiqueta">Reporte de Auditoría · Test de Libertad</div>
    <h1 class="portada-titulo">${esc(titulo)}</h1>
    <div class="portada-subtitulo">${esc(subtitulo || [pais, fecha].filter(Boolean).join(' · '))}</div>

    <div class="indicador-bloque">
      <div class="indicador-puntaje">${puntaje}%</div>
      <div class="indicador-texto-wrap">
        <div class="indicador-etiqueta">Indicador General de Alineación Liberal</div>
        <div class="indicador-desc">${puntaje}% de alineación · ${totalCriterios} criterios evaluados</div>
        <div class="indicador-pills">
          ${pillRiesgo(nivelRiesgo)}
          <span class="indicador-pill pill-verde">${siPlenos} SÍ plenos</span>
          <span class="indicador-pill pill-dorado">${siMatiz} SÍ con matiz</span>
          ${noCount > 0 ? `<span class="indicador-pill pill-rojo">${noCount} NO</span>` : ''}
          ${naCount > 0 ? `<span class="indicador-pill pill-muted">${naCount} N/A</span>` : ''}
        </div>
      </div>
    </div>

    <div class="resumen-ejecutivo">
      <div class="resumen-titulo">Resumen ejecutivo</div>
      <div class="resumen-texto">
        ${resumenHTML || '<p>Ver análisis completo en las páginas siguientes.</p>'}
      </div>
    </div>
  </div>
  <div class="portada-footer">
    <div class="portada-footer-texto">
      Auditoría Cívica Liberal para la Transición Democrática<br>
      liberalmente.app · Marco doctrinal: Manual Cívico Liberal, edición 2026
    </div>
    <div class="portada-footer-texto" style="text-align:right;">
      Generado el ${esc(generadoEl)}
    </div>
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
    ${crit.analisis ? `<div class="criterio-analisis">${esc(crit.analisis)}</div>` : ''}
  </div>`).join('');

    const cabecera = idxCat === 0 ? `
  <div class="seccion-cabecera">
    <div class="seccion-label">Análisis por criterio</div>
    <div class="seccion-referencia">Test de Libertad — ${totalCriterios} criterios · 7 categorías</div>
  </div>
  <div class="seccion-titulo-principal">
    Reporte de Auditoría Cívica Liberal: Análisis por Criterio del Test de Libertad
  </div>` : `
  <div class="seccion-cabecera">
    <div class="seccion-label">Análisis por criterio (cont.)</div>
    <div class="seccion-referencia">liberalmente.app</div>
  </div>`;

    return `
<div class="categoria-bloque">
  ${cabecera}
  <div class="categoria-titulo">
    <span class="categoria-num-roman">CAT. ${esc(cat.num)}</span>
    ${esc(cat.nombre)}
  </div>
  ${critHTML}
  <div class="pie-pagina">
    <span class="pie-logo">Liberalmente</span>
    <span>${esc(cat.nombre)} · Test de Libertad</span>
    <span>liberalmente.app</span>
  </div>
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
      ${esc(alerta.descripcion)}
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
  <div class="pie-pagina">
    <span class="pie-logo">Liberalmente</span>
    <span>${alertas.length} alerta${alertas.length !== 1 ? 's' : ''} identificada${alertas.length !== 1 ? 's' : ''}</span>
    <span>liberalmente.app</span>
  </div>
</div>`;
  }

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
    <tr><td>Marco doctrinal</td><td>${esc(marcaDoctrinal)}</td></tr>
    <tr><td>Auditor</td><td>Auditor Cívico Liberal — liberalmente.app</td></tr>
    <tr><td>Generado el</td><td>${esc(generadoEl)}</td></tr>
    <tr><td>Criterios aplicados</td><td>${totalCriterios} criterios en 7 categorías del Test de Libertad</td></tr>
    <tr>
      <td>Resultado</td>
      <td>
        ${puntaje}% de alineación · Riesgo Liberal: ${esc(nivelRiesgo)} ·
        ${siPlenos} SÍ plenos · ${siMatiz} SÍ con matiz · ${noCount} NO
        ${naCount > 0 ? ` · ${naCount} N/A` : ''}
      </td>
    </tr>
  </table>
  <div class="pie-pagina" style="margin-top:40px;">
    <span class="pie-logo">Liberalmente</span>
    <span>CEDICE / Fundación Friedrich Naumann · Auditoría Cívica Liberal para la Transición Democrática</span>
    <span>liberalmente.app</span>
  </div>
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
${htmlCategorias}
${htmlAlertas}
${htmlFicha}
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
  console.log(`\n   ▶ [${auditoria_id}] INICIO generarReportePDF v2.2`);

  console.log(`   [${auditoria_id}] Paso 1: Parseando reporte...`);
  const datos = parsearReporte(reporteTexto, auditoria_id);

  if (datos.categorias.length === 0) {
    console.log(`   [${auditoria_id}] ⚠️  Sin categorías — usando texto plano`);
    datos.resumenEjecutivo = reporteTexto.slice(0, 1200).replace(/\n+/g, ' ').trim();
  }

  console.log(`   [${auditoria_id}] Paso 2: Generando resumen ejecutivo con Claude...`);
  datos.resumenEjecutivo = await generarResumenEjecutivo(reporteTexto, datos, metadatos);

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