export type Role = 'PLATFORM_ADMIN' | 'COMPANY_ADMIN' | 'STORE_USER';

export interface JwtPayload {
  sub: number;
  companyId: number | null;
  storeId: number | null;
  role: Role;
}

/** Authenticated principal attached to the request by JwtAuthGuard. */
export interface AuthUser {
  userId: number;
  companyId: number | null;
  storeId: number | null;
  role: Role;
}

/**
 * Tenant data-access context. companyId is always present for tenant work.
 * storeId is set for STORE_USER (pinned to one store); null means "all stores
 * in the company" (COMPANY_ADMIN).
 */
export interface DataContext {
  companyId: number;
  storeId: number | null;
  role: Role;
  userId: number;
}
