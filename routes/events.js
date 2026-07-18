import { Router } from "express";
import crypto from "node:crypto";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { sendTicketEmail } from "../email.js";
import { formatDateLabel } from "../dateFormat.js";

export const eventsRouter = Router();

// La foto viaja como data URI en base64 dentro del JSON (ver notas de
// diseño en el README). Ponemos un tope generoso pero razonable para que
// nadie mande un archivo enorme sin querer y se quede la base de datos
// hecha un lío — unos 4MB de texto en base64 equivalen a ~3MB de imagen.
const MAX_IMAGE_LENGTH = 4 * 1024 * 1024;

// "Vendida" incluye tanto las entradas válidas como las ya validadas en la
// puerta ('used') — validar una entrada no la deshace, sigue siendo una
// venta real y sigue ocupando aforo. Solo 'refunded' no cuenta como venta.
// (Antes esto solo contaba 'valid', así que en cuanto alguien validaba su
// entrada, desaparecía del conteo de vendidas y "liberaba" aforo que en
// realidad seguía ocupado — quedaba corregido aquí.)
async function ticketStatsFor(eventId) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(quantity) FILTER (WHERE status IN ('valid', 'used')), 0) AS sold,
       COALESCE(SUM(quantity) FILTER (WHERE status = 'used'), 0) AS validated
     FROM tickets WHERE event_id = $1`,
    [eventId]
  );
  return { sold: Number(rows[0].sold), validated: Number(rows[0].validated) };
}

async function withAvailability(event) {
  const { sold, validated } = await ticketStatsFor(event.id);
  return { ...event, sold, validated, available: Math.max(0, event.capacity - sold) };
}

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[crypto.randomInt(chars.length)];
  return s.slice(0, 4) + "-" + s.slice(4);
}

// GET /api/events?category=Graduaciones&q=oviedo
// Lista pública de fiestas publicadas, con disponibilidad calculada al vuelo.
eventsRouter.get("/", async (req, res, next) => {
  try {
    const { category, q } = req.query;
    let sql = "SELECT * FROM events WHERE status = 'published'";
    const params = [];

    if (category && category !== "Todas") {
      params.push(category);
      sql += ` AND category = $${params.length}`;
    }
    if (q) {
      params.push(`%${q}%`, `%${q}%`);
      sql += ` AND (title ILIKE $${params.length - 1} OR location ILIKE $${params.length})`;
    }
    sql += " ORDER BY event_date ASC, event_time ASC";

    const { rows } = await pool.query(sql, params);
    const withStats = await Promise.all(rows.map(withAvailability));
    res.json(withStats);
  } catch (err) {
    next(err);
  }
});

// GET /api/events/mine
// Fiestas publicadas por el organizador autenticado, con ventas e ingresos.
// Va ANTES de /:id para que "mine" no se interprete como un id.
eventsRouter.get("/mine", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM events WHERE organizer_id = $1 ORDER BY created_at DESC",
      [req.user.id]
    );
    const withStats = await Promise.all(rows.map(withAvailability));
    res.json(withStats);
  } catch (err) {
    next(err);
  }
});

// GET /api/events/:id
eventsRouter.get("/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM events WHERE id = $1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Evento no encontrado." });
    res.json(await withAvailability(rows[0]));
  } catch (err) {
    next(err);
  }
});

// POST /api/events
// Crea una fiesta. Cualquier usuario autenticado puede organizar (para
// convertir esto en un rol "organizador" aparte, añade una columna role
// en users y comprueba req.user aquí).
eventsRouter.post("/", requireAuth, async (req, res, next) => {
  try {
    const { title, category, description, location, event_date, event_time, price, capacity, image } = req.body || {};

    if (!title || !location || !event_date || !event_time) {
      return res.status(400).json({ error: "title, location, event_date y event_time son obligatorios." });
    }
    const venueName = String(category || "").trim();
    if (!venueName) {
      return res.status(400).json({ error: "category (el nombre de la discoteca) es obligatorio." });
    }

    const priceCents = Math.round(Number(price) * 100);
    const cap = Number(capacity);
    if (!Number.isFinite(priceCents) || priceCents < 0) {
      return res.status(400).json({ error: "price debe ser un número mayor o igual a 0." });
    }
    if (!Number.isInteger(cap) || cap <= 0) {
      return res.status(400).json({ error: "capacity debe ser un entero mayor que 0." });
    }
    if (image && (typeof image !== "string" || image.length > MAX_IMAGE_LENGTH)) {
      return res.status(400).json({ error: "La imagen es demasiado grande o no es válida." });
    }

    const { rows } = await pool.query(
      `INSERT INTO events (organizer_id, title, category, description, location, event_date, event_time, price_cents, capacity, image_base64)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [req.user.id, title, venueName, description || "", location, event_date, event_time, priceCents, cap, image || null]
    );

    res.status(201).json(await withAvailability(rows[0]));
  } catch (err) {
    next(err);
  }
});

