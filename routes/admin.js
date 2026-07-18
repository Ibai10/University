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
