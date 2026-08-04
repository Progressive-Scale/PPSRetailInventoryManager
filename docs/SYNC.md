# Sync Agent Integration Contract — v3.8

This document is the **integration contract** for a customer sync agent that
exchanges inventory data with the PPS Retail Inventory cloud API. It is
self-contained: you can build an agent against any local ERP without reading the
server source.

The cloud system is the **authoritative system of record** for retail inventory.
The agent always **dials out** over HTTPS to the cloud API; the cloud never
connects into the customer network.

- **Base URL:** `https://<your-deployment-host>/api`
- **Contract version:** `v3.8`
- **Auth:** every request sends the header `X-Api-Key: <key>` (issued per company
  by a platform admin; shown in plaintext only once at creation). No JWT, no host
  tenancy — the key identifies the company.
- **Content type:** `application/json`.

## Planned — an unguessable public company identifier

**Agreed, not built** (recorded 2026-08-03). A company is currently identified by a small
sequential integer. Before real customer rollout, the identifier used to configure an
installation should be a GUID minted in pps so no one can guess or enumerate another
company's identifier.

This is hygiene, not a hole: `companyId` is never read from the request — the `X-Api-Key`
hash resolves it server-side and RLS scopes every row — so knowing another company's int
gains nothing without their key. What it fixes is a customer seeing that they are company
`1`, and an int being a poor identifier for anything customer-facing.

Planned shape: keep `companies.id` (it is the FK target everywhere and the RLS predicate)
and add `companies.public_id uuid unique`. `GET /api/sync/stores` would then also return
the public id. Agents should ignore unknown fields, per §5, so adding it is additive; a
version bump will announce it when it lands.

Whether **store** ids need the same treatment is still open — see
`PPSV8/PPS/migrations/RETAIL_DATABASE.md`.

## What's new in v3.8

**Reorders: the first thing that flows store → ERP as a request rather than a fact.**

Every earlier endpoint reports something that already happened — an item was handed
over, a unit came back, a serial was scanned. A reorder is different: a shop is *asking*
for stock, and the answer is whatever the consuming system does about it.

Two endpoints (§7, §8) and a deliberate design rule:

> **The cloud does not know what an ERP is.** It publishes open requests with enough
> product identity to match against a foreign catalog, and takes back one opaque string
> — whatever that system calls the order it raised. There is no pps-shaped field
> anywhere in this contract, no assumption that the consumer creates *orders* at all,
> and no fulfilment tracking. Any system able to read a queue and hand back a reference
> can consume it.

The PPS Retail Sync Agent is the first consumer, not the interface's owner.

*(The task that specified this called it v2.4; this document was already at v3.7, so it
lands as v3.8. Same contract — the same thing happened at v3.3.)*

### The lifecycle, and what "done" means

```
                     ┌──────────────► CANCELLED   (the store changed its mind)
                     │
        OPEN ────────┴──────────────► ACKNOWLEDGED  (a consumer raised order X)
```

`ACKNOWLEDGED` is terminal. The cloud tracks **no** partial shipment, back-order or
receipt against a reorder, because at that point the order exists in the other system
and that system is the authority on it. Stock arriving later shows up the way stock
always does — as a handoff (§1). If you find yourself wanting a `FULFILLED` status,
what you want is the handoff.

`quantityRequested` may be **null**, meaning "some, you decide". A shop-floor user
often knows the shelf is empty without knowing a case quantity, and demanding a number
would only produce a fictional one. **Treat null as 1** unless you have a better rule.

For a **serialized** product the quantity is *advisory*: the request says "about this
many", and which specific units ship is decided later by whoever picks them.

## What's new in v3.7

**The cloud reduces a scanned retail-label 2D code to its serial.** Nothing changes for an
agent; this documents what the shelf actually scans, because it is not the barcode we sync.

A finished retail package carries **two** symbols, and neither is the GS1-128:

| Symbol | Content | Example |
|---|---|---|
| 1D UPC-A | number system `2` (variable measure) + 5-digit item number + price | `2 07318 01196 8` → item `07318`, $11.96 |
| 2D | `R<serial>/<YYYYMMDD>` — serial + pack date | `R1205058450/20260722` |

