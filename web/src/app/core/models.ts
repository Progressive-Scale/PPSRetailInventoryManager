export type Role =
  | 'PLATFORM_ADMIN'
  | 'COMPANY_ADMIN'
  | 'STORE_MANAGER'
  | 'STORE_USER';

/** The roles a tenant admin may hand out. Never PLATFORM_ADMIN. */
export type TenantRole = Exclude<Role, 'PLATFORM_ADMIN'>;

export function roleLabel(role: Role | string | null | undefined): string {
  switch (role) {
    case 'PLATFORM_ADMIN':
      return 'Platform Admin';
    case 'COMPANY_ADMIN':
      return 'Company Admin';
    case 'STORE_MANAGER':
      return 'Store Manager';
    default:
      return 'Store User';
  }
}

export interface AuthUser {
  id: number;
  email: string;
  /** Sign-in name, unique within the company. */
  username: string;
  companyId: number | null;
  storeId: number | null;
  role: Role;
}

/** Why a password-reset link is or is not usable. */
export type ResetState = 'VALID' | 'INVALID' | 'USED' | 'SUPERSEDED' | 'EXPIRED';

export interface ResetStatusResponse {
  state: ResetState;
  /** Empty when VALID; otherwise what to tell the user. */
  message: string;
  /** Whose account the link belongs to, present only when VALID. */
  username?: string;
}

/** Your own account, as returned by /api/profile. */
export interface Profile {
  id: number;
  email: string;
  username: string;
  companyId: number | null;
  storeId: number | null;
  role: Role;
  createdAt: string;
}

export interface LoginResponse {
  access_token: string;
  user: AuthUser;
  /** Stores the user may access (for the login store picker). */
  availableStores?: { id: number; name: string }[];
  /** True when a multi-store user must choose before working. */
  storeSelectionRequired?: boolean;
}

export interface Branding {
  name: string;
  slug: string;
  branding: {
    logoUrl: string | null;
    primaryColor: string;
  };
}

/**
 * PENDING = shipped by the ERP, not yet physically received (not stock).
 * LOST    = written off as never going to turn up; usually a pending arrival that
 *           stopped being worth waiting for.
 */
export type ItemStatus =
  | 'PENDING'
  | 'ON_HAND'
  | 'SOLD'
  | 'RETURNED_TO_WAREHOUSE'
  | 'ADJUSTED_OUT'
  | 'LOST';

/** Outcome of asking the PPS import agent about an unknown serial. */
export type ImportCheckStatus = 'REQUESTED' | 'MATCHED' | 'NOT_FOUND' | 'DISCREPANCY';

export type TrackingType = 'SERIALIZED' | 'QUANTITY';

export type LocationKind = 'BACKROOM' | 'ONFLOOR' | 'CUSTOM';

/**
 * A named area within a store. A store may have SEVERAL Backroom/On Floor
 * locations; the invariant is that at least one of each stays ACTIVE.
 */
export interface StoreLocation {
  id: number;
  companyId: number;
  storeId: number;
  name: string;
  kind: LocationKind;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  // Lifecycle flags — returned ONLY when listing with includeInactive (the admin
  // view), so the UI can offer the right action without probing.
  /** Live stock present (ON_HAND units or quantity on hand). Blocks both actions. */
  hasStock?: boolean;
  /** Referenced by the ledger or any inventory row. Blocks delete, not deactivate. */
  hasHistory?: boolean;
  /** Last active Backroom/On Floor of its store. Blocks both actions. */
  isLastOfRequiredKind?: boolean;
  /** Item count behind hasStock, for the "move the N items out" message. */
  stockCount?: number;
  /** EVERY item still at this location, whatever its status. Blocks delete. */
  itemCount?: number;
  /** How many of itemCount are sold (sold units cannot currently be moved). */
  soldCount?: number;
  /** The ledger records a movement in/out of here. Blocks delete. */
  hasLedger?: boolean;
}

