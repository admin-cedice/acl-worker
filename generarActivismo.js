// generarActivismo.js — ACL Worker
// Umbusk LLC · Auditoría Cívica Liberal
//
// Módulo nuevo (21 jul 2026), mismo patrón aislado que generarAudioPodcast.js
// y generarGuionPresentacion.js: se prueba solo antes de conectarse al
// pipeline real. Contiene la lógica de la sección de Activismo de la
// Presentación — la última pieza antes de que la Presentación v2 quede
// completa.
//
// Estructura acordada con Moisés (21 jul 2026):
//   - Se calcula el % de "alineación" = (neutral + a_favor) / total,
//     usando el mismo resumenHorizontes POR IMPACTOS que ya usa la
//     portada (calcularResumenHorizontes() en generarDatosGrafo.js) — NO
//     el puntaje del Reporte, que se calcula distinto (por criterio, no
//     por artículo). Decisión explícita: los dos números pueden no
//     coincidir y no queremos dos veredictos distintos para el mismo
//     documento entre el Reporte y la Presentación.
//   - < 20% de alineación: RECHAZO TOTAL al instrumento como un todo.
//     Sin listado de artículos — una sola lámina con recomendaciones de
//     rechazo (Gene Sharp).
//   - > 80% de alineación: PROMOCIÓN TOTAL al instrumento como un todo.
//     Sin listado de artículos — una sola lámina con recomendaciones de
//     promoción.
//   - Entre 20% y 80% ("banda 80/20"): HÍBRIDO — 3 láminas, una por
//     horizonte (rechazo / mejora / promoción), cada una con los
//     criterios de ese horizonte y los artículos que los respaldan
//     (mismo agrupamiento que calcularSeccionesHorizonte() en
//     generarPresentacionPDF.js) — la recomendación se genera POR
//     CRITERIO, no por artículo individual, para no forzar una idea
//     distinta para cada número de artículo suelto que respalda el mismo
//     hallazgo.
//
// PENDIENTE A PROPÓSITO, NO BLOQUEANTE: el contenido real de las
// recomendaciones (qué se le pide exactamente a Claude, con qué tono,
// cuánta extensión, cómo se cita a Gene Sharp) todavía no está definido
// — Moisés lo señaló explícitamente el 21 jul. Este archivo por ahora
// solo trae la parte que no depende de esa decisión: el cálculo del
// veredicto. La generación de recomendaciones se agrega en una siguiente
// sesión, una vez que el contenido esté pensado.

'use strict';

const UMBRAL_RECHAZO_TOTAL   = 0.20;
const UMBRAL_PROMOCION_TOTAL = 0.80;

// ── Veredicto general del instrumento ────────────────────────────────────
// Se calcula sobre las CANTIDADES crudas de resumenHorizontes (no sobre
// los porcentajes de neutral/a_favor ya redondeados por separado), para
// que el umbral 20%/80% nunca dependa de un desfase de redondeo en un
// caso límite (ej. 19.6% redondeado a 20% no debe cruzar el umbral).
function calcularVeredictoActivismo(resumenHorizontes) {
  const { total, neutral, a_favor } = resumenHorizontes;
  const alineacionFraccion = total > 0
    ? (neutral.cantidad + a_favor.cantidad) / total
    : 0;
  const alineacionPorcentaje = Math.round(alineacionFraccion * 100);

  let modo;
  if (alineacionFraccion < UMBRAL_RECHAZO_TOTAL) {
    modo = 'rechazo_total';
  } else if (alineacionFraccion > UMBRAL_PROMOCION_TOTAL) {
    modo = 'promocion_total';
  } else {
    modo = 'hibrido';
  }

  return { modo, alineacionPorcentaje };
}

module.exports = {
  calcularVeredictoActivismo,
};