So the same unit can be identified three ways, and the cloud accepts all three:

1. **the 2D composite** — reduced to the serial before matching (pack date ignored)
2. **the serial alone** — matched directly
3. **the ERP's GS1-128** — matched against the stored `barcode`

The reduction is deliberately strict: it requires a single letter, then digits, then a
slash, then eight digits that form a plausible date. Anything else is passed through
untouched, because shortening a string we cannot prove the shape of would file the scan
under an identity that matches nothing — and then report the unit in the counter's hand as
missing while the real one looks unaccounted for.

Two things worth knowing about the UPC symbol:

- **The price is inside it**, so the same product scans differently on every package. It is
  not a stable product identifier; only digits 2–6 are.
- Those digits are the **item number**, which is the ERP `ProductID` — i.e. the `sku` this
  contract already carries. A UPC scan therefore resolves through `sku`, not through
  `products.upc`, and never needed to match the 14-digit GTIN in `(01)`.

Resolving a product from a price-embedded UPC is **not implemented** — stores scan the
serial. It is a small addition if that changes.

## What's new in v3.6

**A serial is unique per SKU, not per company.** The idempotency key for a unit handoff is
now **(company, sku, serial)**.

This matches the ERP's own rule — `(sku, serial)` is what joins a unit back to
Ordersystem8 — and it means the same serial may legitimately appear under two different
SKUs. Previously the cloud enforced company-wide uniqueness, so the second SKU's unit was
treated as a redelivery of the first and silently relinked to the wrong product.

What changes for an agent: **nothing to send**. Redelivering the same `(sku, serial)` is
still `already_processed`. What changes is that the same serial under a *different* sku now
creates a second unit instead of colliding with the first.

Consequence worth knowing: a scanned serial is no longer guaranteed to identify one unit.
Where the cloud cannot tell two candidates apart it returns **409** rather than guessing —
scanning the whole `barcode` disambiguates, since that carries the GTIN. In practice a
cycle count's product scope resolves it, so 409 means two units of *different* SKUs share a
serial *and* both are countable in the same scope.

## What's new in v3.5

**`serial` means the serial. The full barcode has its own field.**

Additive and backward compatible — but read it, because an agent doing the wrong thing
here produces units the store cannot scan.

A GS1-128 label carries several fields: GTIN `(01)`, weight `(3202)`, dates `(13)`/`(15)`,
lot `(10)`, and the **serial `(21)`**. A store scans, and expects to identify, the
**serial alone**. If an agent sends the whole barcode as `serial`, every unit arrives with
an identity nobody can reproduce at the shelf: the scan says `100000000462`, the cloud has
only `(01) 90097586111018 (3202) 000082 (13) 240911 (21) 100000000462`, and a unit sitting
in front of the user is reported as an unknown serial.

So:

| Field | Send | Example |
|---|---|---|
| `serial` | the AI **(21)** value alone. Identity key, unique per **sku** (see v3.6) | `100000000462` |
| `barcode` | *(new, optional)* the whole barcode as printed | `(01) 90097586111018 (3202) 000082 (13) 240911 (21) 100000000462` |

`barcode` is stored, shown in the portal beneath the serial, and **matched as a fallback on
scan** — so a scanner pointed at the whole symbol still resolves to the right unit. It is
never the identity key, and it is not required to be unique.

`ImportMatch` (§7 results) accepts `barcode` too: a unit created from an unknown-serial
scan has none, so a match is the first opportunity to record it.

### If your ERP stores whole barcodes

Parsing the serial out is less trivial than it looks, and getting it wrong is silent. From
14,186 real rows in one ERP:

- **The `(21)` field is not always last.** ~1% put it before the weight or lot, so "take
  everything after `21`" returns the serial with the next field glued on.
- **Two dialects coexist in the same column** — parenthesised
  (`(01) 9009… (21) 1000…`) and raw unseparated digits (`019009…211000…`). Prefer the
  parenthesised one: it names every field, so order and length stop mattering. A raw
  string has no field separators, so a variable-length field is only readable when nothing
  follows it.
