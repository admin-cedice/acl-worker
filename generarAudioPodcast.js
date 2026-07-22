// generarAudioPodcast.js — ACL Worker
// Umbusk LLC · Auditoría Cívica Liberal
//
// MÓDULO NUEVO (18 jul 2026) — convierte el guion a dos voces (ya generado
// y revisado por generarGuionPresentacion.js) en un mp3 real, usando la
// API de ElevenLabs. NO conectado a procesarAuditoria() todavía — mismo
// criterio que generarGuionPresentacion.js: se prueba aislado primero.
//
// Decisión técnica clave: se usa el endpoint /v1/text-to-dialogue (diseñado
// específicamente para diálogos multi-voz), no el clásico
// /v1/text-to-speech/{voice_id} de una sola voz llamado en bucle. Las
// etiquetas de emoción ([seria], [curioso], [pausa]) van dentro del texto
// de cada parlamento — eleven_v3 las interpreta directo, no son un
// parámetro aparte.
//
// Límite real de la API: máximo ~2.000 caracteres de texto por request,
// sumando todos los parlamentos de esa llamada. Los guiones reales miden
// 4.500-6.500 caracteres, así que se parten en lotes — el corte siempre
// cae entre un parlamento y el siguiente, nunca a mitad de una línea.
//
// CORTINA (18 jul 2026) — 4 piezas en el mp3 final, en orden:
//   1. Cortina FIJA (texto aprobado, se genera UNA sola vez con
//      /generar-pieza-fija?pieza=intro en worker.js, se guarda en
//      assets/cortina-fija.mp3 y se reutiliza siempre — regenerarla en
//      cada podcast desperdiciaría caracteres del plan en algo que nunca
//      cambia).
//   2. Frase DINÁMICA (nombra el documento, se genera en cada corrida,
//      voz de Anita).
//   3. El guion (generado por generarGuionPresentacion.js, en lotes).
//   4. Cierre FIJO (invitación a compartir, mismo criterio que la pieza 1
//      — se genera una sola vez, assets/cierre-fijo.mp3).
//
// PAUSAS (18 jul 2026) — un clip de silencio entre cada pieza de la
// cortina, generado localmente con ffmpeg (filtro anullsrc) — no cuesta
// caracteres de ElevenLabs, no es voz, es silencio puro. Se genera una
// vez por corrida y se reutiliza en cada punto de unión. Sin pausas entre
// los lotes del guion en sí (eso sería un corte técnico de la API, no una
// pausa narrativa — insertar silencio ahí se sentiría más artificial, no
// menos).

'use strict';

const fs      = require('fs');
const path    = require('path');
const ffmpeg  = require('fluent-ffmpeg');

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-dialogue';
const MAX_CHARS_POR_LOTE = 1800; // colchón de seguridad bajo el límite real (~2000)
const DURACION_PAUSA_DEFECTO = 0.8; // segundos

// Voces vigentes desde el 22 jul 2026 — reemplazan a las anteriores
// (activas desde el 20 jul). Los PERSONAJES siguen siendo los mismos
// (Anita = analista, Erick = ciudadano curioso; el guion sigue etiquetando
// sus líneas como "ANITA:"/"ERICK:" — ver parsearGuionADialogo() abajo,
// sin cambios) — lo único que cambia es qué voz de ElevenLabs interpreta
// cada rol: Katy interpreta a Anita, Frank interpreta a Erick.
const VOZ_ID = {
  ANITA: 'EYBbN7OENxAX5QX56IiW', // Anita — analista (voz: Katy)
  ERICK: '7UB6WMKyZDj19XRGC8Sb', // Erick — ciudadano curioso (voz: Frank)
};

// Textos de las 2 piezas fijas de la cortina, aprobados el 18 jul 2026.
const TEXTO_CORTINA_FIJA = '¡Esto es Liberalmente! Este audio es para ayudar a entender mejor los efectos reales de lo auditado con base en criterios de liberalismo popular.';
const TEXTO_CIERRE_FIJO  = 'Si te gusta, compártelo junto con el reporte de auditoría en liberalmente.app.';

