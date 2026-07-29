# PPS Retail Inventory Manager

A **multi-tenant retail inventory SaaS**. Multiple companies subscribe; each
company has retail stores; store users log in to manage their store's inventory.
This cloud system is the **authoritative system of record** for retail inventory
— it is not a mirror of anyone's ERP.

Each company runs a small **sync agent** on its local network (built separately)
that delivers inventory **handoffs** to this API when goods ship to a store and
pulls back **returns**. The agent always dials out over HTTPS; this system never
connects into customer networks. See [`docs/SYNC.md`](docs/SYNC.md) for the agent
integration contract.

Deploys as **one Railway service** (the API serves the built Angular app) plus
managed Postgres. Tenants are served via wildcard subdomains (`acme.yourapp.com`),
resolved from the `Host` header.

```
├── api/          NestJS + Drizzle ORM (PostgreSQL) — REST API + serves web in prod
├── web/          Angular (standalone components)
├── docs/SYNC.md  sync-agent integration contract (v1)
├── docker-compose.yml   local Postgres
└── package.json         root build/deploy orchestration
```

## Tech stack

NestJS (TypeScript) · Drizzle ORM (`node-postgres`) + drizzle-kit · PostgreSQL 16
· Angular 20 (standalone) · JWT auth (bcrypt) · Postgres Row-Level Security.

> **Angular 20 / Node 20:** pinned because the toolchain targets Node 20. bcrypt
> uses `bcryptjs` (pure JS) to avoid native build tooling.

---

## Data model & tenancy

Every tenant-owned table carries `company_id` (denormalized on purpose; indexes
lead with it). Tables: `companies`, `stores`, `users`, `invitations`, `api_keys`
(hashed), `inventory_items` (serial-based, with `status`), `inventory_transactions`
(append-only **ledger** — one row per inventory state change, written in the same
transaction as the item change), `outbox_returns` (queue for the sync agent).

### Roles

- `PLATFORM_ADMIN` — us. Manages companies/keys via the **admin** host+module only.
- `COMPANY_ADMIN` — spans all stores within their company.
- `STORE_USER` — pinned to one store.

No open self-registration: users are created via **invitations** (an admin issues
one; the signup page works only with a valid, unexpired token).

### Row-Level Security (the backstop)

Every tenant table has RLS **enabled + FORCED** with a `tenant_isolation` policy:

```sql
USING (current_setting('app.is_platform_admin', true) = 'on'
       OR company_id = nullif(current_setting('app.company_id', true), '')::int)
```

Per request the API opens a transaction and sets `app.company_id` (tenant scope)
or `app.is_platform_admin = 'on'` (explicit platform-admin/system bypass). An
unset scope denies by default.

**RLS requires a non-superuser DB role** — superusers and table owners bypass RLS.
So:

- **Migrations & seed** connect via **`DATABASE_URL`** (owner; on Railway the
  provided role). They can write across tenants.
- **The running API** connects via **`APP_DATABASE_URL`** — a restricted,
  non-superuser role (`app_user`). The `enable_rls` migration creates `app_user`
  for local dev. If `APP_DATABASE_URL` is unset the API falls back to
  `DATABASE_URL` and logs a warning that **RLS is not enforced**.
- The platform-admin module opts into cross-tenant access per endpoint via the
  bypass setting (see `TenantDbService.withBypass`).

The application layer *also* scopes every query by `company_id`/`store_id`
through `TenantDbService` — RLS is defense-in-depth, not the only guard.

---

## Local development

### Prerequisites

Node.js ≥ 20.19, Docker (for local Postgres).

### 1. Start Postgres

```bash
docker compose up -d
```

Postgres 16 on `localhost:5432` (user `pps` / pass `pps` / db `pps_retail`).

### 2. Configure the API

```bash
cd api && cp .env.example .env
```

| Variable           | Purpose                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `DATABASE_URL`     | Owner role — migrations & seed.                                     |
| `APP_DATABASE_URL` | Restricted `app_user` role — the running API (needed for RLS).      |
| `JWT_SECRET`       | Signs login JWTs.                                                   |
| `PORT`             | API port (Railway injects it).                                      |
| `NODE_ENV`         | `development` / `production`.                                       |
| `ROOT_DOMAIN`      | Base domain for tenant subdomains (see below).                      |

