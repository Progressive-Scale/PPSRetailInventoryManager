export type Role =
  | 'PLATFORM_ADMIN'
  | 'COMPANY_ADMIN'
  | 'STORE_USER'
  | 'STORE_MANAGER';

/**
 * Roles that live inside one store rather than above all of them. They are pinned:
 * reads are filtered to their own store and a body naming another one is refused.
 *
 * A predicate rather than a comparison at each call site on purpose. Every one of
 * these checks is a scope boundary, and a role added later that anybody forgets to
 * add to one of them would quietly read another store's data. There is exactly one
 * place to get this wrong.
 */
export const STORE_SCOPED_ROLES = ['STORE_USER', 'STORE_MANAGER'] as const;

export function isStoreScoped(role: Role): boolean {
  return role === 'STORE_USER' || role === 'STORE_MANAGER';
}

/**
 * STORE_MANAGER's extra reach over STORE_USER: correcting stock (unit fields,
 * absolute shelf quantities, bulk expiration, marking lost, asking the ERP),
 * approving cycle counts, and maintaining locations and the product catalog —
 * all still inside their own store.
 *
 * What it deliberately does NOT get: users, stores, invitations, company settings,
 * notification settings and the company-wide activity log. Those are the company
 * admin's, and a store manager gaining them would make the two roles the same.
 */
export function canManageInventory(role: Role): boolean {
  return role === 'COMPANY_ADMIN' || role === 'STORE_MANAGER';
}

/**
 * Everybody signed in to a tenant. What each of them then SEES is decided by the
 * store scoping above, not by this list.
 */
export const TENANT_USER_ROLES: Role[] = [
  'COMPANY_ADMIN',
  'STORE_MANAGER',
  'STORE_USER',
];

/** The `canManageInventory` pair, for `@Roles(...)`. */
export const INVENTORY_ADMIN_ROLES: Role[] = ['COMPANY_ADMIN', 'STORE_MANAGER'];

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
 * storeId is set for the store-scoped roles (pinned to one store); null means
 * "all stores in the company" (COMPANY_ADMIN).
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