- **Some items have no serial at all** — GTIN, weight and lot only. Those are not
  scannable units. Report them; do not invent a serial.
- **A serial is at most 20 characters.** Longer means fields got glued together.

When the serial cannot be read, leave the line unsent and surface the reason. A parked row
with an explanation costs somebody a minute; a wrong serial creates a unit that is
untraceable at the shelf and blocks the return path later.

## What's new in v3.4

**One read-only endpoint: the store list.** Handoffs are addressed by cloud `storeId`,
so an agent has to know those ids — but until now the only way to see them was the
portal's `GET /stores`, which is JWT + company-admin and unreachable with an API key.

### 6. List stores — `GET /api/sync/stores`

No query parameters; a company has few enough stores to return them all.

```json
{
  "count": 2,
  "stores": [
    { "id": 1, "companyId": 1, "name": "Downtown", "city": "Springfield", "state": "IL", "isActive": true },
    { "id": 7, "companyId": 1, "name": "Uptown",   "city": null,          "state": null, "isActive": false }
  ]
}
```

`id` is the value to send as `storeId` on a handoff line. **Inactive stores are
included** — an agent mirroring these rows needs to know a store went inactive rather
than watching it silently vanish, and historical handoffs still reference it.

There is deliberately **no store code**: the cloud identifies a store by its integer
id and has no second identifier. An ERP with its own code column should leave it null
rather than inventing one.

Read-only. Stores are created and edited in the portal; the cloud mints the ids and
the ERP links to them.

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

A `PENDING` unit that is clearly never coming can be written off by hand from
**Inventory → Pending arrival** (`POST /inventory/items/:id/lost`, company admin),
which moves it to status `LOST`. That is a deliberate human decision, not something a
count or a timer does: the ledger row carries `quantity_delta = 0`, because the unit
never became stock and nothing leaves on-hand. Nothing is sent back to the ERP.

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
      "serial": "100000000462",
      "barcode": "(01) 90097586111018 (3202) 000082 (13) 240911 (21) 100000000462",
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

**`kind: "unit"`** (serialized): also requires `serial`* — the GS1 AI **(21)** value
alone, **not** the whole barcode; see v3.5 above. `barcode` (the full label string, max 400
chars) and `expirationDate` (a `YYYY-MM-DD` calendar date) are optional. Idempotency key is
**(company, sku, serial)** — redelivering the same serial *for the same sku* never creates a
duplicate unit or ledger row, and re-sending with `barcode` fills it in on a unit handed off
before the agent knew how. The same serial under a **different** sku is a different physical
unit and creates a second one; see v3.6.

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

## 7. Pull reorders — `GET /api/sync/reorders`

Query: `status` (`OPEN` | `ACKNOWLEDGED` | `CANCELLED`, default **`OPEN`**), `limit`
(default 100, max 500), `offset`.

```json
{
  "data": [
    { "reorderId": 12, "retailStoreId": 1,
      "product": { "sku": "GLOVE-BLK", "upc": "0002220002",
                   "name": "Work Gloves Black", "trackingType": "QUANTITY" },
      "quantityRequested": 24,
      "note": "Down to the last box on the floor.",
      "createdAt": "2026-08-04T16:15:55.237Z" }
  ],
  "total": 4, "limit": 100, "offset": 0
}
```

**Oldest first**, by `createdAt` then `reorderId`, so a backlog is worked in the order
the shops asked and a trickle of new requests cannot starve an old one.

| Field | Meaning |
|---|---|
| `reorderId` | The cloud's id. The only thing §8 needs. |
| `retailStoreId` | Cloud store id — the same value §1 addresses a handoff to and §6 lists. Map it to your own site/customer on your side; the cloud holds no ERP identifiers. |
| `product.sku` | Match on this **first**. It is the cloud's product key and, where an ERP fed the catalog, it came from that ERP. |
| `product.upc` | Fall back to this when the sku is unknown locally. Nullable. |
| `product.name` | For logs and for a human reading them. Never match on it. |
| `product.trackingType` | `SERIALIZED` or `QUANTITY`. Tells you whether quantity is a count of identifiable units or of stock. |
| `quantityRequested` | May be null — see above. |
| `note` | Free text from the person who asked. Worth carrying onto whatever you create; it is often the only explanation of *why*. |

