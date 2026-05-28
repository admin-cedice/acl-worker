// worker.js — ACL Worker completo
// Umbusk LLC · Auditoría Cívica Liberal
// Railway · Node.js

const express = require('express');
const { google } = require('googleapis');
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ── Clientes globales ────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const WORKER_SECRET = process.env.WORKER_SECRET;
const DIRECTORIO_TEMP = '/tmp/acl-worker';

// ── Rutas ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/procesar', async (req, res) => {
  if (req.headers['x-worker-secret'] !== WORKER_SECRET) {
    console.log('⛔ Acceso no autorizado');
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

// ── Verificar sesión de NotebookLM ───────────────────────────────────────────

app.get('/verificar-sesion', async (req, res) => {
  if (req.headers['x-worker-secret'] !== WORKER_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  console.log('\n🔍 Verificando sesión de NotebookLM...');
  const rutaSesion = '/tmp/sesion-test.json';

  try {
    fs.writeFileSync(rutaSesion, process.env.SESION_GOOGLE, 'utf8');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: rutaSesion });
    const page = await context.newPage();

    await page.goto('https://notebooklm.google.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    const url = page.url();
    const viva = !url.includes('accounts.google.com');

    await browser.close();
    fs.unlinkSync(rutaSesion);

    console.log(`   URL final: ${url}`);
    console.log(`   Sesión: ${viva ? '✅ VIVA' : '❌ MUERTA'}`);

    if (!viva) {
      await alertarSesionExpirada();
    }

    res.json({ viva, url, timestamp: new Date().toISOString() });

  } catch (error) {
    console.error('   Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Función principal ────────────────────────────────────────────────────────

async function procesarAuditoria(auditoria_id, ciudadano_email, pdf_drive_id) {
  console.log(`\n🚀 [${auditoria_id}] Iniciando procesamiento`);

  const dirAuditoria = path.join(DIRECTORIO_TEMP, auditoria_id);
  fs.mkdirSync(dirAuditoria, { recursive: true });

  const rutaPDF     = path.join(dirAuditoria, 'original.pdf');
  const rutaReporte = path.join(dirAuditoria, 'reporte.txt');
  const rutaPodcast = path.join(dirAuditoria, 'podcast.wav');
  const rutaSlides  = path.join(dirAuditoria, 'presentacion.pptx');
  const rutaMapa    = path.join(dirAuditoria, 'mapa-mental.png');
  const rutaSesion  = path.join(dirAuditoria, 'sesion-google.json');

  try {

    console.log(`📥 [${auditoria_id}] PASO 1: Descargando PDF de Drive...`);
    const driveAuth = autenticarDrive();
    const drive = google.drive({ version: 'v3', auth: driveAuth });
    await descargarPDF(drive, pdf_drive_id, rutaPDF);
    console.log(`✅ [${auditoria_id}] PDF descargado`);

    console.log(`📖 [${auditoria_id}] PASO 2: Leyendo configuración doctrinal...`);
    const config = await obtenerConfigDoctrinal();
    console.log(`✅ [${auditoria_id}] Usando prompt versión ${config.version}`);

    console.log(`🏷️  [${auditoria_id}] PASO 3: Extrayendo metadatos con Claude...`);
    await actualizarEstado(auditoria_id, 'procesando');
    const metadatos = await extraerMetadatos(rutaPDF);
    console.log(`✅ [${auditoria_id}] Metadatos: "${metadatos.titulo}" | ${metadatos.pais} | ${metadatos.categoria}`);

    await db.query(
      `UPDATE auditorias SET titulo_documento = $1, pais = $2, categoria = $3 WHERE id = $4`,
      [metadatos.titulo, metadatos.pais, metadatos.categoria, auditoria_id]
    );

    console.log(`🧠 [${auditoria_id}] PASO 4: Analizando con Claude...`);
    const reporte = await analizarConClaude(rutaPDF, config);
    fs.writeFileSync(rutaReporte, reporte, 'utf8');
    console.log(`✅ [${auditoria_id}] Reporte generado (${reporte.length} caracteres)`);

    await db.query(
      `UPDATE auditorias SET reporte_texto = $1, prompt_version = $2 WHERE id = $3`,
      [reporte, config.version, auditoria_id]
    );

    console.log(`🎙️  [${auditoria_id}] PASO 5: Generando paquetes en NotebookLM...`);
    await actualizarEstado(auditoria_id, 'empaquetando');
    fs.writeFileSync(rutaSesion, process.env.SESION_GOOGLE, 'utf8');
    await ejecutarPlaywright(rutaReporte, rutaSesion, rutaPodcast, rutaSlides, rutaMapa, auditoria_id);
    console.log(`✅ [${auditoria_id}] Paquetes generados`);

    console.log(`☁️  [${auditoria_id}] PASO 6: Subiendo a Drive...`);
    await actualizarEstado(auditoria_id, 'empaquetando');
    const carpetaId = await obtenerCarpetaAuditoria(drive, auditoria_id);

    const links = {};
    links.reporte = await subirArchivo(drive, rutaReporte, 'reporte.txt',      'text/plain',          carpetaId);
    links.podcast = await subirArchivo(drive, rutaPodcast, 'podcast.wav',       'audio/wav',           carpetaId);
    links.slides  = await subirArchivo(drive, rutaSlides,  'presentacion.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', carpetaId);
    links.mapa    = await subirArchivo(drive, rutaMapa,    'mapa-mental.png',    'image/png',           carpetaId);
    console.log(`✅ [${auditoria_id}] Archivos subidos`);

    await db.query(
      `UPDATE auditorias
       SET estado = 'completada', link_reporte = $1, link_podcast = $2, link_presentacion = $3, link_mapa = $4, completada_en = NOW()
       WHERE id = $5`,
      [links.reporte, links.podcast, links.slides, links.mapa, auditoria_id]
    );

    console.log(`✉️  [${auditoria_id}] PASO 7: Enviando email...`);
    await enviarEmail(ciudadano_email, auditoria_id, links, metadatos.titulo);

    console.log(`\n🎉 [${auditoria_id}] Auditoría completada exitosamente`);

  } catch (error) {
    console.error(`❌ [${auditoria_id}] Error:`, error.message);
    await actualizarEstado(auditoria_id, 'error').catch(() => {});
    await db.query(`UPDATE auditorias SET error_mensaje = $1 WHERE id = $2`, [error.message, auditoria_id]).catch(() => {});
  } finally {
    fs.rmSync(dirAuditoria, { recursive: true, force: true });
    console.log(`🧹 [${auditoria_id}] Archivos temporales eliminados`);
  }
}

// ── Funciones auxiliares ─────────────────────────────────────────────────────

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

async function extraerMetadatos(rutaPDF) {
  // Llamada rápida y enfocada: solo extrae título, país y categoría
  const pdfBase64 = fs.readFileSync(rutaPDF).toString('base64');

  const respuesta = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: `Eres un clasificador de documentos jurídicos y políticos.
Responde ÚNICAMENTE con JSON válido, sin texto adicional, sin backticks, sin explicaciones.`,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }
        },
        {
          type: 'text',
          text: `Analiza este documento y responde SOLO con este JSON:
{
  "titulo": "título oficial completo del documento (sin siglas ni números de gaceta)",
  "pais": "nombre del país al que se refiere, o 'Varios' si es comparativo, o 'General' si es doctrinal",
  "categoria": "pais" | "comparativo" | "doctrinal"
}

Reglas:
- titulo: el nombre oficial del documento, limpio y completo. Ej: "Ley Orgánica de Hidrocarburos"
- pais: si es una ley nacional, el país. Si compara varios países, "Varios". Si es un texto teórico/doctrinal sin país específico, "General"
- categoria: "pais" si es normativa de un país, "comparativo" si compara países, "doctrinal" si es teórico`
        }
      ]
    }]
  });

  try {
    const texto = respuesta.content[0].text.trim();
    const limpio = texto.replace(/```json|```/g, '').trim();
    const datos = JSON.parse(limpio);
    return {
      titulo: datos.titulo || 'Documento sin título',
      pais: datos.pais || 'General',
      categoria: ['pais', 'comparativo', 'doctrinal'].includes(datos.categoria) ? datos.categoria : 'pais',
    };
  } catch (err) {
    console.error(`   ⚠️  Error parseando metadatos:`, err.message);
    return { titulo: 'Documento sin título', pais: 'General', categoria: 'pais' };
  }
}

