// Envío de emails con Resend (https://resend.com) — 3.000 emails/mes
// gratis, sin necesidad de verificar un dominio propio para empezar
// (usa el remitente de pruebas onboarding@resend.dev por defecto).
//
// Si no hay RESEND_API_KEY configurada, no falla — simplemente avisa por
// consola y no envía nada. Así, si alguien clona este proyecto sin
// configurar el email todavía, el resto de la app (comprar entradas,
// etc.) sigue funcionando con normalidad.

import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const FROM = process.env.EMAIL_FROM || "Festeo <onboarding@resend.dev>";
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || "http://localhost:3001";

function euros(cents) {
  return (cents / 100).toFixed(2).replace(/\.00$/, "");
}

export async function sendTicketEmail({ to, buyerName, tickets, event }) {
  if (!resend) {
    console.log(`[email] RESEND_API_KEY no configurada — no se envía email a ${to}.`);
    return;
  }

  const totalCents = tickets.reduce((sum, t) => sum + t.total_cents, 0);
  const count = tickets.length;

  const ticketRows = tickets
    .map((ticket, i) => {
      const viewUrl = `${PUBLIC_APP_URL}/api/tickets/${ticket.code}/view`;
      return `
        <div style="background:#050B1E;border:1px solid #22355C;border-radius:12px;padding:14px;margin-top:${i === 0 ? "20" : "10"}px;">
          <p style="color:#8B96C4;font-size:12px;margin:0 0 8px;">Entrada ${i + 1} de ${count} · <span style="font-family:monospace;color:#E91E8C;">${ticket.code}</span></p>
          <a href="${viewUrl}" style="display:block;text-align:center;background:#E91E8C;color:#050B1E;font-weight:bold;font-size:14px;text-decoration:none;padding:12px;border-radius:999px;">
            Ver esta entrada y su QR
          </a>
        </div>
      `;
    })
    .join("");

  const html = `
    <div style="background:#050B1E;padding:32px 16px;font-family:Helvetica,Arial,sans-serif;">
      <div style="max-width:480px;margin:0 auto;background:#0C1730;border-radius:16px;overflow:hidden;border:1px solid #22355C;">
        <div style="padding:28px 28px 20px;text-align:center;">
          <div style="width:48px;height:48px;border-radius:24px;background:#E91E8C;display:inline-flex;align-items:center;justify-content:center;font-size:24px;line-height:48px;margin-bottom:12px;">🎟️</div>
          <h1 style="color:#F5F1E8;font-size:22px;margin:0 0 4px;">¡Esta${count > 1 ? "s son tus entradas" : " es tu entrada"}!</h1>
          <p style="color:#8B96C4;font-size:14px;margin:0;">Hola ${buyerName || ""}, gracias por tu compra.</p>
        </div>
        <div style="padding:0 28px 24px;">
          <div style="background:#050B1E;border:1px solid #22355C;border-radius:12px;padding:16px;">
            <p style="color:#F0553D;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 4px;">${event.category}</p>
            <p style="color:#F5F1E8;font-size:17px;font-weight:bold;margin:0 0 8px;">${event.title}</p>
            <p style="color:#8B96C4;font-size:13px;margin:0;">${event.dateLabel}</p>
            <p style="color:#8B96C4;font-size:13px;margin:0 0 12px;">${event.location}</p>
            <p style="color:#8B96C4;font-size:13px;margin:0;">${count} entrada${count > 1 ? "s" : ""} · ${euros(totalCents)}€</p>
          </div>

          ${
            count > 1
              ? `<p style="color:#8B96C4;font-size:12px;text-align:center;margin-top:16px;">Cada entrada tiene su propio código — si vais varios, cada uno enseña la suya en la puerta.</p>`
              : ""
          }

          ${ticketRows}
        </div>
      </div>
    </div>
  `;

  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `Tu entrada para ${event.title}`,
      html,
    });
  } catch (err) {
    // Un fallo al enviar el email NUNCA debe tumbar la compra — la entrada
    // ya está guardada en la base de datos aunque el correo no llegue.
    console.error("[email] No se pudo enviar el correo de la entrada:", err.message);
  }
}

