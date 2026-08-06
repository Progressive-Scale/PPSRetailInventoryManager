# Release runbook

Three pieces ship together and depend on each other in one direction:

```
  PPS server (SQL Server, Ordersystem8)
        │
        │  PPS-Retail-Sync-Agent  ── HTTPS ──▶  cloud API  ◀── HTTPS ── Zebra scanner
        │  (Windows service)                   (Railway)              (signed APK)
        ▼                                           ▲
   handoffs, returns,                               │
   import checks, reorders                    company admins
                                              in a browser
```

Deploy **in that order** — cloud first, because the agent and the scanner both
need a reachable API and an issued credential before they can do anything.

Everything below is written against a real deployment. Values you must decide are
marked `«like this»`.

---

## 0. Decide these first

| Value | Used by | Notes |
| ----- | ------- | ----- |
| `«ROOT_DOMAIN»` | API, DNS, scanner | e.g. `retail.example.com`. Companies live at `«slug».«ROOT_DOMAIN»`, the platform console at `admin.«ROOT_DOMAIN»`. Needs a **wildcard** record, so it usually wants its own subdomain rather than an apex you already use. |
| `«COMPANY_SLUG»` | tenant URL | Lowercase letters, digits, hyphens. Becomes a hostname. `admin`, `www`, `api`, `app`, `mail`, `static` are reserved. |
| `«pilot store»` | cutover | The one store going live first. |

### No domain? There is a supported single-host path

You do not need to buy a domain to run this. On a host that gives you one name and
no subdomains of it (a `*.up.railway.app`, an internal server), set `ROOT_DOMAIN`
to that name and register it as the company's `COMPANY_CUSTOM_DOMAIN` at bootstrap.
The whole app then answers on that one URL.

| | With a wildcard domain | Single host |
| --- | --- | --- |
| Web app + API | ✅ | ✅ |
| Scanner | ✅ release build | ✅ debug build with a custom base URL |
| Sync agent | ✅ | ✅ (`CREATE_SYNC_API_KEY=1` at bootstrap) |
| Companies per deployment | many | **one** |
| Platform admin console | ✅ | ❌ needs `admin.«ROOT_DOMAIN»` |
| Invitation email links | automatic | need `APP_BASE_URL` set to the host |

Moving to a real domain later is environment variables and DNS, not a rebuild:
point the wildcard at the same service, change `ROOT_DOMAIN`, clear the custom
domain. The data is untouched.

---

## 1. Cloud API + web (Railway)

### 1.1 Database

1. Add a **Postgres** plugin to the Railway project. That gives `DATABASE_URL`
   (the owner role).
2. Create the restricted runtime role — **the API refuses to start without it**:

   ```sql
   CREATE ROLE app_user LOGIN PASSWORD '«strong-secret»';
   GRANT USAGE ON SCHEMA public TO app_user;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
   ```

   The `enable_rls` migration also creates an `app_user` with a **development**
   password. Change it. This role must not be `SUPERUSER` and must not have
   `BYPASSRLS`; row-level security does not apply to either, and RLS is the only
   thing separating one company's inventory from another's.

### 1.2 Service

- Root directory: `/`
- Build: `npm run setup && npm run build`
- Start: `npm run db:migrate:prod && npm start`

Migrations run on every deploy. They are forward-only; see §6 for rollback.

### 1.3 Environment

| Variable | Value |
| -------- | ----- |
| `DATABASE_URL` | from the Postgres plugin (owner) |
| `APP_DATABASE_URL` | the restricted role from §1.1 |
| `JWT_SECRET` | **freshly generated**, 32+ chars — `openssl rand -base64 48` |
| `ROOT_DOMAIN` | `«ROOT_DOMAIN»` |
| `NODE_ENV` | `production` |
| `MAIL_PROVIDER` | `postmark` (see §1.5) |
| `POSTMARK_TOKEN` | **freshly generated** server token |
| `MAIL_FROM` | a verified sender on your domain |
| `PORT` | **do not set** — Railway injects it |

The API exits at boot rather than serve traffic if `APP_DATABASE_URL` is missing
or points at a superuser, if `JWT_SECRET` is a published example value or under
32 characters, or if `ROOT_DOMAIN` is a placeholder. That is deliberate: each of
those looks perfectly healthy at runtime and is a data-exposure or
nothing-resolves bug.

