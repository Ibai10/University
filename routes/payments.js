import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { buildPaymentForm, verifyNotification, isApproved } from "../redsys.js";
import { genCode, ticketStatsFor } from "./events.js";
import { sendTicketEmail } from "../email.js";
import { formatDateLabel } from "../dateFormat.js";

export const paymentsRouter = Router();

function publicUrl() {
  return process.env.PUBLIC_APP_URL || "http://localhost:3001";
}

// GET /api/payments/:orderCode/form
// Página pública que arma el formulario de Redsys y lo envía solo (con un
// pequeño script) en cuanto se carga — es el "puente" entre nuestra app y
// la página de pago real del banco. Pública a propósito: el orderCode ya
// hace de identificador de un solo uso.
paymentsRouter.get("/:orderCode/form", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT payment_orders.*, events.title AS event_title
       FROM payment_orders JOIN events ON events.id = payment_orders.event_id
       WHERE order_code = $1`,
      [req.params.orderCode]
    );
    const order = rows[0];
    if (!order) return res.status(404).send(renderMessagePage("Pedido no encontrado", "Revisa el enlace."));
    if (order.status !== "pending") {
      return res.send(renderMessagePage("Este pedido ya se procesó", "Vuelve a la app para ver el resultado."));
    }

    const form = buildPaymentForm({
      orderCode: order.order_code,
      amountCents: order.amount_cents,
      description: order.event_title,
      merchantUrl: `${publicUrl()}/api/payments/notify`,
      urlOk: `${publicUrl()}/api/payments/${order.order_code}/ok`,
      urlKo: `${publicUrl()}/api/payments/${order.order_code}/ko`,
    });

    res.set("Content-Type", "text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Redirigiendo al pago...</title>
</head>
<body style="margin:0;background:#0E2429;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:Helvetica,Arial,sans-serif;">
  <p style="color:#F5F1E8;font-size:14px;">Te estamos llevando a la página de pago segura...</p>
  <form id="redsysForm" method="POST" action="${form.url}">
    <input type="hidden" name="Ds_SignatureVersion" value="${form.Ds_SignatureVersion}" />
    <input type="hidden" name="Ds_MerchantParameters" value="${form.Ds_MerchantParameters}" />
    <input type="hidden" name="Ds_Signature" value="${form.Ds_Signature}" />
  </form>
  <script>document.getElementById('redsysForm').submit();</script>
</body>
</html>`);
  } catch (err) {
    next(err);
  }
});

