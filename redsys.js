// Firma y verificación de pagos con Redsys (TPV Virtual), el sistema que
// usan la mayoría de bancos españoles (Santander, BBVA, CaixaBank,
// Sabadell...) para cobrar con tarjeta.
//
// Redsys funciona por REDIRECCIÓN: el comercio no ve nunca el número de
// tarjeta — arma un formulario firmado, el navegador del cliente lo envía
// a Redsys, el cliente paga en la página del banco, y Redsys avisa al
// comercio de dos formas independientes:
//   1. Redirigiendo el navegador del cliente a tu URL OK/KO (solo para la
//      experiencia visual — no te fíes de esto para dar nada por bueno).
//   2. Una notificación servidor-a-servidor a tu URL de "MerchantURL",
//      firmada igual que la petición — ESTA es la que de verdad confirma
//      el pago, y es la que usamos para crear las entradas.
//
// Algoritmo (versión HMAC_SHA256_V1, la vigente):
//   1. clave_diversificada = 3DES-CBC(clave secreta, IV de ceros) del
//      número de pedido (Ds_Merchant_Order), sin relleno automático.
//   2. firma = HMAC-SHA256(Ds_MerchantParameters en base64, clave_diversificada)
//   3. firma en base64 es el valor de Ds_Signature.

import crypto from "node:crypto";

const ENVIRONMENT_URLS = {
  test: "https://sis-t.redsys.es:25443/sis/realizarPago",
  production: "https://sis.redsys.es/sis/realizarPago",
};

// Credenciales públicas de pruebas que el propio Redsys publica en su
// documentación oficial — funcionan sin tener todavía un contrato de TPV
// Virtual con tu banco. Cuando tengas las tuyas de verdad, solo hay que
// poner las variables de entorno; no hace falta tocar este archivo.
const DEFAULT_TEST_MERCHANT_CODE = "999008881";
const DEFAULT_TEST_TERMINAL = "1";
const DEFAULT_TEST_KEY = "sq7HjrUOBfKmC576ILgskD5srU870gJ7";

function getConfig() {
  const environment = process.env.REDSYS_ENVIRONMENT === "production" ? "production" : "test";
  return {
    environment,
    merchantCode: process.env.REDSYS_MERCHANT_CODE || DEFAULT_TEST_MERCHANT_CODE,
    terminal: process.env.REDSYS_TERMINAL || DEFAULT_TEST_TERMINAL,
    secretKey: process.env.REDSYS_SECRET_KEY || DEFAULT_TEST_KEY,
    url: ENVIRONMENT_URLS[environment],
  };
}

// Cifra el número de pedido con 3DES-CBC (IV de ceros, sin relleno
// automático — se rellena a mano con ceros hasta múltiplo de 8 bytes).
// Esto da la "clave diversificada" — una clave distinta para cada pedido,
// derivada de tu clave secreta fija.
function diversifyKey(orderCode, secretKeyBase64) {
  const key = Buffer.from(secretKeyBase64, "base64");
  const blockSize = 8;

  let message = Buffer.from(orderCode, "utf8");
  const remainder = message.length % blockSize;
  if (remainder !== 0) {
    message = Buffer.concat([message, Buffer.alloc(blockSize - remainder)]);
  }

  const cipher = crypto.createCipheriv("des-ede3-cbc", key, Buffer.alloc(8, 0));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(message), cipher.final()]);
}

function hmacSha256Base64(dataBase64, orderCode, secretKeyBase64) {
  const derivedKey = diversifyKey(orderCode, secretKeyBase64);
  return crypto.createHmac("sha256", derivedKey).update(dataBase64).digest("base64");
}

// Redsys exige que Ds_Merchant_Order tenga entre 4 y 12 caracteres, y que
// los 4 primeros sean numéricos — el resto puede ser alfanumérico.
export function generateOrderCode() {
  const digits = String(crypto.randomInt(0, 10000)).padStart(4, "0");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < 6; i++) suffix += alphabet[crypto.randomInt(alphabet.length)];
  return digits + suffix;
}

// Construye los tres campos que hay que mandar en el formulario que se
// envía (por POST) a la URL de Redsys.
export function buildPaymentForm({ orderCode, amountCents, description, merchantUrl, urlOk, urlKo }) {
  const { merchantCode, terminal, secretKey, url } = getConfig();

  const params = {
    Ds_Merchant_Amount: String(amountCents),
    Ds_Merchant_Order: orderCode,
    Ds_Merchant_MerchantCode: merchantCode,
    Ds_Merchant_Currency: "978", // EUR
    Ds_Merchant_TransactionType: "0", // Autorización estándar
    Ds_Merchant_Terminal: terminal,
    Ds_Merchant_MerchantURL: merchantUrl,
    Ds_Merchant_UrlOK: urlOk,
    Ds_Merchant_UrlKO: urlKo,
    Ds_Merchant_ProductDescription: (description || "").slice(0, 125),
    Ds_Merchant_MerchantName: "Fiestas Asturias",
  };

  const merchantParameters = Buffer.from(JSON.stringify(params), "utf8").toString("base64");
  const signature = hmacSha256Base64(merchantParameters, orderCode, secretKey);

  return {
    url,
    Ds_SignatureVersion: "HMAC_SHA256_V1",
    Ds_MerchantParameters: merchantParameters,
    Ds_Signature: signature,
  };
}

// Redsys codifica su respuesta en base64 "seguro para URL" (usa - y _ en
// vez de + y /) — hay que normalizarlo antes de decodificar o comparar.
function base64UrlToBuffer(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64");
}

// Verifica la notificación servidor-a-servidor que manda Redsys tras un
// pago. Devuelve los parámetros decodificados si la firma es válida, o
// null si no lo es (firma incorrecta = no te fíes de estos datos).
export function verifyNotification({ Ds_MerchantParameters, Ds_Signature }) {
  if (!Ds_MerchantParameters || !Ds_Signature) return null;

  const { secretKey } = getConfig();

  let params;
  try {
    params = JSON.parse(base64UrlToBuffer(Ds_MerchantParameters).toString("utf8"));
  } catch {
    return null;
  }

  // En la notificación, Redsys llama al pedido "Ds_Order" (no
  // "Ds_Merchant_Order" como en la petición) — comprobamos los dos por si
  // acaso, pero el que de verdad importa aquí es Ds_Order.
  const orderCode = params.Ds_Order || params.Ds_Merchant_Order;
  if (!orderCode) return null;

  const expected = base64UrlToBuffer(hmacSha256Base64(Ds_MerchantParameters, orderCode, secretKey));
  const received = base64UrlToBuffer(Ds_Signature);

  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return null;
  }

  return params;
}

// Ds_Response: "0000" a "0099" significa autorizada. Cualquier otro
// código es denegación o error — la lista completa está en el manual de
// Redsys, pero para nuestro caso solo necesitamos saber "aprobado o no".
export function isApproved(params) {
  const code = Number(params?.Ds_Response);
  return Number.isInteger(code) && code >= 0 && code <= 99;
}