### 3. Install, migrate, seed

```bash
npm run setup          # installs api/ and web/
cd api
npm run db:generate    # (only after schema changes) generate SQL
npm run db:migrate      # apply migrations (creates tables, app_user, RLS)
npm run db:seed         # demo data (prints a sync API key ONCE)
```

**Seed logins**

| Who            | Host                    | Email / password                 |
| -------------- | ----------------------- | -------------------------------- |
| Platform admin | `admin.<ROOT_DOMAIN>`   | `admin@platform.test` / `platform123` |
| Company admin  | `demo.<ROOT_DOMAIN>`    | `admin@demo.test` / `admin123`   |
| Store user     | `demo.<ROOT_DOMAIN>`    | `user@demo.test` / `store123`    |

### 4. Multi-tenant hosting locally — pick one

Tenants are resolved from the `Host` header, so you need subdomains locally.

**Option A — zero config with `*.localhost` (recommended for dev).**
Set `ROOT_DOMAIN=localhost` in `api/.env`. Chromium browsers auto-resolve
`*.localhost` to loopback, so `http://demo.localhost:4200` and
`http://admin.localhost:4200` just work — no hosts-file edits.

**Option B — `yourapp.local` with hosts entries.**
Keep `ROOT_DOMAIN=yourapp.local` and add to your hosts file
(`C:\Windows\System32\drivers\etc\hosts` or `/etc/hosts`):

```
127.0.0.1 demo.yourapp.local
127.0.0.1 admin.yourapp.local
```

The dev server has `allowedHosts: true`, and the proxy uses `changeOrigin: false`
so the tenant `Host` is preserved to the API.

### 5. Run

```bash
# repo root, two terminals
npm run dev:api        # API on :3000
npm run dev:web        # Angular on :4200 (proxies /api -> :3000)
```

Open `http://demo.localhost:4200` (store/company) or
`http://admin.localhost:4200` (platform admin).

---

## Drizzle migrations

Schema lives in [`api/src/db/schema.ts`](api/src/db/schema.ts).

- `npm run db:generate` — generate SQL from the schema into `api/drizzle/`.
- `npm run db:migrate` — apply (dev, via drizzle-kit).
- `npm run db:migrate:prod` — apply in production (compiled migrator, no dev deps).

RLS + the `app_user` role live in the custom migration
`api/drizzle/0001_enable_rls.sql`. Commit all generated files — they are the
source of truth for the DB shape.

---

## API surface (under `/api`)

- **Public (company host):** `GET /branding`, `POST /auth/login`,
  `POST /auth/accept-invite`.
- **Store/company (JWT):** `GET/POST/PATCH/DELETE /inventory` (`?needsReview=true`
  review queue), `POST /inventory/:id/sell`, `/return`, `/adjust`;
  `GET /transactions`; company-admin CRUD `/stores`, `/users`, `/invitations`.
- **Cycle counts (JWT):** `POST /cycle-counts` (open + ON_HAND snapshot),
  `POST /cycle-counts/:id/close` (idempotent one-transaction resolution: scanned
  serials, count-by-UPC keeps newest N, new items, and everything unaccounted →
  SOLD via a `CYCLE_COUNT` ledger row), `POST /cycle-counts/:id/cancel`,
  `GET /cycle-counts` (+`/:id` with lines). Cycle-count sales are cloud-side
  ledger events — nothing flows to the ERP outbox, so `docs/SYNC.md` is unchanged.
- **Sync (X-Api-Key):** `POST /sync/handoffs`, `GET /sync/returns`,
  `POST /sync/returns/ack` — see [`docs/SYNC.md`](docs/SYNC.md).
- **Platform admin (admin host, PLATFORM_ADMIN):** `/admin/companies` CRUD,
  `/admin/companies/:id/api-keys`, `/admin/companies/:id/admin-invite`,
  `GET /admin/health`.

Cross-tenant token replay is rejected (the JWT's `companyId` must match the
host-resolved company). Lists are paginated; requests are rate-limited
(per API key / per user / per IP).

---

## Production build (single service)

