const express = require('express');
const app = express();

app.use(express.json({ limit: '50mb' }));

// Clave secreta para que solo Netlify pueda llamar a este worker
const WORKER_SECRET = process.env.WORKER_SECRET;

// Ruta de salud — Railway la usa para saber si el servidor está vivo
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Ruta principal — recibe el pedido de procesar una auditoría
app.post('/procesar', async (req, res) => {
  // Verificar que la llamada viene de Netlify (seguridad básica)
  const authHeader = req.headers['x-worker-secret'];
  if (authHeader !== WORKER_SECRET) {
    console.log('⛔ Intento de acceso no autorizado');
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { auditoria_id, ciudadano_email, pdf_drive_id } = req.body;

  if (!auditoria_id || !ciudadano_email || !pdf_drive_id) {
    return res.status(400).json({ error: 'Faltan datos requeridos' });
  }

  // Responder inmediatamente — no hacemos esperar a Netlify
  res.json({ 
    mensaje: 'Auditoría recibida, procesando en segundo plano',
    auditoria_id 
  });

  // A partir de aquí, el proceso corre solo (sin que nadie espere la respuesta)
  procesarAuditoria(auditoria_id, ciudadano_email, pdf_drive_id);
});

// Función principal — aquí irá todo el trabajo pesado
async function procesarAuditoria(auditoria_id, ciudadano_email, pdf_drive_id) {
  console.log(`\n🚀 [${auditoria_id}] Iniciando procesamiento`);
  console.log(`   Email: ${ciudadano_email}`);
  console.log(`   PDF Drive ID: ${pdf_drive_id}`);

  try {
    // PASO 1 (próxima sesión): Descargar PDF de Drive
    console.log(`📥 [${auditoria_id}] PASO 1: Descargando PDF de Drive...`);
    // await descargarPDF(pdf_drive_id);

    // PASO 2 (próxima sesión): Claude analiza y genera reporte
    console.log(`🧠 [${auditoria_id}] PASO 2: Analizando con Claude...`);
    // await analizarConClaude(auditoria_id, pdf_drive_id);

    // PASO 3 (próxima sesión): NotebookLM genera los 3 paquetes
    console.log(`🎙️ [${auditoria_id}] PASO 3: Generando paquetes en NotebookLM...`);
    // await ejecutarPlaywright(auditoria_id);

    // PASO 4 (próxima sesión): Subir todo a Drive
    console.log(`☁️ [${auditoria_id}] PASO 4: Subiendo archivos a Drive...`);
    // await subirADrive(auditoria_id);

    // PASO 5 (próxima sesión): Actualizar BD y enviar email
    console.log(`✉️ [${auditoria_id}] PASO 5: Notificando al ciudadano...`);
    // await notificarCiudadano(auditoria_id, ciudadano_email);

    console.log(`✅ [${auditoria_id}] Procesamiento simulado completado`);

  } catch (error) {
    console.error(`❌ [${auditoria_id}] Error en el procesamiento:`, error.message);
    // Aquí irá la lógica de actualizar BD con estado "error"
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n⚙️  ACL Worker corriendo en puerto ${PORT}`);
  console.log(`   Listo para recibir auditorías\n`);
});