/** A serialized inventory unit (one row per serial). */
export interface InventoryItem {
  id: string;
  companyId: number;
  storeId: number;
  productId: number;
  serial: string;
  /**
   * The serial of the case this unit came out of, when it came out of one. Grouping only —
   * the case is a barcode on a box, never a unit of its own. Null for the ordinary unit
   * that arrived on its own.
   */
  caseSerial: string | null;
  status: ItemStatus;
  expirationDate: string | null;
  /** Pounds, as a numeric string. Null when nobody has weighed this unit. */
  weightLbs: string | null;
  /**
   * This unit's price override, as a numeric string. NULL is not zero — it means
   * "no override, use the product's price", which is the only way to say that.
   */
  price: string | null;
  receivedAt: string | null;
  updatedAt: string;
  createdAt: string;
}

/** Product-level row from the store_inventory view (GET /api/inventory). */
export interface StoreInventoryRow {
  companyId: number;
  storeId: number;
  productId: number;
  sku: string;
  upc: string | null;
  name: string;
  trackingType: TrackingType;
  onHand: number;
  matchedSerial?: string;
}

/** Quantity-tracked stock counter (one per store per product). */
export interface InventoryStock {
  id: number;
  companyId: number;
  storeId: number;
  productId: number;
  quantityOnHand: number;
  updatedAt: string;
}

/** A serialized unit as returned in product detail (with its location). */
export interface DetailUnit {
  id: string;
  storeId: number;
  locationId: number;
  locationName: string;
  locationKind: LocationKind;
  serial: string;
  /** The box this piece came out of, or null for a unit that arrived on its own. */
  caseSerial: string | null;
  status: ItemStatus;
  expirationDate: string | null;
  /** Pounds, as a numeric string. Null when nobody has weighed this unit. */
  weightLbs: string | null;
  /**
   * This unit's price override, as a numeric string. NULL is not zero — it means
   * "no override, use the product's price", which is the only way to say that.
   */
  price: string | null;
  receivedAt: string | null;
  updatedAt: string;
}

/** A per-location stock counter row as returned in product detail. */
export interface DetailStockRow {
  id: number;
  storeId: number;
  productId: number;
  locationId: number;
  locationName: string;
  locationKind: LocationKind;
  quantityOnHand: number;
  updatedAt: string;
}

/** GET /api/inventory/:productId — serialized detail. */
export interface SerializedInventoryDetail {
  product: Product;
  trackingType: 'SERIALIZED';
  units: DetailUnit[];
  statusCounts: Record<string, number>;
}

/** GET /api/inventory/:productId — quantity detail. */
export interface QuantityInventoryDetail {
  product: Product;
  trackingType: 'QUANTITY';
  stock: DetailStockRow[];
  ledger: Transaction[];
}

/**
 * A flat stock row from GET /api/inventory/stock — one per serialized unit
 * (rowKind 'unit', onHand 1) or per quantity stock-location (rowKind 'stock').
 */
export interface StockRow {
  rowKind: 'unit' | 'stock';
  rowId: string;
  itemId: string | null;
  /**
   * The case a piece came out of; null on a unit that arrived alone and always null on a
   * stock row — a quantity counter is not a piece of anything. Grouping metadata only.
   */
  caseSerial: string | null;
  productId: number;
  sku: string;
  upc: string | null;
  name: string;
  trackingType: TrackingType;
  storeId: number;
  onHand: number;
  locationId: number;
  locationName: string;
  locationKind: LocationKind;
  serial: string | null;
  expirationDate: string | null;
  createdAt: string;
  /**
   * When this unit was scanned into inventory — what the grid shows, sorts and filters on.
   * On a quantity row it is the counter's own creation, which is when the first of those
   * units landed: the same fact, one level up.
   */
  receivedAt: string;
  /**
   * This unit's weight in pounds, as a numeric string. Null on a quantity row (there is
   * no unit to weigh) and on a unit nobody has weighed — both render as "—", never 0.
   */
  weightLbs: string | null;
  /**
   * price       — this unit's override; null means it inherits (and always null on a
   *               quantity row, which has no unit to price).
   * catalogPrice— what the product says, i.e. what it would inherit.
   * effectivePrice — what it actually sells for. The server does the COALESCE so the
   *               grid, the detail panel and any future consumer cannot disagree.
   */
  price: string | null;
  catalogPrice: string | null;
  effectivePrice: string | null;
  // When this unit was sold; null while on hand and always null for quantity rows.
  soldAt: string | null;
  /** This store already has a live reorder for this product. */
  reorderOpen: boolean;
  // Serialized unit status (ON_HAND / SOLD / …); null for quantity rows.
  status: ItemStatus | null;
}

