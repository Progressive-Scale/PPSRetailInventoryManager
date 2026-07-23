export type Role = 'PLATFORM_ADMIN' | 'COMPANY_ADMIN' | 'STORE_USER';

export interface AuthUser {
  id: number;
  email: string;
  companyId: number | null;
  storeId: number | null;
  role: Role;
}

export interface LoginResponse {
  access_token: string;
  user: AuthUser;
}

export interface Branding {
  name: string;
  slug: string;
  branding: {
    logoUrl: string | null;
    primaryColor: string;
  };
}

export type ItemStatus = 'ON_HAND' | 'SOLD' | 'RETURNED_TO_WAREHOUSE' | 'ADJUSTED_OUT';

export interface InventoryItem {
  id: string;
  companyId: number;
  storeId: number;
  serial: string;
  sku: string;
  name: string;
  description: string | null;
  price: string;
  upc: string | null;
  status: ItemStatus;
  needsReview: boolean;
  receivedAt: string | null;
  updatedAt: string;
  createdAt: string;
}

export type TxType = 'RECEIPT' | 'SALE' | 'ADJUSTMENT' | 'RETURN';

export interface Transaction {
  id: number;
  companyId: number;
  storeId: number;
  itemId: string;
  type: TxType;
  quantityDelta: number;
  note: string | null;
  performedByUserId: number | null;
  source: TxSource;
  createdAt: string;
}

export type TxSource = 'PORTAL' | 'SYNC' | 'CYCLE_COUNT';

export interface Store {
  id: number;
  companyId: number;
  name: string;
  code: string;
  externalBuildingId: string | null;
  createdAt: string;
}

export interface User {
  id: number;
  companyId: number | null;
  storeId: number | null;
  email: string;
  role: Role;
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
}

export interface Invitation {
  id: number;
  companyId: number;
  email: string;
  role: Role;
  storeId: number | null;
  token: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
  acceptPath?: string;
}

export interface Company {
  id: number;
  name: string;
  slug: string;
  customDomain: string | null;
  branding: unknown;
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
}

export interface ApiKey {
  id: number;
  companyId: number;
  name: string;
  createdAt: string;
  // Present only in the create response.
  key?: string;
}

export interface AdminInvite {
  id: number;
  companyId: number;
  email: string;
  token: string;
  acceptPath: string;
  expiresAt?: string;
  createdAt?: string;
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

export type CycleCountStatus = 'OPEN' | 'CLOSED' | 'CANCELLED';

export type CycleCountResolution =
  | 'SCANNED'
  | 'COUNTED_BY_UPC'
  | 'MARKED_SOLD'
  | 'NEW_ITEM';

export interface CycleCount {
  id: number;
  companyId: number;
  storeId: number;
  status: CycleCountStatus;
  openedByUserId: number;
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
  itemId: string;
  serial: string;
  resolution: CycleCountResolution;
  createdAt: string;
}

export interface CycleCountDetail {
  cycleCount: CycleCount;
  lines: CycleCountLine[];
  linesByResolution: Record<CycleCountResolution, CycleCountLine[]>;
  markedSoldSerials: string[];
}

export interface Paginated<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

// ---- request DTOs ----

export interface CreateInventoryItem {
  serial: string;
  sku: string;
  name: string;
  description?: string;
  price?: string;
  storeId?: number;
}

export interface UpdateInventoryItem {
  name?: string;
  description?: string;
  price?: string;
  upc?: string | null;
  needsReview?: boolean;
}

export interface CreateStore {
  name: string;
  code: string;
  externalBuildingId?: string;
}

export interface UpdateStore {
  name?: string;
  code?: string;
  externalBuildingId?: string;
}

export interface UpdateUser {
  role?: Role;
  status?: 'ACTIVE' | 'SUSPENDED';
  storeId?: number | null;
}

export interface CreateInvitation {
  email: string;
  role: Role;
  storeId?: number;
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
}
