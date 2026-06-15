// generarReportePDF.js — ACL Worker
// Genera el reporte de auditoría en HTML y lo convierte a PDF con Puppeteer
// Umbusk LLC · Auditoría Cívica Liberal

'use strict';

const fs   = require('fs');
const path = require('path');

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
  const esMatiz = resultado.includes('*') || resultado.toUpperCase().includes('MATIZ');
  if (esMatiz) return `<span class="criterio-resultado si-matiz">! SÍ*</span>`;
  if (resultado.toUpperCase().startsWith('SÍ') || resultado.toUpperCase().startsWith('SI'))
    return `<span class="criterio-resultado si">✓ SÍ</span>`;
  if (resultado.toUpperCase() === 'NO')
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
  const n = nivel?.toUpperCase() || 'BAJO';
  const p = mapa[n] || mapa['BAJO'];
  return `<span class="indicador-pill pill-riesgo" style="background:${p.bg}">${esc(p.texto)}</span>`;
}

function colorAlerta(gravedad) {
  const g = (gravedad || '').toUpperCase();
  if (g === 'ALTA') return { fondo: '#FEF0F0', borde: '#EDAAAA', badge: '#C41230' };
  if (g.includes('MODERADA')) return { fondo: '#F8F3E6', borde: '#D4C080', badge: '#B8860B' };
  return { fondo: '#E8F0F7', borde: '#B5CDE0', badge: '#2A6496' };
}

// ── CSS del reporte ──────────────────────────────────────────────────────────

