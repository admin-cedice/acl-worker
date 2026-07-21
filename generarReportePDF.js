// generarReportePDF.js — ACL Worker v4.0
// Genera el reporte de auditoría en HTML y lo convierte a PDF con CloudConvert
// Umbusk LLC · Auditoría Cívica Liberal
//
// CAMBIOS v2-v3.1 (jun-jul 2026): ver versiones anteriores del archivo en el
// historial. Resumen: resumen ejecutivo por Claude, detección de criterios
// en tabla markdown, Manual/Ficha reordenados, indicador general
// reemplazado por puntos clave, fondo crema de borde a borde, salto de
// página solo antes de la primera categoría, leyenda SÍ/SÍ*/NO, cuadro
// resumen por categoría, fix del párrafo de cierre pegado al último
// criterio ("la coletilla", v3.1), fix de niveles de riesgo (4 niveles
// reales: Bajo/Moderado/Alto/Crítico — "MUY ALTO" nunca existió).
//
// CAMBIOS v3.5 (16 jul 2026, sesión anterior):
//  37. Eliminado el mecanismo de "la coletilla" (marcador
//      @@CIERRE_AUDITORIA@@) — falló el 100% de las corridas reales
//      observadas. Ya no hacía falta: solo "Resultado por criterio" se
//      usaba realmente en el código.
//
// CAMBIOS v4.0 (16 jul 2026) — MIGRACIÓN A SALIDA ESTRUCTURADA:
//  38. ELIMINADO POR COMPLETO parsearReporte() y toda la familia de regex
//      que interpretaba texto libre de Claude (matchCat, matchCritTabla,
//      matchCrit, matchResultadoB, normalizarResultadoTabla). Motivo: cada
//      variación de formato que Claude decidía usar (tabla vs. prosa, con o
//      sin "LIBERAL" en "NIVEL DE RIESGO", encabezados con distinto
//      separador) rompía el parser de una forma distinta, y cada arreglo
//      era un parche reactivo sobre el síntoma más reciente, no sobre la
//      causa. La causa real: un modelo de lenguaje generando texto libre
//      nunca garantiza una forma exacta — no es un bug de nuestro código,
//      es una discordancia de arquitectura entre "texto libre" y "regex que
//      asume una forma fija".
//  39. analizarConClaude() (en worker.js) ahora usa la función de
//      Structured Outputs de la API de Claude (output_config.format, GA
//      para claude-sonnet-5, compatible con el pensamiento adaptativo) para
//      forzar que la respuesta sea JSON válido según
//      SCHEMA_ANALISIS_AUDITORIA — exactamente 7 categorías, cada criterio
//      con id/resultado/analisis. reporte_texto en la BD sigue siendo un
//      string de principio a fin, pero ahora ese string es JSON garantizado
//      en vez de markdown/prosa libre.
//  40. normalizarDatosEstructurados() reemplaza a parsearReporte(): ya no
//      "adivina" nada de un texto ambiguo, solo organiza datos que la API
//      ya garantizó válidos (agrega el nombre de cada categoría, cuenta
//      resultados, calcula el puntaje). Un fallo aquí solo puede significar
//      que el JSON no vino con la forma esperada — imposible en auditorías
//      nuevas, posible solo si se intenta reprocesar una auditoría vieja
//      (pre-16-jul-2026) cuyo reporte_texto todavía es markdown; el error
//      lo dice explícitamente en vez de fallar en silencio.
//  41. generarResumenEjecutivo() ya no recibe reporteTexto ni hace
//      reporteTexto.slice(0, 6000) como contexto — arma su propio resumen
//      compacto a partir de los datos ya estructurados
//      (resumirParaPrompt()), sin depender de dónde cae el corte de 6000
//      caracteres en un texto narrativo.
//  42. normalizarResultadoTabla() eliminada — dead code. Ya no hace falta
//      "normalizar" el resultado de un criterio: el schema garantiza que
//      solo puede venir como SI | SI_MATIZ | NO | NA.
//
// Para depurar una auditoría nueva ya no hace falta SUBSTRING a ciegas:
//   SELECT jsonb_array_length(reporte_texto::jsonb -> 'categorias')
//   FROM auditorias WHERE id = '...';
//
//   SELECT jsonb_pretty(reporte_texto::jsonb -> 'categorias' -> 6) -- cat. VII
//   FROM auditorias WHERE id = '...';


