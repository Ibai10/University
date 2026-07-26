// Calcula si una fiesta ya ha terminado, para que los QR dejen de
// validar en cuanto pase su hora de fin. Dos cosas no triviales que
// resuelve este archivo:
//
// 1. Muchas fiestas empiezan de noche y acaban de madrugada del día
//    SIGUIENTE (p. ej. de 23:00 a 06:00) — si la hora de fin es "menor"
//    que la de inicio, se asume que es al día siguiente. Si alguien
//    organiza algo de día (10:00 a 18:00), no hay salto de día.
// 2. El servidor puede correr en otra zona horaria (Render usa UTC), así
//    que "las 23:00" tal como las escribió el organizador son las 23:00
//    en España, no las 23:00 del reloj del servidor. Hay que convertir
//    explícitamente a la hora de Madrid antes de comparar con "ahora".

const EVENT_TIMEZONE = "Europe/Madrid";

// Convierte una fecha/hora tal como se escribieron ('YYYY-MM-DD' y
// 'HH:MM', pensadas como hora de Madrid) al instante UTC real que
// representan — sea cual sea la zona horaria del servidor, y teniendo en
// cuenta el cambio de hora de verano/invierno de España.
function madridDateTimeToUTC(dateStr, timeStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);

  // Paso 1: interpretamos esos números COMO SI fueran UTC (una primera
  // aproximación, todavía no es el instante correcto).
  const guessUTC = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  // Paso 2: vemos qué hora "aparenta" ser ese instante si se mira desde
  // Madrid — la diferencia con nuestra aproximación nos da el offset real
  // de Madrid en esa fecha concreta (+1 en invierno, +2 en verano).
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: EVENT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(guessUTC).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const madridInterpretationOfGuess = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  const offsetMs = guessUTC.getTime() - madridInterpretationOfGuess;
  return new Date(guessUTC.getTime() + offsetMs);
}

// Devuelve el instante UTC en el que termina de verdad una fiesta, o null
// si no tiene hora de fin registrada (fiestas creadas antes de esta
// función — para esas, los QR se comportan como siempre, sin caducar).
export function computeEventEndUTC(eventDate, startTime, endTime) {
  if (!endTime) return null;

  const [startH, startM] = startTime.split(":").map(Number);
  const [endH, endM] = endTime.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  let effectiveDate = eventDate;
  if (endMinutes <= startMinutes) {
    // La hora de fin "numéricamente" no es posterior a la de inicio —
    // asumimos que es de madrugada, al día siguiente.
    const [y, m, d] = eventDate.split("-").map(Number);
    const nextDay = new Date(Date.UTC(y, m - 1, d + 1));
    effectiveDate = nextDay.toISOString().slice(0, 10);
  }

  return madridDateTimeToUTC(effectiveDate, endTime);
}

// ¿Ya ha terminado esta fiesta? true/false — si no tiene hora de fin
// guardada, nunca se considera terminada (compatibilidad con fiestas
// creadas antes de esta función).
export function hasEventEnded(event) {
  const endUTC = computeEventEndUTC(event.event_date, event.event_time, event.end_time);
  if (!endUTC) return false;
  return Date.now() > endUTC.getTime();
}