const CSS = `
  @page { size: A4; margin: 0; }

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
    font-size: 14px;
    line-height: 1.6;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* ── PORTADA ── */
  .portada {
    width: 794px;
    height: 1123px;
    background: var(--bg);
    display: flex;
    flex-direction: column;
    page-break-after: always;
    overflow: hidden;
  }

  .portada-cinta { height: 5px; background: var(--accent); }

  .portada-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 28px 52px 24px;
    border-bottom: 1px solid var(--border);
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
    display: flex;
    flex-direction: column;
    padding: 52px 52px 0;
  }

  .portada-etiqueta {
    font-size: 10px; font-weight: 600;
    letter-spacing: 0.12em; text-transform: uppercase;
    color: var(--accent); margin-bottom: 20px;
  }

  .portada-titulo {
    font-family: var(--serif);
    font-size: 34px; font-weight: 700;
    line-height: 1.2; letter-spacing: -0.02em;
    color: var(--text); max-width: 580px; margin-bottom: 12px;
  }

  .portada-subtitulo {
    font-size: 14px; color: var(--text-mid);
    font-style: italic; font-family: var(--serif); margin-bottom: 40px;
  }

  /* ── INDICADOR ── */
  .indicador-bloque {
    background: white;
    border: 1px solid var(--border);
    border-left: 4px solid var(--green);
    border-radius: 2px;
    padding: 22px 28px;
    margin-bottom: 24px;
    display: flex;
    align-items: center;
    gap: 28px;
  }

  .indicador-puntaje {
    font-family: var(--serif);
    font-size: 52px; font-weight: 700;
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
    font-size: 18px; font-weight: 600;
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

  /* ── RESUMEN EJECUTIVO ── */
  .resumen-ejecutivo {
    border-top: 2px solid var(--accent);
    padding-top: 20px; margin-bottom: 40px;
  }

  .resumen-titulo {
    font-size: 10px; font-weight: 700;
    letter-spacing: 0.12em; text-transform: uppercase;
    color: var(--accent); margin-bottom: 12px;
  }

  .resumen-texto {
    font-size: 13px; color: var(--text-mid);
    line-height: 1.75; font-weight: 300;
  }

  .portada-footer {
    padding: 20px 52px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: auto;
  }

  .portada-footer-texto {
    font-size: 10px; color: var(--text-muted); line-height: 1.5;
  }

  /* ── PÁGINAS ── */
  .pagina {
    width: 794px;
    height: 1123px;
    background: white;
    padding: 48px 52px;
    display: flex;
    flex-direction: column;
    page-break-after: always;
    overflow: hidden;
  }

  .pagina-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 32px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border);
  }

  .pagina-titulo-seccion {
    font-size: 10px; font-weight: 600;
    letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent);
  }

  .pagina-num { font-size: 11px; color: var(--text-muted); }

  .seccion-titulo-principal {
    font-family: var(--serif);
    font-size: 18px; font-weight: 700;
    letter-spacing: -0.01em; color: var(--text);
    margin-bottom: 28px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border-subtle);
    line-height: 1.3;
  }

  /* ── CATEGORÍAS Y CRITERIOS ── */
  .categoria-titulo {
    font-family: var(--serif);
    font-size: 15px; font-weight: 700;
    letter-spacing: -0.01em; color: var(--text);
    margin: 28px 0 0;
    padding: 14px 0 12px;
    border-top: 2px solid var(--accent);
    display: flex;
    align-items: baseline;
    gap: 10px;
  }

  .categoria-titulo.primera { margin-top: 0; }

  .categoria-num-roman {
    font-size: 11px; font-weight: 400;
    color: var(--accent); letter-spacing: 0.06em; text-transform: uppercase;
  }

  .criterio {
    padding: 16px 0;
    border-bottom: 1px solid var(--border-subtle);
  }
  .criterio:last-child { border-bottom: none; }

  .criterio-header {
    display: flex;
    align-items: flex-start;
    gap: 14px; margin-bottom: 8px;
  }

  .criterio-codigo {
    font-size: 10px; font-weight: 700;
    letter-spacing: 0.08em; color: var(--text-muted);
    flex-shrink: 0; margin-top: 2px; min-width: 32px;
  }

  .criterio-pregunta {
    font-size: 12.5px; font-weight: 600;
    color: var(--text); line-height: 1.4; flex: 1;
  }

  .criterio-resultado {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px; font-weight: 700;
    letter-spacing: 0.04em;
    padding: 4px 10px; border-radius: 2px;
    white-space: nowrap;
  }
  .criterio-resultado.si       { background: var(--green-soft); color: var(--green); border: 1px solid #A8D5BA; }
  .criterio-resultado.si-matiz { background: var(--gold-soft); color: var(--gold); border: 1px solid #D4C080; }
  .criterio-resultado.no       { background: #FEF0F0; color: var(--accent); border: 1px solid #EDAAAA; }
  .criterio-resultado.na       { background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); }

  .criterio-analisis {
    margin-left: 46px;
    font-size: 12.5px; color: var(--text-mid);
    line-height: 1.65; font-weight: 300;
  }

  /* ── ALERTAS ── */
  .alertas-titulo {
    font-family: var(--serif);
    font-size: 18px; font-weight: 700;
    color: var(--text); margin-bottom: 24px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .alerta {
    margin-bottom: 20px;
    border-radius: 2px;
    overflow: hidden;
    border: 1px solid var(--border);
  }

  .alerta-header {
    display: flex; align-items: center;
    gap: 10px; padding: 14px 18px;
    border-bottom: 1px solid var(--border);
  }

  .alerta-num {
    font-size: 11px; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-muted);
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
  }

  .alerta-cuerpo {
    padding: 16px 18px;
    font-size: 12.5px; line-height: 1.65;
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
  .ficha-tabla { width: 100%; border-collapse: collapse; margin-top: 8px; }
  .ficha-tabla tr { border-bottom: 1px solid var(--border-subtle); }
  .ficha-tabla tr:last-child { border-bottom: none; }
  .ficha-tabla td { padding: 11px 12px; font-size: 13px; vertical-align: top; }
  .ficha-tabla td:first-child {
    width: 180px; font-size: 10px; font-weight: 600;
    letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--text-muted); padding-top: 13px;
  }
  .ficha-tabla td:last-child { color: var(--text); }

  /* ── PIE ── */
  .pie-pagina {
    margin-top: auto; padding-top: 18px;
    border-top: 1px solid var(--border-subtle);
    display: flex; justify-content: space-between;
    align-items: center;
    font-size: 10px; color: var(--text-muted);
  }
  .pie-logo { font-family: var(--serif); font-size: 12px; font-weight: 700; color: var(--text-muted); }
`;