### 1.4 DNS + TLS

- Wildcard `*.«ROOT_DOMAIN»` → the Railway service.
- `admin.«ROOT_DOMAIN»` → the same service.

Both need certificates. Verify a browser reaches `https://«slug».«ROOT_DOMAIN»`
before going further — the scanner has no way to tell a TLS failure from a
network one.

### 1.5 Mail

Invitations and password resets are the only mail. Console mode sends nothing and
writes the accept link to the log, so a customer's invitation never arrives — and
because the API still answers 200, nothing anywhere reports a problem. **The API
therefore refuses to start in production if mail would resolve to console**, by
any route: `MAIL_MODE=console`, no `MAIL_PROVIDER`, or a provider whose token is
missing. Before launch:

1. Verify the sender signature (or domain) in Postmark.
2. Set `MAIL_PROVIDER=postmark` and a fresh `POSTMARK_TOKEN`.
3. Use a **transactional** stream, not a broadcast one.
4. Send one real invitation to yourself and accept it.

### 1.6 First run

```bash
DATABASE_URL=…            ROOT_DOMAIN=«ROOT_DOMAIN»
PLATFORM_ADMIN_EMAIL=…    PLATFORM_ADMIN_PASSWORD=…      # 12+ chars
COMPANY_NAME="…"          COMPANY_SLUG=«COMPANY_SLUG»
STORE_NAME="«pilot store»"
COMPANY_ADMIN_EMAIL=…     COMPANY_ADMIN_PASSWORD=…       # 12+ chars
npm run db:bootstrap
```

Creates the platform admin, the company, the store, its Backroom and On Floor
locations, and the customer's own admin. **Never run `db:seed` here** — it builds
demo tenants and accounts whose passwords are published in the README.

Then, signed in as the platform admin at `admin.«ROOT_DOMAIN»`:

- `POST /api/admin/companies/:id/api-keys` issues the sync agent's key. **It is
  shown once.** Put it straight into the agent's configuration (§2.2); do not
  paste it anywhere else.

---

## 2. Sync agent (on the PPS server)

Runs beside SQL Server, reaches the cloud outbound over HTTPS. Nothing inbound is
opened, which is why it lives here rather than in the cloud.

### 2.1 Prerequisites

- .NET runtime per `global.json`.
- A SQL Server login that can read and write `Ordersystem8`.
- Outbound 443 to `«ROOT_DOMAIN»`.

### 2.2 Configure

Copy `appsettings.example.json` to `appsettings.json` in the install directory
and set:

| Setting | Value |
| ------- | ----- |
| `Agent:Pps:ConnectionString` | the Ordersystem8 login — **prefer the env override** `PPSSYNC_Agent__Pps__ConnectionString` so it is not in a file |
| `Agent:Cloud:BaseUrl` | `https://«COMPANY_SLUG».«ROOT_DOMAIN»/api` — the `/api` segment is required |
| `Agent:Cloud:ApiKey` | the key from §1.6, or `PPSSYNC_Agent__Cloud__ApiKey` |
| `Agent:ImportMatchMode` | `AutoTransfer` marks a matched serial `TRANSFERRED_TO_RETAIL` in PPS immediately. `ConfirmQueue` parks it in `retail_import_confirmations` for a person. The cloud is told `MATCHED` either way. |

### 2.3 Install

From an **elevated** PowerShell prompt in the agent repo:

```powershell
.\scripts\install-service.ps1
```

Publishes to `C:\PPS\RetailSyncAgent` and registers `PPSRetailSyncAgent` with
delayed automatic start and restart-on-crash. Delayed because its first act at
boot is to reach SQL Server across the LAN and an HTTPS endpoint across the
internet, and neither is reliably up when the SCM launches automatic services.

To remove: `.\scripts\install-service.ps1 -Uninstall` (leaves the directory and
its logs).

### 2.4 Confirm it is alive

- `Get-Service PPSRetailSyncAgent` → Running.
- `C:/ProgramData/PPS/RetailSyncAgent/logs` shows a sweep, not a stack of
  connection failures.
