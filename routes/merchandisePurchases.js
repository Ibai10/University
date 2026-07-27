import { Router } from "express";
import crypto from "node:crypto";
import QRCode from "qrcode";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";
import { sendMerchandiseEmail } from "../email.js";

export const merchandisePurchasesRouter = Router();

function genPurchaseCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[crypto.randomInt(chars.length)];
  return s.slice(0, 4) + "-" + s.slice(4);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Cuántas unidades quedan de un producto — igual que "available" en
// events se calcula restando "sold" de "capacity". NULL en stock = sin
// límite, siempre hay disponibles.
export async function stockAvailable(merchandiseId, stock) {
  if (stock == null) return Infinity;
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS sold FROM merchandise_purchases WHERE merchandise_id = $1 AND status IN ('valid', 'used')`,
    [merchandiseId]
  );
  return stock - Number(rows[0].sold);
}

// Confirma un pedido de merchandising 'pending' como pagado: crea una
// unidad comprada por cada una pedida (con su propio código y QR), y
// manda el email. La usa tanto el webhook de Redsys como el caso de
// "el precio es 0" (que en la práctica no debería darse aquí, ya que el
// merchandising no admite puntos de fidelidad, pero se deja preparado
// por si algún día un producto se regala/tiene precio 0).
export async function confirmPaidMerchandiseOrder(orderCode) {
  const orderResult = await pool.query("SELECT * FROM merchandise_orders WHERE order_code = $1", [orderCode]);
  const order = orderResult.rows[0];
  if (!order) {
    throw new Error("Pedido no encontrado.");
  }

  if (order.status === "paid") {
    const existing = await pool.query("SELECT * FROM merchandise_purchases WHERE order_id = $1", [orderCode]);
    return { order, purchases: existing.rows };
  }
  if (order.status !== "pending") {
    return { order, purchases: [] };
  }

  const merchResult = await pool.query("SELECT * FROM merchandise WHERE id = $1", [order.merchandise_id]);
  const merchandise = merchResult.rows[0];

  const available = await stockAvailable(merchandise.id, merchandise.stock);
  if (order.quantity > available) {
    await pool.query("UPDATE merchandise_orders SET status = 'failed', redsys_response = $1 WHERE id = $2", [
      "sin_stock_al_confirmar",
      order.id,
    ]);
    throw new Error("Ya no queda stock disponible para este pedido.");
  }

  const purchases = [];
  for (let i = 0; i < order.quantity; i++) {
    let code = genPurchaseCode();
    while ((await pool.query("SELECT id FROM merchandise_purchases WHERE code = $1", [code])).rows.length > 0) {
      code = genPurchaseCode();
    }
    const unitPrice = Math.round(order.amount_cents / order.quantity);
    const { rows } = await pool.query(
      `INSERT INTO merchandise_purchases (merchandise_id, buyer_id, unit_price_cents, code, order_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [merchandise.id, order.buyer_id, unitPrice, code, order.order_code]
    );
    purchases.push(rows[0]);
  }

  await pool.query("UPDATE merchandise_orders SET status = 'paid', paid_at = now() WHERE id = $1", [order.id]);

  const buyer = await pool.query("SELECT email, name FROM users WHERE id = $1", [order.buyer_id]);
  sendMerchandiseEmail({
    to: buyer.rows[0].email,
    buyerName: buyer.rows[0].name,
    purchases,
    merchandise,
  }).catch((err) => console.error("[email] Error inesperado enviando el producto:", err.message));

  return { order, purchases };
}

// GET /api/merchandise-purchases/:code/view
// Página pública con el QR de una unidad comprada — a esto lleva el
// enlace del email, igual que con las entradas.
merchandisePurchasesRouter.get("/:code/view", async (req, res, next) => {
  try {
    const code = req.params.code.trim().toUpperCase();
    const { rows } = await pool.query(
      `SELECT merchandise_purchases.*, merchandise.name AS merchandise_name
       FROM merchandise_purchases
       JOIN merchandise ON merchandise.id = merchandise_purchases.merchandise_id
       WHERE merchandise_purchases.code = $1`,
      [code]
    );
    const purchase = rows[0];
    if (!purchase) {
      return res.status(404).send(renderMessagePage("Producto no encontrado", "Revisa que el enlace esté completo."));
    }

    const qrDataUrl = await QRCode.toDataURL(purchase.code, { width: 260, margin: 1, color: { dark: "#0E2429", light: "#F5F1E8" } });
    const statusNote =
      purchase.status === "used"
        ? `<p style="color:#E8654A;font-size:13px;margin-top:16px;">Ya entregada el ${new Date(purchase.delivered_at).toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" })}.</p>`
        : "";

    res.set("Content-Type", "text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tu producto — ${escapeHtml(purchase.merchandise_name)}</title>
</head>
<body style="margin:0;background:#0E2429;font-family:Helvetica,Arial,sans-serif;display:flex;justify-content:center;padding:32px 16px;">
  <div style="max-width:420px;width:100%;background:#153136;border:1px solid #22474D;border-radius:20px;overflow:hidden;">
    <div style="padding:24px 24px 4px;">
      <h1 style="color:#F5F1E8;font-size:22px;margin:0 0 8px;">${escapeHtml(purchase.merchandise_name)}</h1>
      <p style="color:#8FA6A3;font-size:14px;margin:0;">Código de recogida</p>
    </div>
    <div style="border-top:1px dashed #22474D;margin:20px 0;"></div>
    <div style="padding:0 24px 28px;text-align:center;">
      <img src="${qrDataUrl}" alt="QR" style="width:200px;height:200px;" />
      <p style="color:#F2A93B;font-family:monospace;font-size:20px;letter-spacing:0.1em;margin-top:12px;">${purchase.code}</p>
      ${statusNote}
    </div>
  </div>
</body>
</html>`);
  } catch (err) {
    next(err);
  }
});

// POST /api/merchandise-purchases/:code/checkin
// Marca una unidad comprada como entregada/recogida — solo admin (quien
// gestiona el merchandising).
merchandisePurchasesRouter.post("/:code/checkin", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const code = req.params.code.trim().toUpperCase();
    const { rows } = await pool.query(
      `SELECT merchandise_purchases.*, merchandise.name AS merchandise_name
       FROM merchandise_purchases
       JOIN merchandise ON merchandise.id = merchandise_purchases.merchandise_id
       WHERE merchandise_purchases.code = $1`,
      [code]
    );
    const purchase = rows[0];
    if (!purchase) {
      return res.status(404).json({ error: "Ese código no existe. Revísalo." });
    }
    if (purchase.status === "used") {
      return res.status(409).json({
        error: `Esta unidad ya se entregó antes (${purchase.delivered_at}).`,
        alreadyUsed: true,
      });
    }
    if (purchase.status === "refunded") {
      return res.status(409).json({ error: "Esta compra fue reembolsada y ya no es válida." });
    }

    await pool.query("UPDATE merchandise_purchases SET status = 'used', delivered_at = now() WHERE id = $1", [purchase.id]);
    res.json({ ok: true, merchandiseName: purchase.merchandise_name });
  } catch (err) {
    next(err);
  }
});

function renderMessagePage(title, message) {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${title}</title></head>
<body style="margin:0;background:#0E2429;font-family:Helvetica,Arial,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:16px;">
  <div style="text-align:center;color:#F5F1E8;max-width:320px;">
    <h1 style="font-size:20px;">${title}</h1>
    <p style="color:#8FA6A3;font-size:14px;">${message}</p>
  </div>
</body>
</html>`;
}
