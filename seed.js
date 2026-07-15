// Rellena la base de datos con datos de ejemplo: un organizador, un
// comprador de prueba, las 6 fiestas del prototipo y un par de compras ya
// hechas (para que las estadísticas del organizador no arranquen en cero).
//
// Se puede ejecutar tantas veces como quieras: cada vez limpia las tablas
// y vuelve a sembrarlas desde cero.

import crypto from "node:crypto";
import { pool, initDb } from "./db.js";
import { hashPassword } from "./auth.js";

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[crypto.randomInt(chars.length)];
  return s.slice(0, 4) + "-" + s.slice(4);
}

async function main() {
  await initDb();
  await pool.query("DELETE FROM tickets; DELETE FROM events; DELETE FROM users;");

  const organizerPass = hashPassword("organiza123");
  const organizerResult = await pool.query(
    "INSERT INTO users (email, password_hash, password_salt, name) VALUES ($1, $2, $3, $4) RETURNING id",
    ["organizador@ejemplo.com", organizerPass.hash, organizerPass.salt, "Sala Vintage Eventos"]
  );
  const organizerId = organizerResult.rows[0].id;

  const buyerPass = hashPassword("entrada123");
  const buyerResult = await pool.query(
    "INSERT INTO users (email, password_hash, password_salt, name) VALUES ($1, $2, $3, $4) RETURNING id",
    ["invitado@ejemplo.com", buyerPass.hash, buyerPass.salt, "Invitado"]
  );
  const buyerId = buyerResult.rows[0].id;

  const events = [
    {
      title: "Fiesta Fin de Curso — 2º Bachillerato",
      category: "Graduaciones",
      description: "DJ en directo, barra de refrescos hasta las 02:00 y photocall para el recuerdo.",
      location: "Sala La Lonja, Gijón",
      event_date: "2026-08-14",
      event_time: "23:00",
      price_cents: 2000,
      capacity: 180,
    },
    {
      title: "Graduación Universitaria — Fiesta de Promoción",
      category: "Graduaciones",
      description: "Música en directo, brindis de promoción y sorpresa final.",
      location: "Terraza Real, Oviedo",
      event_date: "2026-08-28",
      event_time: "22:30",
      price_cents: 2500,
      capacity: 120,
    },
    {
      title: "Fiesta de Bienvenida Universitaria",
      category: "Universitarias",
      description: "La fiesta clásica de inicio de curso. Entrada con primera consumición incluida.",
      location: "Sala Vintage, Oviedo",
      event_date: "2026-09-18",
      event_time: "23:30",
      price_cents: 800,
      capacity: 260,
    },
    {
      title: "Ruta Universitaria de Tapas y Copas",
      category: "Universitarias",
      description: "Recorrido guiado por bares del centro con descuentos y quedada final en discoteca.",
      location: "Casco Antiguo, Gijón",
      event_date: "2026-10-09",
      event_time: "21:00",
      price_cents: 1200,
      capacity: 90,
    },
    {
      title: "Despedida de Soltera — Noche VIP",
      category: "Despedidas",
      description: "Reservado privado, cóctel de bienvenida, photocall temático y pase VIP a discoteca.",
      location: "Sala Kaótika, Gijón",
      event_date: "2026-08-15",
      event_time: "21:00",
      price_cents: 3500,
      capacity: 22,
    },
    {
      title: "Despedida de Soltero — Ruta de Bares",
      category: "Despedidas",
      description: "Ruta guiada por Cimavilla con juegos, retos y entrada final a discoteca incluida.",
      location: "Cimavilla, Gijón",
      event_date: "2026-08-22",
      event_time: "20:00",
      price_cents: 1800,
      capacity: 55,
    },
  ];

  const eventIds = [];
  for (const e of events) {
    const result = await pool.query(
      `INSERT INTO events (organizer_id, title, category, description, location, event_date, event_time, price_cents, capacity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [organizerId, e.title, e.category, e.description, e.location, e.event_date, e.event_time, e.price_cents, e.capacity]
    );
    eventIds.push(result.rows[0].id);
  }

  // Un par de compras ya realizadas, para que "Tus fiestas" no arranque vacío.
  const samplePurchases = [
    { eventIndex: 2, quantity: 3 }, // Bienvenida Universitaria
    { eventIndex: 4, quantity: 5 }, // Despedida de Soltera VIP (deja pocas plazas)
  ];

  for (const p of samplePurchases) {
    const event = events[p.eventIndex];
    const eventId = eventIds[p.eventIndex];
    await pool.query(
      `INSERT INTO tickets (event_id, buyer_id, quantity, unit_price_cents, total_cents, code)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [eventId, buyerId, p.quantity, event.price_cents, event.price_cents * p.quantity, genCode()]
    );
  }

  console.log("Datos de ejemplo creados:");
  console.log(`- Organizador: organizador@ejemplo.com / organiza123`);
  console.log(`- Comprador:   invitado@ejemplo.com / entrada123`);
  console.log(`- ${events.length} fiestas publicadas, ${samplePurchases.length} compras de ejemplo.`);
  await pool.end();
}

main().catch((err) => {
  console.error("Error al sembrar datos:", err);
  process.exit(1);
});