// ── Parsear el reporte de texto plano ────────────────────────────────────────
// Soporta dos formatos de salida del prompt de Claude:
// Formato A (clásico): ✅ SÍ / ' **SÍ** / NIVEL DE RIESGO: BAJO
// Formato B (actual):  **RESULTADO: SÍ (con reserva)** / 81.5% / MODERADO

function parsearReporte(reporteTexto) {
  const datos = {
    puntaje:          null,
    nivelRiesgo:      'MODERADO',
    siPlenos:         0,
    siMatiz:          0,
    noCount:          0,
    naCount:          0,
    resumenEjecutivo: '',
    categorias:       [],
    alertas:          [],
  };

  const lineas = reporteTexto.split('\n');

  // ── 1. Extraer puntaje ──────────────────────────────────────────────────────
  // Formato A: "Porcentaje SÍ/aplicables: **100%"
  // Formato B: "22/27 = 81.5%" o "Porcentaje de alineación: 22/27 = 81.5%"
  for (const linea of lineas) {
    const matchPct = linea.match(/([\d.]+)%/);
    if (matchPct && !datos.puntaje) {
      const v = parseFloat(matchPct[1]);
      if (v > 10 && v <= 100) { datos.puntaje = Math.round(v); }
    }
  }

  // ── 2. Extraer totales SÍ / NO / N/A ───────────────────────────────────────
  // Formato B: tabla "| **TOTALES** | **28** | **22** | **5** | **1** |"
  const matchTotales = reporteTexto.match(/TOTALES[^|]*\|[^|]*\|[^|]*\|\s*\**(\d+)\**\s*\|[^|]*\|\s*\**(\d+)\**\s*\|[^|]*\|\s*\**(\d+)\**\s*\|/i);
  if (matchTotales) {
    datos.siPlenos = parseInt(matchTotales[1]);
    datos.noCount  = parseInt(matchTotales[2]);
    datos.naCount  = parseInt(matchTotales[3]);
  }

  // Formato A: "SÍ plenos: 20" / "SÍ con matiz: 8"
  const matchSIplenos = reporteTexto.match(/SÍ plenos[^:]*:\**\s*(\d+)/i);
  if (matchSIplenos) datos.siPlenos = parseInt(matchSIplenos[1]);
  const matchSImatiz = reporteTexto.match(/SÍ con matiz[^:]*:\**\s*(\d+)/i);
  if (matchSImatiz) datos.siMatiz = parseInt(matchSImatiz[1]);
  const matchNO = reporteTexto.match(/\*\*NO:\*\*\s*(\d+)/i);
  if (matchNO) datos.noCount = parseInt(matchNO[1]);

  // ── 3. Extraer nivel de riesgo ─────────────────────────────────────────────
  // Formato A: "NIVEL DE RIESGO LIBERAL: **BAJO**"
  // Formato B: "NIVEL DE RIESGO LIBERAL: **MODERADO**"
  const matchRiesgo = reporteTexto.match(/NIVEL DE RIESGO LIBERAL[^:]*:\s*\**\s*(BAJO|MODERADO|ALTO|MUY ALTO)/i);
  if (matchRiesgo) datos.nivelRiesgo = matchRiesgo[1].toUpperCase();

  // ── 4. Parsear categorías y criterios ──────────────────────────────────────
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
  let bufferResumen   = [];
  let enResumen       = false;

  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i];

    // ── Detectar sección alertas
    if (/^#{1,4}\s*\d+\.\s*ALERTAS?|^##\s*ALERTAS|ALERTAS? PRINCIPALES/i.test(linea)) {
      enAlertas = true; enResumen = false;
      if (criterioActual) { criterioActual.analisis = bufferAnalisis.join(' ').trim(); bufferAnalisis = []; criterioActual = null; }
      if (alertaActual)   { alertaActual.descripcion = bufferAlerta.join(' ').trim(); bufferAlerta = []; datos.alertas.push(alertaActual); alertaActual = null; }
      continue;
    }

    // ── Detectar resumen/conclusión
    if (/conclusi[oó]n|resumen ejecutivo|valoraci[oó]n final/i.test(linea) && linea.startsWith('#')) {
      enResumen = true; enAlertas = false;
      if (criterioActual) { criterioActual.analisis = bufferAnalisis.join(' ').trim(); bufferAnalisis = []; criterioActual = null; }
      continue;
    }

    // ── Detectar categoría
    // Formato A: "## CATEGORÍA I — Nombre" o "### CATEGORÍA I — Nombre"
    // Formato B: "### CATEGORÍA I — DIGNIDAD Y AUTONOMÍA INDIVIDUAL"
    const matchCat = linea.match(/^#{1,4}\s*CATEGOR[IÍ]A\s+(I{1,3}V?|VI{0,3}|IV)\s*[—–-]+\s*(.*)/i);
    if (matchCat) {
      if (criterioActual) { criterioActual.analisis = bufferAnalisis.join(' ').trim(); bufferAnalisis = []; criterioActual = null; }
      const numRom = matchCat[1].toUpperCase();
      const nombre = matchCat[2].trim() || CATEGORIAS_NOMBRES[numRom] || `Categoría ${numRom}`;
      // Capitalizar el nombre si está en mayúsculas
      const nombreFmt = nombre === nombre.toUpperCase()
        ? (CATEGORIAS_NOMBRES[numRom] || nombre.charAt(0) + nombre.slice(1).toLowerCase())
        : nombre;
      categoriaActual = { num: numRom, nombre: nombreFmt, criterios: [] };
      datos.categorias.push(categoriaActual);
      enResumen = false; enAlertas = false;
      continue;
    }

    // ── Detectar criterio C-XX
    const matchCrit = linea.match(/^\*{0,2}(C-\d{2})\*{0,2}[.\s:]*(.*)/);
    if (matchCrit && categoriaActual) {
      if (criterioActual) { criterioActual.analisis = bufferAnalisis.join(' ').trim(); bufferAnalisis = []; }
      const pregunta = matchCrit[2].replace(/\*\*/g, '').trim();
      criterioActual = { id: matchCrit[1], pregunta, resultado: 'SI', analisis: '' };
      categoriaActual.criterios.push(criterioActual);
      continue;
    }

    // ── Detectar resultado del criterio (dentro de criterio activo)
    if (criterioActual) {
      // Formato B: "**RESULTADO: SÍ (con reserva)**" o "**RESULTADO: NO**"
      const matchResultadoB = linea.match(/RESULTADO[:\s]+\*{0,2}(SÍ|SI|NO|N\/A)[^*]*(con reserva|con matiz|parcialmente)?/i);
      if (matchResultadoB) {
        const base    = matchResultadoB[1].toUpperCase();
        const esMatiz = !!(matchResultadoB[2]);
        if (base === 'NO')     criterioActual.resultado = 'NO';
        else if (base === 'N/A') criterioActual.resultado = 'NA';
        else if (esMatiz)      criterioActual.resultado = 'SI_MATIZ';
        else                   criterioActual.resultado = 'SI';
        continue;
      }

      // Formato A: ✅ SÍ / ✅ SÍ* / ❌ NO
      if (/✅\s*SÍ\s*\*|✓\s*SÍ\s*\*|SÍ\s*con\s*matiz/i.test(linea))      criterioActual.resultado = 'SI_MATIZ';
      else if (/✅\s*SÍ|✓\s*SÍ|'\s*\*\*SÍ\*\*/i.test(linea) && !linea.includes('*')) criterioActual.resultado = 'SI';
      else if (/✗\s*NO|❌\s*NO/i.test(linea))                               criterioActual.resultado = 'NO';

      // Acumular análisis
      if (linea.trim() && !linea.startsWith('#') && !linea.startsWith('---') && !linea.startsWith('**RESULTADO')) {
        const limpia = linea.replace(/\*\*/g, '').replace(/^[\s>*-]+/, '').trim();
        if (limpia) bufferAnalisis.push(limpia);
      }
      continue;
    }

    // ── Alertas
    if (enAlertas) {
      const matchAlerta = linea.match(/^#{1,4}\s*ALERTA\s*\d+[^:]*[:\s]*(.*)/i);
      if (matchAlerta) {
        if (alertaActual) { alertaActual.descripcion = bufferAlerta.join(' ').trim(); datos.alertas.push(alertaActual); bufferAlerta = []; }
        alertaActual = { titulo: matchAlerta[1].replace(/\*\*/g,'').trim(), gravedad: 'MODERADA', descripcion: '', criterios: [] };
        // Detectar gravedad en el título
        if (/CRÍT|ALTA/i.test(alertaActual.titulo))       alertaActual.gravedad = 'ALTA';
        else if (/MODERADA?[- ]ALTA/i.test(alertaActual.titulo)) alertaActual.gravedad = 'MODERADA-ALTA';
        else if (/MODERADA?/i.test(alertaActual.titulo))  alertaActual.gravedad = 'MODERADA';
        continue;
      }
      if (alertaActual) {
        const matchGrav = linea.match(/Gravedad[:\s]+\**(ALTA|MODERADA[- ]ALTA|MODERADA|BAJA)\**/i);
        if (matchGrav) { alertaActual.gravedad = matchGrav[1].toUpperCase(); continue; }
        const matchCrits = linea.match(/C-\d{2}/g);
        if (matchCrits) alertaActual.criterios.push(...matchCrits.filter(c => !alertaActual.criterios.includes(c)));
        const limpia = linea.replace(/\*\*/g,'').replace(/^[>\s*#-]+/,'').trim();
        if (limpia && !linea.startsWith('#')) bufferAlerta.push(limpia);
      }
      continue;
    }

    // ── Resumen ejecutivo
    if (enResumen) {
      const limpia = linea.replace(/\*\*/g,'').replace(/^[\s>*-]+/,'').trim();
      if (limpia && !linea.startsWith('#')) bufferResumen.push(limpia);
    }
  }

  // Volcar buffers finales
  if (criterioActual && bufferAnalisis.length > 0) criterioActual.analisis = bufferAnalisis.join(' ').trim();
  if (alertaActual) { alertaActual.descripcion = bufferAlerta.join(' ').trim(); datos.alertas.push(alertaActual); }
  datos.resumenEjecutivo = bufferResumen.join(' ').trim();

  // Si no hubo sección de resumen, construir uno del indicador
  if (!datos.resumenEjecutivo && datos.puntaje) {
    const totalCrits = datos.categorias.reduce((a, c) => a + c.criterios.length, 0) || 28;
    datos.resumenEjecutivo = `El documento analizó ${totalCrits} criterios del Test de Libertad organizados en 7 categorías, obteniendo un ${datos.puntaje}% de alineación con los principios del liberalismo clásico. Nivel de riesgo liberal: ${datos.nivelRiesgo}.`;
  }

  return datos;
}

// ── Generar HTML ─────────────────────────────────────────────────────────────

function generarHTML(datos, metadatos) {
  const {
    puntaje = 89,
    nivelRiesgo = 'BAJO',
    siPlenos = 0,
    siMatiz = 0,
    noCount = 0,
    resumenEjecutivo = '',
    categorias = [],
    alertas = [],
  } = datos;

  const {
    titulo = 'Documento auditado',
    subtitulo = '',
    pais = '',
    fecha = '',
    paginas = '',
    marcaDoctrinal = 'Manual Cívico Liberal — CEDICE / Friedrich Naumann, 2026',
    generadoEl = new Date().toLocaleDateString('es-VE', { year:'numeric', month:'long', day:'numeric' }),
  } = metadatos;

  const totalCriterios = categorias.reduce((acc, cat) => acc + cat.criterios.length, 0) || 28;
  const paginasPorCategoria = agruparCategoriasPorPagina(categorias);
  const totalPaginas = 2 + paginasPorCategoria.length + (alertas.length > 0 ? 1 : 0) + 1;

  // ── Portada
  const htmlPortada = `
  <div class="portada">
    <div class="portada-cinta"></div>
    <div class="portada-header">
      <div class="portada-logo"><strong>Liberal</strong><span>mente</span></div>
      <div class="portada-meta-header">Auditoría Cívica Liberal<br>liberalmente.app · CEDICE / Friedrich Naumann</div>
    </div>
    <div class="portada-body">
      <div class="portada-etiqueta">Reporte de Auditoría · Test de Libertad</div>
      <h1 class="portada-titulo">${esc(titulo)}</h1>
      <div class="portada-subtitulo">${esc(subtitulo || [pais, fecha].filter(Boolean).join(' · '))}</div>

      <div class="indicador-bloque">
        <div class="indicador-puntaje">${puntaje}%</div>
        <div class="indicador-texto-wrap">
          <div class="indicador-etiqueta">Indicador General</div>
          <div class="indicador-desc">${puntaje}% de alineación con criterios liberales</div>
          <div class="indicador-pills">
            ${pillRiesgo(nivelRiesgo)}
            <span class="indicador-pill pill-verde">${siPlenos} SÍ plenos</span>
            <span class="indicador-pill pill-dorado">${siMatiz} SÍ con matiz</span>
            <span class="indicador-pill pill-muted">${noCount} NO · 0 N/A</span>
          </div>
        </div>
      </div>

      <div class="resumen-ejecutivo">
        <div class="resumen-titulo">Resumen ejecutivo</div>
        <p class="resumen-texto">${esc(resumenEjecutivo || 'Ver análisis completo en las páginas siguientes.')}</p>
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

  // ── Páginas de análisis
  let numPagina = 2;
  const htmlCategorias = paginasPorCategoria.map((grupoCats) => {
    const contenido = grupoCats.map((cat, idxCat) => {
      const critHTML = cat.criterios.map(crit => `
        <div class="criterio">
          <div class="criterio-header">
            <span class="criterio-codigo">${esc(crit.id)}</span>
            <span class="criterio-pregunta">${esc(crit.pregunta)}</span>
            ${badgeResultado(crit.resultado)}
          </div>
          ${crit.analisis ? `<div class="criterio-analisis">${esc(crit.analisis)}</div>` : ''}
        </div>`).join('');

      return `
        <div class="categoria-titulo ${idxCat === 0 ? 'primera' : ''}">
          <span class="categoria-num-roman">CAT. ${esc(cat.num)}</span>
          ${esc(cat.nombre)}
        </div>
        ${critHTML}`;
    }).join('');

    const pg = numPagina++;
    return `
    <div class="pagina">
      <div class="pagina-header">
        <div class="pagina-titulo-seccion">Análisis por criterio</div>
        <div class="pagina-num">${pg} / ${totalPaginas}</div>
      </div>
      ${pg === 2 ? `<div class="seccion-titulo-principal">Reporte de Auditoría Cívica Liberal: Análisis por Criterio del Test de Libertad</div>` : ''}
      ${contenido}
      <div class="pie-pagina">
        <span class="pie-logo">Liberalmente</span>
        <span>Análisis por criterio · Test de Libertad — ${totalCriterios} criterios · 7 categorías</span>
        <span>liberalmente.app</span>
      </div>
    </div>`;
  }).join('');

  // ── Página de alertas
  let htmlAlertas = '';
  if (alertas.length > 0) {
    const alertasHTML = alertas.map((alerta, i) => {
      const col = colorAlerta(alerta.gravedad);
      const criteriosHTML = (alerta.criterios || []).map(c =>
        `<span class="alerta-c-tag">${esc(c)}</span>`).join('');

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

    const pg = numPagina++;
    htmlAlertas = `
    <div class="pagina">
      <div class="pagina-header">
        <div class="pagina-titulo-seccion">Alertas principales</div>
        <div class="pagina-num">${pg} / ${totalPaginas}</div>
      </div>
      <div class="alertas-titulo">Alertas Principales</div>
      ${alertasHTML}
      <div class="pie-pagina">
        <span class="pie-logo">Liberalmente</span>
        <span>Alertas · Test de Libertad — ${totalCriterios} criterios · 7 categorías</span>
        <span>liberalmente.app</span>
      </div>
    </div>`;
  }

  // ── Ficha del documento
  const pg = numPagina;
  const htmlFicha = `
  <div class="pagina">
    <div class="pagina-header">
      <div class="pagina-titulo-seccion">Ficha del documento</div>
      <div class="pagina-num">${pg} / ${totalPaginas}</div>
    </div>
    <div class="seccion-titulo-principal">Ficha del Documento Auditado</div>
    <table class="ficha-tabla">
      <tr><td>Título</td><td>${esc(titulo)}</td></tr>
      ${subtitulo ? `<tr><td>Subtítulo</td><td>${esc(subtitulo)}</td></tr>` : ''}
      ${pais     ? `<tr><td>País</td><td>${esc(pais)}</td></tr>` : ''}
      ${fecha    ? `<tr><td>Fecha del documento</td><td>${esc(fecha)}</td></tr>` : ''}
      ${paginas  ? `<tr><td>Extensión analizada</td><td>${esc(paginas)}</td></tr>` : ''}
      <tr><td>Marco doctrinal</td><td>${esc(marcaDoctrinal)}</td></tr>
      <tr><td>Auditor</td><td>Auditor Cívico Liberal — liberalmente.app</td></tr>
      <tr><td>Generado el</td><td>${esc(generadoEl)}</td></tr>
      <tr><td>Criterios aplicados</td><td>${totalCriterios} criterios organizados en 7 categorías del Test de Libertad</td></tr>
      <tr><td>Resultado</td><td>${puntaje}% de alineación · Riesgo Liberal: ${esc(nivelRiesgo)} · ${siPlenos} SÍ plenos · ${siMatiz} SÍ con matiz · ${noCount} NO</td></tr>
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

// Agrupa las 7 categorías en páginas de ~2 categorías cada una
// dependiendo de cuántos criterios tienen
function agruparCategoriasPorPagina(categorias) {
  const paginas = [];
  let paginaActual = [];
  let criteriosEnPagina = 0;
  const MAX_CRITERIOS_POR_PAGINA = 6;

  for (const cat of categorias) {
    const n = cat.criterios.length;
    if (paginaActual.length > 0 && criteriosEnPagina + n > MAX_CRITERIOS_POR_PAGINA) {
      paginas.push(paginaActual);
      paginaActual = [];
      criteriosEnPagina = 0;
    }
    paginaActual.push(cat);
    criteriosEnPagina += n;
  }
  if (paginaActual.length > 0) paginas.push(paginaActual);
  return paginas;
}

// ── Conversión HTML → PDF vía CloudConvert API (import/url) ─────────────────
// El worker sirve el HTML temporalmente en una URL pública que CloudConvert
// abre con Chrome real — así el renderizado es idéntico al navegador.

// Mapa global de HTMLs temporales: auditoria_id → contenido HTML
const _htmlsTemporales = new Map();

// Esta función debe llamarse desde worker.js para registrar la ruta temporal.
// Se llama así: registrarRutaHTMLTemporal(app)
function registrarRutaHTMLTemporal(app) {
  app.get('/reporte-temp/:id', (req, res) => {
    const html = _htmlsTemporales.get(req.params.id);
    if (!html) return res.status(404).send('No encontrado');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });
}

async function convertirHTMLaPDF(rutaHTML, rutaPDF, auditoria_id) {
  const CLOUDCONVERT_API_KEY = process.env.CLOUDCONVERT_API_KEY;
  if (!CLOUDCONVERT_API_KEY) {
    throw new Error('Falta la variable de entorno CLOUDCONVERT_API_KEY');
  }

  const WORKER_URL = process.env.WORKER_URL || 'https://acl-worker-production.up.railway.app';
  const htmlContent = fs.readFileSync(rutaHTML, 'utf8');

  // Registrar el HTML temporalmente en memoria para que CloudConvert lo descargue
  _htmlsTemporales.set(auditoria_id, htmlContent);
  const urlTemporal = `${WORKER_URL}/reporte-temp/${auditoria_id}`;
  console.log(`   [${auditoria_id}] HTML disponible en: ${urlTemporal}`);

  try {
    // Paso 1: Crear job — import/url apunta a la URL temporal del worker
    console.log(`   [${auditoria_id}] Creando job en CloudConvert...`);
    const jobRes = await fetch('https://api.cloudconvert.com/v2/jobs', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLOUDCONVERT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tasks: {
          'import-html': {
            operation: 'import/url',
            url: urlTemporal,
            filename: 'reporte.html',
          },
          'convert-to-pdf': {
            operation: 'convert',
            input: 'import-html',
            input_format: 'html',
            output_format: 'pdf',
            engine: 'chrome',
            print_background: true,
            css_page_size: true,
            margin_top: 0,
            margin_right: 0,
            margin_bottom: 0,
            margin_left: 0,
            screen_width: 794,
            wait_until: 'networkidle0',
            wait_time: 1000,
          },
          'export-pdf': {
            operation: 'export/url',
            input: 'convert-to-pdf',
          },
        },
      }),
    });

    if (!jobRes.ok) {
      const err = await jobRes.text();
      throw new Error(`CloudConvert error creando job: ${err}`);
    }

    const job = await jobRes.json();
    const jobId = job.data.id;
    console.log(`   [${auditoria_id}] Job creado: ${jobId}`);

    // Paso 2: Polling hasta que el job termine (max 3 minutos)
    console.log(`   [${auditoria_id}] Esperando conversión...`);
    const inicio = Date.now();
    const MAX_ESPERA = 180_000;
    const INTERVALO  = 3_000;

    let exportTask = null;
    while (Date.now() - inicio < MAX_ESPERA) {
      await new Promise(r => setTimeout(r, INTERVALO));

      const statusRes = await fetch(`https://api.cloudconvert.com/v2/jobs/${jobId}`, {
        headers: { 'Authorization': `Bearer ${CLOUDCONVERT_API_KEY}` },
      });
      const statusData = await statusRes.json();
      const estado = statusData.data.status;
      console.log(`   [${auditoria_id}] Estado: ${estado}`);

      if (estado === 'finished') {
        exportTask = statusData.data.tasks.find(t => t.name === 'export-pdf');
        break;
      }

      if (estado === 'error') {
        const tareaFallida = statusData.data.tasks.find(t => t.status === 'error');
        throw new Error(`CloudConvert error en conversión: ${tareaFallida?.message || 'Error desconocido'}`);
      }
    }

    if (!exportTask?.result?.files?.[0]?.url) {
      throw new Error('CloudConvert: timeout o no se encontró el PDF exportado');
    }

    // Paso 3: Descargar el PDF resultante
    console.log(`   [${auditoria_id}] Descargando PDF...`);
    const pdfUrl = exportTask.result.files[0].url;
    const pdfRes = await fetch(pdfUrl);
    if (!pdfRes.ok) throw new Error(`Error descargando PDF de CloudConvert: ${pdfRes.status}`);

    const buffer = Buffer.from(await pdfRes.arrayBuffer());
    fs.writeFileSync(rutaPDF, buffer);
    console.log(`   [${auditoria_id}] ✅ PDF descargado: ${rutaPDF} (${Math.round(buffer.length / 1024)} KB)`);

  } finally {
    // Limpiar el HTML temporal de memoria siempre
    _htmlsTemporales.delete(auditoria_id);
    console.log(`   [${auditoria_id}] HTML temporal eliminado de memoria`);
  }
}
// ── Función principal exportada ──────────────────────────────────────────────

async function generarReportePDF(reporteTexto, metadatos, rutaSalida, auditoria_id) {
  console.log(`   [${auditoria_id}] Parseando reporte...`);
  const datos = parsearReporte(reporteTexto);
  console.log(`   [${auditoria_id}] Categorías encontradas: ${datos.categorias.length} · Alertas: ${datos.alertas.length}`);

  if (datos.categorias.length === 0) {
    console.log(`   [${auditoria_id}] ⚠️  No se encontraron categorías — usando reporte como texto plano en resumen`);
    datos.resumenEjecutivo = reporteTexto.slice(0, 1200).replace(/\n+/g, ' ').trim();
  }

  console.log(`   [${auditoria_id}] Generando HTML del reporte...`);
  const html = generarHTML(datos, metadatos);

  const rutaHTML = rutaSalida.replace('.pdf', '.html');
  fs.writeFileSync(rutaHTML, html, 'utf8');
  console.log(`   [${auditoria_id}] HTML generado (${Math.round(html.length / 1024)} KB)`);

  try {
    await convertirHTMLaPDF(rutaHTML, rutaSalida, auditoria_id);
  } finally {
    // Limpiar HTML temporal siempre, aunque la conversión falle
    if (fs.existsSync(rutaHTML)) fs.unlinkSync(rutaHTML);
  }

  return datos;
}

module.exports = { generarReportePDF, parsearReporte, generarHTML, registrarRutaHTMLTemporal };