// Rutas por defecto de las piezas fijas ya generadas — relativas a este
// archivo, para que no dependan de dónde se ejecute el proceso.
const RUTA_CORTINA_FIJA_DEFECTO = path.join(__dirname, 'assets', 'cortina-fija.mp3');
const RUTA_CIERRE_FIJO_DEFECTO  = path.join(__dirname, 'assets', 'cierre-fijo.mp3');

// ── Paso 1: parsear el guion (formato "ANITA: [emoción] texto") ─────────────
// Mismo formato de salida que ya produce generarGuionPresentacion.js — no
// hace falta tocar ese módulo, este solo lo consume.

function parsearGuionADialogo(guionTexto) {
  const lineas = guionTexto.split('\n').map(l => l.trim()).filter(Boolean);
  const parlamentos = [];

  for (const linea of lineas) {
    const match = linea.match(/^(ANITA|ERICK):\s*(.+)$/i);
    if (!match) continue; // ignora líneas vacías o que no siguen el formato
    const hablante = match[1].toUpperCase();
    const texto = match[2].trim();
    const voice_id = VOZ_ID[hablante];
    if (!voice_id || !texto) continue;
    parlamentos.push({ voice_id, text: texto });
  }

  if (parlamentos.length === 0) {
    throw new Error('parsearGuionADialogo: no se reconoció ningún parlamento — ¿el guion sigue el formato "ANITA:"/"ERICK:"?');
  }
  return parlamentos;
}

// ── Paso 2: agrupar en lotes que no excedan el límite de caracteres ─────────

function agruparEnLotes(parlamentos, maxChars = MAX_CHARS_POR_LOTE) {
  const lotes = [];
  let loteActual = [];
  let charsLoteActual = 0;

  for (const p of parlamentos) {
    const largoParlamento = p.text.length;
    if (charsLoteActual + largoParlamento > maxChars && loteActual.length > 0) {
      lotes.push(loteActual);
      loteActual = [];
      charsLoteActual = 0;
    }
    loteActual.push(p);
    charsLoteActual += largoParlamento;
  }
  if (loteActual.length > 0) lotes.push(loteActual);

  return lotes;
}

// ── Paso 3: llamar a la API por cada lote ────────────────────────────────────