// CAMBIOS v4.2 (16 jul 2026):
//  43. FIX: el schema no pedía el campo "pregunta" (enunciado del
//      criterio) — solo id/resultado/analisis. generarHTML() siempre
//      esperó crit.pregunta para mostrarlo junto al código (ej. "C-01:
//      ¿...?"), pero como nunca se pidió, llegaba vacío en todos los
//      reportes generados con el pipeline nuevo. Agregado a
//      SCHEMA_ANALISIS_AUDITORIA como campo required; no hizo falta tocar
//      normalizarDatosEstructurados() ni generarHTML(), porque ambos ya
//      pasaban/leían ese campo — solo faltaba pedírselo a Claude.
//
// CAMBIOS v4.3 (16 jul 2026):
//  44. FIX: en una auditoría real (Ley de Hidrocarburos) Claude anidó
//      C-24/C-25/C-26 bajo la clave "V" en vez de "VI", dejando la
//      Categoría VI vacía — los 28 criterios estaban completos y bien
//      evaluados, solo mal ubicados. El schema garantiza que las 7 claves
//      existan, pero no que Claude clasifique bien cada criterio dentro
//      de ellas (es contenido, no forma). Se agregó CRITERIO_A_CATEGORIA,
//      un mapa fijo id→categoría conocido de antemano;
//      normalizarDatosEstructurados() ahora aplana todos los criterios
//      recibidos e ignora bajo qué clave llegaron, reclasificándolos con
//      ese mapa. Log nuevo: conteo de criterios por categoría en cada
//      corrida, y aviso si el total no da 28.

'use strict';

const fs      = require('fs');
const path    = require('path');
const Anthropic = require('@anthropic-ai/sdk');

// ── Constantes doctrinales ──────────────────────────────────────────────────

const URL_MANUAL = 'https://liberalmente.app/manual-de-liberalismo.pdf';

const CATEGORIAS_NOMBRES = {
  'I':   'Dignidad y Autonomía Individual',
  'II':  'Estado de Derecho e Instituciones',
  'III': 'Propiedad Privada y Libre Empresa',
  'IV':  'Competencia y Rechazo al Rentismo',
  'V':   'Límites al Estado y Subsidiariedad',
  'VI':  'Igualdad de Oportunidades y Política Social',
  'VII': 'Integridad Semántica y Soberanía',
};

// ── Schema de Structured Outputs para analizarConClaude() (worker.js) ───────
// Se define y exporta desde aquí porque este archivo es "el dueño" de la
// forma que debe tener un reporte de auditoría — worker.js solo lo importa
// y lo pasa en output_config.format. Cero campos opcionales a propósito: la
// API limita a 24 parámetros opcionales por request, y este diseño no
// necesita ninguno (todo required = grammar más simple y liviana).

// v4.1 (16 jul 2026): la API rechazó el diseño original con un 400 —
// "For 'array' type, 'minItems' values other than 0 or 1 are not
// supported". El minItems:7/maxItems:7 que usaba para garantizar
// "exactamente 7 categorías" no es una opción real en Structured Outputs.
// Se logra la misma garantía sin arreglos con longitud forzada: en vez de
// un ARREGLO de 7 categorías, "categorias" ahora es un OBJETO con una
// clave fija por cada número romano (I a VII), las 7 marcadas
// "required" — los objetos con propiedades required sí están soportados
// sin restricción de este tipo. normalizarDatosEstructurados() se encarga
// de convertir ese objeto de vuelta a la forma de arreglo que usa
// generarHTML(), así que nada más en el archivo tuvo que cambiar.
const NUMEROS_CATEGORIA = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

