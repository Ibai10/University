import { verifyToken } from "../auth.js";
import { pool } from "../db.js";

// Protege una ruta: exige un header "Authorization: Bearer <token>" válido
// Y que el usuario al que apunta siga existiendo de verdad en la base de
// datos (si alguien corrió `npm run seed` después de que el token se
// creara, el usuario antiguo ya no existe — sin esta comprobación, eso
// provocaba un error de FOREIGN KEY más adelante, en vez de un aviso claro
// de que hay que volver a iniciar sesión).
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
    const { rows } = await pool.query("SELECT id FROM users WHERE id = $1", [payload.id]);
    if (rows.length === 0) {
      return res.status(401).json({ error: "Tu sesión ya no es válida. Vuelve a iniciar sesión." });
    }
  } catch (err) {
    return next(err);
  }

  req.user = payload;
  next();
}
