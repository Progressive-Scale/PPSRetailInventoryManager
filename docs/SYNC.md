# Sync Agent Integration Contract — v3.3

This document is the **integration contract** for a customer sync agent that
exchanges inventory data with the PPS Retail Inventory cloud API. It is
self-contained: you can build an agent against any local ERP without reading the
server source.

The cloud system is the **authoritative system of record** for retail inventory.
The agent always **dials out** over HTTPS to the cloud API; the cloud never
connects into the customer network.

- **Base URL:** `https://<your-deployment-host>/api`
- **Contract version:** `v3.3`
- **Auth:** every request sends the header `X-Api-Key: <key>` (issued per company
  by a platform admin; shown in plaintext only once at creation). No JWT, no host
  tenancy — the key identifies the company.
- **Content type:** `application/json`.

## What's new in v3.3

Two endpoints for a new job: **identifying serials nobody recognises.**

When a store scans a serial the catalog has never seen, the cloud creates a unit with
**no product at all** and flags it for review. If the counter chose "check for
imported inventory", that unit enters `import_check_status = REQUESTED` and appears
in the queue below for PPS to identify.

*(The task that specified this called it v2.2; this document was already at v3.2, so
it lands as v3.3. Same contract.)*

### 4. Pull import checks — `GET /api/sync/import-checks`

Query: `limit` (default 100, max 500), `offset`.

```json
{
  "data": [
    { "itemId": "957d0e3c-…", "serial": "SN-77219", "storeId": 1,
      "storeName": "Downtown", "scannedAt": "2026-07-31T20:27:09.000Z",
      "requestedAt": "2026-07-31T20:27:09.000Z" }
  ],
  "total": 3, "limit": 100, "offset": 0
}
```

**Oldest first**, by `requestedAt` — drain the backlog in the order things were
scanned so a unit cannot be starved by a trickle of newer ones.

`storeId` is the cloud's store id, and `storeName` is included so a human reading agent
logs can tell where a serial came from. There is deliberately **no** `retailStoreId`:
the cloud does not hold PPS's own store identifiers, so the agent maps
`storeId -> PPS store` on its side.

### 5. Return answers — `POST /api/sync/import-checks/results`

```json
{ "results": [
  { "itemId": "957d0e3c-…", "outcome": "MATCHED",
    "match": { "sku": "WIDGET-9", "name": "Widget", "description": "…",
               "price": 12.50, "expirationDate": "2028-03-01",
               "ppsProductRef": "PPSREF-9" } },
  { "itemId": "aa3b338f-…", "outcome": "NOT_FOUND" },
  { "itemId": "b1602114-…", "outcome": "DISCREPANCY",
    "discrepancy": { "reason": "serial belongs to a different store",
                     "ppsState": { "store": "Uptown", "qty": 3 } } }
] }
```

Response — **one ack per item**, in request order:

```json
{ "results": [
  { "itemId": "957d0e3c-…", "status": "resolved", "outcome": "MATCHED" },
  { "itemId": "aa3b338f-…", "status": "resolved", "outcome": "NOT_FOUND" },
  { "itemId": "zzz",        "status": "error", "reason": "unknown itemId" }
] }
```

| Outcome | What the cloud does |
| --- | --- |
| `MATCHED` | Finds the product by (company, `sku`) and links it, or creates it — **`needs_review = false`, because the ERP is authoritative for catalog data**. Sets the unit's product, price and expiration, clears its needs-review flag, and writes a ledger row noted `adopted via PPS import match (<sku>)`. The unit leaves the review queue on its own. |
| `NOT_FOUND` | Records the answer. The unit **stays** needs-review — nobody has identified it, so it must not leave the queue just because the ERP shrugged. |
| `DISCREPANCY` | Stores `reason` and `ppsState` verbatim and surfaces them to an admin. The unit **stays** needs-review. |

**MATCHED is the only outcome that resolves a unit.** The other two are answers, not
fixes.

**Idempotent.** A redelivered result for a unit that has already been answered returns
`already_resolved` and changes nothing, so the agent can retry a whole batch safely.

**Per-item isolation.** Each item is applied in its own transaction, exactly like
handoff lines: one bad result never rolls back the rest of the batch. A `MATCHED`
naming a quantity-tracked SKU, a missing `match.sku`, a `DISCREPANCY` with no
`reason`, or an unknown `itemId` all come back as that item's `error` while its
siblings succeed.

**Re-asking.** An admin can re-request a check from `NOT_FOUND` or `DISCREPANCY` — the
ERP may have caught up since it last answered — which puts the unit back into
`REQUESTED` and so back into this queue.

## What's new in v3.2

**A `unit` handoff no longer puts stock in the store.** It records that the ERP
*shipped* the unit. The item is created with status **`PENDING`** and **no
location**, and is deliberately excluded from on-hand totals, expiration alerts,
sell/move eligibility and location emptiness checks. It becomes real stock only
when somebody physically scans it during a cycle count, which sets it `ON_HAND`,
assigns the location being counted, and writes a **`RECEIVE`** ledger row.