// POST /api/payments/notify
// A esta URL llama Redsys directamente (servidor a servidor), no el
// navegador de nadie — es la confirmación de verdad, la única en la que
// nos fiamos para crear las entradas. Redsys manda los datos como
// formulario normal (no JSON), por eso este router usa su propio parser
// de x-www-form-urlencoded (ver server.js).
paymentsRouter.post("/notify", async (req, res) => {
  try {
    const params = verifyNotification(req.body || {});
    if (!params) {
      console.error("[redsys] Notificación con firma inválida, se ignora.");
      return res.status(400).send("KO");
    }

    const orderCode = params.Ds_Order;
    const { rows } = await pool.query("SELECT * FROM payment_orders WHERE order_code = $1", [orderCode]);
    const order = rows[0];
    if (!order) {
      console.error("[redsys] Notificación de un pedido que no existe:", orderCode);
      return res.status(404).send("KO");
    }

    // Idempotencia: Redsys puede reintentar la misma notificación más de
    // una vez. Si ya lo procesamos, no lo repetimos.
    if (order.status !== "pending") {
      return res.send("OK");
    }

    if (!isApproved(params)) {
      await pool.query("UPDATE payment_orders SET status = 'failed', redsys_response = $1 WHERE id = $2", [
        params.Ds_Response || "desconocido",
        order.id,
      ]);
      return res.send("OK");
    }

    // Vuelve a comprobar el aforo AHORA — puede haber pasado tiempo desde
    // que se inició el pago y otra persona podría haber agotado las
    // entradas mientras tanto.
    const eventResult = await pool.query("SELECT * FROM events WHERE id = $1", [order.event_id]);
    const event = eventResult.rows[0];
    const { sold } = await ticketStatsFor(event.id);
    const available = event.capacity - sold;

    if (order.quantity > available) {
      // Caso raro (pago aprobado pero ya no queda aforo): lo dejamos
      // registrado como fallido de cara al aforo, pero el dinero ya se ha
      // cobrado — un caso así necesitaría un reembolso manual. Se anota
      // como mejora futura en el README (reservar aforo al iniciar el
      // pago, no solo comprobarlo).
      await pool.query("UPDATE payment_orders SET status = 'failed', redsys_response = $1 WHERE id = $2", [
        "sin_aforo_al_confirmar",
        order.id,
      ]);
      console.error(`[redsys] Pedido ${orderCode} pagado pero sin aforo disponible — requiere reembolso manual.`);
      return res.send("OK");
    }

    const tickets = [];
    for (let i = 0; i < order.quantity; i++) {
      let code = genCode();
      while ((await pool.query("SELECT id FROM tickets WHERE code = $1", [code])).rows.length > 0) {
        code = genCode();
      }
      const unitPrice = Math.round(order.amount_cents / order.quantity);
      const ticketResult = await pool.query(
        `INSERT INTO tickets (event_id, buyer_id, quantity, unit_price_cents, total_cents, code, order_id)
         VALUES ($1, $2, 1, $3, $3, $4, $5)
         RETURNING *`,
        [event.id, order.buyer_id, unitPrice, code, order.order_code]
      );
      tickets.push(ticketResult.rows[0]);
    }

    await pool.query(
      "UPDATE payment_orders SET status = 'paid', redsys_response = $1, paid_at = now() WHERE id = $2",
      [params.Ds_Response, order.id]
    );

    const buyer = await pool.query("SELECT email, name FROM users WHERE id = $1", [order.buyer_id]);
    sendTicketEmail({
      to: buyer.rows[0].email,
      buyerName: buyer.rows[0].name,
      tickets,
      event: { ...event, dateLabel: formatDateLabel(event.event_date, event.event_time) },
    }).catch((err) => console.error("[email] Error inesperado enviando la entrada:", err.message));

    res.send("OK");
  } catch (err) {
    console.error("[redsys] Error procesando la notificación:", err);
    res.status(500).send("KO");
  }
});

// GET /api/payments/:orderCode/status
// La app pregunta aquí cada pocos segundos mientras el navegador de pago
// está abierto (o después de cerrarlo), para saber en cuanto se confirme.
paymentsRouter.get("/:orderCode/status", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM payment_orders WHERE order_code = $1", [req.params.orderCode]);
    const order = rows[0];
    if (!order) return res.status(404).json({ error: "Pedido no encontrado." });
    if (order.buyer_id !== req.user.id) {
      return res.status(403).json({ error: "Este pedido no es tuyo." });
    }

    let tickets = [];
    if (order.status === "paid") {
      const ticketRows = await pool.query("SELECT * FROM tickets WHERE order_id = $1", [order.order_code]);
      tickets = ticketRows.rows;
    }

    res.json({ status: order.status, tickets });
  } catch (err) {
    next(err);
  }
});

// GET /api/payments/:orderCode/ok  y  /ko
// A donde Redsys redirige el NAVEGADOR (no el servidor) tras el pago —
// solo es informativo para la persona; la confirmación real ya llegó (o
// llegará) por /notify. Por eso aquí no hace falta ni comprobar nada.
paymentsRouter.get("/:orderCode/ok", (req, res) => {
  res.send(
    renderMessagePage("¡Pago recibido!", "Ya puedes cerrar esta ventana y volver a la app — tu entrada se está preparando.")
  );
});

paymentsRouter.get("/:orderCode/ko", (req, res) => {
  res.send(renderMessagePage("Pago no completado", "Puedes cerrar esta ventana y volver a la app para intentarlo de nuevo."));
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
