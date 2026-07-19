# Backend — App de fiestas (graduaciones, universitarias, despedidas)

API REST + PostgreSQL para la app. Pensado para poder alojarse en un
servidor real (Render, Railway...) y no depender de tu ordenador.

## Requisitos

- Node.js **20 o superior**. Comprueba tu versión con `node --version`.
- Una base de datos PostgreSQL. La forma más simple de conseguir una
  gratis, sin instalar nada en tu ordenador, es [Neon](https://neon.tech)
  (ver el paso 0 de abajo) — es la misma que usarás cuando despliegues de
  verdad, así que sirve para local y para producción con la misma cuenta.

## Puesta en marcha

### 0. Consigue una base de datos Postgres (una vez, gratis)

1. Entra en [neon.tech](https://neon.tech) y crea una cuenta (no pide
   tarjeta).
2. Crea un proyecto nuevo. Te da una **cadena de conexión** parecida a:
   `postgres://usuario:contraseña@ep-algo.eu-central-1.aws.neon.tech/neondb?sslmode=require`
3. Cópiala — la necesitas en el paso 2.

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Abre `.env` y ajusta:
- `JWT_SECRET`: cualquier cadena larga y aleatoria.
- `DATABASE_URL`: pega aquí la cadena de conexión de Neon del paso 0.

### 3. Crear las tablas y los datos de ejemplo

```bash
npm run seed
```

### 4. Arrancar el servidor

```bash
npm run dev
```

Verás `API escuchando en http://localhost:3001`.

### Usuarios de prueba (creados por `npm run seed`)

| Rol         | Email                     | Contraseña   |
|-------------|---------------------------|--------------|
| Organizador | organizador@ejemplo.com   | organiza123  |
| Comprador   | invitado@ejemplo.com      | entrada123   |

## Cómo alojarlo de verdad (que no dependa de tu ordenador)

Con esto tienes una API en internet, con HTTPS, corriendo 24 horas al día
sin que tu ordenador tenga que estar encendido.

### Paso 1: sube el código a GitHub

Si no tienes cuenta de GitHub, créate una en [github.com](https://github.com)
(gratis). Luego, dentro de esta carpeta (`backend`):

```bash
git init
git add .
git commit -m "Primer commit del backend"
```

Crea un repositorio nuevo en GitHub (botón "New" en github.com), y sigue
las instrucciones que te da para conectar tu carpeta con ese repositorio
(algo como `git remote add origin ...` y `git push`).

### Paso 2: despliega en Render

1. Entra en [render.com](https://render.com) y crea una cuenta con tu
   GitHub (así puede ver tus repositorios).
2. "New +" → "Blueprint". Elige el repositorio que acabas de crear. Este
   proyecto ya incluye un `render.yaml`, así que Render configura casi todo
   solo: nombre del servicio, comando de arranque, etc.
3. Te pedirá el valor de `DATABASE_URL` — pega la cadena de conexión de
   Neon del paso 0. `JWT_SECRET` se genera solo, no hace falta que lo
   escribas.
4. Dale a desplegar. En unos minutos tendrás una URL parecida a
   `https://eventos-backend.onrender.com`.
5. Compruébalo abriendo `https://tu-url.onrender.com/api/health` en el
   navegador — debería devolver `{"ok":true,...}`.
6. Entra por SSH/Shell de Render (o simplemente ejecuta `npm run seed` una
   vez apuntando tu `DATABASE_URL` local a la misma base de datos de Neon)
   para tener las fiestas de ejemplo también en producción.

Esa URL (con `/api` al final) es la que tienes que poner en
`EXPO_PUBLIC_API_URL` en el proyecto de la app — mira su README.

### Cosas que conviene saber sobre el plan gratuito de Render

- El servicio gratuito **se "duerme" tras 15 minutos sin tráfico**, y la
  primera petición después tarda ~30-60 segundos en despertar. Normal para
  probarlo tú; molesto si alguien más lo usa a diario. Cuando quieras que
  esté siempre despierto, el plan de pago (unos 7$/mes) lo soluciona.
- **No uses el Postgres gratuito de Render** para esto — caduca a los 30
  días y se borra. Neon es gratis y no caduca, por eso lo recomendamos para
  la base de datos en vez del Postgres del propio Render.

## Sistema de roles

Cuatro roles, guardados en `users.role`:

| Rol | Puede |
|-----|-------|
| `comprador` (por defecto) | Navegar y comprar entradas |
| `organizador` | Todo lo del comprador + publicar/cancelar/borrar sus fiestas + añadir discotecas + validar entradas de sus propias fiestas |
| `validador` | Validar entradas de **cualquier** fiesta. No puede comprar entradas ni organizar — su cuenta existe solo para hacer de puerta |
| `admin` | Todo, sobre cualquier fiesta (no solo las suyas) + gestionar el rol de otros usuarios |

Nadie puede auto-asignarse `organizador`, `validador` ni `admin` al
registrarse — siempre nace como `comprador`. Para nombrar al primer
administrador sin tocar la base de datos a mano:

1. Añade `ADMIN_EMAIL=tu-email@ejemplo.com` en las variables de entorno
   (local y en Render).
2. Inicia sesión (o regístrate, si esa cuenta es nueva) con ese email.
3. Esa cuenta pasa a `admin` automáticamente en ese mismo momento.

A partir de ahí, entra en el Perfil de la app → "Panel de administración"
para buscar a cualquier otro usuario y cambiarle el rol.

**Importante**: el rol se comprueba en cada petición leyendo la base de
datos, no el token — si un admin te asciende a `organizador`, puedes
publicar fiestas al momento, sin tener que cerrar sesión y volver a
entrar.

## Residencias de estudiantes

Una residencia es un grupo cerrado con su propio código de acceso: quien
lo introduce pasa a ver, además del listado público normal, las fiestas
que se hayan marcado como exclusivas de esa residencia — nadie más las ve.

- **Solo un admin puede crear una residencia** (`POST /api/residencias`),
  y al crearla se genera un código único al momento (8 caracteres, sin
  0/O ni 1/I para que no se confundan al escribirlo a mano).
- **Cualquier usuario se une con ese código** (`POST /api/residencias/join`)
  — pasa a guardarse en `users.residencia_id`. Puede salir cuando quiera
  (`POST /api/residencias/leave`) o unirse a otra distinta más adelante
  (el código nuevo simplemente sustituye al anterior).
- **Solo un admin puede marcar una fiesta como exclusiva** de una
  residencia al publicarla (`POST /api/events` admite un `residencia_id`
  opcional) — un organizador normal solo publica fiestas públicas.
- **La visibilidad se aplica en dos sitios**: el listado (`GET
  /api/events`) simplemente no incluye las fiestas exclusivas de
  residencias a las que no perteneces, y el detalle de una fiesta
  concreta (`GET /api/events/:id`) también lo comprueba — no basta con no
  aparecer en el listado, tampoco se puede abrir directamente por su id.
  Un admin sí ve todo, sea de la residencia que sea.
- **`category` (el nombre de la discoteca) y `residencia_id` son cosas
  independientes** — una fiesta exclusiva de una residencia sigue
  teniendo su discoteca/sala normal, la residencia solo decide quién
  puede verla, no dónde se celebra.

## Pago con tarjeta (Redsys / TPV Virtual)

Redsys es el sistema que usan la mayoría de bancos españoles (Santander,
BBVA, CaixaBank, Sabadell...) para cobrar con tarjeta. Funciona por
**redirección**: la persona paga en la página del banco, no dentro de tu
app ni de tu web — así nunca ves ni guardas un número de tarjeta.

### Cómo funciona el flujo

1. La app llama a `POST /api/events/:id/pay`. Esto **no crea ninguna
   entrada todavía** — solo registra un "pedido" en estado `pending` y
   devuelve una URL.
2. La app abre esa URL en el navegador del móvil. Es una página nuestra
   que arma el formulario de Redsys (firmado) y lo envía sola — de ahí
   pasa ya a la página real del banco.
3. La persona paga (o cancela) en la página del banco.
4. Redsys avisa **a nuestro servidor directamente** (no al móvil) en
   `POST /api/payments/notify`, con los datos firmados. Solo cuando esta
   notificación llega y su firma es válida, se crean las entradas de
   verdad — una fila por entrada, igual que en el resto de la app.
5. Mientras tanto, la app pregunta `GET /api/payments/:orderCode/status`
   cada pocos segundos hasta ver `paid` (o `failed`), y entonces muestra
   la confirmación con las entradas ya creadas.

### Probarlo ahora mismo, sin esperar al banco

Redsys publica unas credenciales de **prueba** oficiales que funcionan
sin tener todavía un contrato de TPV Virtual — por eso, si no rellenas
nada en las variables `REDSYS_*`, el backend las usa automáticamente. Para
probar un pago de principio a fin:

- **Tarjeta que simula un pago aprobado**: `4548 8120 4940 0004`,
  caducidad `12/34`, CVC `123`.
- **Tarjeta que simula un pago denegado**: `1111 1111 1111 1117`.

### Pasar a cobros reales

Cuando tu banco te dé las credenciales de tu TPV Virtual (código de
comercio, terminal y clave secreta), rellena estas tres variables y
cambia el entorno — no hace falta tocar ni una línea de código:

```
REDSYS_ENVIRONMENT=production
REDSYS_MERCHANT_CODE=tu-codigo-real
REDSYS_TERMINAL=tu-terminal-real
REDSYS_SECRET_KEY=tu-clave-secreta-real
```

Para conseguir esas credenciales: se piden **a tu banco** (no a Redsys
directamente), como parte de contratar un "TPV Virtual" — normalmente
piden tener actividad y web operativa (aviso legal, política de
privacidad). El banco primero te da credenciales de _pruebas_ para que
verifiques que todo funciona (que es justo lo que ya tienes montado y
probado), y cuando confirmes que va bien, te da las de producción.

### Cosas que conviene saber

- **`POST /api/events/:id/purchase` (el que ya teníamos) se queda tal
  cual**, sin pago real — sigue siendo útil para pruebas rápidas o
  sembrar datos, pero la app ya no lo usa para comprar de verdad.
- **La notificación de Redsys es la única fuente de verdad.** Lo que le
  pase al navegador del cliente (si cierra la pestaña, si su móvil se
  queda sin batería a mitad de pago...) no importa — en cuanto Redsys
  confirme al servidor, las entradas se crean igualmente.
- **Es resistente a reintentos**: si Redsys manda la misma notificación
  dos veces (a veces pasa), la segunda no crea entradas duplicadas — se
  detecta que el pedido ya se procesó y se ignora.
- **Vuelve a comprobar el aforo en el momento de la confirmación**, no
  solo al iniciar el pago — por si ha pasado tiempo y alguien más agotó
  las entradas mientras tanto. Si eso ocurriera (pago aprobado pero sin
  aforo ya), el pedido queda marcado como fallido y anotado en los logs
  para gestionar un reembolso a mano — es un caso raro, pero puede pasar
  sin una reserva temporal de aforo (mejora anotada más abajo).

## Email de la entrada al comprar

Cuando alguien compra, recibe un email con "¡Esta es tu entrada!" y un
enlace a una página con su código QR — no hace falta tener la app
instalada para verla ni para enseñarla en la puerta.

### Configurarlo (5 minutos, gratis)

1. Entra en [resend.com](https://resend.com) y crea una cuenta (no pide
   tarjeta). El plan gratis da 3.000 emails al mes, de sobra para esto.
2. En el panel, ve a **API Keys** → **Create API Key**. Copia la clave
   (empieza por `re_...`).
3. En tu `.env` local:
   ```
   RESEND_API_KEY=re_tu_clave_aqui
   PUBLIC_APP_URL=http://localhost:3001
   ```
4. En Render (Environment): añade esas mismas dos variables, pero con
   `PUBLIC_APP_URL` apuntando a tu URL real de Render (ej.
   `https://eventos-backend-i9gl.onrender.com`).

No hace falta verificar un dominio propio para empezar — por defecto los
emails se envían desde `onboarding@resend.dev`, un remitente de pruebas de
Resend que funciona sin configuración adicional. Cuando quieras que el
remitente sea el tuyo (ej. `entradas@tudominio.com`), verifica tu dominio
en Resend y cambia `EMAIL_FROM` en las variables de entorno.

**Si no configuras `RESEND_API_KEY`, la app sigue funcionando igual** —
comprar entradas no falla, simplemente no se envía el email (avisa por
consola). Así puedes seguir desarrollando sin tener la cuenta de Resend
lista todavía.

## Endpoints

Todas las rutas devuelven JSON. Las que requieren sesión necesitan el header
`Authorization: Bearer <token>` (el token lo devuelven login y register).

| Método | Ruta                        | Auth | Descripción |
|--------|-----------------------------|:---:|-------------|
| GET    | `/api/health`               |  —  | Comprobación de que la API está viva |
| POST   | `/api/auth/register`        |  —  | Crea una cuenta. Body: `{ email, password, name, nickname }` |
| POST   | `/api/auth/login`           |  —  | Inicia sesión. Body: `{ email, password }` |
| POST   | `/api/auth/forgot-password` |  —  | Pide un código de recuperación por email. Body: `{ email }` |
| POST   | `/api/auth/reset-password`  |  —  | Cambia la contraseña con el código. Body: `{ email, code, newPassword }` |
| GET    | `/api/events`               |  —  | Lista fiestas publicadas. Filtros opcionales: `?category=Despedidas&q=gijon` |
| GET    | `/api/events/:id`           |  —  | Detalle de una fiesta |
| POST   | `/api/events`               |  ✓  | Publica una fiesta nueva (admite `image` en base64) |
| POST   | `/api/events/:id/purchase`  |  ✓  | Crea la entrada al momento, SIN pago real — pensado para pruebas rápidas, no para producción (ver "Pago con tarjeta" abajo) |
| POST   | `/api/events/:id/pay`       |  ✓  | Inicia un pago DE VERDAD con Redsys. Body: `{ quantity }` → devuelve `{ orderCode, paymentUrl }` |
| POST   | `/api/payments/notify`      |  —  | Webhook de Redsys (servidor a servidor) — no lo llama nadie a mano |
| GET    | `/api/payments/:orderCode/status` |  ✓  | Estado de un pedido de pago: `pending` / `paid` / `failed` |
| PATCH  | `/api/events/:id/cancel`    |  ✓  | Cancela tu fiesta (conserva las entradas ya vendidas) |
| DELETE | `/api/events/:id`           |  ✓  | Borra tu fiesta — solo si no tiene entradas vendidas |
| GET    | `/api/events/mine`          |  ✓  | Tus fiestas publicadas, con ventas e ingresos |
| GET    | `/api/me/tickets`           |  ✓  | Tus entradas compradas |
| POST   | `/api/tickets/:code/checkin`|  ✓  | Valida una entrada por su código (el que lleva el QR) y la marca como usada. Solo funciona si la fiesta es tuya. |
| GET    | `/api/tickets/:code/view`   |  —  | Página pública con el QR de la entrada — a esto lleva el enlace del email |
| GET    | `/api/venues`               |  —  | Lista las discotecas/salas conocidas (para el selector de categoría) |
| POST   | `/api/venues`               |  ✓  | Añade una discoteca nueva a la lista. Body: `{ name }` — requiere rol organizador o admin |
| GET    | `/api/admin/users`          |  ✓  | Busca usuarios por email/nickname/nombre (`?q=`) — solo admin |
| PATCH  | `/api/admin/users/:id/role` |  ✓  | Cambia el rol de un usuario. Body: `{ role }` — solo admin |
| GET    | `/api/residencias`          |  ✓  | Lista las residencias con su código — solo admin |
| POST   | `/api/residencias`          |  ✓  | Crea una residencia y le genera un código único. Body: `{ name }` — solo admin |
| POST   | `/api/residencias/join`     |  ✓  | Te une a una residencia por su código. Body: `{ code }` |
| POST   | `/api/residencias/leave`    |  ✓  | Dejas de pertenecer a tu residencia actual |

### Ejemplo rápido con curl

```bash
# Login
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"invitado@ejemplo.com","password":"entrada123"}'
# -> copia el "token" de la respuesta

# Comprar 2 entradas del evento con id 3
curl -X POST http://localhost:3001/api/events/3/purchase \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN_AQUI" \
  -d '{"quantity":2}'
```

## Cómo está organizado

```
backend/
  server.js          punto de entrada: monta Express y las rutas
  db.js              conexión PostgreSQL + creación de tablas
  auth.js            hash de contraseñas (scrypt) y JWT
  redsys.js            firma y verificación de pagos con Redsys
  email.js            envío del email de la entrada (Resend)
  dateFormat.js        formatea fechas en español, compartido por email y la vista de entrada
  seed.js            datos de ejemplo (npm run seed)
  render.yaml         configuración de despliegue en Render
  middleware/
    requireAuth.js   protege rutas comprobando el token y el rol
  routes/
    auth.js          registro (con nickname) / login / recuperar contraseña
    events.js         listar, crear, comprar/pagar, "mis fiestas"
    me.js             "mis entradas"
    tickets.js         validar por código (QR) + página pública de la entrada
    venues.js          listar y añadir discotecas/salas
    admin.js           buscar usuarios y cambiar su rol (solo admin)
    payments.js         formulario de pago, webhook de Redsys, estado del pedido
    residencias.js       crear residencias, unirse por código (solo admin crea)
```

## Decisiones de diseño que conviene conocer

- **El precio se guarda en céntimos** (`price_cents`, entero), no en euros
  con decimales. Es la forma estándar de evitar errores de redondeo con
  dinero. El frontend debe dividir entre 100 al mostrarlo.
- **No existe una columna "entradas disponibles"**. Se calcula siempre como
  `capacity - entradas vendidas`, para que nunca pueda quedar
  desincronizada de las compras reales (que es justo el mismo enfoque que
  usa ya el prototipo de React).
- **Comprar "3 entradas" crea 3 filas en `tickets`, no 1 fila con
  `quantity=3`.** Cada entrada tiene su propio `code` y su propio QR — así
  cada persona del grupo se valida por separado en la puerta. `order_id`
  (un UUID) agrupa las que se compraron juntas, por si algún día hace
  falta mostrarlas o gestionarlas como un solo pedido. `POST
  .../purchase` devuelve `{ orderId, tickets: [...] }`, un array, no una
  entrada suelta.
- **"Vendida" y "validada" son cosas distintas.** Una entrada cuenta como
  vendida (y sigue ocupando aforo) mientras su estado sea `valid` o
  `used` — validarla en la puerta no la "deshace". Solo `refunded` deja de
  contar. `withAvailability` devuelve `sold` (vendidas) y `validated`
  (cuántas de esas ya se validaron) por separado.
- **La compra comprueba el aforo en el momento de guardar**, no antes. Así
  dos compras casi simultáneas no pueden sobrevender las últimas entradas.
- **El QR de cada entrada codifica su `code`** (el mismo que ya existía,
  tipo `SY7E-DVQR`), no una URL — así el escaneo funciona sin depender de
  tener un dominio público. Al escanearla, la entrada pasa a `status =
  'used'` y queda registrada `checked_in_at`: una vez validada, un segundo
  escaneo (por ejemplo, de una captura de pantalla reenviada) se rechaza.
- **Solo el organizador dueño de la fiesta puede validar sus entradas** —
  el check-in comprueba `events.organizer_id` contra el usuario autenticado.
- **`requireAuth` comprueba que el usuario del token siga existiendo** en
  la base de datos, no solo que la firma sea válida. Esto evita errores
  confusos si alguna vez vuelves a ejecutar `npm run seed` con una sesión
  ya abierta en el móvil — en vez de romper, responde con un 401 claro.
- **`sold` cuenta las entradas válidas Y las ya validadas en la puerta**
  (todo lo que no sea `refunded`). En un primer momento solo contaba las
  `valid`, así que en cuanto alguien validaba su entrada, "desaparecía" del
  conteo de vendidas y de paso liberaba aforo que en realidad seguía
  ocupado — quedó corregido para que validar una entrada nunca reduzca las
  ventas ni abra hueco donde no lo hay. `validated` es un conteo aparte,
  solo de las que ya se usaron en la puerta.
- **Cancelar no es lo mismo que borrar.** Cancelar (`PATCH .../cancel`)
  siempre está disponible y conserva el historial — las entradas ya
  vendidas no desaparecen. Borrar (`DELETE`) solo se permite si nadie ha
  comprado entradas todavía; si ya hay ventas, el backend lo rechaza (409)
  y sugiere cancelar en su lugar, para no destruir el comprobante de compra
  de alguien que ya pagó.
- **La foto de la fiesta se guarda como base64 dentro de la propia fila**
  (`image_base64`), no como archivo aparte. Es la opción más simple para
  este tamaño de proyecto — sin necesidad de servir archivos estáticos ni
  gestionar su borrado. Si el proyecto crece mucho, el paso natural es
  moverlas a almacenamiento de objetos (S3, Cloudinary...) y guardar solo
  la URL.
- **Por qué PostgreSQL y no el SQLite de antes**: SQLite guardaba todo en
  un archivo en el disco de tu ordenador. La mayoría de plataformas de
  alojamiento (Render incluido) borran ese disco en cada despliegue o
  reinicio, así que un archivo así no sobrevive en producción. Postgres es
  un servidor de base de datos aparte (en este caso, gestionado por Neon),
  así que tus datos viven ahí, no en el mismo sitio que el código.
- **La página de la entrada (`/api/tickets/:code/view`) es pública a
  propósito**, sin login — es el mismo nivel de acceso que una entrada de
  papel: quien tiene el código (o el enlace del email), la ve. El código
  es suficientemente largo y aleatorio como para que adivinarlo a ciegas
  no sea viable.
- **El fallo al enviar un email nunca tumba la compra.** La entrada se
  guarda primero en la base de datos; el envío del email pasa después y
  cualquier error se registra en los logs sin afectar a la respuesta que
  recibe quien compra — su entrada ya es válida aunque el correo no llegue
  (siempre puede volver a verla si tú le compartes el enlace a mano).
- **Recuperar contraseña usa un código de 6 dígitos por email, no un
  enlace.** Un enlace que abriera la app directamente necesitaría
  configurar "deep links", que se comportan distinto en Expo Go que en una
  build de verdad — un código que se escribe a mano dentro de la propia
  app evita ese lío y funciona igual en todos los casos.
- **`forgot-password` responde siempre igual**, exista o no una cuenta con
  ese email — así nadie puede usarlo para averiguar qué emails están
  registrados en la app.
- **El código de recuperación se guarda con hash (scrypt), nunca en
  texto**, igual que las contraseñas. Caduca a los 15 minutos y se
  bloquea tras 5 intentos fallidos (hay que pedir uno nuevo) — así no se
  puede adivinar a base de probar.
- **El nickname es único ignorando mayúsculas/minúsculas** (`Ibai10` y
  `ibai10` no pueden coexistir) — mismo enfoque que ya usábamos para el
  email. Formato: 3-20 caracteres, sin espacios, letras (incluidas
  acentuadas), números, guiones o puntos.
- **Las discotecas ya no son una lista fija de 3 valores** ("category" ya
  no tiene un `CHECK` que la limite a Graduaciones/Universitarias/
  Despedidas). En su lugar, `venues` guarda los nombres que se van
  añadiendo desde la app, y `events.category` sigue siendo texto libre —
  no una clave foránea — para no forzar una migración de los datos que
  ya existían. Los nombres de discoteca son únicos también ignorando
  mayúsculas, para que no se dupliquen por un simple cambio de mayúscula.

## Próximos pasos naturales

- **Merchandising por residencia** — pendiente de decidir el alcance (¿solo
  catálogo para ver, o ya se puede comprar con Redsys como las entradas?)
  antes de construirlo. La tabla `residencias` ya existe y está lista
  para colgar de ahí un catálogo de productos cuando se decida.

- **Reservar el aforo al iniciar el pago, no solo comprobarlo.** Ahora
  mismo, entre que alguien empieza a pagar y Redsys confirma, ese aforo no
  está "apartado" — si dos personas casi a la vez agotan las últimas
  entradas, el segundo pago podría aprobarse sin que quede sitio (se
  detecta y no se crea la entrada, pero ya se ha cobrado — necesitaría un
  reembolso manual). El paso natural es un estado "reservado" con
  caducidad de unos minutos mientras dura el pago.
- **Los `validador` pueden validar entradas de cualquier fiesta, no solo
  de una en concreto.** Es la simplificación de partida: no existe (todavía)
  una relación de "este validador trabaja para este organizador/esta
  fiesta". Si hiciera falta restringirlo, el paso natural es una tabla
  `event_validators (event_id, user_id)` y comprobar esa asignación en
  `POST /api/tickets/:code/checkin` en vez de aceptar el rol sin más.
- Verificar un dominio propio en Resend para que los emails no salgan
  desde `onboarding@resend.dev`, y añadir un reenvío manual ("¿no te llegó
  el email? reenviar") desde la propia app.
- Cuando el tráfico crezca de verdad, pasar del plan gratuito de Render a
  uno de pago (para que no se "duerma"), y de la foto en base64 a
  almacenamiento de objetos real.
- Si tienes entradas compradas **antes** de este cambio con `quantity` > 1
  (una sola fila representando varias entradas), esas siguen tal cual —
  no se dividieron automáticamente en entradas individuales. Es un caso
  raro estando el proyecto todavía en pruebas; si hiciera falta migrarlas
  de verdad más adelante, se puede escribir un script que reparta cada
  fila antigua en N filas nuevas con `quantity=1` cada una.
- Las cuentas creadas **antes** de añadir el nickname se quedan sin uno
  (`nickname = NULL`) — no se les pide rellenarlo a la fuerza. Si algún
  día hace falta, el paso natural es una pantalla de "completa tu perfil"
  que se muestre una vez a quien inicie sesión sin nickname todavía.