The `RECEIPT` ledger row is still written at handoff time — that is when the ERP
handed the unit over, and the ledger records what was said as well as what was
confirmed — carrying the note `awaiting receiving scan` and no location.

**Nothing changes for the agent.** The request and response shapes are identical;
`accepted` still means "recorded". What changed is what `accepted` implies: shipped,
not shelved. A unit that is never scanned in stays `PENDING` indefinitely and is
reported as *shipped, not yet received* — it is never inferred sold, because it was
never in the store to sell.

### The unit/stock asymmetry (deliberate)

| Handoff kind | On arrival at the cloud | Becomes stock when |
| --- | --- | --- |
| `unit` (serialized) | `PENDING`, no location | physically scanned in a cycle count |
| `stock` (quantity) | added to Backroom stock **immediately** | at once, on handoff |

Quantity handoffs are **unchanged** and still land in the store's default Backroom.
The asymmetry is intentional: a serialized unit is an identifiable thing whose
physical arrival can be confirmed by scanning its serial, so it is worth tracking
the gap between shipped and received. A quantity handoff is an anonymous count with
nothing to scan one-by-one on arrival, so there is no confirmation event to wait
for and pretending otherwise would only strand stock in limbo. If per-unit receiving
for quantity products is ever needed it requires lot/batch identity first, which is
the same prerequisite as quantity expiration.

## What's new in v3.1

Stores now have named **locations** (areas). Every handoff — both `unit` and
`stock` — lands in the store's **default Backroom** — when a store has several
active Backroom locations this is the oldest active one by
(`sort_order`, `created_at`, `id`); deactivated locations are never chosen. Store staff then
move stock onto the sales floor in the app. The agent sends **no** location
field: routing to the Backroom is automatic and this is transparent to the
agent. `expirationDate` remains **unit-only** (serialized); quantity handoffs
carry no expiration (lot/batch expiration for quantity products is a planned
future feature).

## What's new in v3

Handoffs now route to a store by its **cloud store id** (`storeId`, the immutable
integer id assigned by the cloud) instead of the old `storeExternalBuildingId`.
Look up each store's `id` once (from the portal / stores list) and send it on
every handoff line.

## What's new in v2

Inventory is **dual-tracked**, driven by each product's `trackingType`:

- **Serialized** products — one physical unit per serial (`kind: "unit"`).
- **Quantity** products — a per-store counter, moved by ±N (`kind: "stock"`).

A handoff batch may **mix both kinds**. Unknown products are auto-created with
the `trackingType` implied by `kind`. See §1 for the idempotency rules (they
differ by kind). Contract v1 (serial-only) requests still work: a handoff line
with no `kind` is treated as `kind: "unit"`.

The agent's job, in a loop:

1. **Deliver handoffs** — push items shipped to a store (`POST /sync/handoffs`),
   then mark each local handoff delivered based on the per-line ack.
2. **Pull returns** — fetch returns the store initiated (`GET /sync/returns`),
   apply them in the local ERP, then acknowledge (`POST /sync/returns/ack`).

---

## 1. Handoffs — `POST /api/sync/handoffs`

Report items shipped/handed off to a store. The batch may mix `unit` and
`stock` lines. `storeId` maps to a store by its cloud id (the integer `id`
assigned when the store is created in the portal); an unknown id rejects that
line only (the rest of the batch still succeeds).

### Request

```http
POST /api/sync/handoffs
X-Api-Key: pps_xxx
Content-Type: application/json
```

```json
{
  "handoffs": [
    {
      "kind": "unit",
      "serial": "SN-1001",
      "sku": "TS-BLK-M",
      "name": "T-Shirt Black M",
      "price": 19.99,
      "upc": "0001110001",
      "expirationDate": "2026-12-31",
      "storeId": 3
    },
    {
      "kind": "stock",
      "handoffId": "ship-2026-07-27-line-42",
      "sku": "SOCK-WHT",
      "name": "Socks White 6-pack",
      "upc": "0002220001",
      "price": 9.99,
      "quantity": 24,
      "storeId": 3
    }
  ]
}
```

**Common fields** (both kinds): `sku`*, `name`*, `storeId`* (a positive integer,
the cloud store id) are required; `description`, `price`, `upc` are optional.

**`kind: "unit"`** (serialized): also requires `serial`*. `expirationDate` (a
`YYYY-MM-DD` calendar date) optional. Idempotency key is **(company, serial)** —
redelivering the same serial never creates a duplicate unit or ledger row.

**`kind: "stock"`** (quantity): also requires `quantity`* (positive integer) and
`handoffId`* — a **client-generated id, unique per shipment line**. The server
records each `handoffId` once (in `sync_receipts`, unique per company) inside the
same transaction as the stock increment, so **redelivering the same batch cannot
double-increment** a counter. Use a stable id derived from your shipment/line
(e.g. `"<shipmentId>-<lineNo>"`), not a random one per attempt.

> A `sku` that already exists with the other tracking type is rejected for that
> line (`error`): a serialized product can't receive a `stock` line and vice
> versa. Max 1000 lines per batch.

### Response `200`

