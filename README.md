# PPS Retail Inventory Manager

A multi-store retail inventory portal. Remote store locations log in to view and
edit **their own** inventory. An admin can see every store. It is built to deploy
as a **single Railway service** (NestJS API that also serves the built Angular app),
backed by PostgreSQL.

The data model is **sync-friendly from day one**: every inventory write is recorded
in an `outbox_changes` table and every row carries change timestamps, so a future
sync agent on the local network can exchange data with this API without schema
changes.

```
PPSRetailInventoryManager/
├── api/    NestJS + Drizzle ORM (PostgreSQL) REST API
├── web/    Angular (standalone components) frontend
├── scripts/copy-client.mjs   copies the built web app into the API for prod
├── docker-compose.yml        local Postgres for development
└── package.json              root build/deploy orchestration
```

## Tech stack

- **API:** NestJS (TypeScript), Drizzle ORM with the `node-postgres` driver,
  drizzle-kit for migrations, JWT auth (bcrypt password hashing).
- **Web:** Angular (latest stable, standalone components), plain CSS.
- **DB:** PostgreSQL 16.

---

## Local development

### Prerequisites

- Node.js >= 20.19
- Docker (for the local Postgres) — or any local/remote Postgres you point
  `DATABASE_URL` at.

### 1. Start Postgres

```bash
docker compose up -d
```

This starts Postgres 16 on `localhost:5432` with user `pps`, password `pps`,
database `pps_retail` (matches `api/.env.example`).

> No Docker? Point `DATABASE_URL` at any Postgres instance instead.

### 2. Configure the API environment

```bash
cd api
cp .env.example .env      # then edit if needed
```

`.env` values:

| Variable       | Purpose                                              |
| -------------- | ---------------------------------------------------- |
| `DATABASE_URL` | Postgres connection string.                          |
| `JWT_SECRET`   | Secret used to sign login JWTs.                      |
| `PORT`         | Port the API listens on (Railway sets this for you). |
| `SYNC_API_KEY` | Shared secret for the `/api/sync/*` endpoints.       |
| `NODE_ENV`     | `development` locally; `production` on Railway.      |

### 3. Install dependencies

From the repo root:

```bash
npm run setup      # installs api/ and web/ dependencies
```

### 4. Run migrations and seed

```bash
cd api
npm run db:generate   # generate SQL migrations from the Drizzle schema
npm run db:migrate    # apply them to the database
npm run db:seed       # create a demo store + login
```

**Seed login:** `demo@store.test` / `password123` (store code `DEMO`), plus an
admin `admin@pps.test` / `admin123`.

### 5. Run the app in dev mode

Two terminals from the repo root:

```bash
npm run dev:api    # NestJS on http://localhost:3000
npm run dev:web    # Angular on http://localhost:4200 (proxies /api -> :3000)
```

Open http://localhost:4200 and log in with the seed credentials.

---

## How Drizzle migrations work

The schema is defined in TypeScript at [`api/src/db/schema.ts`](api/src/db/schema.ts).

- **Generate** SQL from the schema after any schema change:
  `npm run db:generate` (writes versioned `.sql` files into `api/drizzle/`).
- **Apply** pending migrations to the database:
  `npm run db:migrate` (dev, via drizzle-kit) or
  `npm run db:migrate:prod` (production, runs the compiled migrator with no dev
  dependencies required).

Commit the generated `api/drizzle/` files — they are the source of truth for the
database shape across environments.

---

## API surface

All routes are under the `/api` prefix.

### Auth

- `POST /api/auth/login` → `{ email, password }` → `{ access_token, user }`

### Inventory (JWT required; scoped to the caller's store, ADMIN sees all)

- `GET    /api/inventory`
- `POST   /api/inventory`
- `PATCH  /api/inventory/:id`
- `DELETE /api/inventory/:id` (soft delete — sets `deleted_at`)

Every inventory write also inserts an `outbox_changes` row **in the same database
transaction**.

### Sync (for the future local sync agent; secured by the `x-api-key` header = `SYNC_API_KEY`)

- `POST /api/sync/push` — idempotent batch upsert of inventory items
  (Postgres `ON CONFLICT (store_id, sku)`, never a blind insert).
- `GET  /api/sync/pending` — undelivered `outbox_changes` rows.
- `POST /api/sync/ack` — `{ ids: [...] }` marks outbox rows delivered.

> Note: `/api/sync/push` ingests changes **from** the local system, so it does not
> itself emit `outbox_changes` rows (that would create an echo loop back to the
> agent). The outbox captures changes that originate **in the portal**.

---

## Production build (single service)

```bash
npm run build      # builds web/, copies it into api/client, builds api/
npm start          # runs the compiled API, which also serves the web app
```

In `NODE_ENV=production` the API serves the built Angular app as static files with
a catch-all fallback to `index.html`, so the frontend and API share one origin
(the web app calls the API with relative `/api/...` paths).

---

## Railway deployment

Deploy as a **single service** from the repo root.

1. **Create a Postgres database** in your Railway project. Railway exposes its
   connection string as `DATABASE_URL` — reference it from the service variables.
2. **Service settings**
   - **Root directory:** `/` (repo root)
   - **Build command:** `npm run setup && npm run build`
   - **Start command:** `npm run db:migrate:prod && npm start`
     (runs migrations on every deploy, then boots the API)
3. **Environment variables** to set on the service:
   - `DATABASE_URL` — from the Railway Postgres plugin
   - `JWT_SECRET` — a long random string
   - `SYNC_API_KEY` — a long random string
   - `NODE_ENV=production`
   - `PORT` — **do not set**; Railway injects it and the API reads `process.env.PORT`.
4. After the first deploy, seed a store/login once (from the Railway shell, or
   temporarily add `npm run db:seed` to the start command): `npm --prefix api run db:seed`.

> Do not commit real secrets. `.env` is git-ignored; use `api/.env.example` as the
> template.
