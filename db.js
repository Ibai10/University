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

    -- Qué validadores puede validar entradas de qué discoteca. Antes un
    -- 'validador' podía validar CUALQUIER fiesta — ahora solo las de las
    -- discotecas donde el organizador (o un admin) lo haya añadido aquí
    -- explícitamente. Un mismo validador puede estar en varias discotecas
    -- (por ejemplo, alguien que hace de puerta en más de un sitio).
    CREATE TABLE IF NOT EXISTS venue_validators (
      id SERIAL PRIMARY KEY,
      venue_id INTEGER NOT NULL REFERENCES venues(id),
      validator_id INTEGER NOT NULL REFERENCES users(id),
      assigned_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(venue_id, validator_id)
    );

    -- Igual que venue_validators, pero para quién puede vender entradas EN
    -- EFECTIVO de cada discoteca (rol 'rrpp'). Un RRPP solo puede hacer
    -- ventas en efectivo de las discotecas donde esté aquí — no de
    -- cualquiera, igual que un validador no puede escanear en cualquiera.
    CREATE TABLE IF NOT EXISTS venue_rrpp (
      id SERIAL PRIMARY KEY,
      venue_id INTEGER NOT NULL REFERENCES venues(id),
      rrpp_id INTEGER NOT NULL REFERENCES users(id),
      assigned_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(venue_id, rrpp_id)
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
      -- Hora a la que termina la fiesta ('HH:MM') — a partir de ahí, los
      -- QR dejan de validar. NULL en fiestas creadas antes de esta
      -- función (esas nunca caducan, para no romper nada de golpe).
      -- Si es "menor" que event_time, se entiende que es de madrugada
      -- del día siguiente (ver eventTiming.js).
      end_time TEXT,
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      capacity INTEGER NOT NULL CHECK (capacity > 0),
      status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','cancelled')),
      image_base64 TEXT,
      -- NULL = fiesta pública normal, visible para todo el mundo (como
      -- hasta ahora). Con un valor = exclusiva para quien pertenezca a
      -- esa residencia; el resto de la gente ni la ve en el listado.
      residencia_id INTEGER REFERENCES residencias(id),
      -- Cuándo se "borró" desde el punto de vista del organizador — no es
      -- un borrado de verdad (eso rompería la entrada de quien ya la
      -- compró), solo hace que deje de aparecer en "Tus fiestas". Solo
      -- tiene sentido en fiestas ya canceladas.
      archived_at TIMESTAMPTZ,
      -- Si es TRUE, solo se puede comprar 1 entrada por persona en una
      -- misma compra normal (por Redsys o la de pruebas) — pensado para
      -- fiestas con mucha demanda donde no se quiere que alguien acapare
      -- varias. NO afecta a la venta en efectivo de un RRPP, que ya de
      -- por sí da exactamente 1 entrada a cada persona seleccionada.
      limit_one_per_buyer BOOLEAN NOT NULL DEFAULT false,
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
      checked_in_at TIMESTAMPTZ,
      -- Si no es NULL, esta entrada se vendió en efectivo por un RRPP (el
      -- id de quien la vendió) en vez de comprarse por la propia persona
      -- a través de la pasarela de pago.
      sold_by_rrpp_id INTEGER REFERENCES users(id)
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
      points_redeemed INTEGER NOT NULL DEFAULT 0,
      discount_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
      redsys_response TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at TIMESTAMPTZ
    );

    -- Historial de puntos de fidelidad — en vez de guardar "el saldo" como
    -- un número suelto, cada movimiento queda registrado (positivo =
    -- ganados, negativo = canjeados) y el saldo se calcula sumando. Así
    -- nunca se puede desincronizar, y queda un historial de por qué se
    -- ganó o gastó cada punto — mismo enfoque que ya usamos para
    -- "entradas vendidas" en events.
    CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      points INTEGER NOT NULL,
      reason TEXT NOT NULL, -- 'ticket_purchase' | 'ticket_redemption'
      order_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
      -- NULL = sin límite de stock. Con un número, no se puede vender más
      -- unidades de las que quedan (se calcula restando lo ya comprado,
      -- igual que "available" en events se calcula restando "sold").
      stock INTEGER,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Un pedido de pago de merchandising — mismo patrón que
    -- payment_orders (pending -> paid/failed vía la notificación de
    -- Redsys), pero para productos en vez de entradas.
    CREATE TABLE IF NOT EXISTS merchandise_orders (
      id SERIAL PRIMARY KEY,
      order_code TEXT UNIQUE NOT NULL,
      merchandise_id INTEGER NOT NULL REFERENCES merchandise(id),
      buyer_id INTEGER NOT NULL REFERENCES users(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
      redsys_response TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at TIMESTAMPTZ
    );

    -- Cada unidad comprada, con su propio código y QR — igual que con las
    -- entradas, una fila por unidad (si compras 3 sudaderas, son 3 filas),
    -- para que cada una se pueda recoger/entregar por separado.
    -- 'used' aquí significa "ya entregada/recogida", no "validada en la
    -- puerta" como en tickets, pero es el mismo concepto de fondo.
    CREATE TABLE IF NOT EXISTS merchandise_purchases (
      id SERIAL PRIMARY KEY,
      merchandise_id INTEGER NOT NULL REFERENCES merchandise(id),
      buyer_id INTEGER NOT NULL REFERENCES users(id),
      unit_price_cents INTEGER NOT NULL,
      code TEXT UNIQUE NOT NULL,
      order_id TEXT,
      status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','used','refunded')),
      purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      delivered_at TIMESTAMPTZ
    );

    -- Galería de fotos por residencia — mismo criterio de acceso que el
    -- merchandising (solo un admin sube/borra, solo quien pertenece a
    -- esa residencia o un admin las ve), pero sin nombre ni precio, solo
    -- la imagen y un pie de foto opcional.
    CREATE TABLE IF NOT EXISTS residencia_photos (
      id SERIAL PRIMARY KEY,
      residencia_id INTEGER NOT NULL REFERENCES residencias(id),
      image_base64 TEXT NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
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
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sold_by_rrpp_id INTEGER REFERENCES users(id);
    ALTER TABLE merchandise ADD COLUMN IF NOT EXISTS stock INTEGER;
    ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS points_redeemed INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS discount_cents INTEGER NOT NULL DEFAULT 0;

    -- A qué residencia pertenece este usuario (NULL = a ninguna) — se
    -- rellena al introducir el código de una residencia en la app.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS residencia_id INTEGER REFERENCES residencias(id);
    ALTER TABLE events ADD COLUMN IF NOT EXISTS residencia_id INTEGER REFERENCES residencias(id);
    ALTER TABLE events ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS limit_one_per_buyer BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS end_time TEXT;

    -- A qué discoteca está asignado un organizador (NULL = a ninguna
    -- todavía). Solo lo rellena un admin, desde el panel de
    -- administración — un organizador no puede asignarse una a sí mismo.
    -- Mientras no tenga ninguna, no puede publicar fiestas.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS organizer_venue_id INTEGER REFERENCES venues(id);

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
    CREATE INDEX IF NOT EXISTS idx_loyalty_user ON loyalty_transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_users_residencia ON users(residencia_id);
    CREATE INDEX IF NOT EXISTS idx_events_residencia ON events(residencia_id);
    CREATE INDEX IF NOT EXISTS idx_merchandise_residencia ON merchandise(residencia_id);
    CREATE INDEX IF NOT EXISTS idx_merch_orders_buyer ON merchandise_orders(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_merch_orders_merch ON merchandise_orders(merchandise_id);
    CREATE INDEX IF NOT EXISTS idx_merch_purchases_buyer ON merchandise_purchases(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_merch_purchases_merch ON merchandise_purchases(merchandise_id);
    CREATE INDEX IF NOT EXISTS idx_residencia_photos_residencia ON residencia_photos(residencia_id);
    CREATE INDEX IF NOT EXISTS idx_users_organizer_venue ON users(organizer_venue_id);
    CREATE INDEX IF NOT EXISTS idx_venue_validators_venue ON venue_validators(venue_id);
    CREATE INDEX IF NOT EXISTS idx_venue_validators_validator ON venue_validators(validator_id);
    CREATE INDEX IF NOT EXISTS idx_venue_rrpp_venue ON venue_rrpp(venue_id);
    CREATE INDEX IF NOT EXISTS idx_venue_rrpp_rrpp ON venue_rrpp(rrpp_id);
  `);
}
