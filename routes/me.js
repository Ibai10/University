import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { getPointsBalance, POINTS_PER_EURO, POINTS_PER_EURO_DISCOUNT } from "../loyalty.js";

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

// GET /api/me/points
// Saldo de puntos de fidelidad, más las tarifas vigentes (para que la app
// pueda explicar "100 puntos = 1€" sin tenerlo hardcodeado por su cuenta).
meRouter.get("/points", requireAuth, async (req, res, next) => {
  try {
    const balance = await getPointsBalance(req.user.id);
    res.json({ balance, pointsPerEuro: POINTS_PER_EURO, pointsPerEuroDiscount: POINTS_PER_EURO_DISCOUNT });
  } catch (err) {
    next(err);
  }
});
