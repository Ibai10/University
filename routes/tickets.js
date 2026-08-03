import { Router } from "express";
import QRCode from "qrcode";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";
import { formatDateLabel } from "../dateFormat.js";
import { hasEventEnded } from "../eventTiming.js";

export const ticketVerifyRouter = Router();

// POST /api/tickets/:code/checkin
// Valida una entrada por su código (el que lleva el QR) y la marca como
// usada. Puede hacerlo: un organizador de la MISMA discoteca a la que
// pertenece esa fiesta (no hace falta que él mismo la creara), un
// 'validador' que haya sido añadido explícitamente a esa discoteca (ver
// venue_validators — ya no vale para cualquier fiesta, tiene que
// haberlo elegido el organizador o un admin), o un 'admin'.
ticketVerifyRouter.post("/:code/checkin", requireAuth, requireRole("organizador", "validador", "admin"), async (req, res, next) => {
  try {
    const code = req.params.code.trim().toUpperCase();

    const { rows } = await pool.query(
      `SELECT tickets.*, events.title AS event_title, events.organizer_id, events.category,
              events.event_date, events.event_time, events.end_time, events.location
       FROM tickets
       JOIN events ON events.id = tickets.event_id
       WHERE tickets.code = $1`,
      [code]
    );
    const ticket = rows[0];

    if (!ticket) {
      return res.status(404).json({ error: "Esa entrada no existe. Revisa el código." });
    }

    let canValidateThis = req.user.role === "admin";
    if (!canValidateThis && req.user.role === "organizador" && req.user.organizerVenueId) {
      const venueResult = await pool.query("SELECT name FROM venues WHERE id = $1", [req.user.organizerVenueId]);
      canValidateThis = venueResult.rows[0]?.name === ticket.category;
    }
    if (!canValidateThis && req.user.role === "validador") {
      const assignment = await pool.query(
        `SELECT 1
         FROM venue_validators
         JOIN venues ON venues.id = venue_validators.venue_id
         WHERE venue_validators.validator_id = $1 AND venues.name = $2`,
        [req.user.id, ticket.category]
      );
      canValidateThis = assignment.rows.length > 0;
    }
    if (!canValidateThis) {
      return res.status(403).json({ error: "Esta entrada no pertenece a ninguna de tus fiestas." });
    }
    if (ticket.status === "used") {
      return res.status(409).json({
        error: `Esta entrada ya se validó antes (${ticket.checked_in_at}).`,
        alreadyUsed: true,
        ticket: {
          code: ticket.code,
          quantity: ticket.quantity,
          eventTitle: ticket.event_title,
          checkedInAt: ticket.checked_in_at,
        },
      });
    }
    if (ticket.status === "refunded") {
      return res.status(409).json({ error: "Esta entrada fue reembolsada y ya no es válida." });
    }
    // Comprobamos esto DESPUÉS de "ya usada"/"reembolsada" a propósito —
    // si alguien intenta re-escanear una entrada ya validada, el aviso
    // más útil para quien está en la puerta sigue siendo "ya se validó",
    // no "la fiesta ya terminó".
    if (hasEventEnded(ticket)) {
      return res.status(409).json({ error: "La fiesta ya ha terminado. Este código ya no es válido.", eventEnded: true });
    }

    await pool.query("UPDATE tickets SET status = 'used', checked_in_at = now() WHERE id = $1", [ticket.id]);

    res.json({
      ok: true,
      ticket: {
        code: ticket.code,
        quantity: ticket.quantity,
        eventTitle: ticket.event_title,
        location: ticket.location,
        eventDate: ticket.event_date,
        eventTime: ticket.event_time,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/:code/view
// Página pública (sin login) que muestra la entrada con su QR — es a donde
// lleva el enlace del email. No requiere sesión a propósito: es el mismo
// nivel de acceso que una entrada de papel — quien tiene el código, la ve.
// El código es lo bastante largo y aleatorio (8 caracteres) como para que
// adivinarlo a ciegas no sea viable.
ticketVerifyRouter.get("/:code/view", async (req, res, next) => {
  try {
    const code = req.params.code.trim().toUpperCase();

    const { rows } = await pool.query(
      `SELECT tickets.*, events.title AS event_title, events.category,
              events.location, events.event_date, events.event_time
       FROM tickets
       JOIN events ON events.id = tickets.event_id
       WHERE tickets.code = $1`,
      [code]
    );
    const ticket = rows[0];

    if (!ticket) {
      return res.status(404).send(renderMessagePage("Entrada no encontrada", "Revisa que el enlace esté completo."));
    }

    const qrDataUrl = await QRCode.toDataURL(ticket.code, { width: 260, margin: 1, color: { dark: "#050B1E", light: "#F5F1E8" } });
    const dateLabel = formatDateLabel(ticket.event_date, ticket.event_time);
    const statusNote =
      ticket.status === "used"
        ? `<p style="color:#F0553D;font-size:13px;margin-top:16px;">Ya validada en la puerta el ${new Date(ticket.checked_in_at).toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" })}.</p>`
        : "";

    res.set("Content-Type", "text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tu entrada — ${escapeHtml(ticket.event_title)}</title>
</head>
<body style="margin:0;background:#050B1E;font-family:Helvetica,Arial,sans-serif;display:flex;justify-content:center;padding:32px 16px;">
  <div style="max-width:420px;width:100%;background:#0C1730;border:1px solid #22355C;border-radius:20px;overflow:hidden;">
    <div style="padding:24px 24px 4px;">
      <p style="color:#F0553D;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 6px;">${escapeHtml(ticket.category)}</p>
      <h1 style="color:#F5F1E8;font-size:22px;margin:0 0 8px;">${escapeHtml(ticket.event_title)}</h1>
      <p style="color:#8B96C4;font-size:14px;margin:0;">${escapeHtml(dateLabel)}</p>
      <p style="color:#8B96C4;font-size:14px;margin:0;">${escapeHtml(ticket.location)}</p>
    </div>
    <div style="border-top:1px dashed #22355C;margin:20px 0;"></div>
    <div style="padding:0 24px 28px;text-align:center;">
      <img src="${qrDataUrl}" alt="Código QR de la entrada" style="width:220px;height:220px;border-radius:12px;" />
      <p style="color:#E91E8C;font-family:monospace;font-size:16px;letter-spacing:0.05em;margin:16px 0 4px;">${escapeHtml(ticket.code)}</p>
      <p style="color:#8B96C4;font-size:13px;margin:0;">${ticket.quantity} entrada${ticket.quantity > 1 ? "s" : ""}</p>
      ${statusNote}
    </div>
  </div>
</body>
</html>`);
  } catch (err) {
    next(err);
  }
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderMessagePage(title, message) {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#050B1E;font-family:Helvetica,Arial,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:16px;">
  <div style="text-align:center;color:#F5F1E8;">
    <h1 style="font-size:20px;">${escapeHtml(title)}</h1>
    <p style="color:#8B96C4;font-size:14px;">${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}
