import { verifyToken } from "../auth.js";
import { pool } from "../db.js";

// Protege una ruta: exige un header "Authorization: Bearer <token>" válido
// Y que el usuario al que apunta siga existiendo de verdad en la base de
// datos (si alguien corrió `npm run seed` después de que el token se
// creara, el usuario antiguo ya no existe — sin esta comprobación, eso
// provocaba un error de FOREIGN KEY más adelante, en vez de un aviso claro
// de que hay que volver a iniciar sesión).
//
// El rol se lee AQUÍ, de la base de datos — no del token. El token puede
// tener hasta 7 días, y si un admin cambia el rol de alguien mientras
// tanto, queremos que se note en la siguiente petición, no una semana
// después cuando caduque el token.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Falta el token de autenticación." });
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return res.status(401).json({ error: "Token inválido o caducado." });
  }

  try {
    const { rows } = await pool.query("SELECT id, role, residencia_id FROM users WHERE id = $1", [payload.id]);
    if (rows.length === 0) {
      return res.status(401).json({ error: "Tu sesión ya no es válida. Vuelve a iniciar sesión." });
    }
    req.user = { ...payload, role: rows[0].role, residenciaId: rows[0].residencia_id };
  } catch (err) {
    return next(err);
  }

  next();
}

// requireRole('organizador', 'admin') -> deja pasar solo si req.user.role
// es uno de los indicados. Debe ir SIEMPRE después de requireAuth en la
// cadena de middlewares (necesita que req.user ya exista).
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Falta el token de autenticación." });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "Tu cuenta no tiene permiso para hacer esto." });
    }
    next();
  };
}

// Como requireAuth, pero nunca rechaza la petición — si no hay token (o no
// es válido), simplemente sigue con req.user = null. Sirve para rutas
// públicas que aun así necesitan saber "¿quién pregunta, si es que alguien
// ha iniciado sesión?" — por ejemplo, el listado de fiestas necesita saber
// si quien pregunta pertenece a una residencia, para enseñarle también las
// fiestas exclusivas de esa residencia, sin dejar de ser una ruta pública.
export async function optionalAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const payload = verifyToken(token);
    const { rows } = await pool.query("SELECT id, role, residencia_id FROM users WHERE id = $1", [payload.id]);
    req.user = rows[0] ? { ...payload, role: rows[0].role, residenciaId: rows[0].residencia_id } : null;
  } catch {
    req.user = null;
  }

  next();
}