async function analizarConClaude(rutaPDF, config) {
  const pdfBase64 = fs.readFileSync(rutaPDF).toString('base64');
  const respuesta = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    system: config.prompt_sistema,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: config.prompt_analisis }
      ]
    }]
  });
  return respuesta.content[0].text;
}

async function ejecutarPlaywright(rutaReporte, rutaSesion, rutaPodcast, rutaSlides, rutaMapa, auditoria_id) {
  const ESPERA = 30_000;
  const TIMEOUT = 30 * 60_000;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: rutaSesion, acceptDownloads: true });
  const page = await context.newPage();

  try {
    await page.goto('https://notebooklm.google.com');
    await page.waitForTimeout(5000);
    if (page.url().includes('accounts.google.com')) {
      throw new Error('Sesión de NotebookLM expirada. Renovar SESION_GOOGLE en Railway.');
    }

    await page.locator('text=Crear cuaderno nuevo').click();
    await page.waitForTimeout(5000);
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('button:has-text("Subir archivos")').click()
    ]);
    await fileChooser.setFiles(rutaReporte);
    await page.waitForTimeout(8000);
    const botonInsertar = page.locator('button:has-text("Insertar")').or(page.locator('button:has-text("Agregar")')).or(page.locator('button:has-text("Listo")')).first();
    if (await botonInsertar.isVisible().catch(() => false)) await botonInsertar.click();
    await page.waitForTimeout(5000);

    const cerrarModal = page.locator('button').filter({ hasText: 'close' }).last();
    if (await cerrarModal.isVisible().catch(() => false)) { await cerrarModal.click(); await page.waitForTimeout(1500); }
    await page.locator('button[aria-label="Personalizar el resumen de audio"]').click();
    await page.waitForTimeout(3000);
    const btnAudio = page.locator('button:has-text("Generar")').last();
    if (await btnAudio.isVisible().catch(() => false)) { await btnAudio.click(); await page.waitForTimeout(3000); }
    const t0 = Date.now();
    while (true) {
      if (await page.locator('button[aria-label="Reproducir"]').isVisible().catch(() => false)) break;
      if (Date.now() - t0 > TIMEOUT) throw new Error('Timeout: audio no terminó en 30 min');
      await page.waitForTimeout(ESPERA);
    }
    console.log(`   [${auditoria_id}] Audio listo`);

    await page.keyboard.press('Escape'); await page.waitForTimeout(1000);
    await page.locator('button[aria-label="Personalizar la presentación de diapositivas"]').click();
    await page.waitForTimeout(2000);
    const btnPptx = page.locator('button:has-text("Generar")').last();
    if (await btnPptx.isVisible().catch(() => false)) { await btnPptx.click(); await page.waitForTimeout(2000); }
    await page.keyboard.press('Escape'); await page.waitForTimeout(1000);
    for (let i = 0; i < 60; i++) {
      if (await page.locator('button[aria-label="Más"]').count() >= 3) { console.log(`   [${auditoria_id}] Presentación lista`); break; }
      if (i === 59) throw new Error('Timeout: presentación no terminó');
      await page.waitForTimeout(30000);
    }

    let pptxOk = false;
    for (const btn of await page.locator('button[aria-label="Más"]').all()) {
      await btn.click().catch(() => {}); await page.waitForTimeout(800);
      if (await page.locator('[role="menuitem"]').filter({ hasText: /powerpoint|pptx/i }).isVisible().catch(() => false)) {
        const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[role="menuitem"]').filter({ hasText: /powerpoint|pptx/i }).first().click()]);
        await dl.saveAs(rutaSlides); pptxOk = true; break;
      }
      await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    }
    if (!pptxOk) throw new Error('No se encontró opción PowerPoint');

    let podcastOk = false;
    for (const btn of await page.locator('button[aria-label="Más"]').all()) {
      await btn.click().catch(() => {}); await page.waitForTimeout(800);
      if (await page.locator('[role="menuitem"]').filter({ hasText: /descargar/i }).isVisible().catch(() => false)) {
        const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[role="menuitem"]').filter({ hasText: /descargar/i }).first().click()]);
        await dl.saveAs(rutaPodcast); podcastOk = true; break;
      }
      await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    }
    if (!podcastOk) throw new Error('No se encontró opción Descargar para podcast');

    await page.keyboard.press('Escape'); await page.waitForTimeout(1000);
    await page.locator('button[aria-label="Personalizar mapa mental"]').click();
    await page.waitForTimeout(2000);
    const btnMapa = page.locator('button:has-text("Generar")').last();
    if (await btnMapa.isVisible().catch(() => false)) { await btnMapa.click(); await page.waitForTimeout(2000); }
    await page.keyboard.press('Escape'); await page.waitForTimeout(1000);
    for (let i = 0; i < 60; i++) {
      if (await page.locator('button[aria-label="Más"]').count() >= 4) { console.log(`   [${auditoria_id}] Mapa listo`); break; }
      if (i === 59) throw new Error('Timeout: mapa no terminó');
      await page.waitForTimeout(30000);
    }

    await page.locator('button[aria-label="Personalizar mapa mental"]').click();
    await page.waitForTimeout(5000);
    const cerrarMapa = page.locator('button').filter({ hasText: 'close' }).last();
    if (await cerrarMapa.isVisible().catch(() => false)) { await cerrarMapa.click(); await page.waitForTimeout(1000); }
    const btnArtefacto = page.locator('button[aria-description="Artefacto"]').first();
    if (await btnArtefacto.isVisible().catch(() => false)) { await btnArtefacto.click(); await page.waitForTimeout(4000); }
    let frameMapa = null;
    for (let i = 0; i < 20; i++) {
      frameMapa = page.frames().find(f => f.url().startsWith('blob:'));
      if (frameMapa) break;
      await page.waitForTimeout(1000);
    }
    if (!frameMapa) throw new Error('No se encontró el frame del mapa mental');
    await frameMapa.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);
    await frameMapa.locator('button[aria-label="Expand all nodes"]').waitFor({ state: 'visible', timeout: 5000 });
    await frameMapa.locator('button[aria-label="Expand all nodes"]').click();
    await page.waitForTimeout(4000);
    await frameMapa.locator('button[aria-label="Download mindmap as image"]').waitFor({ state: 'visible', timeout: 5000 });
    const [dlMapa] = await Promise.all([page.waitForEvent('download'), frameMapa.locator('button[aria-label="Download mindmap as image"]').click()]);
    await dlMapa.saveAs(rutaMapa);
    console.log(`   [${auditoria_id}] Mapa mental descargado`);

  } finally {
    await browser.close();
  }
}