- A handoff created in PPS appears in the cloud's **Pending arrivals**.
- **Until this service runs, import checks sit at `REQUESTED` forever** — a store
  scanning an unknown serial and choosing "ask PPS" gets no answer at all.

---

## 3. Scanner APK

### 3.1 Signing key — you create this, once

Android Studio → **Build → Generate Signed Bundle / APK → APK → Create new…**

The keystore and its passwords **never enter the repo**. Back the `.jks` up
somewhere you will still have in five years: lose it and you cannot ship an
update to an already-installed app — Android will refuse the install.

### 3.2 Point the build at it

Copy `keystore.properties.example` to `keystore.properties` (git-ignored) at the
scanner repo root:

```properties
storeFile=C:/…/keystore.jks
storePassword=…
keyAlias=…
keyPassword=…
rootDomain=«ROOT_DOMAIN»
```

`rootDomain` matters as much as the signing does: a release build without it
falls back to `yourapp.com`, which nobody owns, and the APK installs fine and
then cannot reach anything. The build warns when that happens.

### 3.3 Build and check

Release build, then on a real gun:

- Sign in as a store user at `«COMPANY_SLUG»`.
- Scan a known UPC and a known serial.
- Run a cycle count end to end and submit it.

Current version is `1.1.0 (2)`; bump `versionCode` for every build you install
over another.

---

## 4. Pilot cutover (one store)

1. **Catalog** — the products the store actually carries, by SKU and UPC. An
   unknown scan creates a needs-review product rather than failing, but a store
   that starts empty spends its first day in the review queue.
2. **Locations** — Backroom and On Floor exist from bootstrap. Add real bays now
   if you want them; a count is scoped to one location.
3. **Opening stock** — either let handoffs from PPS fill it, or run a first cycle
   count and approve it as the opening balance.
4. **People** — invite the store's users from Manage. One `STORE_MANAGER` per
   store means counts can be approved without waiting for a company admin.
5. **Watch the first week** — Cycle Counts → Needs Review, and the agent log.

---

## 5. Smoke test after every deploy

| # | Check | Expected |
| - | ----- | -------- |
| 1 | `GET https://«slug».«ROOT_DOMAIN»/api/health` | `{"status":"ok"}` |
| 2 | Boot log | `Runtime role "app_user" is subject to RLS.` |
| 3 | Sign in as the company admin | Inventory loads |
| 4 | Sign in as a store user | No Manage, no Settings |
| 5 | `GET /api/auth/login` on an unknown subdomain | 404 `Unknown host / tenant` |
| 6 | Scanner login + one lookup | Product resolves |
| 7 | Agent log | A completed sweep since the deploy |
| 8 | Send yourself an invitation | Arrives by email, accept link works |

Check 2 is the one people skip. If it is missing, RLS is not enforced and every
tenant can read every other tenant.

---

## 6. Rollback

| Piece | How |
| ----- | --- |
| Cloud | Redeploy the previous Railway deployment. **Migrations are forward-only** — a deploy that added a migration is not undone by rolling back the code, so a schema change needs its own reverse SQL written before you need it. |
| Agent | `install-service.ps1 -Uninstall`, or stop the service. Nothing is lost: handoffs stay queued in PPS and import checks stay `REQUESTED` until it runs again. |
| Scanner | Reinstall the previous APK. It must be signed with the **same** key. |

The riskiest step is a migration, not a deploy. Take a Postgres snapshot
immediately before any release that carries one.

---

## 7. Before the first customer

Still open at the time of writing:

- **Rotate every credential that has been shared** — the Postmark token, the
  Resend key, and any cloud API key issued during development. Treat anything
  that has been in a chat window, a ticket, or a screenshot as public.
- **Public company id** — the cloud company needs an unguessable public
  identifier minted in PPS, with integer ids staying internal. Not built yet.
- **Backups** — Railway's Postgres backup schedule, and a restore you have
  actually tried. An untested backup is a hope.
- **Dev database clutter** — the development database carries ~50 test users from
  invitation-flow verification. Irrelevant if production starts fresh, which
  `db:bootstrap` assumes; it matters only if you ever copy this database forward.
