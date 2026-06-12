// testPodcast.js — ACL Worker — PRUEBA AISLADA
// Genera el fragmento de 2 minutos (Reforma a la Ley de Hidrocarburos)
// usando ElevenLabs (eleven_v3) con dos voces, y concatena con ffmpeg.
// No toca el flujo de /procesar ni NotebookLM — es un endpoint independiente.

'use strict';

const fs     = require('fs');
const path   = require('path');
const ffmpeg = require('fluent-ffmpeg');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_BASE    = 'https://api.elevenlabs.io/v1';

// Voces de la prueba
const VOZ_PRESENTADOR = 'haaEg4BqiAAwDT7ahTxl'; // Roderick
const VOZ_EXPERTA     = '9cySrnzVAcRAUGO8JQtx'; // Janet Morales

// ── El guion de prueba, dividido en turnos ───────────────────────────────────
// Cada turno = una llamada a la API (una sola voz por llamada)

const GUION = [
  { voz: VOZ_PRESENTADOR, texto: '[warmly] Bienvenidos a otro Audio Overview de Auditoría Cívica Liberal. Hoy tenemos sobre la mesa la Reforma a la Ley de Hidrocarburos. [curious] Y la primera pregunta que me surge es... ¿por qué una ley de hidrocarburos termina siendo un tema de libertad?' },
  { voz: VOZ_EXPERTA,     texto: '[thoughtful] Es una excelente pregunta, y honestamente es el corazón de todo el análisis. [pause] Cuando el Estado controla un sector entero de la economía —como ha pasado históricamente con el petróleo en Venezuela— no es solo una decisión técnica. Es una decisión sobre quién tiene poder.' },
  { voz: VOZ_PRESENTADOR, texto: '[surprised] ¿Poder en qué sentido?' },
  { voz: VOZ_EXPERTA,     texto: '[explaining] Piénsalo así: si el Estado es dueño del recurso más rentable del país, automáticamente se vuelve el actor económico más poderoso. [slightly skeptical] Y eso tiende a generar algo que el Manual Cívico Liberal llama "rentismo" — donde el éxito económico depende de tu cercanía al poder político, no de competir bien en el mercado.' },
  { voz: VOZ_PRESENTADOR, texto: '[getting it] Ah, ya veo. Entonces cuando esta reforma abre el sector a participación privada...' },
  { voz: VOZ_EXPERTA,     texto: '[nodding tone] Exacto. [pause] La pregunta del Test de Libertad no es "¿es bueno o malo el petróleo estatal?" — es más específica: ¿la reforma reduce ese rentismo, o lo reemplaza por una versión privada del mismo problema?' },
  { voz: VOZ_PRESENTADOR, texto: '[intrigued] ¿Y eso pasa?' },
  { voz: VOZ_EXPERTA,     texto: '[carefully] Aquí está lo interesante del documento... [excited] porque sí abre la puerta a privatización, pero —y esto es importante— no especifica con suficiente detalle los mecanismos de licitación.' },
  { voz: VOZ_PRESENTADOR, texto: '[concerned] O sea, que el riesgo no es "privado versus estatal"...' },
  { voz: VOZ_EXPERTA,     texto: '[firmly] El riesgo es la opacidad. [pause] Da igual si el comprador es del Estado o un privado: si el proceso para asignar esos activos no es transparente, terminas con los mismos oligopolios de siempre, solo que ahora con otro nombre en la puerta.' },
  { voz: VOZ_PRESENTADOR, texto: '[laughs softly] Qué manera tan clara de explicarlo. [warmly] Vamos a profundizar en esto después de una breve pausa...' },
];

// ── Generar un segmento de audio con ElevenLabs ──────────────────────────────

async function generarSegmento(voiceId, texto, rutaSalida) {
  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key':   ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      'Accept':       'audio/mpeg',
    },
    body: JSON.stringify({
      text:     texto,
      model_id: 'eleven_v3',
    }),
  });

  if (!res.ok) {
    const errorTexto = await res.text();
    throw new Error(`ElevenLabs error ${res.status}: ${errorTexto}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(rutaSalida, buffer);
  return rutaSalida;
}

// ── Concatenar segmentos con ffmpeg ──────────────────────────────────────────

async function concatenarSegmentos(rutasSegmentos, rutaSalida, dir) {
  // ffmpeg concat demuxer necesita un archivo de texto con la lista
  const rutaLista = path.join(dir, 'lista.txt');
  const contenidoLista = rutasSegmentos
    .map(r => `file '${path.basename(r)}'`)
    .join('\n');
  fs.writeFileSync(rutaLista, contenidoLista, 'utf8');

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(rutaLista)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy'])
      .output(rutaSalida)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// ── Función principal ─────────────────────────────────────────────────────────

async function generarPodcastPrueba(dirTemp) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('Falta la variable de entorno ELEVENLABS_API_KEY');
  }

  fs.mkdirSync(dirTemp, { recursive: true });
  const rutasSegmentos = [];

  console.log(`🎙️  Generando ${GUION.length} segmentos con ElevenLabs (eleven_v3)...`);
  for (let i = 0; i < GUION.length; i++) {
    const { voz, texto } = GUION[i];
    const nombreArchivo = `segmento_${String(i + 1).padStart(2, '0')}.mp3`;
    const ruta = path.join(dirTemp, nombreArchivo);
    console.log(`   [${i + 1}/${GUION.length}] Voz ${voz === VOZ_PRESENTADOR ? 'Presentador' : 'Experta'}...`);
    await generarSegmento(voz, texto, ruta);
    rutasSegmentos.push(ruta);
  }

  console.log(`🔗 Concatenando ${rutasSegmentos.length} segmentos...`);
  const rutaFinal = path.join(dirTemp, 'podcast-prueba.mp3');
  await concatenarSegmentos(rutasSegmentos, rutaFinal, dirTemp);

  console.log(`✅ Podcast de prueba generado: ${rutaFinal}`);
  return rutaFinal;
}

module.exports = { generarPodcastPrueba };