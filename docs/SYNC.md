# Sync Agent Integration Contract — v3

This document is the **integration contract** for a customer sync agent that
exchanges inventory data with the PPS Retail Inventory cloud API. It is
self-contained: you can build an agent against any local ERP without reading the
server source.

The cloud system is the **authoritative system of record** for retail inventory.
The agent always **dials out** over HTTPS to the cloud API; the cloud never
connects into the customer network.

- **Base URL:** `https://<your-deployment-host>/api`
- **Contract version:** `v3`
- **Auth:** every request sends the header `X-Api-Key: <key>` (issued per company
  by a platform admin; shown in plaintext only once at creation). No JWT, no host
  tenancy — the key identifies the company.
- **Content type:** `application/json`.

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
