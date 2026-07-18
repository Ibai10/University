import { Router } from "express";
import crypto from "node:crypto";
import { pool } from "../db.js";
import { hashPassword, verifyPassword, signToken } from "../auth.js";
import { sendPasswordResetEmail } from "../email.js";

export const authRouter = Router();

const RESET_CODE_TTL_MINUTES = 15;
const MAX_RESET_ATTEMPTS = 5;

function generateResetCode() {
  // 6 dígitos, fácil de escribir en el móvil. crypto.randomInt es
  // criptográficamente seguro (a diferencia de Math.random).
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

// Letras (incluidas las acentuadas/ñ), números, guion, guion bajo y punto.
// Sin espacios — así funciona bien como "@nickname" en pantalla.
const NICKNAME_PATTERN = /^[\p{L}0-9_.-]{3,20}$/u;

// POST /api/auth/register
authRouter.post("/register", async (req, res, next) => {
  try {
    const { email, password, name, nickname } = req.body || {};

    if (!email || !password || !name || !nickname) {
      return res.status(400).json({ error: "email, password, name y nickname son obligatorios." });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres." });
    }

    const trimmedNickname = String(nickname).trim();
    if (!NICKNAME_PATTERN.test(trimmedNickname)) {
      return res.status(400).json({
        error: "El nickname debe tener entre 3 y 20 caracteres, sin espacios (letras, números, guiones o puntos).",
      });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const existingEmail = await pool.query("SELECT id FROM users WHERE email = $1", [normalizedEmail]);
    if (existingEmail.rows.length > 0) {
      return res.status(409).json({ error: "Ya existe una cuenta con ese email." });
    }

    const existingNickname = await pool.query("SELECT id FROM users WHERE LOWER(nickname) = LOWER($1)", [
      trimmedNickname,
    ]);
    if (existingNickname.rows.length > 0) {
      return res.status(409).json({ error: "Ese nickname ya está en uso. Prueba con otro." });
    }

    const { hash, salt } = hashPassword(password);
    const insert = await pool.query(
      "INSERT INTO users (email, password_hash, password_salt, name, nickname) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [normalizedEmail, hash, salt, name, trimmedNickname]
    );

    const user = { id: insert.rows[0].id, email: normalizedEmail, name, nickname: trimmedNickname };
    const token = signToken(user);
    res.status(201).json({ token, user });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
authRouter.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "email y password son obligatorios." });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [normalizedEmail]);
    const row = rows[0];

    if (!row || !verifyPassword(password, row.password_hash, row.password_salt)) {
      return res.status(401).json({ error: "Email o contraseña incorrectos." });
    }

    const user = { id: row.id, email: row.email, name: row.name, nickname: row.nickname };
    const token = signToken(user);
    res.json({ token, user });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/forgot-password
// Siempre responde igual, exista o no una cuenta con ese email — así nadie
// puede usar esto para averiguar qué emails están registrados.
authRouter.post("/forgot-password", async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: "email es obligatorio." });
    }
    const normalizedEmail = String(email).toLowerCase().trim();

    const { rows } = await pool.query("SELECT id, name FROM users WHERE email = $1", [normalizedEmail]);
    const user = rows[0];

    if (user) {
      const code = generateResetCode();
      const { hash, salt } = hashPassword(code);
      const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MINUTES * 60 * 1000);

      await pool.query(
        `UPDATE users
         SET reset_code_hash = $1, reset_code_salt = $2, reset_code_expires_at = $3, reset_code_attempts = 0
         WHERE id = $4`,
        [hash, salt, expiresAt, user.id]
      );

      sendPasswordResetEmail({ to: normalizedEmail, name: user.name, code }).catch((err) =>
        console.error("[email] Error inesperado enviando el código de recuperación:", err.message)
      );
    }

    res.json({ ok: true, message: "Si existe una cuenta con ese email, te hemos enviado un código." });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/reset-password
authRouter.post("/reset-password", async (req, res, next) => {
  try {
    const { email, code, newPassword } = req.body || {};
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: "email, code y newPassword son obligatorios." });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres." });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [normalizedEmail]);
    const user = rows[0];

    // Mensaje genérico para no revelar si el email existe o no.
    const invalidCodeError = { error: "Código incorrecto o caducado." };

    if (!user || !user.reset_code_hash || !user.reset_code_expires_at) {
      return res.status(400).json(invalidCodeError);
    }
    if (new Date(user.reset_code_expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "Este código ha caducado. Pide uno nuevo." });
    }
    if (user.reset_code_attempts >= MAX_RESET_ATTEMPTS) {
      return res.status(429).json({ error: "Demasiados intentos con este código. Pide uno nuevo." });
    }

    const codeMatches = verifyPassword(code, user.reset_code_hash, user.reset_code_salt);
    if (!codeMatches) {
      await pool.query("UPDATE users SET reset_code_attempts = reset_code_attempts + 1 WHERE id = $1", [user.id]);
      return res.status(400).json(invalidCodeError);
    }

    const { hash, salt } = hashPassword(newPassword);
    await pool.query(
      `UPDATE users
       SET password_hash = $1, password_salt = $2,
           reset_code_hash = NULL, reset_code_salt = NULL, reset_code_expires_at = NULL, reset_code_attempts = 0
       WHERE id = $3`,
      [hash, salt, user.id]
    );

    // Te dejamos ya con sesión iniciada, para no obligarte a hacer login
    // aparte justo después de cambiar la contraseña.
    const authUser = { id: user.id, email: user.email, name: user.name, nickname: user.nickname };
    const token = signToken(authUser);
    res.json({ token, user: authUser });
  } catch (err) {
    next(err);
  }
});