async function generarAudioLote(lote, auditoria_id, etiqueta) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('Falta la variable de entorno ELEVENLABS_API_KEY');

  const response = await fetch(ELEVENLABS_API_URL, {
    method: 'POST',
    headers: {
      'xi-api-key':   apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs:   lote,
      model_id: 'eleven_v3',
    }),
  });

  if (!response.ok) {
    const detalle = await response.text();
    throw new Error(`ElevenLabs /text-to-dialogue error ${response.status} (lote ${etiqueta}): ${detalle}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`   [generarAudioLote] [${auditoria_id}] Lote ${etiqueta}: ${lote.length} parlamentos, ${Math.round(buffer.length / 1024)} KB`);
  return buffer;
}

// ── Paso 3.5: generar un clip de silencio local (sin tocar ElevenLabs) ──────
// Usa el filtro virtual "anullsrc" de ffmpeg — genera silencio puro, no
// cuesta ningún carácter del plan porque no pasa por la API de voz.

function generarSilencioMp3(duracionSegundos, rutaSalida) {
  return new Promise((resolve, reject) => {
    ffmpeg('anullsrc=r=44100:cl=stereo')
      .inputFormat('lavfi')
      .duration(duracionSegundos)
      .audioCodec('libmp3lame')
      .on('error', reject)
      .on('end', resolve)
      .save(rutaSalida);
  });
}

// Acepta "70" (segundos) o "1:10" (mm:ss) o "1:02:30" (hh:mm:ss) y devuelve
// siempre segundos totales — para que en la URL del endpoint se pueda
// escribir el tiempo tal como se ve en el reproductor de Pixabay, sin
// tener que calcular segundos a mano.
function parsearTiempoASegundos(valor) {
  if (valor === undefined || valor === null || valor === '') return 0;
  const texto = String(valor).trim();
  if (/^\d+(\.\d+)?$/.test(texto)) return parseFloat(texto);
  const partes = texto.split(':').map(Number);
  if (partes.some(isNaN)) return 0;
  if (partes.length === 2) return partes[0] * 60 + partes[1];
  if (partes.length === 3) return partes[0] * 3600 + partes[1] * 60 + partes[2];
  return 0;
}

// ── Paso 3.6: mezclar una pieza de voz con música de fondo (opcional) ───────
// Pensado para las 2 piezas FIJAS (cortina, cierre) — se mezcla una sola
// vez, no en cada podcast. La música se recorta a la duración exacta de
// la voz (nunca al revés), con fade-in/fade-out para que no entre ni
// salga de golpe, y su volumen se reduce fuerte (12% por defecto) para
// que la voz se siga escuchando clara por encima.

function agregarFondoMusical(rutaVoz, rutaMusica, rutaSalida, opciones = {}) {
  const {
    volumenMusica          = 0.12,
    duracionFadeSegundos   = 1,
    inicioSegundos         = 0,
    silencioAntesSegundos  = 2.5, // música sola antes de que entre la voz
    silencioDespuesSegundos = 2.5, // música sola después de que termina la voz
  } = opciones;
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(rutaVoz, (err, metadata) => {
      if (err) return reject(err);
      const duracionVoz   = metadata.format.duration;
      const duracionTotal = silencioAntesSegundos + duracionVoz + silencioDespuesSegundos;
      const inicioFadeOut = Math.max(0, duracionTotal - duracionFadeSegundos);
      const finRecorte    = inicioSegundos + duracionTotal;
      const retrasoMs     = Math.round(silencioAntesSegundos * 1000);

      ffmpeg()
        .input(rutaVoz)
        .input(rutaMusica)
        .complexFilter([
          // La música se recorta a la duración TOTAL (colchón + voz + colchón),
          // no solo a la duración de la voz como antes.
          `[1:a]atrim=${inicioSegundos}:${finRecorte},asetpts=PTS-STARTPTS,volume=${volumenMusica},afade=t=in:st=0:d=${duracionFadeSegundos},afade=t=out:st=${inicioFadeOut}:d=${duracionFadeSegundos}[musica]`,
          // La voz se retrasa (adelay) para que entre después del colchón inicial.
          `[0:a]adelay=${retrasoMs}|${retrasoMs}:all=1[voz]`,
          // duration=longest (no "first") — ahora la música es más larga que la
          // voz a propósito, y no queremos que se corte al terminar la voz.
          `[voz][musica]amix=inputs=2:duration=longest:dropout_transition=0[salida]`,
        ], 'salida')
        .audioCodec('libmp3lame')
        .on('error', reject)
        .on('end', () => resolve(rutaSalida))
        .save(rutaSalida);
    });
  });
}

// ── Paso 4: ensamblar todos los segmentos (+ cortina) en un mp3 final ───────

function concatenarMp3(rutasEnOrden, rutaSalida) {
  return new Promise((resolve, reject) => {
    const comando = ffmpeg();
    rutasEnOrden.forEach(ruta => comando.input(ruta));
    comando
      .on('error', reject)
      .on('end', resolve)
      .mergeToFile(rutaSalida, path.dirname(rutaSalida));
  });
}

// ── Función principal exportada ──────────────────────────────────────────────
// guionTexto: el guion ya revisado (resultado.guionFinal de generarYRevisarGuion)
// opciones.fraseDinamica: texto corto con el nombre del documento (se sintetiza con la voz de Anita)
// opciones.rutaCortinaFija / opciones.rutaCierreFijo: por defecto, las rutas de assets/ —
//   pásalas explícitamente solo si quieres usar otro archivo. Si el archivo por defecto
//   todavía no existe (piezas fijas no generadas todavía), se omite esa pieza (y su
//   pausa asociada) con un aviso en consola, en vez de fallar todo el podcast.
// opciones.duracionPausaSegundos: por defecto 0.8s entre cada pieza de la cortina.
//
// Orden final: [cortina fija] [pausa] [frase dinámica] [pausa] [guion, en lotes] [pausa] [cierre fijo]

async function generarPodcastMp3(guionTexto, rutaSalida, auditoria_id, opciones = {}) {
  const {
    fraseDinamica         = null,
    rutaCortinaFija       = RUTA_CORTINA_FIJA_DEFECTO,
    rutaCierreFijo        = RUTA_CIERRE_FIJO_DEFECTO,
    duracionPausaSegundos = DURACION_PAUSA_DEFECTO,
  } = opciones;
  const dirTemp = path.dirname(rutaSalida);
  const rutasParaConcatenar = [];

  console.log(`   [generarPodcastMp3] [${auditoria_id}] Generando clip de pausa (${duracionPausaSegundos}s, local, sin costo de API)...`);
  const rutaPausa = path.join(dirTemp, 'pausa.mp3');
  await generarSilencioMp3(duracionPausaSegundos, rutaPausa);

  const cortinaFijaExiste = fs.existsSync(rutaCortinaFija);
  if (cortinaFijaExiste) {
    rutasParaConcatenar.push(rutaCortinaFija);
  } else {
    console.warn(`   [generarPodcastMp3] [${auditoria_id}] ⚠️ No se encontró la cortina fija en ${rutaCortinaFija} — se omite. Generarla con /generar-pieza-fija?pieza=intro`);
  }

  if (fraseDinamica) {
    if (cortinaFijaExiste) rutasParaConcatenar.push(rutaPausa);

    console.log(`   [generarPodcastMp3] [${auditoria_id}] Generando frase dinámica de cortina...`);
    const bufferFrase = await generarAudioLote(
      [{ voice_id: VOZ_ID.ANITA, text: fraseDinamica }],
      auditoria_id,
      'cortina-dinamica'
    );
    const rutaFrase = path.join(dirTemp, 'cortina-dinamica.mp3');
    fs.writeFileSync(rutaFrase, bufferFrase);
    rutasParaConcatenar.push(rutaFrase);
  }

  // Pausa antes de entrar al cuerpo del guion, si hubo algo de cortina antes.
  if (cortinaFijaExiste || fraseDinamica) {
    rutasParaConcatenar.push(rutaPausa);
  }

  const parlamentos = parsearGuionADialogo(guionTexto);
  const lotes = agruparEnLotes(parlamentos);
  console.log(`   [generarPodcastMp3] [${auditoria_id}] ${parlamentos.length} parlamentos en ${lotes.length} lote(s)`);

  for (let i = 0; i < lotes.length; i++) {
    const buffer = await generarAudioLote(lotes[i], auditoria_id, i + 1);
    const rutaLote = path.join(dirTemp, `lote-${i + 1}.mp3`);
    fs.writeFileSync(rutaLote, buffer);
    rutasParaConcatenar.push(rutaLote);
  }

  if (fs.existsSync(rutaCierreFijo)) {
    rutasParaConcatenar.push(rutaPausa);
    rutasParaConcatenar.push(rutaCierreFijo);
  } else {
    console.warn(`   [generarPodcastMp3] [${auditoria_id}] ⚠️ No se encontró el cierre fijo en ${rutaCierreFijo} — se omite. Generarlo con /generar-pieza-fija?pieza=cierre`);
  }

  console.log(`   [generarPodcastMp3] [${auditoria_id}] Concatenando ${rutasParaConcatenar.length} segmento(s) con ffmpeg...`);
  await concatenarMp3(rutasParaConcatenar, rutaSalida);
  console.log(`   [generarPodcastMp3] [${auditoria_id}] ✅ Podcast generado: ${rutaSalida}`);

  return rutaSalida;
}

module.exports = {
  parsearGuionADialogo,
  agruparEnLotes,
  generarAudioLote,
  generarSilencioMp3,
  agregarFondoMusical,
  parsearTiempoASegundos,
  concatenarMp3,
  generarPodcastMp3,
  VOZ_ID,
  TEXTO_CORTINA_FIJA,
  TEXTO_CIERRE_FIJO,
  RUTA_CORTINA_FIJA_DEFECTO,
  RUTA_CIERRE_FIJO_DEFECTO,
};