```bash
npm run build   # builds web/, copies it into api/client, builds api/
npm start       # runs the compiled API, which also serves the web app
```

In `NODE_ENV=production` the API serves the built Angular app as static files
with a catch-all fallback to `index.html`, so the frontend + API share one origin
(the web app calls the API with relative `/api` paths).

---

## Railway deployment

Deploy as **one service** from the repo root, plus a managed Postgres.

1. **Add a Postgres database** in the Railway project → gives `DATABASE_URL`.
2. **Create a restricted runtime role** for RLS and set `APP_DATABASE_URL`:
   ```sql
   CREATE ROLE app_user LOGIN PASSWORD '<strong-secret>';
   GRANT USAGE ON SCHEMA public TO app_user;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
   ```
   (The `enable_rls` migration also creates `app_user` with a dev password; change
   it in production.) Set `APP_DATABASE_URL` to that role's connection string.
   **Do not** point `APP_DATABASE_URL` at a superuser — RLS would not apply.
3. **Service settings**
   - Root directory: `/`
   - Build: `npm run setup && npm run build`
   - Start: `npm run db:migrate:prod && npm start` (migrations run each deploy)
4. **Environment variables:** `DATABASE_URL` (from the plugin), `APP_DATABASE_URL`
   (restricted role), `JWT_SECRET`, `ROOT_DOMAIN=yourapp.com`,
   `NODE_ENV=production`. Do **not** set `PORT` (Railway injects it).
5. **Domains:** add a **wildcard** custom domain `*.yourapp.com` and the
   `admin.yourapp.com` subdomain, all pointing at this service. Each company's
   `slug` (or its `custom_domain`) resolves to its tenant; `admin.yourapp.com`
   is the platform console.
6. After the first deploy, seed a platform admin + first company (run the seed
   once, or create them via the admin module).

> Never commit real secrets — `.env` is git-ignored; use `api/.env.example`.

## Inventory locations & expiration alerts

Every store has named **locations** — two system locations (**Backroom**,
**On Floor**; renamable, not deletable) plus any custom ones. Inventory lives at
a location; staff **move** stock between locations from the portal or the
scanner. Serialized units carry an **expiration date**, and a scheduled job
raises alerts for on-floor units nearing/past expiration so staff rotate stock.

> **Future feature:** expiration is **serialized-only**. Quantity products track
> per-location counts but have no expiration (lot/batch expiration for quantity
> products is a planned enhancement). The scanner's cycle-count screen is not yet
> location-aware — counted quantities default to the Backroom (a follow-up).

## Invitation emails

Company admins invite users from **Manage → Invitations**. Creating an invitation
emails the invitee an accept link; the link is single-use, expires in 7 days, and
can be revoked or resent.

Only a **sha256 hash** of the invite token is stored. The plaintext token appears
exactly once — in the emailed accept URL (and in the create/resend API response,
so the admin can copy it if the email fails). It is not retrievable afterwards;
"Copy link" on a failed row mints a **new** link (and invalidates the old one).

**Postmark is the current production provider.** Resend is retained as a working
alternative, and `console` is the default for development.

### Choosing a provider

The provider is chosen in exactly one place — `api/src/mail/mail.module.ts` — from
the environment. All providers send the identical template, so switching cannot
change what the invitee receives.

| Variable | Meaning |
| --- | --- |
| `MAIL_PROVIDER` | `postmark` \| `resend` \| `console` |
| `MAIL_FROM` | Sender; must be verified in the active provider |
| `POSTMARK_SERVER_TOKEN` | Postmark **Server** API token |
| `POSTMARK_MESSAGE_STREAM` | Stream name; defaults to `outbound` |
| `RESEND_API_KEY` | Resend API key |
| `MAIL_MODE` | Legacy: `console` forces console; `live` means Resend |
| `APP_BASE_URL` | Optional origin override for the accept link (localhost testing) |

Precedence, highest first:

1. `MAIL_MODE=console` → **console**, regardless of `MAIL_PROVIDER` (a kill switch
   for turning off outbound mail without unsetting credentials).
2. `MAIL_PROVIDER` set → that provider. If its token is missing it **falls back to
   console** and logs a warning rather than failing to boot.
