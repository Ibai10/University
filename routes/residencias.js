import { Router } from "express";
import crypto from "node:crypto";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";

export const residenciasRouter = Router();

function generateResidenciaCode() {
  // Sin caracteres ambiguos (0/O, 1/I) — la gente lo escribe a mano.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return code;
}

// GET /api/residencias
// Lista todas las residencias, con su código — solo admin, porque el
// código hay que dárselo a mano a los residentes, no es público.
residenciasRouter.get("/", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM residencias ORDER BY name ASC");
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/residencias
// Crea una residencia nueva y le genera un código único al momento. Solo
// admin — es quien reparte los códigos a cada residencia.
residenciasRouter.post("/", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "El nombre de la residencia es obligatorio." });
    }

    let code = generateResidenciaCode();
    while ((await pool.query("SELECT id FROM residencias WHERE code = $1", [code])).rows.length > 0) {
      code = generateResidenciaCode();
    }

    const { rows } = await pool.query(
      "INSERT INTO residencias (name, code, created_by) VALUES ($1, $2, $3) RETURNING *",
      [name, code, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/residencias/join
// Cualquier usuario introduce el código que le han dado y pasa a
// pertenecer a esa residencia — a partir de ahí ve también las fiestas
// exclusivas de esa residencia en el listado normal.
residenciasRouter.post("/join", requireAuth, async (req, res, next) => {
  try {
    const code = String(req.body?.code || "").trim();
    if (!code) {
      return res.status(400).json({ error: "El código es obligatorio." });
    }

    const { rows } = await pool.query("SELECT * FROM residencias WHERE UPPER(code) = UPPER($1)", [code]);
    const residencia = rows[0];
    if (!residencia) {
      return res.status(404).json({ error: "Ese código no corresponde a ninguna residencia." });
    }

    await pool.query("UPDATE users SET residencia_id = $1 WHERE id = $2", [residencia.id, req.user.id]);
    res.json({ id: residencia.id, name: residencia.name });
  } catch (err) {
    next(err);
  }
});

// POST /api/residencias/leave
// Por si alguien quiere dejar de pertenecer a su residencia (por ejemplo,
// si se equivocó de código).
residenciasRouter.post("/leave", requireAuth, async (req, res, next) => {
  try {
    await pool.query("UPDATE users SET residencia_id = NULL WHERE id = $1", [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
