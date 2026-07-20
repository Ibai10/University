// Sistema de puntos de fidelidad. El saldo nunca se guarda como un
// número suelto — se calcula sumando el historial en
// loyalty_transactions, igual que "entradas vendidas" se calcula sumando
// tickets en vez de guardarse aparte. Así nunca puede desincronizarse.

import { pool } from "./db.js";

// Tarifas — fáciles de ajustar si algún día quieres cambiarlas.
export const POINTS_PER_EURO = 1; // se gana 1 punto por cada 1€ pagado
export const POINTS_PER_EURO_DISCOUNT = 100; // 100 puntos = 1€ de descuento

export async function getPointsBalance(userId) {
  const { rows } = await pool.query(
    "SELECT COALESCE(SUM(points), 0) AS balance FROM loyalty_transactions WHERE user_id = $1",
    [userId]
  );
  return Number(rows[0].balance);
}

// Cuántos céntimos de descuento dan X puntos, y a cuántos puntos "completos"
// equivale ese descuento (por si se pide un número de puntos que no encaja
// justo en euros — por ejemplo 150 puntos solo dan 1€, no 1,50€, porque el
// descuento se aplica en euros enteros).
export function discountForPoints(points) {
  const wholeEuros = Math.floor(points / POINTS_PER_EURO_DISCOUNT);
  return {
    discountCents: wholeEuros * 100,
    pointsUsed: wholeEuros * POINTS_PER_EURO_DISCOUNT,
  };
}

export async function recordPointsEarned(userId, amountCents, orderCode) {
  const points = Math.floor((amountCents / 100) * POINTS_PER_EURO);
  if (points <= 0) return 0;
  await pool.query(
    "INSERT INTO loyalty_transactions (user_id, points, reason, order_code) VALUES ($1, $2, 'ticket_purchase', $3)",
    [userId, points, orderCode]
  );
  return points;
}

export async function recordPointsRedeemed(userId, points, orderCode) {
  if (points <= 0) return;
  await pool.query(
    "INSERT INTO loyalty_transactions (user_id, points, reason, order_code) VALUES ($1, $2, 'ticket_redemption', $3)",
    [userId, -points, orderCode]
  );
}