// Mapa fijo criterio → categoría, según la estructura real del Test de
// Libertad (28 criterios, 7 categorías: I=5, II=5, III=5, IV=4, V=4, VI=3,
// VII=2). Se usa en normalizarDatosEstructurados() para volver a clasificar
// cada criterio por su propio id, sin confiar en bajo qué clave de
// categoría lo haya anidado Claude — ver v4.3 en el changelog.
const CRITERIO_A_CATEGORIA = (() => {
  const rangos = { I: [1, 5], II: [6, 10], III: [11, 15], IV: [16, 19], V: [20, 23], VI: [24, 26], VII: [27, 28] };
  const mapa = {};
  for (const [num, [desde, hasta]] of Object.entries(rangos)) {
    for (let n = desde; n <= hasta; n++) {
      mapa[`C-${String(n).padStart(2, '0')}`] = num;
    }
  }
  return mapa;
})();

function schemaCriterios() {
  return {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Código del criterio, formato "C-01" a "C-28".',
        },
        pregunta: {
          type: 'string',
          description: 'El enunciado completo y exacto de la pregunta de este criterio, tal como aparece en el Test de Libertad (prompt_analisis). No lo resumas ni lo parafrasees.',
        },
        resultado: {
          type: 'string',
          enum: ['SI', 'SI_MATIZ', 'NO', 'NA'],
          description: 'SI: se cumple plenamente. SI_MATIZ: se cumple con reservas o matices. NO: no se cumple. NA: no aplica a este documento.',
        },
        analisis: {
          type: 'string',
          description: 'De 3 a 5 oraciones en prosa razonada explicando el resultado, citando artículos o elementos concretos del documento cuando aplique.',
        },
        articulos: {
          type: 'string',
          description: 'Números o identificadores de los artículos, secciones o disposiciones del documento en los que se basa este resultado, separados por punto y coma si hay más de uno (ej. "Artículo 12; Artículo 45; Disposición Transitoria Segunda"). Usa exactamente cómo el documento los llama. Cadena vacía solo si el criterio evalúa el documento como un todo y no hay artículos específicos que citar.',
        },
      },
      required: ['id', 'pregunta', 'resultado', 'analisis', 'articulos'],
      additionalProperties: false,
    },
  };
}

function schemaCategoriaUnica() {
  return {
    type: 'object',
    properties: {
      criterios: schemaCriterios(),
    },
    required: ['criterios'],
    additionalProperties: false,
  };
}

const SCHEMA_ANALISIS_AUDITORIA = {
  type: 'object',
  properties: {
    categorias: {
      type: 'object',
      description: 'Las 7 categorías del Test de Libertad — una clave por cada número romano (I a VII), cada una con todos sus criterios evaluados. Las 7 claves son obligatorias.',
      properties: {
        I:   schemaCategoriaUnica(),
        II:  schemaCategoriaUnica(),
        III: schemaCategoriaUnica(),
        IV:  schemaCategoriaUnica(),
        V:   schemaCategoriaUnica(),
        VI:  schemaCategoriaUnica(),
        VII: schemaCategoriaUnica(),
      },
      required: NUMEROS_CATEGORIA,
      additionalProperties: false,
    },
    alertas: {
      type: 'array',
      description: 'Alertas principales del documento. Arreglo vacío si no hay ninguna.',
      items: {
        type: 'object',
        properties: {
          titulo:      { type: 'string' },
          gravedad:    { type: 'string', enum: ['ALTA', 'MODERADA-ALTA', 'MODERADA', 'BAJA'] },
          descripcion: { type: 'string', description: '2 a 4 oraciones describiendo la alerta.' },
          criterios:   { type: 'array', items: { type: 'string' }, description: 'Códigos relacionados, ej. ["C-19","C-08"].' },
        },
        required: ['titulo', 'gravedad', 'descripcion', 'criterios'],
        additionalProperties: false,
      },
    },
  },
  required: ['categorias', 'alertas'],
  additionalProperties: false,
};

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
// vive en la Ficha y en la leyenda de riesgo — ver changelog v3.0.
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

