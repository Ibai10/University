import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";

export const usersRouter = Router();

// GET /api/users/search?q=nombre
// Busca gente por nombre o nickname — para que un RRPP encuentre a quién
// venderle una entrada en efectivo. A propósito NO devuelve el email (a
// diferencia de la búsqueda del panel de admin): un RRPP no es un admin,
// así que no debería poder ver el correo de cualquiera solo con buscar.
usersRouter.get("/search", requireAuth, requireRole("rrpp", "admin"), async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json([]);

    const { rows } = await pool.query(
      "SELECT id, name, nickname FROM users WHERE name ILIKE $1 OR nickname ILIKE $1 ORDER BY name ASC LIMIT 20",
      [`%${q}%`]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
