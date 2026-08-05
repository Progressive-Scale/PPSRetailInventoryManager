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

### Signing in: username or email

Every user has a **username**, chosen when they accept their invitation and unique
**per company** — two tenants can both have an `admin`, and the host decides which
one a given login means. `POST /auth/login` takes a single `identifier` and works
out what it received: anything containing `@` is looked up as an email, everything
else as a username. Usernames cannot contain `@`, so the two never overlap.

Both are compared case-insensitively; usernames are stored lowercase. The rule
(3–32 chars, letters/digits/`.`/`_`/`-`, must start and end alphanumeric) lives in
`api/src/auth/username.util.ts` and is mirrored for the browser in
`web/src/app/core/username.ts` — **change both together**; there is no shared
package between `api` and `web`.

Accounts predating this feature were given a username derived from their email
local part by migration `0016`, deduplicated per company (`alice`, `alice2`, …).
The login DTO still accepts the old `email` field as an alias for `identifier`, so
a scanner build already in the field keeps working.

### Forgotten password

Three unauthenticated steps, all scoped by host — a request on `demo.example.com`
can only find and reset a Demo user, even when the same address exists in another
company. Platform admins use the admin host and are handled under `withBypass`,
since they have no company to scope to.

| Step | Endpoint | Notes |
| --- | --- | --- |
| Ask | `POST /auth/forgot-password` | 5/min. **404 when no active account has that address.** |
| Check | `GET /auth/reset-status?token=` | Lets the page explain a dead link before asking for a password |
| Redeem | `POST /auth/reset-password` | Single use; signs the user in on success |

Links live **60 minutes** (`RESET_TTL_MINUTES`), work **once**, and requesting a new
one **supersedes** every outstanding link for that user — so an older email sitting
in an inbox stops working. Only the sha256 of the token is stored, as with
invitations. A suspended account is treated as absent: it cannot log in, so a
working link would be misleading.

> **Account enumeration, by choice.** Reporting a 404 for an unknown address is
> friendlier when someone mistypes their own email, but it lets anyone probe which
> addresses belong to users of a tenant. Set `REVEAL_UNKNOWN_EMAIL = false` in
> `api/src/auth/password-reset.util.ts` for the standard privacy-preserving
> behaviour — identical response either way, no email for an unknown address.
> Nothing else has to change.

A reset does **not** sign other devices out, for the same reason a password change
does not: stateless tokens, no revocation list.

### My profile (`/profile`)

Clicking your own name in the top bar opens it. Users change **their own** username
and password here; `/api/profile/*` acts on whoever the token belongs to, so there
is no id in any path and one user can never address another's account. Email and
role are read-only — an administrator owns those, via Manage → Users, where in turn
usernames are *not* editable. The two screens never overlap.

Changing a password does **not** sign other devices out: tokens are stateless with
no revocation list, so a session opened beforehand keeps working until it expires.

**A 401 from an authenticated route means the session is dead** — the web
interceptor logs the user out and redirects to `/login` when it sees one. An
endpoint that validates a credential passed in the *body* (the current-password
confirmation) must therefore answer **400**, not 401, when that value is wrong.
Otherwise a single typo ejects the user from the app.

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
- **Cycle counts (JWT):** two-phase, because a count infers sales and that is
  destructive.
  - `POST /cycle-counts` — open, scoped by `locationId` (+ optional `productIds`).
    **The scope of the count is the scope of the sold sweep:** units elsewhere are
    untouched and cannot be inferred sold by a count that never went near them.
    Returns `{scope, snapshot:{units, pending, stock}}`.
  - `GET /cycle-counts/:id/resolve?serial=` — how the count classifies one serial
    (`IN_SCOPE | ELSEWHERE | PENDING | SOLD | OTHER | UNKNOWN`). For the scanner,
    which cannot know that a serial belongs to a unit held elsewhere or one already
    sold. Reuses the same scope logic as submit, so the two cannot disagree.
  - `POST /cycle-counts/:id/submit` — idempotent; computes proposed lines and sets
    `AWAITING_REVIEW`. **Changes nothing.** Handles scanned serials, units found
    away from their recorded location, arrivals being received, sold units the
    counter chose to put back, quantity counts, unknown serials, and everything
    unaccounted-for. `/close` remains as a deprecated alias with this new meaning.

    Two unaccounted-for outcomes, and the difference matters. A product the counter
    scanned *some* of has its remainder proposed `MARKED_SOLD`; a product with **no
    scan at all** is reported `NOT_COUNTED` and left alone, because a count that never
    reached a shelf is not evidence its stock was sold. `markSoldSerials` is how a
    counter who *did* walk that shelf says it was empty — those units are proposed sold
    instead. Only in-scope, unaccounted units are honoured, and a scan always wins over
    a declaration: one is evidence, the other is a recollection.
  - `POST /cycle-counts/:id/approve` / `reject` — **`COMPANY_ADMIN` only.** Approve
    applies every unapplied line in one transaction (this is the step that sells
    unscanned units and zeroes uncounted shelves); reject reopens for a recount and
    discards the proposals. The role that counts is not the role that confirms.
  - `POST /cycle-counts/:id/cancel`, `GET /cycle-counts` (+`/:id` with lines and a
    `destructive` summary). Cycle-count sales are cloud-side ledger events —
    nothing flows to the ERP outbox.
