export type Role = 'ADMIN' | 'STORE_USER';

/** Shape of the JWT payload we sign. */
export interface JwtPayload {
  sub: number;
  email: string;
  storeId: number | null;
  role: Role;
}

/** The authenticated user attached to the request by JwtAuthGuard. */
export interface AuthUser {
  userId: number;
  email: string;
  storeId: number | null;
  role: Role;
}
