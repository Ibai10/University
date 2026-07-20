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
      nickname TEXT,
      -- 'comprador' (por defecto, nadie se auto-asigna otro rol al
      -- registrarse) | 'organizador' | 'validador' | 'admin'.
      -- Sin CHECK a nivel de base de datos a propósito (igual que
      -- "category" en events) — se valida en el código de las rutas,
      -- para no repetir el lío de migrar constraints en Postgres.
      role TEXT NOT NULL DEFAULT 'comprador',
      reset_code_hash TEXT,
      reset_code_salt TEXT,
      reset_code_expires_at TIMESTAMPTZ,
      reset_code_attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- El nombre de cada discoteca/sala. Sustituye a la lista fija de
    -- categorías (Graduaciones/Universitarias/Despedidas): cualquiera
    -- puede añadir una nueva desde la app, no hay que tocar el código
    -- para eso. "category" en events sigue siendo texto libre (no una
    -- clave foránea) para no forzar una migración de datos ya existentes;
    -- esta tabla es solo la lista de nombres que ofrece el selector.
    CREATE TABLE IF NOT EXISTS venues (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Una residencia de estudiantes. Solo un admin puede crear una (botón
    -- en el panel de administración) — al crearla se genera un código
    -- único que se le da a los residentes; quien lo introduce en la app
    -- pasa a ver las fiestas que se publiquen en exclusiva para esa
    -- residencia (ver events.residencia_id más abajo).
    CREATE TABLE IF NOT EXISTS residencias (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      organizer_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL,
      event_date TEXT NOT NULL,          -- 'YYYY-MM-DD'
      event_time TEXT NOT NULL,          -- 'HH:MM'
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      capacity INTEGER NOT NULL CHECK (capacity > 0),
      status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','cancelled')),
      image_base64 TEXT,
      -- NULL = fiesta pública normal, visible para todo el mundo (como
      -- hasta ahora). Con un valor = exclusiva para quien pertenezca a
      -- esa residencia; el resto de la gente ni la ve en el listado.
      residencia_id INTEGER REFERENCES residencias(id),
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

    -- Un pedido de pago con Redsys. Se crea en 'pending' al iniciar el
    -- pago (antes de que el cliente ni siquiera vea la página del banco);
    -- pasa a 'paid' o 'failed' cuando llega la notificación de Redsys
    -- confirmando el resultado. Las entradas (tickets) solo se crean de
    -- verdad cuando el pedido pasa a 'paid' — nunca antes.
    CREATE TABLE IF NOT EXISTS payment_orders (
      id SERIAL PRIMARY KEY,
      order_code TEXT UNIQUE NOT NULL,
      event_id INTEGER NOT NULL REFERENCES events(id),
      buyer_id INTEGER NOT NULL REFERENCES users(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
      redsys_response TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at TIMESTAMPTZ
    );

    -- Catálogo de merchandising por residencia — de momento solo para
    -- ver (no hay compra todavía). Solo un admin añade productos; solo
    -- quien pertenezca a esa residencia (o un admin) los ve, igual que
    -- las fiestas exclusivas.
    CREATE TABLE IF NOT EXISTS merchandise (
      id SERIAL PRIMARY KEY,
      residencia_id INTEGER NOT NULL REFERENCES residencias(id),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      image_base64 TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Migraciones para bases de datos que ya existían antes de estos
    -- cambios. Van SIEMPRE antes de los índices/constraints que dependan
    -- de las columnas nuevas — un índice sobre una columna que aún no
    -- existe falla (ya nos pasó una vez).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_salt TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_expires_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'comprador';
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS order_id TEXT;

    -- A qué residencia pertenece este usuario (NULL = a ninguna) — se
    -- rellena al introducir el código de una residencia en la app.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS residencia_id INTEGER REFERENCES residencias(id);
    ALTER TABLE events ADD COLUMN IF NOT EXISTS residencia_id INTEGER REFERENCES residencias(id);

    -- "category" ya no está limitado a 3 valores fijos (ahora son nombres
    -- de discotecas, con lista abierta) — si la restricción antigua
    -- existe todavía en una base de datos previa, se quita.
    ALTER TABLE events DROP CONSTRAINT IF EXISTS events_category_check;

    -- Únicos que ignoran mayúsculas/minúsculas: "Ibai10" y "ibai10" no
    -- pueden coexistir como nicknames distintos, ni "Sala Vintage" y
    -- "sala vintage" como dos discotecas distintas.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname_lower ON users (LOWER(nickname));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_venues_name_lower ON venues (LOWER(name));

    CREATE INDEX IF NOT EXISTS idx_events_organizer ON events(organizer_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_buyer ON tickets(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_order ON tickets(order_id);
    CREATE INDEX IF NOT EXISTS idx_payment_orders_buyer ON payment_orders(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_users_residencia ON users(residencia_id);
    CREATE INDEX IF NOT EXISTS idx_events_residencia ON events(residencia_id);
    CREATE INDEX IF NOT EXISTS idx_merchandise_residencia ON merchandise(residencia_id);
  `);
}
