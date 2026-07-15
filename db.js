// Capa de base de datos — PostgreSQL de verdad, para poder alojar el
// backend en un servidor real (Render, Railway...) sin depender de un
// archivo local que desaparece en cuanto el servidor se reinicia.
//
// Antes esto usaba SQLite (node:sqlite) para poder probar todo en tu
// ordenador sin instalar nada. El resto del código (routes/) no ha tenido
// que cambiar su forma de pensar en los datos, solo la forma de pedirlos —
// justo la razón por la que separamos esta pieza desde el principio.

import pg from "pg";

const { Pool } = pg;

// En local (tu ordenador, o esta prueba) no hace falta SSL. En Render/Neon
// y la mayoría de proveedores en la nube, sí. Lo detectamos por si acaso
// no defines DATABASE_SSL a mano.
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "");

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      name TEXT NOT NULL,
      reset_code_hash TEXT,
      reset_code_salt TEXT,
      reset_code_expires_at TIMESTAMPTZ,
      reset_code_attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      organizer_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('Graduaciones','Universitarias','Despedidas')),
      description TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL,
      event_date TEXT NOT NULL,          -- 'YYYY-MM-DD'
      event_time TEXT NOT NULL,          -- 'HH:MM'
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      capacity INTEGER NOT NULL CHECK (capacity > 0),
      status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','cancelled')),
      image_base64 TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Cada fila es UNA entrada individual (quantity siempre 1 en compras
    -- nuevas) — así cada persona tiene su propio código y su propio QR,
    -- aunque se hayan comprado varias a la vez. order_id agrupa las que
    -- se compraron juntas (para el email y el historial), pero cada una
    -- se valida por separado en la puerta.
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id),
      buyer_id INTEGER NOT NULL REFERENCES users(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price_cents INTEGER NOT NULL,
      total_cents INTEGER NOT NULL,
      code TEXT UNIQUE NOT NULL,
      order_id TEXT,
      status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','used','refunded')),
      purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      checked_in_at TIMESTAMPTZ
    );

    -- Migración para bases de datos que ya existían antes de añadir la
    -- recuperación de contraseña y las entradas individuales: a diferencia
    -- de SQLite, Postgres sí deja añadir una columna "solo si no existe"
    -- en una sola sentencia. Esto tiene que ir ANTES de los índices de
    -- abajo — un índice sobre una columna que todavía no existe falla.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_salt TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_expires_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS order_id TEXT;

    CREATE INDEX IF NOT EXISTS idx_events_organizer ON events(organizer_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_buyer ON tickets(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_order ON tickets(order_id);
  `);
}