/**
 * A product row in the stock grid: the rollup of every {@link StockRow} the current
 * filters admit for that product, from GET /api/inventory/stock/by-product.
 *
 * Dates arrive as From/To pairs because a product holds many units — one date would be
 * a lie. They collapse to a single value when the range is a point.
 */
export interface ProductStockRow {
  productId: number;
  sku: string;
  upc: string | null;
  name: string;
  trackingType: TrackingType;
  /** Summed over the filtered rows, so it equals what the expansion shows. */
  onHand: number;
  /** How many rows the expansion will hold. */
  rowCount: number;
  /** 1 → storeId names the single store; more → "N stores". */
  storeCount: number;
  storeId: number;
  /**
   * The product's CATALOG price. Not a rollup of its units' effective prices — an
   * average of overrides is a number nothing sells for. `overriddenCount` says how
   * many units underneath carry their own instead.
   */
  price: string | null;
  overriddenCount: number;
  /** 1 → locationName names it; more → "N locations". */
  locationCount: number;
  locationName: string | null;
  expirationFrom: string | null;
  expirationTo: string | null;
  receivedFrom: string;
  receivedTo: string;
  soldFrom: string | null;
  soldTo: string | null;
  /**
   * Total pounds over the SAME units onHand counts, summed server-side. Numeric string,
   * or null when no unit of the product has a weight at all.
   *
   * A total is the useful rollup for weight where the dates get a range: what a shop
   * wants off a product row is how many pounds are sitting there.
   */
  totalWeightLbs: string | null;
  /**
   * How many of those units have no weight recorded. Above zero, the total is a partial
   * sum and must be shown as one — see the indicator in the grid.
   */
  unweightedCount: number;
  /** Shipped, not yet received. Excluded from onHand by design. */
  pendingCount: number;
}

export type StockSortField =
  | 'sku'
  | 'barcode'
  | 'name'
  | 'type'
  | 'store'
  | 'onHand'
  | 'location'
  | 'expiration'
  | 'received'
  | 'sold'
  /** Per-unit lbs on the flat grid; the product total in the by-product view. */
  | 'weight'
  /** Effective price on the flat grid; the catalog price in the by-product view. */
  | 'price';

export type StockStatusFilter = 'ON_HAND' | 'SOLD' | 'ALL';

/** An audit record for a manual field change on a serialized item. */
export interface ItemAudit {
  id: number;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  source: 'BULK_EDIT' | 'SINGLE_EDIT' | 'SYNC';
  note: string | null;
  createdAt: string;
  changedByUserId: number | null;
  changedByEmail: string | null;
}

/**
 * One row of the unified activity stream — a field change, a lifecycle event, or a stock
 * movement, all in one shape. `kind` says which stream it came from; `summary` is the
 * sentence the server already composed, so every surface says the same thing.
 */
export interface ActivityRow {
  id: string;
  kind: 'AUDIT' | 'LEDGER';
  at: string;
  actorType: 'USER' | 'SYNC_AGENT' | 'SYSTEM_JOB';
  userId: number | null;
  /** username / 'Sync' / 'System'. */
  actor: string;
  source: 'WEB' | 'SCANNER' | 'SYNC' | 'JOB';
  storeId: number | null;
  storeName: string | null;
  entityType: string;
  entityId: string;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  details: Record<string, unknown> | null;
  summary: string;
  quantityDelta: number | null;
  productId: number | null;
  sku: string | null;
  productName: string | null;
  serial: string | null;
  locationFrom: string | null;
  locationTo: string | null;
  cycleCountId: number | null;
  note: string | null;
}

/** Filters the activity stream accepts. Every field is optional and ANDed server-side. */
export interface ActivityQuery {
  userId?: number | null;
  entityType?: string | null;
  action?: string | null;
  storeId?: number | null;
  /** Free text over actor, store, product, serial and the action. Global feed only. */
  search?: string | null;
  source?: string | null;
  /** ISO dates (yyyy-mm-dd is fine); `to` is exclusive. */
  from?: string | null;
  to?: string | null;
  limit?: number;
  offset?: number;
}

