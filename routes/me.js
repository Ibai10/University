import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const meRouter = Router();

// GET /api/me/tickets
// Entradas compradas por el usuario autenticado, con los datos del evento
// ya incluidos (join) para que el frontend no tenga que hacer una petición
// aparte por cada ticket.
meRouter.get("/tickets", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         tickets.id, tickets.quantity, tickets.unit_price_cents, tickets.total_cents,
         tickets.code, tickets.status, tickets.purchased_at,
         events.id AS event_id, events.title, events.category,
         events.location, events.event_date, events.event_time
       FROM tickets
       JOIN events ON events.id = tickets.event_id
       WHERE tickets.buyer_id = $1
       ORDER BY tickets.purchased_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
