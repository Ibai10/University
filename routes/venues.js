import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";

export const venuesRouter = Router();

// GET /api/venues
// Lista pública de discotecas/salas conocidas — es lo que rellena el
// selector de "categoría" tanto al filtrar eventos como al publicar uno.
venuesRouter.get("/", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT id, name FROM venues ORDER BY name ASC");
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/venues
// Añade una discoteca nueva a la lista. Solo organizador o admin — igual
// que publicar una fiesta, no tiene sentido dejarlo abierto a compradores.
venuesRouter.post("/", requireAuth, requireRole("organizador", "admin"), async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "El nombre de la discoteca es obligatorio." });
    }
    if (name.length > 60) {
      return res.status(400).json({ error: "El nombre es demasiado largo (máximo 60 caracteres)." });
    }

    const existing = await pool.query("SELECT id, name FROM venues WHERE LOWER(name) = LOWER($1)", [name]);
    if (existing.rows[0]) {
      // Ya existe (puede que con otra mayúscula/minúscula) — devolvemos la
      // que ya había en vez de dar error, para que el selector la use tal
      // cual sin que el usuario tenga que reintentar con otro nombre.
      return res.status(200).json(existing.rows[0]);
    }

    const { rows } = await pool.query(
      "INSERT INTO venues (name, created_by) VALUES ($1, $2) RETURNING id, name",
      [name, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});