export interface BulkExpirationResult {
  results: { itemId: string; ok: boolean; reason?: string }[];
}

/**
 * A serialized unit row from GET /api/inventory/items.
 *
 * product and location are nullable because this endpoint also serves the two
 * queues where they are legitimately absent: PENDING units have no location, and
 * unidentified units have no product.
 */
export interface ExpiringItem {
  id: string;
  storeId: number;
  productId: number | null;
  sku: string | null;
  name: string | null;
  locationId: number | null;
  locationName: string | null;
  locationKind: LocationKind | null;
  /** GS1 AI (21) — the value a store scans. */
  serial: string;
  /** The full GS1-128 barcode from the ERP label, when it sent one. */
  barcode: string | null;
  /**
   * The case this piece arrived in, or null for a unit that arrived on its own. Pending
   * arrival groups by it so one carton reads as one delivery rather than N arrivals.
   */
  caseSerial: string | null;
  status: ItemStatus;
  expirationDate: string | null;
  receivedAt: string | null;
  needsReview: boolean;
  importCheckStatus: ImportCheckStatus | null;
  /** Whatever the agent reported; only DISCREPANCY carries useful detail. */
  importCheckResult: Record<string, unknown> | null;
  /** For a PENDING unit this is the handoff moment. */
  createdAt: string;
  /** Whole days since handoff; null unless PENDING. */
  daysPending: number | null;
}

export type InventoryProductDetail = SerializedInventoryDetail | QuantityInventoryDetail;

/** Body shared by sell/return/adjust. Quantity ops require `locationId`. */
export interface InventoryOpBody {
  itemId?: string;
  productId?: number;
  quantity?: number;
  locationId?: number;
  storeId?: number;
  note?: string;
}

/** POST /api/inventory/move — serialized batch OR one quantity line. */
export interface MoveInventoryBody {
  toLocationId: number;
  itemIds?: string[];
  productId?: number;
  fromLocationId?: number;
  quantity?: number;
  note?: string;
}

export interface MoveSerialResult {
  mode: 'serial';
  toLocationId: number;
  moved: number;
  results: { itemId: string; status: 'moved' | 'unchanged' | 'error'; reason?: string }[];
}

export interface MoveQuantityResult {
  mode: 'quantity';
  productId: number;
  fromLocationId: number;
  toLocationId: number;
  quantity: number;
  fromRemaining: number;
  toOnHand: number;
}

export type MoveResult = MoveSerialResult | MoveQuantityResult;

export type TxType = 'RECEIPT' | 'SALE' | 'ADJUSTMENT' | 'RETURN' | 'MOVE';

export interface Transaction {
  id: number;
  companyId: number;
  storeId: number;
  itemId: string | null;
  productId: number;
  type: TxType;
  quantityDelta: number;
  locationFromId: number | null;
  locationToId: number | null;
  note: string | null;
  performedByUserId: number | null;
  source: TxSource;
  cycleCountId: number | null;
  createdAt: string;
}

export type TxSource = 'PORTAL' | 'SYNC' | 'CYCLE_COUNT';