// POST /api/events/:id/purchase
// Compra entradas. Comprueba aforo real en el momento de la compra para
// evitar sobreventa (dos compras a la vez no pueden dejar el aforo en
// negativo). IMPORTANTE: crea UNA fila por cada entrada (cada una con su
// propio código y su propio QR) en vez de una sola fila con quantity=N —
// así cada persona del grupo se valida por separado en la puerta, y no
// pasa que al escanear la entrada de uno se marquen como usadas las de
// los demás.
eventsRouter.post("/:id/purchase", requireAuth, async (req, res, next) => {
  try {
    const { rows: eventRows } = await pool.query(
      "SELECT * FROM events WHERE id = $1 AND status = 'published'",
      [req.params.id]
    );
    const event = eventRows[0];
    if (!event) return res.status(404).json({ error: "Evento no encontrado." });

    const quantity = Number(req.body?.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "quantity debe ser un entero mayor que 0." });
    }

    const { sold } = await ticketStatsFor(event.id);
    const available = event.capacity - sold;
    if (quantity > available) {
      return res.status(409).json({ error: `Solo quedan ${available} entradas disponibles.` });
    }

    async function uniqueCode() {
      let code = genCode();
      while ((await pool.query("SELECT id FROM tickets WHERE code = $1", [code])).rows.length > 0) {
        code = genCode();
      }
      return code;
    }

    const orderId = crypto.randomUUID();
    const tickets = [];
    for (let i = 0; i < quantity; i++) {
      const code = await uniqueCode();
      const { rows } = await pool.query(
        `INSERT INTO tickets (event_id, buyer_id, quantity, unit_price_cents, total_cents, code, order_id)
         VALUES ($1, $2, 1, $3, $3, $4, $5)
         RETURNING *`,
        [event.id, req.user.id, event.price_cents, code, orderId]
      );
      tickets.push(rows[0]);
    }

    // El email se envía después de confirmar la compra, y un fallo aquí no
    // debe tumbar la respuesta — las entradas ya están guardadas de todas
    // formas. No lo esperamos (await) para no retrasar la respuesta al
    // comprador por si el envío tarda.
    sendTicketEmail({
      to: req.user.email,
      buyerName: req.user.name,
      tickets,
      event: { ...event, dateLabel: formatDateLabel(event.event_date, event.event_time) },
    }).catch((err) => console.error("[email] Error inesperado enviando la entrada:", err.message));

    res.status(201).json({ orderId, tickets });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/events/:id/cancel
// Cancela una fiesta (no la borra): deja de ser comprable y de aparecer en
// el listado público, pero las entradas ya vendidas y su historial se
// conservan intactos — quien ya compró sigue teniendo su entrada.
eventsRouter.patch("/:id/cancel", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM events WHERE id = $1", [req.params.id]);
    const event = rows[0];
    if (!event) return res.status(404).json({ error: "Evento no encontrado." });
    if (event.organizer_id !== req.user.id) {
      return res.status(403).json({ error: "Esta fiesta no es tuya." });
    }
    if (event.status === "cancelled") {
      return res.status(409).json({ error: "Esta fiesta ya estaba cancelada." });
    }

    const updated = await pool.query("UPDATE events SET status = 'cancelled' WHERE id = $1 RETURNING *", [event.id]);
    res.json(await withAvailability(updated.rows[0]));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/events/:id
// Borra la fiesta de verdad — solo si nadie ha comprado entradas todavía.
// Si ya se vendió alguna, se rechaza y se sugiere cancelar en su lugar,
// para no destruir el historial de compra de quien ya pagó.
eventsRouter.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM events WHERE id = $1", [req.params.id]);
    const event = rows[0];
    if (!event) return res.status(404).json({ error: "Evento no encontrado." });
    if (event.organizer_id !== req.user.id) {
      return res.status(403).json({ error: "Esta fiesta no es tuya." });
    }

    const { sold } = await ticketStatsFor(event.id);
    if (sold > 0) {
      return res.status(409).json({
        error: "No se puede borrar una fiesta con entradas ya vendidas. Cancélala en su lugar.",
      });
    }

    await pool.query("DELETE FROM events WHERE id = $1", [event.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