- **Sync (X-Api-Key):** `POST /sync/handoffs`, `GET /sync/returns`,
  `POST /sync/returns/ack` — see [`docs/SYNC.md`](docs/SYNC.md).
- **Platform admin (admin host, PLATFORM_ADMIN):** `/admin/companies` CRUD,
  `/admin/companies/:id/api-keys`, `GET /admin/health`, plus support access for when
  a tenant cannot help themselves:
  - `GET /admin/users` — every user in every company, filterable by `companyId`,
    `role`, `status` and `q` (username/email substring), paginated.
  - `PATCH /admin/users/:id` — role, status and permitted stores. Refuses
    `PLATFORM_ADMIN` rows (400): they have no company to scope to, and demoting one
    from a list of all users is how you lock yourself out of the panel.
  - `POST /admin/users/:id/password-reset` — issues a reset link on the user's own
    company host, emails it, **and returns it** so it can be handed over when the
    mailbox is the problem. Refused for suspended accounts.
  - `GET /admin/companies/:id/stores`, `GET`/`POST /admin/companies/:id/invitations`,
    `POST /admin/invitations/:id/resend|revoke` — invitations into any company, with
    role and stores.

  The invitation and user-patch rules are not reimplemented here: these endpoints
  call the same `InvitationService` and `updateCompanyUser` the tenants' own screens
  use, so "no inviting an existing user", "one live link per address", and "the
  active store stays inside the permitted set" cannot drift between the two entry
  points. Every handler runs under `withBypass` (RLS off), so both gates —
  admin host **and** `PLATFORM_ADMIN` token — are required.

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

## A fixture for testing counts by hand

```bash
npm run db:fixture           # or: npm run db:fixture -- "Downtown"
```

Puts one store into a known state — **10 Water Bottles in the Backroom, 10 Water Bottles
plus 2 Chuck Rolls On Floor** — so a cycle count has 10 items in one location and 12 in
the other, one product counted by UPC and one by serial. Defaults to the `Teset` store of
the `demo` company; pass a store name to use another.

It uses the products that are already there, found by the identifiers a scanner reads (the
water bottle's UPC, the chuck roll's SKU), so scanning a physical label matches what the
fixture created rather than a look-alike it invented. Idempotent: run it as often as you
like and it converges on those numbers instead of adding to them. Every stock change writes
its `inventory_transactions` row like any other, because a fixture that adjusts stock
silently is the one hole a cycle count cannot find.

It never deletes anything it did not create. If the store holds other stock, or has counts
already in progress, it says so and leaves them alone — quietly deleting data to make an
expectation true is not a trade a script gets to make.

## Audit trail — who did what

Two append-only tables answer two different questions, and neither is written twice
for one fact:

- **`inventory_transactions`** — where stock went: receipts, sales, returns,
  adjustments, moves.
- **`audit_events`** — who changed what: catalog edits, location lifecycle, reorders,
  cycle-count decisions, invitations, user role/status changes, alert settings, and
  single/bulk field edits on a unit.

Reads come from **one stream**. `GET /api/activity` unions the two at query time and
maps them onto a common shape (actor resolved to a username / `Sync` / `System`,
entity, action, when, plus a ready-to-render summary). Unioning at read time rather
than duplicating movements into `audit_events` is deliberate: two records of one fact
can disagree, and a ledger that contradicts the audit log is worse than having only
one of them.

| Endpoint | Who | What |
| --- | --- | --- |
| `GET /api/activity` | `COMPANY_ADMIN` | the company's whole stream; filters `userId`, `entityType`, `action`, `storeId`, `source`, `from`, `to` (exclusive) |
| `GET /api/activity/:entityType/:entityId` | admin, plus store users for stock entities | one thing's history, newest first |

That split is the permission boundary. "What has everyone been doing" is management
information; "what happened to this item" is part of reading the item, so a store
user keeps it — otherwise the history sections on detail views would be admin-only
and the shop floor loses the answer to *why does this say 3*. Store users are refused
`USER`, `INVITATION` and `NOTIFICATION_SETTINGS` histories: those are people
management, and a guessable id must not route around the admin-only stream.

