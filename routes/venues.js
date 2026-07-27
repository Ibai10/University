import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";
import { hasEventEnded } from "../eventTiming.js";

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

// DELETE /api/venues/:id
// Borra una discoteca — solo admin, y solo si no tiene ninguna fiesta
// ACTIVA (publicada y que todavía no haya terminado; una cancelada o una
// ya pasada no cuenta, esas no bloquean el borrado).
// A los validadores/RRPP que estuvieran asignados a esta discoteca NO se
// les toca el rol — solo se borra la asignación a ESTA discoteca en
// concreto, para que sigan pudiendo usarlo si algún día se les asigna a
// otra. Al organizador que la tuviera asignada se le deja "sin discoteca
// asignada" (como si un admin se la quitara desde el panel), no se le
// borra la cuenta ni el rol.
venuesRouter.delete("/:id", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const venueId = Number(req.params.id);
    const venueResult = await pool.query("SELECT id, name FROM venues WHERE id = $1", [venueId]);
    const venue = venueResult.rows[0];
    if (!venue) return res.status(404).json({ error: "Esa discoteca no existe." });

    const eventsResult = await pool.query(
      "SELECT event_date, event_time, end_time FROM events WHERE category = $1 AND status = 'published' AND archived_at IS NULL",
      [venue.name]
    );
    const activeCount = eventsResult.rows.filter((ev) => !hasEventEnded(ev)).length;
    if (activeCount > 0) {
      return res.status(409).json({
        error: `No se puede borrar "${venue.name}" porque tiene ${activeCount} fiesta${activeCount > 1 ? "s" : ""} activa${activeCount > 1 ? "s" : ""}. Cancélala${activeCount > 1 ? "s" : ""} primero, o espera a que termine${activeCount > 1 ? "n" : ""}.`,
      });
    }

    await pool.query("DELETE FROM venue_validators WHERE venue_id = $1", [venueId]);
    await pool.query("DELETE FROM venue_rrpp WHERE venue_id = $1", [venueId]);
    await pool.query("UPDATE users SET organizer_venue_id = NULL WHERE organizer_venue_id = $1", [venueId]);
    await pool.query("DELETE FROM venues WHERE id = $1", [venueId]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ¿Puede este usuario gestionar el personal (validadores o RRPP) de esta
// discoteca? Un admin, cualquiera. Un organizador, solo si es SU
// discoteca asignada — no puede tocar la de otra.
function canManageVenueStaff(req, venueId) {
  if (req.user.role === "admin") return true;
  return req.user.role === "organizador" && req.user.organizerVenueId === venueId;
}

// GET /api/venues/:id/validators
// Quién puede validar entradas de esta discoteca ahora mismo.
venuesRouter.get("/:id/validators", requireAuth, requireRole("organizador", "admin"), async (req, res, next) => {
  try {
    const venueId = Number(req.params.id);
    if (!canManageVenueStaff(req, venueId)) {
      return res.status(403).json({ error: "Esta discoteca no es la tuya." });
    }

    const { rows } = await pool.query(
      `SELECT users.id, users.name, users.nickname, users.email
       FROM venue_validators
       JOIN users ON users.id = venue_validators.validator_id
       WHERE venue_validators.venue_id = $1
       ORDER BY users.name ASC`,
      [venueId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/venues/:id/validators/search?q=nombre
// Busca entre TODAS las cuentas con rol validador, para encontrar a quién
// añadir — no hace falta que ya estén asignados a ninguna discoteca.
venuesRouter.get("/:id/validators/search", requireAuth, requireRole("organizador", "admin"), async (req, res, next) => {
  try {
    const venueId = Number(req.params.id);
    if (!canManageVenueStaff(req, venueId)) {
      return res.status(403).json({ error: "Esta discoteca no es la tuya." });
    }

    const q = String(req.query.q || "").trim();
    let sql = "SELECT id, name, nickname, email FROM users WHERE role = 'validador'";
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      sql += ` AND (name ILIKE $1 OR nickname ILIKE $1 OR email ILIKE $1)`;
    }
    sql += " ORDER BY name ASC LIMIT 30";

    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/venues/:id/validators
// Añade un validador a la lista de esta discoteca. Body: { validator_id }.
venuesRouter.post("/:id/validators", requireAuth, requireRole("organizador", "admin"), async (req, res, next) => {
  try {
    const venueId = Number(req.params.id);
    if (!canManageVenueStaff(req, venueId)) {
      return res.status(403).json({ error: "Esta discoteca no es la tuya." });
    }

    const validatorId = Number(req.body?.validator_id);
    if (!validatorId) {
      return res.status(400).json({ error: "validator_id es obligatorio." });
    }

    const userCheck = await pool.query("SELECT id, role FROM users WHERE id = $1", [validatorId]);
    if (!userCheck.rows[0]) return res.status(404).json({ error: "Ese usuario no existe." });
    if (userCheck.rows[0].role !== "validador") {
      return res.status(400).json({ error: "Solo se pueden añadir cuentas con rol validador." });
    }

    await pool.query(
      "INSERT INTO venue_validators (venue_id, validator_id, assigned_by) VALUES ($1, $2, $3) ON CONFLICT (venue_id, validator_id) DO NOTHING",
      [venueId, validatorId, req.user.id]
    );

    const { rows } = await pool.query("SELECT id, name, nickname, email FROM users WHERE id = $1", [validatorId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/venues/:id/validators/:validatorId
// Quita a un validador de la lista de esta discoteca.
venuesRouter.delete("/:id/validators/:validatorId", requireAuth, requireRole("organizador", "admin"), async (req, res, next) => {
  try {
    const venueId = Number(req.params.id);
    if (!canManageVenueStaff(req, venueId)) {
      return res.status(403).json({ error: "Esta discoteca no es la tuya." });
    }

    await pool.query("DELETE FROM venue_validators WHERE venue_id = $1 AND validator_id = $2", [
      venueId,
      req.params.validatorId,
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/venues/:id/rrpp
// Quién puede vender entradas en efectivo de esta discoteca ahora mismo.
venuesRouter.get("/:id/rrpp", requireAuth, requireRole("organizador", "admin"), async (req, res, next) => {
  try {
    const venueId = Number(req.params.id);
    if (!canManageVenueStaff(req, venueId)) {
      return res.status(403).json({ error: "Esta discoteca no es la tuya." });
    }

    const { rows } = await pool.query(
      `SELECT users.id, users.name, users.nickname, users.email
       FROM venue_rrpp
       JOIN users ON users.id = venue_rrpp.rrpp_id
       WHERE venue_rrpp.venue_id = $1
       ORDER BY users.name ASC`,
      [venueId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/venues/:id/rrpp/search?q=nombre
// Busca gente para añadir como RRPP de esta discoteca. A diferencia de la
// búsqueda de validadores, aquí SÍ pueden salir compradores normales —
// añadirlos como RRPP los convierte en ese rol al momento (ver POST de
// abajo). No salen cuentas con otro rol (organizador/validador/admin):
// esas no se pueden convertir en RRPP desde aquí.
venuesRouter.get("/:id/rrpp/search", requireAuth, requireRole("organizador", "admin"), async (req, res, next) => {
  try {
    const venueId = Number(req.params.id);
    if (!canManageVenueStaff(req, venueId)) {
      return res.status(403).json({ error: "Esta discoteca no es la tuya." });
    }

    const q = String(req.query.q || "").trim();
    let sql = "SELECT id, name, nickname, email, role FROM users WHERE role IN ('comprador', 'rrpp')";
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      sql += ` AND (name ILIKE $1 OR nickname ILIKE $1 OR email ILIKE $1)`;
    }
    sql += " ORDER BY name ASC LIMIT 30";

    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/venues/:id/rrpp
// Añade a alguien como RRPP de esta discoteca. Body: { user_id }. Si la
// persona todavía es un comprador normal, se convierte en RRPP al
// momento como parte de esta misma acción — un organizador puede dar
// este rol en concreto (y solo este), aunque no pueda tocar ningún otro.
venuesRouter.post("/:id/rrpp", requireAuth, requireRole("organizador", "admin"), async (req, res, next) => {
  try {
    const venueId = Number(req.params.id);
    if (!canManageVenueStaff(req, venueId)) {
      return res.status(403).json({ error: "Esta discoteca no es la tuya." });
    }

    const userId = Number(req.body?.user_id);
    if (!userId) {
      return res.status(400).json({ error: "user_id es obligatorio." });
    }

    const userCheck = await pool.query("SELECT id, role FROM users WHERE id = $1", [userId]);
    if (!userCheck.rows[0]) return res.status(404).json({ error: "Ese usuario no existe." });
    const currentRole = userCheck.rows[0].role;
    if (currentRole !== "comprador" && currentRole !== "rrpp") {
      return res.status(400).json({
        error: "Esa cuenta ya tiene otro rol (organizador, validador o admin) y no se puede convertir en RRPP desde aquí.",
      });
    }

    if (currentRole === "comprador") {
      await pool.query("UPDATE users SET role = 'rrpp' WHERE id = $1", [userId]);
    }

    await pool.query(
      "INSERT INTO venue_rrpp (venue_id, rrpp_id, assigned_by) VALUES ($1, $2, $3) ON CONFLICT (venue_id, rrpp_id) DO NOTHING",
      [venueId, userId, req.user.id]
    );

    const { rows } = await pool.query("SELECT id, name, nickname, email, role FROM users WHERE id = $1", [userId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/venues/:id/rrpp/:rrppId
// Quita a alguien de la lista de RRPP de esta discoteca. No le retira el
// rol (podría estar asignado a otra discoteca, o querer conservarlo) —
// solo deja de poder vender en efectivo aquí.
venuesRouter.delete("/:id/rrpp/:rrppId", requireAuth, requireRole("organizador", "admin"), async (req, res, next) => {
  try {
    const venueId = Number(req.params.id);
    if (!canManageVenueStaff(req, venueId)) {
      return res.status(403).json({ error: "Esta discoteca no es la tuya." });
    }

    await pool.query("DELETE FROM venue_rrpp WHERE venue_id = $1 AND rrpp_id = $2", [venueId, req.params.rrppId]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
