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

const MAX_MERCH_IMAGE_LENGTH = 4 * 1024 * 1024;

// GET /api/residencias/:id/merchandise
// El catálogo de una residencia — solo lo ve quien pertenezca a ella (o
// un admin). Mismo criterio que las fiestas exclusivas: si no es lo tuyo,
// ni te enteras de que existe (404, no 403).
residenciasRouter.get("/:id/merchandise", requireAuth, async (req, res, next) => {
  try {
    const residenciaId = Number(req.params.id);
    const belongs = req.user.residenciaId === residenciaId;
    if (!belongs && req.user.role !== "admin") {
      return res.status(404).json({ error: "Residencia no encontrada." });
    }

    const { rows } = await pool.query(
      "SELECT * FROM merchandise WHERE residencia_id = $1 ORDER BY created_at DESC",
      [residenciaId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/residencias/:id/merchandise
// Añade un producto al catálogo — solo admin. Body: { name, description,
// price, image }.
residenciasRouter.post("/:id/merchandise", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const residenciaId = Number(req.params.id);
    const residenciaCheck = await pool.query("SELECT id FROM residencias WHERE id = $1", [residenciaId]);
    if (!residenciaCheck.rows[0]) {
      return res.status(404).json({ error: "Residencia no encontrada." });
    }

    const { name, description, price, image } = req.body || {};
    const trimmedName = String(name || "").trim();
    if (!trimmedName) {
      return res.status(400).json({ error: "El nombre del producto es obligatorio." });
    }

    const priceCents = Math.round(Number(price) * 100);
    if (!Number.isFinite(priceCents) || priceCents < 0) {
      return res.status(400).json({ error: "price debe ser un número mayor o igual a 0." });
    }
    if (image && (typeof image !== "string" || image.length > MAX_MERCH_IMAGE_LENGTH)) {
      return res.status(400).json({ error: "La imagen es demasiado grande o no es válida." });
    }

    const { rows } = await pool.query(
      `INSERT INTO merchandise (residencia_id, name, description, price_cents, image_base64, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [residenciaId, trimmedName, description || "", priceCents, image || null, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/residencias/:id/merchandise/:itemId
// Quita un producto del catálogo — solo admin.
residenciasRouter.delete("/:id/merchandise/:itemId", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "DELETE FROM merchandise WHERE id = $1 AND residencia_id = $2 RETURNING id",
      [req.params.itemId, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Producto no encontrado." });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const MAX_PHOTO_LENGTH = 4 * 1024 * 1024;

// GET /api/residencias/:id/photos
// La galería de una residencia — mismo criterio de acceso que el
// merchandising: solo la ve quien pertenezca a ella (o un admin).
residenciasRouter.get("/:id/photos", requireAuth, async (req, res, next) => {
  try {
    const residenciaId = Number(req.params.id);
    const belongs = req.user.residenciaId === residenciaId;
    if (!belongs && req.user.role !== "admin") {
      return res.status(404).json({ error: "Residencia no encontrada." });
    }

    const { rows } = await pool.query(
      "SELECT * FROM residencia_photos WHERE residencia_id = $1 ORDER BY created_at DESC",
      [residenciaId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/residencias/:id/photos
// Sube una foto a la galería — solo admin. Body: { image, caption }.
residenciasRouter.post("/:id/photos", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const residenciaId = Number(req.params.id);
    const residenciaCheck = await pool.query("SELECT id FROM residencias WHERE id = $1", [residenciaId]);
    if (!residenciaCheck.rows[0]) {
      return res.status(404).json({ error: "Residencia no encontrada." });
    }

    const { image, caption } = req.body || {};
    if (!image || typeof image !== "string") {
      return res.status(400).json({ error: "La foto es obligatoria." });
    }
    if (image.length > MAX_PHOTO_LENGTH) {
      return res.status(400).json({ error: "La imagen es demasiado grande." });
    }

    const { rows } = await pool.query(
      `INSERT INTO residencia_photos (residencia_id, image_base64, caption, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [residenciaId, image, (caption || "").trim(), req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/residencias/:id/photos/:photoId
// Quita una foto de la galería — solo admin.
residenciasRouter.delete("/:id/photos/:photoId", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "DELETE FROM residencia_photos WHERE id = $1 AND residencia_id = $2 RETURNING id",
      [req.params.photoId, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Foto no encontrada." });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
