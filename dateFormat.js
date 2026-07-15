const MONTHS_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const WEEKDAYS_ES = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

// event_date llega como 'YYYY-MM-DD' y event_time como 'HH:MM' (así los
// guarda la tabla events). Esto arma algo como "Vie 20 jun · 23:00" para
// mostrar en el email y en la página de la entrada.
export function formatDateLabel(dateStr, timeStr) {
  if (!dateStr) return timeStr || "";
  const [y, m, d] = dateStr.split("-").map(Number);
  const dateObj = new Date(y, m - 1, d);
  const weekday = WEEKDAYS_ES[dateObj.getDay()];
  return `${weekday} ${d} ${MONTHS_ES[m - 1]}${timeStr ? " · " + timeStr : ""}`;
}