Each line is acked individually so the agent knows exactly what to mark
delivered. Key off `serial` (unit) or `handoffId` (stock) — never array
position.

```json
{
  "results": [
    { "kind": "unit",  "serial": "SN-1001", "status": "accepted" },
    { "kind": "stock", "handoffId": "ship-2026-07-27-line-42", "status": "accepted" },
    { "kind": "stock", "handoffId": "ship-2026-07-20-line-9", "status": "already_processed" },
    { "kind": "unit",  "serial": "SN-9999", "status": "error", "reason": "unknown store id '999'" }
  ]
}
```

| status              | meaning                                                                                          | agent action                  |
| ------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------- |
| `accepted`          | New unit created / stock incremented; a `RECEIPT` ledger row written.                            | Mark local handoff delivered. |
| `already_processed` | Serial already present (unit), or `handoffId` already recorded (stock). No duplicate, no change. | Mark delivered (idempotent).  |
| `error`             | Not applied. See `reason`.                                                                        | Fix and retry that line.      |

> **Idempotency guarantee:** delivering the identical batch twice yields the same
> state — every line returns `already_processed` on the second delivery and no
> new ledger rows are written. Safe to retry after a timeout.

---

## 2. Pull returns — `GET /api/sync/returns`

Returns are items a store sent back to the warehouse in the portal. They queue
for the agent to apply in the local ERP. Oldest-first, undelivered only.

### Request

```http
GET /api/sync/returns?limit=100
X-Api-Key: pps_xxx
```

`limit` optional (default 100, max 500).

### Response `200`

Each return's `payload` carries a `kind` matching the product's tracking type.

```json
{
  "count": 2,
  "returns": [
    {
      "id": 42,
      "companyId": 1,
      "storeId": 3,
      "productId": 7,
      "itemId": "b3f7...uuid",
      "serial": "SN-1002",
      "payload": {
        "kind": "unit",
        "serial": "SN-1002",
        "sku": "TS-BLK-L",
        "name": "T-Shirt Black L",
        "upc": "0001110002",
        "storeId": 3,
        "returnedAt": "2026-07-27T19:03:00.000Z",
        "note": "overstock"
      },
      "createdAt": "2026-07-27T19:03:00.000Z",
      "deliveredAt": null
    },
    {
      "id": 43,
      "companyId": 1,
      "storeId": 3,
      "productId": 9,
      "itemId": null,
      "serial": null,
      "payload": {
        "kind": "stock",
        "sku": "SOCK-WHT",
        "name": "Socks White 6-pack",
        "upc": "0002220001",
        "quantity": 6,
        "storeId": 3,
        "returnedAt": "2026-07-27T19:05:00.000Z",
        "note": null
      },
      "createdAt": "2026-07-27T19:05:00.000Z",
      "deliveredAt": null
    }
  ]
}
```

Apply each return in the ERP using `payload`. For `kind: "unit"` restore the
serial; for `kind: "stock"` add `quantity` back to the product at that store
(`storeId`). Track the `id` values you successfully applied.

---

## 3. Acknowledge returns — `POST /api/sync/returns/ack`

Mark returns delivered so they stop appearing in `GET /sync/returns`.
**Idempotent**: acking an already-acked id is a no-op.

### Request

```http
POST /api/sync/returns/ack
X-Api-Key: pps_xxx
Content-Type: application/json
```

```json
{ "ids": [42, 43] }
```

### Response `200`

```json
{ "acknowledged": 2 }
```

`acknowledged` counts rows that transitioned from undelivered → delivered (so a
replay returns a smaller number or `0`).

---

## 4. The agent loop (reference)

```
every N seconds:
  # push
  batch = local.pendingHandoffs(limit=1000)   # each line has a kind
  if batch:
    resp = POST /sync/handoffs { handoffs: batch }
    for r in resp.results:
      key = r.serial or r.handoffId
      if r.status in (accepted, already_processed): local.markDelivered(key)
      else: local.flagError(key, r.reason)   # retry next cycle

  # pull
  resp = GET /sync/returns?limit=100
  applied = []
  for ret in resp.returns:
    try: local.applyReturn(ret.payload); applied.push(ret.id)
    except: pass   # will be re-served next cycle
  if applied: POST /sync/returns/ack { ids: applied }
```

---

## 5. Errors & retries

| HTTP  | meaning                        | agent action                             |
| ----- | ------------------------------ | ---------------------------------------- |
| `401` | Missing/invalid/revoked key.   | Stop; alert operator to rotate the key.  |
| `400` | Malformed body / validation.   | Fix payload; do not blindly retry.       |
| `429` | Rate limited.                  | Back off (exponential) and retry.        |
| `5xx` | Transient server error.        | Retry with backoff. Operations are safe to retry (idempotent). |

Guidance:

- **Always retry on network failure/timeout** — handoffs and acks are idempotent
  (units key on `serial`, stock keys on `handoffId`, acks on outbox `id`).
- Never key off array position.
- Rate limiting is per API key; keep batches reasonable and back off on `429`.
- This is contract **v3**. Additive fields may appear; ignore unknown fields.
  Breaking changes will bump the version and be announced.
```