**Actor and door.** `audit_events` records both: *who* (user / API key / system job)
and *which door* (`WEB`, `SCANNER`, `SYNC`, `JOB`). The door comes from the optional
`X-Client` header, so a handheld's writes read as `SCANNER` and the portal's as
`WEB`. Ledger rows predate that distinction — `transaction_source` knows only
`PORTAL | SYNC | CYCLE_COUNT` — so a movement made from the handheld still reports
`WEB` in the unified stream. **The actor on a movement is exact; the door is not.**

A platform admin acting on a tenant's behalf is recorded as a **system** actor with
`details.byPlatformAdmin`, not as one of the tenant's users: their user row lives in
another company, so storing the id would put a name the tenant can never resolve into
the tenant's own history.

**Append-only, and role-proof.** `app_user` holds `SELECT, INSERT` only (migration
0029), and a trigger refuses `UPDATE`, `DELETE` and `TRUNCATE` for *every* role,
table owner included (migration 0030). The grant alone was not enough: a connection
string pointing at the owner bypasses it, and which role is in the connection string
is a deployment detail, not something this guarantee should rest on.
`inventory_transactions` is still protected by grants alone — tightening it the same
way is a separate change with its own verification.

**Retention: none.** Events are kept forever, the same posture as the ledger. Three
indexes carry the reads — `(company_id, created_at desc)`,
`(company_id, entity_type, entity_id, created_at)` and
`(company_id, user_id, created_at)` — covering the global tab, an entity's history
and "what did this employee do". When volume makes that uncomfortable, the shape to
reach for is monthly range partitioning on `created_at` with cold partitions archived
out, not a delete job: a trail with a hole in it cannot be told apart from one that
never recorded anything.

`item_audit` survives as a **view** over `audit_events` for older readers; its rows
were migrated in as `entity_type = 'INVENTORY_ITEM'`.

## Inventory locations & expiration alerts

Every store has named **locations**. Two are created with the store
(**Backroom**, **On Floor**) and there are two **required kinds**: a store must
always keep at least one *active* Backroom and one *active* On Floor. Beyond that
it may have as many locations of any kind as it likes — several backrooms, several
floor areas, plus custom areas. A location's kind is fixed once created.

**Lifecycle.** Locations are retired rather than erased:

| State | When | Effect |
| --- | --- | --- |
| **Delete** (hard) | only if never used — no stock and nothing referencing it in history | row disappears |
| **Deactivate** | anything with history, once its stock is moved out | hidden from dropdowns, move targets, handoff landing and expiration alerts; still named in past ledger rows; reactivatable |
| blocked | live stock present, or it is the last active location of a required kind | the UI disables the action and explains why |

Only **live** stock blocks deactivation (on-hand units and quantity on hand) —
sold units are history, not stock. A location that has ever been used can never be
hard-deleted, because the ledger references it.

Names are unique among *active* locations **within a store**, case-insensitively.
Every store owns its own "Backroom" and "On Floor" — the Store column
disambiguates them in cross-store lists. Deactivated rows are exempt, so a retired
name can be reused; reactivating a row whose name is taken is rejected.

The required-kind invariant is **per store** and keys on `kind`, so a store with
one active Backroom refuses to give it up whatever it is named. To retire it, add a
second Backroom to that store first.

> **Convention — location logic keys on `kind`, never on `name`.** A location's
> name is a user-editable label; its `kind` (`BACKROOM` / `ONFLOOR` / `CUSTOM`)
> is immutable and is the only field business logic may depend on. Renaming
> "Backroom" to "Stock Room West" must change nothing but the display. When
> reviewing a change, reject any query filter, guard, default or comparison that
> matches a location by name. The initial names live in
> `api/src/locations/location-names.ts` and belong only to the creation and seed
> paths. Same rule of thumb applies generally: **if a user can edit the field,
> logic must not depend on it.**

When a store has several active locations of a required kind, the **default** one
(handoff landing, cycle-count fallback) is the oldest active by `sort_order`, then
`created_at`, then `id`. Expiration alerts watch **all** active On Floor
locations, not just the default. Inventory lives at
a location; staff **move** stock between locations from the portal or the
scanner. Serialized units carry an **expiration date**, and a scheduled job
raises alerts for on-floor units nearing/past expiration so staff rotate stock.

> **Future feature:** expiration is **serialized-only**. Quantity products track
> per-location counts but have no expiration (lot/batch expiration for quantity
> products is a planned enhancement).

The scanner's cycle-count flow **is** location-aware: the counter picks the
location before the count starts, and that choice bounds the sweep. Omitting a
location still opens a whole-store count, and quantity counts without an explicit
location fall back to the count's own location (the Backroom for a whole-store
count).

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
