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
  /**
   * Which front door this request came through, for audit attribution. Read from the
   * optional `X-Client: scanner` header and defaulted to WEB.
   *
   * A default rather than a guess: the handheld uses the same JWT and the same endpoints as
   * the portal, so nothing else can tell them apart. Until the handheld sends the header its
   * events read as WEB — the ACTOR is still exact, only the door is assumed.
   */
  client: 'WEB' | 'SCANNER';
}