3. `MAIL_MODE=live` with no `MAIL_PROVIDER` → **Resend** (the original contract, so
   existing deployments keep working untouched).
4. Nothing set → **console**.

**Console mode is the default** and sends nothing: the full email, including a
working accept URL, is logged to the API console. Local development and automated
tests need no credentials. The chosen provider is logged once at boot.

The accept URL is always built for the **invitee's** company subdomain
(`https://{companySlug}.{ROOT_DOMAIN}/accept-invite?token=…`), not the host the
admin happened to be on. Set `APP_BASE_URL` (e.g. `http://demo.localhost:4200`)
when testing on localhost, where subdomains are awkward.

### Postmark setup (production)

1. **Get the Server API Token:** in Postmark open your **Server** → **API Tokens**.
   This is a *per-server* token — not the Account token, which cannot send mail.
2. **Verify the sender:** `MAIL_FROM` must exactly match a confirmed **Sender
   Signature**, or be an address on a **verified domain**, in that Postmark
   account. Postmark rejects anything else outright (see the failure table below).
3. **Message stream:** invitations are **transactional**, so leave
   `POSTMARK_MESSAGE_STREAM` on the default transactional stream `outbound`.
   **Do not point it at a broadcast stream** — those are for bulk/marketing mail
   and carry different throttling and unsubscribe handling.
4. Set in `api/.env`:

   ```
   MAIL_PROVIDER=postmark
   MAIL_FROM="PPS Retail Inventory <noreply@provisionprocessingsystem.com>"
   POSTMARK_SERVER_TOKEN=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   POSTMARK_MESSAGE_STREAM=outbound
   ```

Unlike the Resend sandbox, a verified Postmark sender delivers to **any**
recipient — no allow-listing.

Sends are verifiable in Postmark under **Activity**.

#### Postmark failure reasons

A failed send never fails invitation creation. The invitation is still stored,
marked `email_status = FAILED` with one of these reasons, and the admin list shows
the reason plus **Copy link** to recover the flow manually:

| Postmark response | Recorded reason |
| --- | --- |
| `401` | `Postmark token invalid` |
| `422` ErrorCode `400`/`401` | `sender address not verified in Postmark — verify {MAIL_FROM} or use a verified sender signature` |
| `422` ErrorCode `300` | `recipient address invalid` |
| `406` or ErrorCode `406` | `recipient previously bounced — reactivate in Postmark or correct the address` |
| anything else | `Postmark responded {status} (ErrorCode n): {Postmark's Message}` |

A `2xx` carrying a non-zero `ErrorCode` is treated as a failure too — Postmark
reports per-message problems in the body, so the status alone is not proof of
acceptance.

### Resend (alternative provider, retained)

```
MAIL_PROVIDER=resend
RESEND_API_KEY=re_…
MAIL_FROM="PPS Retail Inventory <onboarding@resend.dev>"
```

Our domain is **not** verified in Resend, so this uses the `resend.dev` **sandbox
sender**, which only delivers to the email address on the Resend account. Invites
to any other address are recorded as `FAILED` with:

> sandbox sender: recipient not allowed — verify a domain to invite external
> addresses

Use **Copy link** on the failed row to send the invite yourself. Verifying a domain
in Resend (then pointing `MAIL_FROM` at it) lifts the restriction with no code
changes.

### Invitation lifecycle

State is evaluated in this order on every token lookup:

| State | Meaning |
| --- | --- |
| `INVALID` | No such token (or it was replaced by a resend) |
| `REVOKED` | An admin revoked it |
| `ALREADY_ACCEPTED` | Already used to create the account |
| `EXPIRED` | Past `expires_at` |
| `VALID` | Ready to accept |

The accept page resolves the state on load and the server **re-validates on
submit**, so an invitation revoked between page load and submit fails cleanly with
the revoked message. Both public endpoints
(`GET /api/invitations/status`, `POST /api/auth/accept-invite`) are IP rate-limited,
and non-`VALID` states reveal nothing beyond the state itself.

Admin actions: **Revoke** (idempotent), **Resend** (new token + reset expiry;
invalidates the old link; rejected once accepted), and **Copy link** on failed
sends.
