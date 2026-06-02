// worker.js — ACL Worker v3.0
// Umbusk LLC · Auditoría Cívica Liberal
// Railway · Node.js
// Hemisferio derecho: NotebookLM Enterprise API (sin Playwright)

'use strict';

const express    = require('express');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const Anthropic  = require('@anthropic-ai/sdk');
const { Pool }   = require('pg');
const pptxgen    = require('pptxgenjs');
const fs         = require('fs');
const path       = require('path');
const pdfParse   = require('pdf-parse');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ── Clientes globales ────────────────────────────────────────────────────────

const anthropic     = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const db            = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const WORKER_SECRET = process.env.WORKER_SECRET;
const DIRECTORIO_TEMP = '/tmp/acl-worker';

// ── Autenticación Google Cloud (cuenta de servicio) ──────────────────────────
// GOOGLE_SERVICE_ACCOUNT_JSON debe contener el contenido del archivo JSON
// de la cuenta de servicio acl-notebooklm-worker

function obtenerGoogleAuth() {
  const credenciales = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new GoogleAuth({
    credentials: credenciales,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
}

async function obtenerTokenGoogle() {
  const auth   = obtenerGoogleAuth();
  const client = await auth.getClient();
  const token  = await client.getAccessToken();
  return token.token;
}

// ── NotebookLM Enterprise API ────────────────────────────────────────────────

const NLM_BASE    = 'https://global-discoveryengine.googleapis.com/v1alpha';
const NLM_PROJECT = process.env.GOOGLE_CLOUD_PROJECT_NUMBER || '721904248474';
const NLM_PARENT  = `projects/${NLM_PROJECT}/locations/global`;

async function nlmRequest(method, endpoint, body = null) {
  const token = await obtenerTokenGoogle();
  const url   = `${NLM_BASE}/${endpoint}`;
  const opts  = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'x-goog-request-params': `parent=${NLM_PARENT}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const texto = await res.text();
    throw new Error(`NotebookLM API error ${res.status}: ${texto}`);
  }
  return res.json();
}

// Crear notebook vacío
async function nlmCrearNotebook(titulo) {
  const data = await nlmRequest('POST', `${NLM_PARENT}/notebooks`, { title: titulo });
  return data.notebookId;
}

// Agregar fuente (texto) al notebook
async function nlmAgregarFuente(notebookId, titulo, contenido) {
  await nlmRequest(
    'POST',
    `${NLM_PARENT}/notebooks/${notebookId}/sources`,
    {
      displayName: titulo,
      corpus: { inlineSource: { content: contenido, mimeType: 'text/plain' } },
    }
  );
}

// Disparar generación de Audio Overview
async function nlmGenerarAudio(notebookId) {
  const data = await nlmRequest(
    'POST',
    `${NLM_PARENT}/notebooks/${notebookId}/audioOverviews`,
    { language: 'es-US' }
  );
  return data.audioOverviewId || data.name?.split('/').pop();
}

// Esperar hasta que el Audio Overview esté listo (polling)
async function nlmEsperarAudio(notebookId, audioId, auditoria_id) {
  const INTERVALO = 30_000;  // 30 segundos
  const TIMEOUT   = 30 * 60_000; // 30 minutos
  const t0 = Date.now();

  while (true) {
    const data = await nlmRequest(
      'GET',
      `${NLM_PARENT}/notebooks/${notebookId}/audioOverviews/${audioId}`
    );

    const estado = data.state || data.status;
    console.log(`   [${auditoria_id}] Audio estado: ${estado}`);

    if (estado === 'SUCCEEDED' || estado === 'ACTIVE' || data.audioData) {
      return data;
    }
    if (estado === 'FAILED' || estado === 'ERROR') {
      throw new Error(`Audio Overview falló: ${JSON.stringify(data)}`);
    }
    if (Date.now() - t0 > TIMEOUT) {
      throw new Error('Timeout: Audio Overview no terminó en 30 minutos');
    }
    await new Promise(r => setTimeout(r, INTERVALO));
  }
}

// Descargar el audio a un archivo local
async function nlmDescargarAudio(audioData, rutaSalida) {
  // La API puede devolver el audio como base64 en audioData.audioContent
  // o como URL en audioData.audioUri
  if (audioData.audioContent) {
    const buffer = Buffer.from(audioData.audioContent, 'base64');
    fs.writeFileSync(rutaSalida, buffer);
    return;
  }
  if (audioData.audioUri) {
    const token = await obtenerTokenGoogle();
    const res   = await fetch(audioData.audioUri, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Error descargando audio: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(rutaSalida, buffer);
    return;
  }
  throw new Error('Audio Overview completado pero sin datos de audio en la respuesta');
}

// Eliminar notebook (limpieza)
async function nlmEliminarNotebook(notebookId) {
  await nlmRequest('DELETE', `${NLM_PARENT}/notebooks/${notebookId}`).catch(() => {});
}

// ── Pipeline NotebookLM completo ─────────────────────────────────────────────

async function ejecutarNotebookLMApi(reporteTexto, titulo, rutaPodcast, auditoria_id) {
  let notebookId = null;
  try {
    console.log(`   [${auditoria_id}] Creando notebook en NotebookLM...`);
    notebookId = await nlmCrearNotebook(`ACL — ${titulo}`);
    console.log(`   [${auditoria_id}] Notebook creado: ${notebookId}`);

    console.log(`   [${auditoria_id}] Agregando reporte como fuente...`);
    await nlmAgregarFuente(notebookId, titulo, reporteTexto);
    console.log(`   [${auditoria_id}] Fuente agregada`);

    // Breve pausa para que NotebookLM indexe el contenido
    await new Promise(r => setTimeout(r, 10_000));

    console.log(`   [${auditoria_id}] Disparando generación de Audio Overview...`);
    const audioId = await nlmGenerarAudio(notebookId);
    console.log(`   [${auditoria_id}] Audio en proceso: ${audioId}`);

    console.log(`   [${auditoria_id}] Esperando que el audio esté listo...`);
    const audioData = await nlmEsperarAudio(notebookId, audioId, auditoria_id);
    console.log(`   [${auditoria_id}] Audio listo`);

    console.log(`   [${auditoria_id}] Descargando audio...`);
    await nlmDescargarAudio(audioData, rutaPodcast);
    console.log(`   [${auditoria_id}] Audio guardado en ${rutaPodcast}`);

  } finally {
    if (notebookId) {
      await nlmEliminarNotebook(notebookId);
      console.log(`   [${auditoria_id}] Notebook eliminado`);
    }
  }
}

// ── Paleta institucional para PPTX ──────────────────────────────────────────

const C = {
  rojo:      'C41230', rojoOsc:  '9B0D24',
  blanco:    'FFFFFF', cremaBorde: 'D4CFC4',
  texto:     '1A1A1A', textoMid:   '4A4A4A', textoMuted: '8A8478',
  teal:      '2A6496', verde:    '2E7D32',   verdeBg:  'E8F5E9',
  dorado:    'B8860B', doradoBg: 'FFF8E1',
};
const W = 10, H = 5.625, ML = 0.45, MR = 0.45, MT = 0.55, CW = W - ML - MR;

function svgToBase64(svg) {
  return 'image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function iconResultado(resultado) {
  const esSI = resultado === 'SI', esMatiz = resultado === 'SI_MATIZ';
  const stroke = esSI ? '388E3C' : esMatiz ? 'B8860B' : 'C41230';
  const bg     = esSI ? 'E8F5E9' : esMatiz ? 'FFF8E1' : 'FFEBEE';
  return svgToBase64(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <circle cx="32" cy="32" r="30" fill="#${bg}" stroke="#${stroke}" stroke-width="3"/>
    <path d="M18 32 L27 43 L46 21" stroke="#${stroke}" stroke-width="4.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    ${esMatiz ? `<circle cx="50" cy="14" r="10" fill="#${stroke}"/><text x="50" y="19" text-anchor="middle" font-size="14" fill="white" font-weight="bold" font-family="sans-serif">*</text>` : ''}
  </svg>`);
}

function iconGauge(pct) {
  const r = 52, circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ, gap = circ - dash;
  return svgToBase64(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
    <circle cx="80" cy="80" r="${r}" fill="none" stroke="#EDEBE4" stroke-width="12"/>
    <circle cx="80" cy="80" r="${r}" fill="none" stroke="#C41230" stroke-width="12"
      stroke-dasharray="${dash.toFixed(1)} ${gap.toFixed(1)}"
      stroke-dashoffset="${(circ * 0.25).toFixed(1)}"
      stroke-linecap="round" transform="rotate(-90 80 80)"/>
    <text x="80" y="74" text-anchor="middle" font-size="32" font-weight="bold" fill="#1A1A1A" font-family="Arial,sans-serif">${pct}%</text>
    <text x="80" y="92" text-anchor="middle" font-size="10" fill="#8A8478" font-family="Arial,sans-serif" letter-spacing="1">ÍNDICE LIBERAL</text>
  </svg>`);
}

function iconCategoria(num) {
  const paths = {
    'I':   `<circle cx="16" cy="8" r="5" stroke="#C41230" stroke-width="2" fill="none"/><path d="M4 28v-2a8 8 0 0 1 8-8h8a8 8 0 0 1 8 8v2" stroke="#C41230" stroke-width="2" fill="none" stroke-linecap="round"/>`,
    'II':  `<path d="M3 6h18M3 12h18M3 18h12" stroke="#C41230" stroke-width="2.5" stroke-linecap="round"/>`,
    'III': `<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="#C41230" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M9 22V12h6v10" stroke="#C41230" stroke-width="2" fill="none"/>`,
    'IV':  `<polyline points="22,7 13.5,15.5 8.5,10.5 2,17" stroke="#C41230" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><polyline points="16,7 22,7 22,13" stroke="#C41230" stroke-width="2.5" fill="none" stroke-linecap="round"/>`,
    'V':   `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="#C41230" stroke-width="2" fill="none" stroke-linejoin="round"/>`,
    'VI':  `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="#C41230" stroke-width="2" fill="none"/><circle cx="9" cy="7" r="4" stroke="#C41230" stroke-width="2" fill="none"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="#C41230" stroke-width="2" fill="none" stroke-linecap="round"/>`,
    'VII': `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="#C41230" stroke-width="2" fill="none" stroke-linejoin="round"/>`,
  };
  return svgToBase64(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24">${paths[num] || paths['I']}</svg>`);
}

function iconAlerta(gravedad) {
  const color = gravedad === 'ALTA' ? 'C41230' : gravedad === 'MODERADA-ALTA' ? 'B8860B' : '2A6496';
  return svgToBase64(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
    <polygon points="48,8 90,84 6,84" fill="#${color}22" stroke="#${color}" stroke-width="4" stroke-linejoin="round"/>
    <text x="48" y="72" text-anchor="middle" font-size="40" font-weight="bold" fill="#${color}" font-family="Arial,sans-serif">!</text>
  </svg>`);
}

function barraRoja(slide) {
  slide.addShape('rect', { x: 0, y: 0, w: W, h: 0.07, fill: { color: C.rojo }, line: { color: C.rojo, width: 0 } });
}

function footer(slide) {
  slide.addText('liberalmente.app · Auditoría Cívica Liberal · CEDICE / Friedrich Naumann', {
    x: ML, y: H - 0.25, w: CW, h: 0.2,
    fontSize: 7, color: C.textoMuted, fontFace: 'Calibri', align: 'left', margin: 0,
  });
}

// ── Lámina 1: Portada + Resumen ──────────────────────────────────────────────

function laminaPortada(pres, d) {
  const slide = pres.addSlide();
  slide.background = { color: C.blanco };
  barraRoja(slide);

  slide.addText('AUDITORÍA CÍVICA LIBERAL · LIBERALMENTE.APP', {
    x: ML, y: MT, w: 7, h: 0.22,
    fontSize: 7.5, color: C.textoMuted, fontFace: 'Calibri', charSpacing: 1.5, margin: 0,
  });
  slide.addText(d.titulo, {
    x: ML, y: MT + 0.25, w: 7.1, h: 1.0,
    fontSize: 22, color: C.texto, fontFace: 'Georgia', bold: true,
    align: 'left', valign: 'top', margin: 0,
  });
  slide.addText(d.subtitulo || '', {
    x: ML, y: MT + 1.3, w: 7, h: 0.3,
    fontSize: 11, color: C.textoMid, fontFace: 'Calibri', margin: 0,
  });
  slide.addShape('rect', { x: ML, y: MT + 1.72, w: CW, h: 0.008, fill: { color: C.cremaBorde }, line: { color: C.cremaBorde, width: 0 } });

  // Gauge
  slide.addImage({ data: iconGauge(d.puntaje), x: 7.8, y: MT - 0.05, w: 1.7, h: 1.7 });
  const colorRiesgo = d.nivelRiesgo === 'BAJO' ? C.rojo : d.nivelRiesgo === 'MODERADO' ? C.dorado : C.texto;
  slide.addShape('rect', { x: 7.85, y: MT + 1.65, w: 1.6, h: 0.28, fill: { color: colorRiesgo }, line: { color: colorRiesgo, width: 0 } });
  slide.addText(`RIESGO ${d.nivelRiesgo}`, {
    x: 7.85, y: MT + 1.65, w: 1.6, h: 0.28,
    fontSize: 8, color: C.blanco, fontFace: 'Calibri', bold: true,
    align: 'center', valign: 'middle', charSpacing: 1, margin: 0,
  });

  slide.addText(`RESULTADOS POR CATEGORÍA — ${d.criterios_total || 28} CRITERIOS EVALUADOS`, {
    x: ML, y: MT + 1.88, w: CW, h: 0.22,
    fontSize: 7.5, color: C.textoMuted, fontFace: 'Calibri', charSpacing: 1.2, margin: 0,
  });

  const catW = 2.18, catH = 1.0, catGap = 0.07, catY = MT + 2.18;
  d.categorias.forEach((cat, i) => {
    const col = i % 4, row = Math.floor(i / 4);
    const x = ML + col * (catW + catGap), y = catY + row * (catH + catGap);
    slide.addShape('rect', { x, y, w: catW, h: catH, fill: { color: 'FAFAF8' }, line: { color: C.cremaBorde, width: 0.5 } });
    slide.addImage({ data: iconCategoria(cat.num), x: x + 0.1, y: y + 0.1, w: 0.22, h: 0.22 });
    slide.addText(`CAT. ${cat.num}`, { x: x + 0.36, y: y + 0.1, w: catW - 0.46, h: 0.2, fontSize: 7, color: C.textoMuted, fontFace: 'Calibri', charSpacing: 1, margin: 0 });
    slide.addText(cat.nombre, { x: x + 0.1, y: y + 0.34, w: catW - 0.2, h: 0.4, fontSize: 9.5, color: C.texto, fontFace: 'Calibri', bold: true, align: 'left', valign: 'top', margin: 0 });
    const badgeY = y + catH - 0.26;
    let bx = x + 0.1;
    if (cat.siPlenos > 0) {
      slide.addShape('rect', { x: bx, y: badgeY, w: 0.44, h: 0.18, fill: { color: C.verdeBg }, line: { color: C.verdeBg, width: 0 } });
      slide.addText(`${cat.siPlenos} SÍ`, { x: bx, y: badgeY, w: 0.44, h: 0.18, fontSize: 7.5, color: C.verde, fontFace: 'Calibri', bold: true, align: 'center', valign: 'middle', margin: 0 });
      bx += 0.5;
    }
    if (cat.siMatiz > 0) {
      slide.addShape('rect', { x: bx, y: badgeY, w: 0.5, h: 0.18, fill: { color: C.doradoBg }, line: { color: C.doradoBg, width: 0 } });
      slide.addText(`${cat.siMatiz} SÍ*`, { x: bx, y: badgeY, w: 0.5, h: 0.18, fontSize: 7.5, color: C.dorado, fontFace: 'Calibri', bold: true, align: 'center', valign: 'middle', margin: 0 });
    }
  });

  // Celda de totales
  const totalCol = d.categorias.length % 4, totalRow = Math.floor(d.categorias.length / 4);
  const tx = ML + totalCol * (catW + catGap), ty = catY + totalRow * (catH + catGap);
  slide.addShape('rect', { x: tx, y: ty, w: catW, h: catH, fill: { color: C.rojo }, line: { color: C.rojo, width: 0 } });
  slide.addText('TOTAL', { x: tx, y: ty + 0.12, w: catW, h: 0.18, fontSize: 8, color: 'FFFFFF', fontFace: 'Calibri', align: 'center', charSpacing: 1.5, margin: 0 });
  slide.addText(`${d.siPlenos} SÍ · ${d.siMatiz} SÍ*`, { x: tx, y: ty + 0.34, w: catW, h: 0.28, fontSize: 13, color: C.blanco, fontFace: 'Calibri', bold: true, align: 'center', margin: 0 });
  slide.addText(`0 NO · 0 N/A`, { x: tx, y: ty + 0.65, w: catW, h: 0.18, fontSize: 9, color: 'FFFFFF', fontFace: 'Calibri', align: 'center', margin: 0 });

  footer(slide);
}

// ── Lámina por categoría ─────────────────────────────────────────────────────

function laminaCategoria(pres, cat) {
  const slide = pres.addSlide();
  slide.background = { color: C.blanco };
  barraRoja(slide);

  slide.addImage({ data: iconCategoria(cat.num), x: ML, y: MT, w: 0.38, h: 0.38 });
  slide.addText(`CATEGORÍA ${cat.num}`, { x: ML + 0.45, y: MT + 0.02, w: 5, h: 0.18, fontSize: 8, color: C.textoMuted, fontFace: 'Calibri', charSpacing: 1.5, margin: 0 });
  slide.addText(cat.nombre, { x: ML + 0.45, y: MT + 0.2, w: 6.5, h: 0.3, fontSize: 17, color: C.texto, fontFace: 'Georgia', bold: true, margin: 0 });

  let bx = W - MR - 1.85;
  if (cat.siPlenos > 0) {
    slide.addShape('rect', { x: bx, y: MT + 0.06, w: 0.9, h: 0.26, fill: { color: C.verdeBg }, line: { color: C.verdeBg, width: 0 } });
    slide.addText(`${cat.siPlenos} SÍ plenos`, { x: bx, y: MT + 0.06, w: 0.9, h: 0.26, fontSize: 8, color: C.verde, fontFace: 'Calibri', bold: true, align: 'center', valign: 'middle', margin: 0 });
    bx += 0.96;
  }
  if (cat.siMatiz > 0) {
    slide.addShape('rect', { x: bx, y: MT + 0.06, w: 0.95, h: 0.26, fill: { color: C.doradoBg }, line: { color: C.doradoBg, width: 0 } });
    slide.addText(`${cat.siMatiz} SÍ con matiz`, { x: bx, y: MT + 0.06, w: 0.95, h: 0.26, fontSize: 8, color: C.dorado, fontFace: 'Calibri', bold: true, align: 'center', valign: 'middle', margin: 0 });
  }

  slide.addShape('rect', { x: ML, y: MT + 0.6, w: CW, h: 0.008, fill: { color: C.cremaBorde }, line: { color: C.cremaBorde, width: 0 } });

  const n = cat.criterios.length;
  const cols = Math.min(n, 5), rows = Math.ceil(n / cols);
  const cW = (CW - (cols - 1) * 0.07) / cols;
  const cH = (H - MT - 0.85 - (rows - 1) * 0.07 - 0.3) / rows;
  const gridY = MT + 0.72;

  cat.criterios.forEach((crit, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const cx = ML + col * (cW + 0.07), cy = gridY + row * (cH + 0.07);
    const borderColor = crit.resultado === 'SI' ? C.verdeBg : crit.resultado === 'SI_MATIZ' ? C.doradoBg : crit.resultado === 'NO' ? 'FFEBEE' : C.cremaBorde;
    slide.addShape('rect', { x: cx, y: cy, w: cW, h: cH, fill: { color: 'FAFAF8' }, line: { color: borderColor, width: 1 } });
    slide.addText(crit.id, { x: cx + 0.1, y: cy + 0.1, w: cW * 0.55, h: 0.18, fontSize: 8, color: C.textoMuted, fontFace: 'Calibri', bold: true, margin: 0 });
    slide.addImage({ data: iconResultado(crit.resultado), x: cx + cW - 0.36, y: cy + 0.08, w: 0.26, h: 0.26 });
    slide.addText(crit.resumen, { x: cx + 0.1, y: cy + 0.3, w: cW - 0.2, h: cH - 0.56, fontSize: 9, color: C.texto, fontFace: 'Calibri', align: 'left', valign: 'top', margin: 0 });
    const badgeColor = crit.resultado === 'SI' ? C.verde : crit.resultado === 'SI_MATIZ' ? C.dorado : crit.resultado === 'NO' ? 'C62828' : C.textoMuted;
    const badgeBg    = crit.resultado === 'SI' ? C.verdeBg : crit.resultado === 'SI_MATIZ' ? C.doradoBg : crit.resultado === 'NO' ? 'FFEBEE' : 'F0F0F0';
    const badgeLabel = crit.resultado === 'SI' ? 'SÍ' : crit.resultado === 'SI_MATIZ' ? 'SÍ*' : crit.resultado === 'NO' ? 'NO' : 'N/A';
    slide.addShape('rect', { x: cx + 0.1, y: cy + cH - 0.24, w: 0.38, h: 0.17, fill: { color: badgeBg }, line: { color: badgeBg, width: 0 } });
    slide.addText(badgeLabel, { x: cx + 0.1, y: cy + cH - 0.24, w: 0.38, h: 0.17, fontSize: 7.5, color: badgeColor, fontFace: 'Calibri', bold: true, align: 'center', valign: 'middle', margin: 0 });
  });

  footer(slide);
}

// ── Lámina de alerta ─────────────────────────────────────────────────────────

function laminaAlerta(pres, alerta, numero, total) {
  const slide = pres.addSlide();
  slide.background = { color: C.blanco };
  barraRoja(slide);

  const colorGrav = alerta.gravedad === 'ALTA' ? C.rojo : alerta.gravedad === 'MODERADA-ALTA' ? C.dorado : C.teal;
  slide.addImage({ data: iconAlerta(alerta.gravedad), x: ML, y: MT, w: 0.52, h: 0.52 });
  slide.addText(`ALERTA ${numero} DE ${total}  ·  GRAVEDAD: ${alerta.gravedad}`, {
    x: ML + 0.6, y: MT + 0.05, w: 7, h: 0.22,
    fontSize: 8, color: colorGrav, fontFace: 'Calibri', bold: true, charSpacing: 1, margin: 0,
  });
  slide.addText(alerta.titulo, {
    x: ML + 0.6, y: MT + 0.28, w: W - ML - MR - 0.6, h: 0.42,
    fontSize: 18, color: C.texto, fontFace: 'Georgia', bold: true, margin: 0,
  });
  slide.addShape('rect', { x: ML, y: MT + 0.84, w: CW, h: 0.008, fill: { color: C.cremaBorde }, line: { color: C.cremaBorde, width: 0 } });
  slide.addText(alerta.descripcion, {
    x: ML, y: MT + 1.0, w: CW * 0.72, h: 3.1,
    fontSize: 11, color: C.textoMid, fontFace: 'Calibri', align: 'left', valign: 'top', margin: 0,
  });

  if (alerta.criterios && alerta.criterios.length > 0) {
    slide.addText('CRITERIOS AFECTADOS', { x: ML, y: MT + 4.18, w: CW * 0.72, h: 0.18, fontSize: 7.5, color: C.textoMuted, fontFace: 'Calibri', charSpacing: 1.2, margin: 0 });
    let bx = ML;
    alerta.criterios.forEach(cid => {
      slide.addShape('rect', { x: bx, y: MT + 4.38, w: 0.6, h: 0.2, fill: { color: 'EDEBE4' }, line: { color: 'EDEBE4', width: 0 } });
      slide.addText(cid, { x: bx, y: MT + 4.38, w: 0.6, h: 0.2, fontSize: 8, color: C.textoMid, fontFace: 'Calibri', bold: true, align: 'center', valign: 'middle', margin: 0 });
      bx += 0.66;
    });
  }

  const panelX = ML + CW * 0.76, panelW = CW * 0.24;
  slide.addShape('rect', { x: panelX, y: MT + 1.0, w: panelW, h: 3.6, fill: { color: 'FAFAF8' }, line: { color: C.cremaBorde, width: 0.5 } });
  slide.addShape('rect', { x: panelX, y: MT + 1.0, w: 0.04, h: 3.6, fill: { color: colorGrav }, line: { color: colorGrav, width: 0 } });
  slide.addText('IMPACTO LIBERAL', { x: panelX + 0.12, y: MT + 1.12, w: panelW - 0.18, h: 0.2, fontSize: 7.5, color: C.textoMuted, fontFace: 'Calibri', charSpacing: 1, margin: 0 });
  slide.addText(alerta.impacto || '', { x: panelX + 0.12, y: MT + 1.36, w: panelW - 0.22, h: 2.9, fontSize: 9.5, color: C.texto, fontFace: 'Calibri', align: 'left', valign: 'top', margin: 0 });

  footer(slide);
}

// ── Extraer estructura del reporte con Claude ─────────────────────────────────

const PROMPT_EXTRACCION = `Eres un asistente que convierte reportes de auditoría liberal en estructuras JSON para generar presentaciones.
Responde ÚNICAMENTE con JSON válido, sin texto adicional, sin backticks.

Estructura requerida:
{
  "titulo": "Título completo del documento auditado",
  "subtitulo": "Naturaleza jurídica · País · Fecha · Páginas",
  "puntaje": 89,
  "nivelRiesgo": "BAJO",
  "siPlenos": 20,
  "siMatiz": 8,
  "criterios_total": 28,
  "categorias": [
    {
      "num": "I",
      "nombre": "Dignidad y Autonomía Individual",
      "siPlenos": 4,
      "siMatiz": 1,
      "criterios": [
        { "id": "C-01", "resultado": "SI", "resumen": "Respeta libre desarrollo individual sin modelo colectivo" },
        { "id": "C-04", "resultado": "SI_MATIZ", "resumen": "Igualdad formal garantizada pero omite orientación sexual" }
      ]
    }
  ],
  "alertas": [
    {
      "titulo": "Opacidad en el proceso de privatizaciones",
      "gravedad": "ALTA",
      "descripcion": "Descripción clara en 2-4 oraciones.",
      "criterios": ["C-19", "C-08"],
      "impacto": "Consecuencias liberales en 1-2 oraciones."
    }
  ]
}

Reglas:
- resultado: "SI", "SI_MATIZ", "NO", "NA"
- nivelRiesgo: "BAJO", "MODERADO", "ALTO", "MUY ALTO"
- resumen de criterio: máximo 12 palabras, sin citar páginas
- Las 7 categorías siempre son: I=Dignidad y Autonomía Individual, II=Estado de Derecho e Instituciones, III=Propiedad Privada y Libre Empresa, IV=Competencia y Rechazo al Rentismo, V=Límites al Estado y Subsidiariedad, VI=Igualdad de Oportunidades y Política Social, VII=Integridad Semántica y Soberanía
- Incluye TODAS las alertas del reporte`;

async function extraerEstructuraPresentacion(reporteTexto) {
  const respuesta = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    system: PROMPT_EXTRACCION,
    messages: [{ role: 'user', content: `Extrae la estructura de este reporte:\n\n${reporteTexto}` }],
  });
  const limpio = respuesta.content[0].text.trim().replace(/```json|```/g, '').trim();
  return JSON.parse(limpio);
}

// ── Generar PPTX ─────────────────────────────────────────────────────────────

async function generarPresentacion(reporteTexto, titulo, rutaSalida, auditoria_id) {
  console.log(`   [${auditoria_id}] Extrayendo estructura de presentación con Claude...`);
  const estructura = await extraerEstructuraPresentacion(reporteTexto);
  console.log(`   [${auditoria_id}] Estructura extraída: ${estructura.categorias.length} categorías · ${estructura.alertas.length} alertas`);

  const pres = new pptxgen();
  pres.layout  = 'LAYOUT_16x9';
  pres.author  = 'Auditoría Cívica Liberal — liberalmente.app';
  pres.title   = titulo;
  pres.subject = 'Auditoría Liberal · CEDICE / Friedrich Naumann';

  laminaPortada(pres, estructura);
  for (const cat of estructura.categorias) laminaCategoria(pres, cat);
  if (estructura.alertas?.length > 0) {
    estructura.alertas.forEach((alerta, i) => laminaAlerta(pres, alerta, i + 1, estructura.alertas.length));
  }

  await pres.writeFile({ fileName: rutaSalida });
  console.log(`   [${auditoria_id}] PPTX generado: ${rutaSalida}`);
  return rutaSalida;
}

// ── Rutas ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '3.0', timestamp: new Date().toISOString() });
});

app.post('/procesar', async (req, res) => {
  if (req.headers['x-worker-secret'] !== WORKER_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  const { auditoria_id, ciudadano_email, pdf_drive_id } = req.body;
  if (!auditoria_id || !ciudadano_email || !pdf_drive_id) {
    return res.status(400).json({ error: 'Faltan datos requeridos' });
  }
  res.json({ mensaje: 'Recibido, procesando en segundo plano', auditoria_id });
  procesarAuditoria(auditoria_id, ciudadano_email, pdf_drive_id).catch(err => {
    console.error(`❌ [${auditoria_id}] Error no capturado:`, err.message);
  });
});

app.post('/retomar', async (req, res) => {
  if (req.headers['x-worker-secret'] !== WORKER_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  try {
    const result = await db.query(`
      SELECT a.id, a.pdf_drive_id, c.email AS ciudadano_email, a.titulo_documento
      FROM auditorias a
      JOIN ciudadanos c ON c.id = a.ciudadano_id
      WHERE a.estado = 'awaiting_session'
      ORDER BY a.creada_en ASC
    `);
    const pendientes = result.rows;
    if (pendientes.length === 0) return res.json({ mensaje: 'No hay auditorías en espera', retomadas: 0 });
    res.json({ mensaje: `Retomando ${pendientes.length} auditoría(s)`, retomadas: pendientes.length });
    for (const a of pendientes) {
      await retomarDesdePaquetes(a.id, a.ciudadano_email)
        .catch(err => console.error(`❌ Error retomando [${a.id}]:`, err.message));
      if (pendientes.indexOf(a) < pendientes.length - 1) await new Promise(r => setTimeout(r, 3000));
    }
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// ── Función principal ────────────────────────────────────────────────────────

async function procesarAuditoria(auditoria_id, ciudadano_email, pdf_drive_id) {
  console.log(`\n🚀 [${auditoria_id}] Iniciando procesamiento`);

  const dir            = path.join(DIRECTORIO_TEMP, auditoria_id);
  const rutaPDF        = path.join(dir, 'original.pdf');
  const rutaTXT        = path.join(dir, 'original.txt');
  const rutaReporte    = path.join(dir, 'reporte.txt');
  const rutaReportePDF = path.join(dir, 'reporte.pdf');
  const rutaPodcast    = path.join(dir, 'podcast.wav');
  const rutaSlides     = path.join(dir, 'presentacion.pptx');

  fs.mkdirSync(dir, { recursive: true });

  try {
    // PASO 1 — Descargar PDF
    console.log(`📥 [${auditoria_id}] PASO 1: Descargando PDF...`);
    const driveAuth = autenticarDrive();
    const drive = google.drive({ version: 'v3', auth: driveAuth });
    await descargarPDF(drive, pdf_drive_id, rutaPDF);
    console.log(`✅ [${auditoria_id}] PDF descargado`);

    // PASO 2 — Extraer texto
    console.log(`📝 [${auditoria_id}] PASO 2: Extrayendo texto...`);
    const textoPDF = await extraerTextoPDF(rutaPDF);
    fs.writeFileSync(rutaTXT, textoPDF, 'utf8');
    console.log(`✅ [${auditoria_id}] Texto extraído (${textoPDF.length} chars)`);

    // PASO 3 — Configuración doctrinal
    console.log(`📖 [${auditoria_id}] PASO 3: Leyendo configuración doctrinal...`);
    const config = await obtenerConfigDoctrinal();
    console.log(`✅ [${auditoria_id}] Prompt versión ${config.version}`);

    // PASO 4 — Metadatos
    console.log(`🏷️  [${auditoria_id}] PASO 4: Extrayendo metadatos...`);
    await actualizarEstado(auditoria_id, 'procesando');
    const metadatos = await extraerMetadatos(textoPDF);
    await db.query(
      `UPDATE auditorias SET titulo_documento = $1, pais = $2, categoria = $3 WHERE id = $4`,
      [metadatos.titulo, metadatos.pais, metadatos.categoria, auditoria_id]
    );
    console.log(`✅ [${auditoria_id}] Metadatos: "${metadatos.titulo}"`);

    // Pausa rate limit
    console.log(`⏳ [${auditoria_id}] Esperando ventana de rate limit...`);
    await new Promise(r => setTimeout(r, 90_000));

    // PASO 5 — Análisis Claude
    console.log(`🧠 [${auditoria_id}] PASO 5: Analizando con Claude...`);
    const reporte = await analizarConClaude(textoPDF, config);
    fs.writeFileSync(rutaReporte, reporte, 'utf8');
    await db.query(
      `UPDATE auditorias SET reporte_texto = $1, prompt_version = $2 WHERE id = $3`,
      [reporte, config.version, auditoria_id]
    );
    console.log(`✅ [${auditoria_id}] Reporte generado (${reporte.length} chars)`);

    // PASO 6 — PDF del reporte
    console.log(`📄 [${auditoria_id}] PASO 6: Generando PDF del reporte...`);
    await convertirTXTaPDF(rutaReporte, rutaReportePDF, metadatos.titulo);
    console.log(`✅ [${auditoria_id}] PDF generado`);

    // PASO 7 — NotebookLM (Audio Overview)
    console.log(`🎙️  [${auditoria_id}] PASO 7: Generando audio con NotebookLM API...`);
    await actualizarEstado(auditoria_id, 'empaquetando');
    await ejecutarNotebookLMApi(reporte, metadatos.titulo, rutaPodcast, auditoria_id);
    console.log(`✅ [${auditoria_id}] Audio generado`);

    // PASO 8 — Presentación PPTX
    console.log(`📊 [${auditoria_id}] PASO 8: Generando presentación PPTX...`);
    await generarPresentacion(reporte, metadatos.titulo, rutaSlides, auditoria_id);
    console.log(`✅ [${auditoria_id}] Presentación generada`);

    // PASO 9 — Subir a Drive y enviar email
    await finalizarAuditoria(drive, auditoria_id, ciudadano_email, metadatos.titulo,
      rutaReportePDF, rutaPodcast, rutaSlides);

  } catch (error) {
    console.error(`❌ [${auditoria_id}] Error:`, error.message);
    await actualizarEstado(auditoria_id, 'error').catch(() => {});
    await db.query(`UPDATE auditorias SET error_mensaje = $1 WHERE id = $2`, [error.message, auditoria_id]).catch(() => {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`🧹 [${auditoria_id}] Archivos temporales eliminados`);
  }
}

// ── Retomar desde PASO 7 ─────────────────────────────────────────────────────

async function retomarDesdePaquetes(auditoria_id, ciudadano_email) {
  const dir            = path.join(DIRECTORIO_TEMP, `retomar-${auditoria_id}`);
  const rutaReporte    = path.join(dir, 'reporte.txt');
  const rutaReportePDF = path.join(dir, 'reporte.pdf');
  const rutaPodcast    = path.join(dir, 'podcast.wav');
  const rutaSlides     = path.join(dir, 'presentacion.pptx');

  fs.mkdirSync(dir, { recursive: true });

  try {
    const result = await db.query(
      `SELECT reporte_texto, titulo_documento FROM auditorias WHERE id = $1`, [auditoria_id]
    );
    if (!result.rows[0]?.reporte_texto) throw new Error('No se encontró el reporte en BD');
    const { reporte_texto, titulo_documento } = result.rows[0];

    fs.writeFileSync(rutaReporte, reporte_texto, 'utf8');
    await convertirTXTaPDF(rutaReporte, rutaReportePDF, titulo_documento || 'Documento');

    await actualizarEstado(auditoria_id, 'empaquetando');
    await ejecutarNotebookLMApi(reporte_texto, titulo_documento, rutaPodcast, auditoria_id);
    await generarPresentacion(reporte_texto, titulo_documento, rutaSlides, auditoria_id);

    const driveAuth = autenticarDrive();
    const drive = google.drive({ version: 'v3', auth: driveAuth });
    await finalizarAuditoria(drive, auditoria_id, ciudadano_email, titulo_documento || 'Documento',
      rutaReportePDF, rutaPodcast, rutaSlides);

  } catch (error) {
    console.error(`❌ [${auditoria_id}] Error al retomar:`, error.message);
    await actualizarEstado(auditoria_id, 'error').catch(() => {});
    await db.query(`UPDATE auditorias SET error_mensaje = $1 WHERE id = $2`, [error.message, auditoria_id]).catch(() => {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Finalizar auditoría ───────────────────────────────────────────────────────

async function finalizarAuditoria(drive, auditoria_id, ciudadano_email, titulo,
  rutaReportePDF, rutaPodcast, rutaSlides) {

  console.log(`☁️  [${auditoria_id}] Subiendo archivos a Drive...`);
  const carpetaId = await obtenerCarpetaAuditoria(drive, auditoria_id);
  const links = {};
  links.reporte = await subirArchivo(drive, rutaReportePDF, 'reporte.pdf', 'application/pdf', carpetaId);
  links.podcast = await subirArchivo(drive, rutaPodcast, 'podcast.wav', 'audio/wav', carpetaId);
  links.slides  = await subirArchivo(drive, rutaSlides, 'presentacion.pptx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', carpetaId);
  console.log(`✅ [${auditoria_id}] Archivos subidos`);

  await db.query(
    `UPDATE auditorias
     SET estado = 'completada', link_reporte = $1, link_podcast = $2,
         link_presentacion = $3, completada_en = NOW()
     WHERE id = $4`,
    [links.reporte, links.podcast, links.slides, auditoria_id]
  );

  await enviarEmail(ciudadano_email, auditoria_id, links, titulo);
  console.log(`\n🎉 [${auditoria_id}] Auditoría completada`);
}

// ── Funciones auxiliares (sin cambios) ───────────────────────────────────────

function autenticarDrive() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost'
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

async function descargarPDF(drive, fileId, destino) {
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destino);
    res.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function obtenerConfigDoctrinal() {
  const result = await db.query(
    `SELECT version, prompt_sistema, prompt_analisis FROM configuracion_doctrinal WHERE activo = true ORDER BY version DESC LIMIT 1`
  );
  if (result.rows.length === 0) throw new Error('No hay configuración doctrinal activa');
  return result.rows[0];
}

async function extraerTextoPDF(rutaPDF) {
  const buffer = fs.readFileSync(rutaPDF);
  const data   = await pdfParse(buffer);
  return data.text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function extraerMetadatos(textoPDF) {
  const muestra = textoPDF.slice(0, 3000);
  const respuesta = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: `Eres un clasificador de documentos jurídicos. Responde ÚNICAMENTE con JSON válido, sin texto adicional, sin backticks.`,
    messages: [{
      role: 'user',
      content: `Analiza este fragmento y responde SOLO con este JSON:
{"titulo":"título oficial completo","pais":"país o General","categoria":"pais|comparativo|doctrinal"}

Fragmento:\n${muestra}`,
    }],
  });
  try {
    const limpio = respuesta.content[0].text.trim().replace(/```json|```/g, '').trim();
    const datos  = JSON.parse(limpio);
    return {
      titulo:    datos.titulo    || 'Documento sin título',
      pais:      datos.pais      || 'General',
      categoria: ['pais', 'comparativo', 'doctrinal'].includes(datos.categoria) ? datos.categoria : 'pais',
    };
  } catch {
    return { titulo: 'Documento sin título', pais: 'General', categoria: 'pais' };
  }
}

async function analizarConClaude(textoPDF, config) {
  const respuesta = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    system: config.prompt_sistema,
    messages: [{ role: 'user', content: `${config.prompt_analisis}\n\n---\n\nTEXTO DEL DOCUMENTO:\n\n${textoPDF}` }],
  });
  return respuesta.content[0].text;
}

async function convertirTXTaPDF(rutaTXT, rutaPDF, titulo) {
  const PDFDocument = require('pdfkit');
  const texto = fs.readFileSync(rutaTXT, 'utf8');
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 72, size: 'LETTER' });
    const stream = fs.createWriteStream(rutaPDF);
    doc.pipe(stream);
    doc.fontSize(9).fillColor('#888888').font('Helvetica')
      .text('AUDITORÍA CÍVICA LIBERAL — liberalmente.app', { align: 'center' }).moveDown(0.75);
    doc.fontSize(17).fillColor('#1a1a1a').font('Helvetica-Bold')
      .text(titulo, { align: 'center' }).moveDown(0.5);
    doc.fontSize(9).fillColor('#888888').font('Helvetica')
      .text(`Generado el ${new Date().toLocaleDateString('es-VE', { year: 'numeric', month: 'long', day: 'numeric' })}`, { align: 'center' }).moveDown(1.5);
    doc.moveTo(72, doc.y).lineTo(doc.page.width - 72, doc.y).strokeColor('#cccccc').lineWidth(0.5).stroke().moveDown(1.5);
    doc.fontSize(11).fillColor('#1a1a1a').font('Helvetica').text(texto, { lineGap: 5, paragraphGap: 10 });
    doc.on('pageAdded', () => {
      doc.fontSize(8).fillColor('#aaaaaa')
        .text('Auditoría Cívica Liberal · liberalmente.app', 72, doc.page.height - 40, { align: 'center', width: doc.page.width - 144 });
    });
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function obtenerCarpetaAuditoria(drive, auditoria_id) {
  const res = await drive.files.list({
    q: `name = '${auditoria_id}' and mimeType = 'application/vnd.google-apps.folder'`,
    fields: 'files(id)',
  });
  if (res.data.files.length > 0) return res.data.files[0].id;
  const nueva = await drive.files.create({
    requestBody: { name: auditoria_id, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id',
  });
  return nueva.data.id;
}

async function subirArchivo(drive, ruta, nombre, mime, carpetaId) {
  if (!fs.existsSync(ruta)) { console.log(`   ⚠️  Omitiendo ${nombre} (no encontrado)`); return null; }
  const res = await drive.files.create({
    requestBody: { name: nombre, parents: [carpetaId] },
    media: { mimeType: mime, body: fs.createReadStream(ruta) },
    fields: 'id, webViewLink',
  });
  await drive.permissions.create({ fileId: res.data.id, requestBody: { role: 'reader', type: 'anyone' } });
  console.log(`   ✅ ${nombre} subido`);
  return res.data.webViewLink;
}

async function actualizarEstado(auditoria_id, estado) {
  await db.query(`UPDATE auditorias SET estado = $1 WHERE id = $2`, [estado, auditoria_id]);
}

async function enviarEmail(email, auditoria_id, links, titulo) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: 'Auditoría Cívica Liberal <no-reply@liberalmente.app>',
      to: email,
      subject: '✅ Tu auditoría está lista',
      html: `
        <p>Tu auditoría de <strong>${titulo}</strong> ha sido procesada. Aquí están tus materiales:</p>
        <ul>
          ${links.reporte ? `<li><a href="${links.reporte}">📋 Reporte de Auditoría (PDF)</a></li>` : ''}
          ${links.podcast ? `<li><a href="${links.podcast}">🎙️ Podcast (Audio Overview)</a></li>` : ''}
          ${links.slides  ? `<li><a href="${links.slides}">📊 Presentación (PPTX)</a></li>` : ''}
        </ul>
        <p>Accede a todos tus análisis en <a href="https://liberalmente.app/biblioteca">liberalmente.app/biblioteca</a></p>
      `,
    }),
  });
  if (!res.ok) throw new Error(`Error enviando email: ${await res.text()}`);
  console.log(`   ✅ Email enviado a ${email}`);
}

// ── Arrancar servidor ────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n⚙️  ACL Worker v3.0 corriendo en puerto ${PORT}`);
  console.log(`   Hemisferio derecho: NotebookLM Enterprise API`);
  console.log(`   Listo para recibir auditorías\n`);
});