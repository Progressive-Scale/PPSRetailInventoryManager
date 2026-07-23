# Sync Agent Integration Contract — v1

This document is the **integration contract** for a customer sync agent that
exchanges inventory data with the PPS Retail Inventory cloud API. It is
self-contained: you can build an agent against any local ERP without reading the
server source.

The cloud system is the **authoritative system of record** for retail inventory.
The agent always **dials out** over HTTPS to the cloud API; the cloud never
connects into the customer network.

- **Base URL:** `https://<your-deployment-host>/api`
- **Contract version:** `v1`
- **Auth:** every request sends the header `X-Api-Key: <key>` (issued per company
  by a platform admin; shown in plaintext only once at creation). No JWT, no host
  tenancy — the key identifies the company.
- **Content type:** `application/json`.

The agent's job, in a loop:

1. **Deliver handoffs** — push items shipped to a store (`POST /sync/handoffs`),
   then mark each local handoff delivered based on the per-serial ack.
2. **Pull returns** — fetch returns the store initiated (`GET /sync/returns`),
   apply them in the local ERP, then acknowledge (`POST /sync/returns/ack`).

---

## 1. Handoffs — `POST /api/sync/handoffs`

Report items that have been shipped/handed off to a store. **Idempotent**:
re-delivering the same `serial` never creates a duplicate item or ledger entry.

Idempotency key: **(company, serial)**. `serial` is your ERP's serial / GS1 id
and must be unique per company.

`storeExternalBuildingId` maps to a store via its `externalBuildingId` (set when
the store is created in the portal). If it doesn't match a store, that item is
rejected (the rest of the batch still succeeds).

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
      "serial": "SN-1001",
      "sku": "TS-BLK-M",
      "name": "T-Shirt Black M",
      "description": "Optional",
      "price": 19.99,
      "storeExternalBuildingId": "BLDG-001"
    },
    {
      "serial": "SN-1002",
      "sku": "TS-BLK-L",
      "name": "T-Shirt Black L",
      "storeExternalBuildingId": "BLDG-001"
    }
  ]
}
```

Fields: `serial`*, `sku`*, `name`* and `storeExternalBuildingId`* are required;
`description` and `price` optional. Max 1000 items per batch.

### Response `200`

Each serial is acked individually so the agent knows exactly what to mark
delivered. Order matches the request but always key off `serial`.

```json
{
  "results": [
    { "serial": "SN-1001", "status": "accepted" },
    { "serial": "SN-1002", "status": "already_exists" },
    { "serial": "SN-9999", "status": "error", "reason": "unknown store building 'BLDG-XYZ'" }
  ]
}
```

| status           | meaning                                                        | agent action                  |
| ---------------- | -------------------------------------------------------------- | ----------------------------- |
| `accepted`       | New item created (`ON_HAND`), a `RECEIPT` ledger row written.  | Mark local handoff delivered. |
| `already_exists` | Item with this serial already present; mutable fields refreshed. No duplicate created. | Mark delivered (idempotent).  |
| `error`          | Not applied. See `reason`.                                     | Fix and retry that serial.    |

> **Idempotency guarantee:** delivering the identical batch twice yields the same
> item set — the second delivery returns `already_exists` for every serial and
> writes no new ledger rows. Safe to retry after a timeout.

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

```json
{
  "count": 1,
  "returns": [
    {
      "id": 42,
      "companyId": 1,
      "storeId": 3,
      "itemId": "b3f7...uuid",
      "serial": "SN-1002",
      "payload": {
        "serial": "SN-1002",
        "sku": "TS-BLK-L",
        "name": "T-Shirt Black L",
        "storeId": 3,
        "storeExternalBuildingId": "BLDG-001",
        "returnedAt": "2026-07-23T19:03:00.000Z",
        "note": "overstock"
      },
      "createdAt": "2026-07-23T19:03:00.000Z",
      "deliveredAt": null
    }
  ]
}
```

Apply each return in the ERP using `payload` (it carries
`storeExternalBuildingId` so you can map back to the ERP location). Track the
`id` values you successfully applied.

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
{ "acknowledged": 1 }
```

`acknowledged` counts rows that transitioned from undelivered → delivered (so a
replay returns a smaller number or `0`).

---

## 4. The agent loop (reference)

```
every N seconds:
  # push
  batch = local.pendingHandoffs(limit=1000)
  if batch:
    resp = POST /sync/handoffs { handoffs: batch }
    for r in resp.results:
      if r.status in (accepted, already_exists): local.markDelivered(r.serial)
      else: local.flagError(r.serial, r.reason)   # retry next cycle

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

- **Always retry on network failure/timeout** — handoffs and acks are idempotent.
- Key off `serial` (handoffs) and outbox `id` (returns), never on array position.
- Rate limiting is per API key; keep batches reasonable and back off on `429`.
- This is contract **v1**. Additive fields may appear; ignore unknown fields.
  Breaking changes will bump the version and be announced.
