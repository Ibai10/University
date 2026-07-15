import { Router } from "express";
import QRCode from "qrcode";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { formatDateLabel } from "../dateFormat.js";

export const ticketVerifyRouter = Router();

// POST /api/tickets/:code/checkin
// Valida una entrada por su código (el que lleva el QR) y la marca como
// usada. Solo puede hacerlo el organizador dueño de la fiesta a la que
// pertenece esa entrada — así alguien no puede validar entradas ajenas.
ticketVerifyRouter.post("/:code/checkin", requireAuth, async (req, res, next) => {
  try {
    const code = req.params.code.trim().toUpperCase();

    const { rows } = await pool.query(
      `SELECT tickets.*, events.title AS event_title, events.organizer_id,
              events.event_date, events.event_time, events.location
       FROM tickets
       JOIN events ON events.id = tickets.event_id
       WHERE tickets.code = $1`,
      [code]
    );
    const ticket = rows[0];

    if (!ticket) {
      return res.status(404).json({ error: "Esa entrada no existe. Revisa el código." });
    }
    if (ticket.organizer_id !== req.user.id) {
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

    const qrDataUrl = await QRCode.toDataURL(ticket.code, { width: 260, margin: 1, color: { dark: "#0E2429", light: "#F5F1E8" } });
    const dateLabel = formatDateLabel(ticket.event_date, ticket.event_time);
    const statusNote =
      ticket.status === "used"
        ? `<p style="color:#E8654A;font-size:13px;margin-top:16px;">Ya validada en la puerta el ${new Date(ticket.checked_in_at).toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" })}.</p>`
        : "";

    res.set("Content-Type", "text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tu entrada — ${escapeHtml(ticket.event_title)}</title>
</head>
<body style="margin:0;background:#0E2429;font-family:Helvetica,Arial,sans-serif;display:flex;justify-content:center;padding:32px 16px;">
  <div style="max-width:420px;width:100%;background:#153136;border:1px solid #22474D;border-radius:20px;overflow:hidden;">
    <div style="padding:24px 24px 4px;">
      <p style="color:#E8654A;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 6px;">${escapeHtml(ticket.category)}</p>
      <h1 style="color:#F5F1E8;font-size:22px;margin:0 0 8px;">${escapeHtml(ticket.event_title)}</h1>
      <p style="color:#8FA6A3;font-size:14px;margin:0;">${escapeHtml(dateLabel)}</p>
      <p style="color:#8FA6A3;font-size:14px;margin:0;">${escapeHtml(ticket.location)}</p>
    </div>
    <div style="border-top:1px dashed #22474D;margin:20px 0;"></div>
    <div style="padding:0 24px 28px;text-align:center;">
      <img src="${qrDataUrl}" alt="Código QR de la entrada" style="width:220px;height:220px;border-radius:12px;" />
      <p style="color:#F2A93B;font-family:monospace;font-size:16px;letter-spacing:0.05em;margin:16px 0 4px;">${escapeHtml(ticket.code)}</p>
      <p style="color:#8FA6A3;font-size:13px;margin:0;">${ticket.quantity} entrada${ticket.quantity > 1 ? "s" : ""}</p>
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
<body style="margin:0;background:#0E2429;font-family:Helvetica,Arial,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:16px;">
  <div style="text-align:center;color:#F5F1E8;">
    <h1 style="font-size:20px;">${escapeHtml(title)}</h1>
    <p style="color:#8FA6A3;font-size:14px;">${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}