A product your catalog does not contain is a **line-level** problem, not a batch-level
one: skip that line, leave the request unacknowledged (it stays `OPEN` and will be
offered again), and surface it to an operator. Do **not** invent a local product.

## 8. Acknowledge a reorder — `POST /api/sync/reorders/:id/ack`

```json
{ "externalOrderRef": "1284" }
```

`externalOrderRef` (1–128 chars, required) is **opaque to the cloud**. It is displayed
verbatim to store staff, so send whatever a human would recognise in your system — an
order number, a document id, a URL.

### Response `200`

```json
{ "status": "acknowledged", "reorderId": 12, "externalOrderRef": "1284" }
```

| `status` | When |
|---|---|
| `acknowledged` | It was `OPEN`; it is now `ACKNOWLEDGED` with your reference, and the person who raised it gets a notification. |
| `already_acknowledged` | It already carried **this same** reference. Nothing changed. |

### Errors

| HTTP | When | What to do |
|---|---|---|
| `404` | No such request for your company. | Log and drop it. |
| `409` | Already acknowledged with a **different** reference. | **Stop and escalate.** Two orders now exist for one request; the cloud refuses to overwrite because that would silently lose the first order number. A human decides which is real. |
| `410` | The store cancelled the request. | Log and skip. Terminal — never retry, and cancel your order if you already raised one. |

**Idempotency is by reference, and it is the point.** Follow the same rule as everywhere
else in this contract: *create locally first, acknowledge second* (§4). If your order is
created and the ack then fails — network drop, process restart — repeat the ack with the
**same** reference next sweep and it is a no-op. That is why a differing reference is an
error rather than an update: it is the one case that cannot be a retry.

Partial success is normal and per-request: acknowledge each reorder you actually
included, and leave the rest `OPEN`.

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

every M seconds (M is usually larger — reorders are not urgent):
  # reorders: one local document per store per sweep
  resp = GET /sync/reorders?status=OPEN
  for storeId, lines in groupBy(resp.data, 'retailStoreId'):
    site = local.resolveSite(storeId)
    if not site: warn("store %s is not mapped" % storeId); continue   # stays OPEN

    usable = [l for l in lines if local.findProduct(l.product.sku, l.product.upc)]
    for l in lines - usable: warn("unknown product %s" % l.product.sku)  # stays OPEN
    if not usable: continue

    ref = local.createOrder(site, usable)        # ONE transaction, commits first
    for l in usable:
      POST /sync/reorders/%s/ack % l.reorderId { externalOrderRef: ref }
```

Note the ordering in the reorder block: the local document is committed **before** any
ack. If the process dies between the two, the next sweep re-serves those requests, the
consumer must recognise it already has an order for them, and re-acking with the same
reference is a no-op (§8).

---

## 5. Errors & retries

| HTTP  | meaning                        | agent action                             |
| ----- | ------------------------------ | ---------------------------------------- |
| `401` | Missing/invalid/revoked key.   | Stop; alert operator to rotate the key.  |
| `400` | Malformed body / validation.   | Fix payload; do not blindly retry.       |
| `409` | Conflict with existing state.  | Do **not** retry. Only §8 returns this; it means two orders exist for one reorder and a human must decide. |
| `410` | The thing is gone for good.    | Log and skip; never retry. Only §8 returns this, for a cancelled reorder. |
| `429` | Rate limited.                  | Back off (exponential) and retry.        |
| `5xx` | Transient server error.        | Retry with backoff. Operations are safe to retry (idempotent). |

Guidance:

- **Always retry on network failure/timeout** — handoffs and acks are idempotent
  (units key on `serial`, stock keys on `handoffId`, return acks on outbox `id`, and a
  reorder ack on the `externalOrderRef` you sent).
- Never key off array position.
- Rate limiting is per API key; keep batches reasonable and back off on `429`.
- `409` and `410` are **not** retryable — they are answers, not failures. See §8.
- This is contract **v3**. Additive fields may appear; ignore unknown fields.
  Breaking changes will bump the version and be announced.
```
