import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";

export const adminRouter = Router();

const VALID_ROLES = ["comprador", "organizador", "validador", "admin"];

// Todas las rutas de este archivo son solo para administradores.
adminRouter.use(requireAuth, requireRole("admin"));

// GET /api/admin/users?q=ana
// Busca usuarios por email o nickname, para encontrar a quién cambiarle
// el rol. Sin "q", devuelve los más recientes.
adminRouter.get("/users", async (req, res, next) => {
  try {
    const { q } = req.query;
    let sql = "SELECT id, email, name, nickname, role, created_at FROM users";
    const params = [];

    if (q) {
      params.push(`%${q}%`);
      sql += ` WHERE email ILIKE $1 OR nickname ILIKE $1 OR name ILIKE $1`;
    }
    sql += " ORDER BY created_at DESC LIMIT 50";

    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:id/role
// Cambia el rol de un usuario. Body: { role }.
adminRouter.patch("/users/:id/role", async (req, res, next) => {
  try {
    const { role } = req.body || {};
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role debe ser una de: ${VALID_ROLES.join(", ")}` });
    }

    const { rows } = await pool.query(
      "UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, name, nickname, role",
      [role, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Usuario no encontrado." });

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/organizadores
// Todos los usuarios con rol 'organizador', con la discoteca a la que
// están asignados (si tienen alguna) — para el panel de "asignar
// discotecas". No es "tiempo real" en el sentido técnico (no hay
// websockets), pero siempre refleja el estado actual en el momento en que
// se abre o se refresca la pantalla.
adminRouter.get("/organizadores", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT users.id, users.name, users.email, users.nickname,
              venues.id AS venue_id, venues.name AS venue_name
       FROM users
       LEFT JOIN venues ON venues.id = users.organizer_venue_id
       WHERE users.role = 'organizador'
       ORDER BY users.name ASC`
    );
    const organizadores = rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      nickname: row.nickname,
      venue: row.venue_id ? { id: row.venue_id, name: row.venue_name } : null,
    }));
    res.json(organizadores);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/organizadores/:id/venue
// Asigna (o quita, con venue_id: null) la discoteca de un organizador.
adminRouter.patch("/organizadores/:id/venue", async (req, res, next) => {
  try {
    const { venue_id } = req.body || {};

    const userCheck = await pool.query("SELECT id, role FROM users WHERE id = $1", [req.params.id]);
    if (!userCheck.rows[0]) return res.status(404).json({ error: "Usuario no encontrado." });
    if (userCheck.rows[0].role !== "organizador") {
      return res.status(400).json({ error: "Solo se puede asignar una discoteca a cuentas con rol organizador." });
    }

    let venueId = null;
    if (venue_id) {
      const venueCheck = await pool.query("SELECT id, name FROM venues WHERE id = $1", [venue_id]);
      if (!venueCheck.rows[0]) return res.status(400).json({ error: "Esa discoteca no existe." });
      venueId = venueCheck.rows[0].id;
    }

    await pool.query("UPDATE users SET organizer_venue_id = $1 WHERE id = $2", [venueId, req.params.id]);

    const updated = await pool.query(
      `SELECT users.id, users.name, users.email, users.nickname,
              venues.id AS venue_id, venues.name AS venue_name
       FROM users
       LEFT JOIN venues ON venues.id = users.organizer_venue_id
       WHERE users.id = $1`,
      [req.params.id]
    );
    const row = updated.rows[0];
    res.json({
      id: row.id,
      name: row.name,
      email: row.email,
      nickname: row.nickname,
      venue: row.venue_id ? { id: row.venue_id, name: row.venue_name } : null,
    });
  } catch (err) {
    next(err);
  }
});
