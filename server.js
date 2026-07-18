import express from "express";
import cors from "cors";
import { initDb } from "./db.js";
import { authRouter } from "./routes/auth.js";
import { eventsRouter } from "./routes/events.js";
import { meRouter } from "./routes/me.js";
import { ticketVerifyRouter } from "./routes/tickets.js";
import { venuesRouter } from "./routes/venues.js";
import { adminRouter } from "./routes/admin.js";

const app = express();

app.use(cors());
// Límite más alto de lo normal: las fotos de las fiestas viajan como texto
// en base64 dentro del JSON (ver notas en routes/events.js).
app.use(express.json({ limit: "6mb" }));

// Registra cada petición: método, ruta, código de respuesta y cuánto
// tardó. Sin esto, los logs de Render no dicen nada cuando algo se queda
// "colgado" desde el móvil — con esto, sabes al instante si la petición
// llegó o no.
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "eventos-backend" });
});

app.use("/api/auth", authRouter);
app.use("/api/events", eventsRouter);
app.use("/api/me", meRouter);
app.use("/api/tickets", ticketVerifyRouter);
app.use("/api/venues", venuesRouter);
app.use("/api/admin", adminRouter);

// Manejador de errores por si algo revienta de forma inesperada.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Error interno del servidor." });
});

const PORT = process.env.PORT || 3001;

// Esperamos a que las tablas existan antes de aceptar peticiones — así el
// primer arranque contra una base de datos nueva (por ejemplo, recién
// creada en Neon) no falla por llegar una petición antes de tiempo.
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`API escuchando en http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("No se pudo conectar con la base de datos:", err.message);
    process.exit(1);
  });