async function obtenerCarpetaAuditoria(drive, auditoria_id) {
  const res = await drive.files.list({
    q: `name = '${auditoria_id}' and mimeType = 'application/vnd.google-apps.folder'`,
    fields: 'files(id)'
  });
  if (res.data.files.length > 0) return res.data.files[0].id;
  const nueva = await drive.files.create({
    requestBody: { name: auditoria_id, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  });
  return nueva.data.id;
}

async function subirArchivo(drive, ruta, nombre, mime, carpetaId) {
  if (!fs.existsSync(ruta)) { console.log(`   ⚠️  Omitiendo ${nombre} (no encontrado)`); return null; }
  const res = await drive.files.create({
    requestBody: { name: nombre, parents: [carpetaId] },
    media: { mimeType: mime, body: fs.createReadStream(ruta) },
    fields: 'id, webViewLink'
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
          ${links.reporte  ? `<li><a href="${links.reporte}">📋 Reporte de Auditoría</a></li>` : ''}
          ${links.podcast  ? `<li><a href="${links.podcast}">🎙️ Podcast</a></li>` : ''}
          ${links.slides   ? `<li><a href="${links.slides}">📊 Presentación</a></li>` : ''}
          ${links.mapa     ? `<li><a href="${links.mapa}">🗺️ Mapa Mental</a></li>` : ''}
        </ul>
        <p>Accede a todos tus análisis en <a href="https://liberalmente.app/biblioteca">liberalmente.app/biblioteca</a></p>
      `
    })
  });
  if (!res.ok) throw new Error(`Error enviando email: ${await res.text()}`);
  console.log(`   ✅ Email enviado a ${email}`);
}

async function alertarSesionExpirada() {
  try {
    const result = await db.query(
      `SELECT email FROM configuracion_alertas WHERE tipo = 'sesion_notebooklm' AND activo = true`
    );
    const destinatarios = result.rows.map(r => r.email);
    if (destinatarios.length === 0) { console.log('   ⚠️  Sesión muerta pero no hay destinatarios configurados'); return; }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'Auditoría Cívica Liberal <no-reply@liberalmente.app>',
        to: destinatarios,
        subject: '⚠️ Sesión de NotebookLM expirada',
        html: `<p>La sesión de NotebookLM ha expirado.</p><p>Las auditorías en cola fallarán hasta que se renueve.</p><p><strong>Acción requerida:</strong> Actualizar <code>SESION_GOOGLE</code> en Railway.</p><p><small>${new Date().toISOString()}</small></p>`
      })
    });
    if (!res.ok) throw new Error(await res.text());
    console.log(`   📧 Alerta enviada a: ${destinatarios.join(', ')}`);
  } catch (err) {
    console.error('   ❌ Error enviando alerta:', err.message);
  }
}

// ── Arrancar servidor ────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n⚙️  ACL Worker corriendo en puerto ${PORT}`);
  console.log(`   Listo para recibir auditorías\n`);
});