export async function sendMerchandiseEmail({ to, buyerName, purchases, merchandise }) {
  if (!resend) {
    console.log(`[email] RESEND_API_KEY no configurada — no se envía email a ${to}.`);
    return;
  }

  const totalCents = purchases.reduce((sum, p) => sum + p.unit_price_cents, 0);
  const count = purchases.length;

  const purchaseRows = purchases
    .map((purchase, i) => {
      const viewUrl = `${PUBLIC_APP_URL}/api/merchandise-purchases/${purchase.code}/view`;
      return `
        <div style="background:#050B1E;border:1px solid #22355C;border-radius:12px;padding:14px;margin-top:${i === 0 ? "20" : "10"}px;">
          <p style="color:#8B96C4;font-size:12px;margin:0 0 8px;">Unidad ${i + 1} de ${count} · <span style="font-family:monospace;color:#E91E8C;">${purchase.code}</span></p>
          <a href="${viewUrl}" style="display:block;text-align:center;background:#E91E8C;color:#050B1E;font-weight:bold;font-size:14px;text-decoration:none;padding:12px;border-radius:999px;">
            Ver este código de recogida
          </a>
        </div>
      `;
    })
    .join("");

  const html = `
    <div style="background:#050B1E;padding:32px 16px;font-family:Helvetica,Arial,sans-serif;">
      <div style="max-width:480px;margin:0 auto;background:#0C1730;border-radius:16px;overflow:hidden;border:1px solid #22355C;">
        <div style="padding:28px 28px 20px;text-align:center;">
          <div style="width:48px;height:48px;border-radius:24px;background:#E91E8C;display:inline-flex;align-items:center;justify-content:center;font-size:24px;line-height:48px;margin-bottom:12px;">🛍️</div>
          <h1 style="color:#F5F1E8;font-size:22px;margin:0 0 4px;">¡Gracias por tu compra!</h1>
          <p style="color:#8B96C4;font-size:14px;margin:0;">Hola ${buyerName || ""}, esto es lo que has comprado.</p>
        </div>
        <div style="padding:0 28px 24px;">
          <div style="background:#050B1E;border:1px solid #22355C;border-radius:12px;padding:16px;">
            <p style="color:#F5F1E8;font-size:17px;font-weight:bold;margin:0 0 8px;">${merchandise.name}</p>
            <p style="color:#8B96C4;font-size:13px;margin:0;">${count} unidad${count > 1 ? "es" : ""} · ${euros(totalCents)}€</p>
          </div>

          ${
            count > 1
              ? `<p style="color:#8B96C4;font-size:12px;text-align:center;margin-top:16px;">Cada unidad tiene su propio código, para poder recogerlas por separado si hace falta.</p>`
              : ""
          }

          ${purchaseRows}
        </div>
      </div>
    </div>
  `;

  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `Tu compra: ${merchandise.name}`,
      html,
    });
  } catch (err) {
    console.error("[email] No se pudo enviar el correo del producto:", err.message);
  }
}

export async function sendPasswordResetEmail({ to, name, code }) {
  if (!resend) {
    console.log(`[email] RESEND_API_KEY no configurada — no se envía email de recuperación a ${to}.`);
    return;
  }

  const html = `
    <div style="background:#050B1E;padding:32px 16px;font-family:Helvetica,Arial,sans-serif;">
      <div style="max-width:420px;margin:0 auto;background:#0C1730;border-radius:16px;overflow:hidden;border:1px solid #22355C;">
        <div style="padding:28px;text-align:center;">
          <h1 style="color:#F5F1E8;font-size:20px;margin:0 0 8px;">Recupera tu contraseña</h1>
          <p style="color:#8B96C4;font-size:14px;margin:0 0 24px;">Hola ${name || ""}, usa este código en la app para elegir una contraseña nueva. Caduca en 15 minutos.</p>
          <div style="background:#050B1E;border:1px solid #22355C;border-radius:12px;padding:20px;">
            <p style="color:#E91E8C;font-family:monospace;font-size:32px;letter-spacing:0.15em;margin:0;">${code}</p>
          </div>
          <p style="color:#8B96C4;font-size:12px;margin-top:20px;">
            Si no has pedido esto, puedes ignorar este correo — tu contraseña actual sigue siendo válida.
          </p>
        </div>
      </div>
    </div>
  `;

  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: "Tu código para recuperar la contraseña",
      html,
    });
  } catch (err) {
    console.error("[email] No se pudo enviar el correo de recuperación:", err.message);
  }
}