// ── CSS del reporte (sin cambios respecto a v3.1) ────────────────────────────

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

  .alineacion-bloque {
    display: flex;
    align-items: baseline;
    gap: 16px;
    margin-bottom: 14px;
  }
  .alineacion-numero {
    font-family: var(--serif);
    font-weight: 700;
    font-size: 40px;
    color: var(--accent);
    line-height: 1;
  }
  .alineacion-label {
    font-size: 12px;
    color: var(--text-mid);
    max-width: 160px;
    line-height: 1.4;
  }
  .alineacion-desglose {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 4px;
  }
  .alineacion-badge {
    padding: 3px 9px;
    border-radius: 2px;
    font-size: 10.5px;
    font-weight: 700;
    border: 1px solid;
  }
  .alineacion-badge.si       { background: var(--green-soft); color: var(--green); border-color: #A8D5BA; }
  .alineacion-badge.si-matiz { background: var(--gold-soft);  color: var(--gold);  border-color: #D4C080; }
  .alineacion-badge.no       { background: #FEF0F0; color: var(--accent); border-color: #EDAAAA; }
  .alineacion-badge.na       { background: var(--bg); color: var(--text-muted); border-color: var(--border); }

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

// ── Normalizar los datos ya estructurados (reemplaza a parsearReporte) ──────
// Ya no interpreta texto ambiguo: solo organiza un JSON que la API de
// Claude ya garantizó válido según SCHEMA_ANALISIS_AUDITORIA. Si esto
// lanza un error, significa que reporte_texto no es JSON (probablemente
// una auditoría de antes del 16 jul 2026, previa a esta migración).

function normalizarDatosEstructurados(reporteJSON, auditoria_id = 'N/A') {
  let resultado;
  try {
    resultado = typeof reporteJSON === 'string' ? JSON.parse(reporteJSON) : reporteJSON;
  } catch (err) {
    throw new Error(
      `[${auditoria_id}] reporte_texto no es JSON válido — ¿es una auditoría de antes de la ` +
      `migración a salida estructurada (16 jul 2026)? Ese formato ya no es compatible; ` +
      `bórrala con /eliminar-auditoria y reprocésala desde cero. Detalle: ${err.message}`
    );
  }

  // "categorias" llega como objeto { I: {criterios:[...]}, II: {...}, ... }
  // (ver v4.1 en el schema) — se recorre siempre en el mismo orden fijo
  // I→VII y se devuelve como arreglo, que es la forma que espera
  // generarHTML() desde v3.1 y no tuvo que cambiar.
  const categoriasFaltantes = NUMEROS_CATEGORIA.filter(
    num => !resultado.categorias || !resultado.categorias[num]
  );
  if (categoriasFaltantes.length > 0) {
    // Con las 7 claves marcadas "required" en el schema esto no debería
    // poder pasar nunca — si aparece, revisar SCHEMA_ANALISIS_AUDITORIA o
    // la llamada a la API, no un texto mal escrito.
    console.warn(`   ⚠️ [${auditoria_id}] Categorías ausentes en la respuesta: ${categoriasFaltantes.join(', ')}.`);
  }

  // v4.3 (16 jul 2026) — FIX: se detectó en una auditoría real (Ley de
  // Hidrocarburos) que Claude clasificó C-24/C-25/C-26 dentro de la clave
  // "V" en vez de "VI", dejando la Categoría VI vacía. Los 28 criterios
  // estaban completos y bien evaluados — el contenido era correcto — solo
  // la UBICACIÓN estaba mal. El schema (Structured Outputs) garantiza que
  // existan las 7 claves y que cada criterio tenga id/pregunta/resultado/
  // analisis válidos, pero NO puede garantizar que Claude decida bien bajo
  // cuál de las 7 claves anidar cada uno — eso es una decisión de
  // contenido, no de forma. Solución: se ignora por completo bajo qué
  // clave llegó cada criterio. Se aplanan TODOS los criterios recibidos
  // (sin importar su categoría de origen) y se re-clasifican en código
  // usando CRITERIO_A_CATEGORIA, que es fijo y no depende de nada que
  // escriba Claude — mismo principio de toda esta migración, aplicado un
  // nivel más profundo.
  const todosLosCriteriosRecibidos = NUMEROS_CATEGORIA.flatMap(
    num => resultado.categorias?.[num]?.criterios || []
  );

  const criteriosPorCategoria = {};
  NUMEROS_CATEGORIA.forEach(num => { criteriosPorCategoria[num] = []; });

  const sinMapeoConocido = [];
  for (const crit of todosLosCriteriosRecibidos) {
    const categoriaReal = CRITERIO_A_CATEGORIA[crit.id];
    if (!categoriaReal) {
      sinMapeoConocido.push(crit.id);
      continue;
    }
    criteriosPorCategoria[categoriaReal].push(crit);
  }
  if (sinMapeoConocido.length > 0) {
    // Solo puede pasar si Claude inventa un id fuera de C-01..C-28 —
    // no debería ocurrir, pero si pasa, mejor que quede visible en el log
    // a que el criterio desaparezca en silencio.
    console.warn(`   ⚠️ [${auditoria_id}] Criterios con id no reconocido (no mapean a C-01..C-28): ${sinMapeoConocido.join(', ')}`);
  }

  // Orden interno estable dentro de cada categoría, sin importar el orden
  // en que Claude los haya escrito.
  NUMEROS_CATEGORIA.forEach(num => {
    criteriosPorCategoria[num].sort((a, b) => a.id.localeCompare(b.id));
  });

  const categorias = NUMEROS_CATEGORIA.map(num => ({
    num,
    nombre:    CATEGORIAS_NOMBRES[num],
    criterios: criteriosPorCategoria[num],
  }));

  const todos    = categorias.flatMap(c => c.criterios);
  const siPlenos = todos.filter(c => c.resultado === 'SI').length;
  const siMatiz  = todos.filter(c => c.resultado === 'SI_MATIZ').length;
  const noCount  = todos.filter(c => c.resultado === 'NO').length;
  const naCount  = todos.filter(c => c.resultado === 'NA').length;

  console.log(`\n   ╔══════════════════════════════════════════════════`);
  console.log(`   ║ DIAGNÓSTICO [${auditoria_id}] (salida estructurada)`);
  console.log(`   ╠══════════════════════════════════════════════════`);
  console.log(`   ║ Categorías : ${categorias.length} (se esperan 7)`);
  console.log(`   ║ Criterios  : ${todos.length} (se esperan 28)`);
  if (todos.length !== 28) {
    console.warn(`   ⚠️ [${auditoria_id}] Se esperaban 28 criterios en total, llegaron ${todos.length}.`);
  }
  categorias.forEach(cat => console.log(`   ║   Cat. ${cat.num.padEnd(3)}: ${cat.criterios.length} criterios`));
  console.log(`   ╠──────────────────────────────────────────────────`);
  console.log(`   ║ SÍ plenos  : ${siPlenos}`);
  console.log(`   ║ SÍ con *   : ${siMatiz}`);
  console.log(`   ║ NO         : ${noCount}`);
  console.log(`   ║ N/A        : ${naCount}`);
  console.log(`   ╠──────────────────────────────────────────────────`);
  console.log(`   ║ Alertas    : ${(resultado.alertas || []).length}`);
  console.log(`   ╚══════════════════════════════════════════════════\n`);

  // PONDERACIÓN DEL PUNTAJE (20 jul 2026) — decisión de Moisés: un SÍ con
  // matiz ya no vale cero en el numerador. Antes solo restaba terreno (contaba
  // en "aplicables" pero no sumaba nada), lo cual castigaba con dureza a un
  // documento que avanza parcialmente en un criterio. Ahora cada SÍ con matiz
  // aporta medio punto de un SÍ pleno — el divisor (aplicables) no cambia,
  // solo el numerador. La condición para mostrar puntaje en absoluto (que
  // haya al menos un SÍ pleno) tampoco cambia — eso es una decisión aparte,
  // no se tocó.
  const aplicables = siPlenos + siMatiz + noCount;
  const puntaje = (aplicables > 0 && siPlenos > 0)
    ? Math.round(((siPlenos + siMatiz * 0.5) / aplicables) * 100)
    : null;

  return {
    puntaje, siPlenos, siMatiz, noCount, naCount,
    resumenEjecutivo: '', puntosClave: [],
    categorias,
    alertas: resultado.alertas || [],
  };
}

// Arma un texto compacto y limpio a partir de los datos ya estructurados,
// para usar como contexto en el llamado de generarResumenEjecutivo(). Ya no
// depende de reporteTexto.slice(0, 6000) — ese corte podía caer a mitad de
// un criterio en un texto narrativo largo.
function resumirParaPrompt(datos) {
  return datos.categorias.map(cat =>
    `CATEGORÍA ${cat.num} — ${cat.nombre}\n` +
    cat.criterios.map(c => `${c.id} [${c.resultado}]: ${c.analisis}`).join('\n')
  ).join('\n\n');
}

// ── Generar resumen ejecutivo + puntos clave con Claude ──────────────────────
// v3.0: formato de texto plano con marcadores, NO JSON — un texto largo con
// saltos de línea dentro de un string JSON es frágil. Esto sigue siendo
// válido en v4.0: aquí SÍ queremos que Claude escriba prosa libre (es un
// resumen para humanos, no datos para parsear), así que no tiene sentido
// forzarlo con Structured Outputs — el problema de fondo que resolvimos hoy
// era específico de los 28 criterios estructurados, no de este texto.

async function generarResumenEjecutivo(datos, metadatos) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const { puntaje, siPlenos, siMatiz, noCount, naCount, alertas } = datos;
  const totalCriterios = datos.categorias.reduce((acc, c) => acc + c.criterios.length, 0);
  const { titulo, pais, fecha } = metadatos;

  const prompt = `Eres el redactor institucional de la plataforma Auditoría Cívica Liberal (liberalmente.app), operada por CEDICE y la Fundación Friedrich Naumann. Tu tarea es escribir el RESUMEN EJECUTIVO y los PUNTOS CLAVE del reporte de auditoría de un documento jurídico o de política pública venezolana/latinoamericana.

DATOS DEL ANÁLISIS:
- Documento auditado: ${titulo}${pais ? ` (${pais})` : ''}${fecha ? `, ${fecha}` : ''}
- Alineación con postulados liberales: ${puntaje !== null ? puntaje + '%' : 'sin total general — ningún criterio con SÍ pleno; ver desglose SÍ/SÍ con matiz/NO'}
- Criterios evaluados: ${totalCriterios} (${siPlenos} SÍ plenos, ${siMatiz} SÍ con reserva, ${noCount} NO, ${naCount} N/A)
${alertas.length > 0 ? `- Alertas principales: ${alertas.map(a => a.titulo).join('; ')}` : ''}

ANÁLISIS COMPLETO POR CRITERIO (del cual debes extraer las ideas más importantes):
${resumirParaPrompt(datos).slice(0, 6000)}

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
  Párrafo 3 (2-3 oraciones): valoración final de la alineación con los postulados liberales y recomendación al ciudadano.
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
    let resumen = puntaje !== null
      ? `El documento obtuvo un ${puntaje}% de alineación con los postulados liberales. `
      : `El documento no registró ningún criterio con SÍ pleno, por lo que no se calcula un total general de alineación liberal. `;
    resumen += `De ${aplicables} criterios aplicables: ${totalSI} SÍ (${siPlenos} plenos, ${siMatiz} con reserva)`;
    if (noCount > 0) resumen += `, ${noCount} NO`;
    if (naCount > 0) resumen += `, ${naCount} N/A`;
    resumen += `.`;
    if (alertas.length > 0) resumen += ` Alerta principal: ${alertas[0].titulo}.`;
    return { puntosClave: [], resumen };
  }
}

// ── Generar HTML ─────────────────────────────────────────────────────────────
// Sin cambios respecto a v3.1 — consume la misma forma de "datos" que
// devolvía parsearReporte(), y normalizarDatosEstructurados() la respeta a
// propósito para no tener que tocar nada de esto.

function generarHTML(datos, metadatos) {
  const {
    puntaje: puntajeRaw,
    siPlenos         = 0,
    siMatiz          = 0,
    noCount          = 0,
    naCount          = 0,
    resumenEjecutivo = '',
    puntosClave      = [],
    categorias       = [],
    alertas          = [],
  } = datos;

  const puntaje = puntajeRaw; // puede ser null — se maneja en la Ficha, no se fuerza a 0

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

  // v3.4: reemplaza la leyenda de 4 niveles de riesgo por el número de
  // alineación (o solo el desglose si no hay ningún SÍ pleno). El link al
  // Manual sigue siendo fijo (no depende de la frase "efecto comadreja").
  const htmlAlineacion = criteriosDetectados ? `
<div class="alineacion-bloque">
  ${puntaje !== null ? `
  <span class="alineacion-numero">${puntaje}%</span>
  <span class="alineacion-label">de alineación con postulados liberales</span>` : ''}
</div>
<div class="alineacion-desglose">
  <span class="alineacion-badge si">${siPlenos} SÍ</span>
  <span class="alineacion-badge si-matiz">${siMatiz} SÍ*</span>
  <span class="alineacion-badge no">${noCount} NO</span>
  <span class="alineacion-badge na">${naCount} N/A</span>
</div>
<div class="nota-final-texto" style="margin-top:10px;">Consulta el <a href="${URL_MANUAL}" class="nota-doctrinal">Manual de Liberalismo completo</a> para el marco doctrinal detrás de este Test.</div>` : '';

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
  ${htmlAlineacion}
  <table class="resumen-categorias-tabla resumen-categorias-tabla--compacta">
    <thead>
      <tr><th>Categoría</th><th>SÍ</th><th>SÍ*</th><th>NO</th><th>N/A</th><th>Total</th></tr>
    </thead>
    <tbody>${filasTabla}</tbody>
    <tfoot>${filaTotalTabla}</tfoot>
  </table>
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
      <span class="criterio-pregunta">${esc(crit.pregunta || '')}</span>
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
        ${puntaje !== null ? `${puntaje}% de alineación con postulados liberales` : 'Sin total general'}${desgloseFicha}
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
// Sin cambios respecto a v3.1.

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

async function generarReportePDF(reporteJSON, metadatos, rutaSalida, auditoria_id) {
  console.log(`\n   ▶ [${auditoria_id}] INICIO generarReportePDF v4.0 (salida estructurada)`);

  console.log(`   [${auditoria_id}] Paso 1: Normalizando datos estructurados...`);
  const datos = normalizarDatosEstructurados(reporteJSON, auditoria_id);

  console.log(`   [${auditoria_id}] Paso 2: Generando resumen ejecutivo y puntos clave con Claude...`);
  const { puntosClave, resumen } = await generarResumenEjecutivo(datos, metadatos);
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
  normalizarDatosEstructurados,
  generarHTML,
  registrarRutaHTMLTemporal,
  SCHEMA_ANALISIS_AUDITORIA,
};