export interface Store {
  id: number;
  companyId: number;
  name: string;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface User {
  id: number;
  companyId: number | null;
  /** The user's ACTIVE store (what their session scopes to). */
  storeId: number | null;
  /** Every store this user may access. */
  storeIds: number[];
  email: string;
  /** Sign-in name, unique within the company. */
  username: string;
  role: Role;
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
}

export type InvitationState =
  | 'VALID'
  | 'INVALID'
  | 'REVOKED'
  | 'ALREADY_ACCEPTED'
  | 'EXPIRED';

export type InvitationEmailStatus = 'PENDING' | 'SENT' | 'FAILED';

export interface Invitation {
  id: number;
  companyId: number;
  email: string;
  role: Role;
  /** Mirrors storeIds when exactly one store is granted, else null. */
  storeId: number | null;
  /** Stores the invitee is granted on accept. */
  storeIds: number[];
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  revokedByUserId: number | null;
  emailStatus: InvitationEmailStatus;
  emailSentAt: string | null;
  emailError: string | null;
  createdAt: string;
  /** Returned ONLY by create/resend — the plaintext link, shown once. */
  acceptUrl?: string;
  acceptPath?: string;
  emailWarning?: string | null;
}

/** GET /api/invitations/status — public accept-page state. */
export interface InvitationStatus {
  state: InvitationState;
  message: string;
  email?: string;
  companyName?: string;
  role?: Role;
}

export interface Product {
  id: number;
  companyId: number;
  sku: string;
  name: string;
  description: string | null;
  price: string;
  upc: string | null;
  trackingType: TrackingType;
  needsReview: boolean;
  /** Low-stock hint threshold; null = no opinion, no hint. */
  reorderThreshold: number | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Company {
  id: number;
  name: string;
  slug: string;
  customDomain: string | null;
  branding: unknown;
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
  /** Which scanner build this tenant's devices are offered. */
  releaseChannelId: number;
  /** Name of that channel, joined server-side so the dropdown needs no lookup. */
  releaseChannel: string;
}

// ---- scanner releases ----

export interface AppRelease {
  id: number;
  versionCode: number;
  versionName: string;
  apkUrl: string;
  apkSha256: string;
  releaseNotes: string | null;
  fileSizeBytes: number | null;
  createdAt: string;
}

/** Whether the URL actually answered when the release was recorded. Advisory. */
export interface ReleaseUrlCheck {
  ok: boolean;
  status: number | null;
  error: string | null;
  sizeBytes: number | null;
}

export type CreatedRelease = AppRelease & { urlCheck: ReleaseUrlCheck };

export interface CreateRelease {
  versionCode: number;
  versionName: string;
  apkUrl: string;
  apkSha256: string;
  releaseNotes?: string;
  fileSizeBytes?: number;
}

/** A release as embedded in a channel row — enough to name it. */
export interface ChannelRelease {
  id: number;
  versionCode: number;
  versionName: string;
  apkUrl: string;
}

export interface ReleaseChannel {
  id: number;
  name: string;
  releaseId: number | null;
  minSupportedReleaseId: number | null;
  release: ChannelRelease | null;
  minSupportedRelease: ChannelRelease | null;
  /** How many companies follow this channel right now. */
  companyCount: number;
}

export interface UpdateChannel {
  releaseId?: number | null;
  minSupportedReleaseId?: number | null;
}

export interface FleetDevice {
  deviceIdentifier: string;
  versionCode: number | null;
  /** Null when the reported code is not one we published — a sideloaded build. */
  versionName: string | null;
  lastSeenAt: string | null;
  username: string | null;
  /** At or ahead of what its company's channel offers. */
  current: boolean;
}

export interface FleetCompany {
  companyId: number;
  companyName: string;
  companySlug: string;
  channel: string;
  channelVersionCode: number | null;
  channelVersionName: string | null;
  devices: FleetDevice[];
}

export interface FleetResponse {
  companies: FleetCompany[];
}

export interface ApiKey {
  id: number;
  companyId: number;
  name: string;
  createdAt: string;
  // Present only in the create response.
  key?: string;
}

/** A user as the platform panel lists them: which tenant, and which stores. */
export interface AdminUser extends User {
  companyName: string | null;
  companySlug: string | null;
  /** Names of the permitted stores, in the same order as storeIds. */
  storeNames: string[];
}

/** Filters for the cross-company user list. */
export interface AdminUserQuery {
  companyId?: number;
  role?: Role;
  status?: 'ACTIVE' | 'SUSPENDED';
  /** Substring of username or email. */
  q?: string;
  limit?: number;
  offset?: number;
}

export interface AdminUpdateUser {
  role?: TenantRole;
  status?: 'ACTIVE' | 'SUSPENDED';
  storeIds?: number[];
}

/** A reset link issued on a user's behalf — returned once, to the platform admin. */
export interface AdminPasswordReset {
  userId: number;
  email: string;
  username: string;
  resetUrl: string;
  expiresAt: string;
  emailSent: boolean;
  emailError: string | null;
}

export interface HealthRow {
  id: number;
  slug: string;
  name: string;
  status: string;
  last_agent_sync: string | null;
  undelivered_returns: number;
  items: number;
  transactions: number;
}

export interface HealthResponse {
  companies: HealthRow[];
}

// ---- cycle counts ----

/** AWAITING_REVIEW = submitted; the proposals have changed nothing yet. */
export type CycleCountStatus =
  | 'OPEN'
  | 'AWAITING_REVIEW'
  | 'CLOSED'
  | 'CANCELLED';

/** Columns the cycle-count list can be ordered by. Must match the API's whitelist. */
export type CycleCountSortField =
  | 'id'
  | 'status'
  | 'openedAt'
  | 'expectedCount'
  | 'scannedCount'
  | 'soldGeneratedCount';

export type CycleCountResolution =
  | 'SCANNED'
  | 'COUNTED_BY_UPC'
  | 'MARKED_SOLD'
  | 'NEW_ITEM'
  | 'RECEIVED'
  | 'PENDING_NOT_RECEIVED'
  | 'REINSTATED'
  | 'MOVED_IN';

export interface CycleCount {
  id: number;
  companyId: number;
  storeId: number;
  status: CycleCountStatus;
  /** The counted location. Null = a whole-store count. */
  locationId: number | null;
  openedByUserId: number;
  submittedByUserId: number | null;
  submittedAt: string | null;
  closedByUserId: number | null;
  openedAt: string;
  closedAt: string | null;
  expectedCount: number;
  scannedCount: number;
  soldGeneratedCount: number;
}

export interface CycleCountLine {
  id: number;
  companyId: number;
  cycleCountId: number;
  /** Null for an unidentified unit — no catalog row yet. */
  productId: number | null;
  itemId: string | null;
  serial: string | null;
  quantity: number | null;
  resolution: CycleCountResolution;
  /** Where the line puts the unit; null on PENDING_NOT_RECEIVED. */
  locationId: number | null;
  /** MOVED_IN only: where the system thought it was. */
  locationFromId: number | null;
  /** Null while proposed; set once approval applied it. */
  appliedAt: string | null;
  importCheckRequested: boolean;
  createdAt: string;
  sku: string | null;
  name: string | null;
  locationName: string | null;
  /**
   * COUNTED_BY_UPC only: what the books said was on that shelf, and how many units the
   * count removes from it. Null on every other resolution — a serialized line's shortfall
   * is the line itself.
   */
  recordedQuantity: number | null;
  shortfall: number | null;
}

/** The scope a count was opened with — and therefore what its sweep can touch. */
export interface CycleCountScope {
  locationId: number | null;
  locationName: string | null;
  productIds: number[];
  wholeStore: boolean;
}

/** How much of this count REMOVES stock. Surfaced separately for the reviewer. */
export interface CycleCountDestructive {
  /** Every unit the count would record as sold: unscanned units AND shelf shortfalls. */
  inferredSales: number;
  /** The serialized half of inferredSales — units nobody accounted for. */
  markedSoldUnits: number;
  /** Units missing off the quantity shelves that were counted. */
  shortfallUnits: number;
  /** How many shelves came up short. A zeroed shelf is the extreme case of one. */
  shortfallLines: number;
  zeroedStockLines: number;
}

export interface CycleCountDetail {
  cycleCount: CycleCount;
  scope: CycleCountScope;
  lines: CycleCountLine[];
  linesByResolution: Record<CycleCountResolution, CycleCountLine[]>;
  markedSoldSerials: (string | null)[];
  pendingNotReceived: CycleCountLine[];
  destructive: CycleCountDestructive;
  awaitingReview: boolean;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

// ---- request DTOs ----

/**
 * A store is a delivery destination, so the ship-to parts are required — the ERP cannot
 * raise a shipment against a row without them. Only address2 (suite/unit) is optional.
 */
export interface CreateStore {
  name: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  zip: string;
  notes?: string;
  isActive?: boolean;
}

export interface UpdateStore {
  name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  notes?: string;
  isActive?: boolean;
}

export interface UpdateUser {
  role?: Role;
  status?: 'ACTIVE' | 'SUSPENDED';
  storeId?: number | null;
  /** Full replacement of the stores this user may access. */
  storeIds?: number[];
}

export interface CreateInvitation {
  email: string;
  role: Role;
  /** Stores granted on accept; omit or empty for no store. */
  storeIds?: number[];
}

export interface CreateProduct {
  sku: string;
  name: string;
  description?: string;
  price?: number;
  upc?: string;
  trackingType: TrackingType;
}

export interface UpdateProduct {
  sku?: string;
  name?: string;
  /** Explicit null removes the description; omit to leave it alone. */
  description?: string | null;
  price?: number;
  /** Explicit null removes the barcode; omit to leave it alone. */
  upc?: string | null;
  active?: boolean;
  needsReview?: boolean;
  /** Explicit null clears the low-stock threshold; omit to leave it alone. */
  reorderThreshold?: number | null;
  trackingType?: TrackingType;
}

export interface CreateLocation {
  storeId: number;
  name: string;
  /** Defaults to CUSTOM; immutable afterwards. */
  kind?: LocationKind;
  isActive?: boolean;
}

export interface UpdateLocation {
  name?: string;
  sortOrder?: number;
  isActive?: boolean;
}

// ---- notifications ----

export type NotificationType =
  | 'EXPIRATION_WARNING'
  | 'INVITE_ACCEPTED'
  | 'REORDER_ACKNOWLEDGED'
  | 'CYCLE_COUNT_REVIEW'
  | 'ITEMS_NEED_REVIEW'
  | 'ITEMS_IDENTIFIED'
  | 'REORDER_DECLINED';
export type NotificationStatus = 'UNREAD' | 'READ' | 'DISMISSED';

export interface ExpirationPayload {
  itemId: string;
  serial: string;
  productName: string;
  expirationDate: string;
  daysLeft: number;
  expired: boolean;
}

/** Raised for company admins when an invitee finishes signing up. */
export interface InviteAcceptedPayload {
  userId: number;
  email: string;
  /** Absent on notifications raised before usernames existed. */
  username?: string;
  role: Role;
  storeIds: number[];
}

/** Raised for the person who asked, once a consumer turns the request into an order. */
export interface ReorderAcknowledgedPayload {
  reorderId: number;
  productId: number;
  sku: string | null;
  productName: string | null;
  storeId: number;
  storeName: string | null;
  quantityRequested: number | null;
  externalOrderRef: string;
}

/**
 * Raised for everyone who can approve, the moment a count is handed in. Addressed per
 * person rather than broadcast: the counter who submitted it cannot approve it.
 */
export interface CycleCountReviewPayload {
  cycleCountId: number;
  storeId: number;
  storeName: string | null;
  expectedCount: number;
  scannedCount: number;
  lineCount: number;
  submittedByUserId: number | null;
}

/**
 * Raised once per approval that put unidentified things into the review queue — one
 * notification for the batch, not one per item. Counts are what that approval added.
 */
export interface ItemsNeedReviewPayload {
  cycleCountId: number;
  storeId: number;
  storeName: string | null;
  itemCount: number;
  productCount: number;
}

/**
 * Raised when the sync agent answers the import-check queue with an identification —
 * one per store per sweep, not one per item.
 *
 * A case answer identifies its PIECES, so identifiedCount is units + pieces; caseCount
 * says how many boxes those pieces came out of. serial/sku/productName are filled only
 * when a single unit was identified, which is what lets the bell name it.
 */
export interface ItemsIdentifiedPayload {
  storeId: number;
  storeName: string | null;
  identifiedCount: number;
  unitCount: number;
  caseCount: number;
  pieceCount: number;
  serial: string | null;
  sku: string | null;
  productName: string | null;
}

/** Raised for the requester when the ERP says it will not fill their request. */
export interface ReorderDeclinedPayload {
  reorderId: number;
  productId: number;
  sku: string | null;
  productName: string | null;
  storeId: number;
  storeName: string | null;
  quantityRequested: number | null;
  /** Why, in the ERP operator's words. Null when they gave none. */
  reason: string | null;
}

export interface AppNotification {
  id: number;
  companyId: number;
  /** Null for company-wide notifications such as INVITE_ACCEPTED. */
  storeId: number | null;
  /** Addressed at one person when set; null means everyone in store scope. */
  userId: number | null;
  type: NotificationType;
  payload: ExpirationPayload &
    Partial<InviteAcceptedPayload> &
    Partial<ReorderAcknowledgedPayload> &
    Partial<CycleCountReviewPayload> &
    Partial<ItemsNeedReviewPayload> &
    Partial<ItemsIdentifiedPayload> &
    Partial<ReorderDeclinedPayload>;
  status: NotificationStatus;
  createdAt: string;
}

// ---- reorders -------------------------------------------------------------

export type ReorderStatus = 'OPEN' | 'ACKNOWLEDGED' | 'CANCELLED';

export interface Reorder {
  id: number;
  storeId: number;
  storeName: string;
  productId: number;
  sku: string;
  productName: string;
  upc: string | null;
  trackingType: TrackingType;
  status: ReorderStatus;
  quantityRequested: number | null;
  note: string | null;
  requestedByUserId: number | null;
  requestedBy: string | null;
  /** The consuming system's order identifier, once acknowledged. */
  externalOrderRef: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  cancelledAt: string | null;
}

export interface CreateReorder {
  productId: number;
  quantity?: number;
  note?: string;
  /** Required when the caller manages several stores. */
  storeId?: number;
}

/**
 * `created` is false when a request was already open for that store + product — the
 * duplicate guard hands back the live one instead of erroring, so the dialog can say
 * who asked and when rather than claiming to have raised a second request.
 */
export interface CreateReorderResult {
  created: boolean;
  request: Reorder;
}

export interface NotificationSetting {
  id: number;
  companyId: number;
  storeId: number | null;
  expirationAlertDays: number;
  enabled: boolean;
}

export interface NotificationSettingsResponse {
  companyDefault: NotificationSetting | null;
  overrides: NotificationSetting[];
}

export interface PutNotificationSettings {
  storeId?: number;
  expirationAlertDays: number;
  enabled: boolean;
}

export interface CreateCompany {
  name: string;
  slug: string;
  customDomain?: string;
  logoUrl?: string;
  primaryColor?: string;
}

export interface UpdateCompany {
  name?: string;
  status?: 'ACTIVE' | 'SUSPENDED';
  customDomain?: string;
  logoUrl?: string;
  primaryColor?: string;
  /** Moving a tenant between scanner channels. Audited on the tenant's own trail. */
  releaseChannelId?: number;
}


// ---- reports --------------------------------------------------------------

export type ReportKind = 'SUMMARY' | 'DETAIL' | 'SOLD';

export interface ReportMeta {
  kind: ReportKind;
  title: string;
  /** When it ran — the legacy calls this the Print Date. */
  generatedAt: string;
  companyName: string;
  storeName: string | null;
  locationName: string | null;
  from: string | null;
  to: string | null;
}

export interface SummaryRow {
  productId: number;
  sku: string;
  name: string;
  trackingType: 'SERIALIZED' | 'QUANTITY';
  /** Null, not 0, when nothing was weighed — shown as a dash. */
  weightLbs: number | null;
  cases: number | null;
  pieces: number;
  avgWeightLbs: number | null;
  avgPricePerLb: number | null;
  value: number;
}

export interface ReportDetailUnit {
  serial: string;
  caseSerial: string | null;
  weightLbs: number | null;
  locationName: string | null;
  receivedAt: string | null;
  soldAt: string | null;
  value: number;
  pricePerLb: number | null;
}

export interface ReportDetailGroup {
  productId: number;
  sku: string;
  name: string;
  units: ReportDetailUnit[];
  subtotal: { weightLbs: number | null; pieces: number; value: number };
}

export interface ReportTotals {
  weightLbs: number | null;
  cases: number;
  pieces: number;
  value: number;
}

export interface SummaryReport {
  meta: ReportMeta;
  rows: SummaryRow[];
  totals: ReportTotals;
}

export interface DetailReport {
  meta: ReportMeta;
  groups: ReportDetailGroup[];
  totals: ReportTotals;
}

export interface ReportFilters {
  storeId?: number;
  locationId?: number;
  productId?: number;
  from?: string;
  to?: string;
}

export interface EmailReportRequest extends ReportFilters {
  kind: ReportKind;
  /** Named recipients because `to` is the sold range's end date. */
  recipients: string[];
  formats?: ('pdf' | 'csv')[];
  message?: string;
}

export interface EmailReportResult {
  ok: boolean;
  error?: string;
  attached: string[];
}
