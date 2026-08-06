import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { AuthUser, LoginResponse } from './models';

const TOKEN_KEY = 'pps_token';
const USER_KEY = 'pps_user';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  private readonly _user = signal<AuthUser | null>(this.readStoredUser());
  readonly user = this._user.asReadonly();
  readonly isLoggedIn = computed(() => this._user() !== null);

  /**
   * What this session may do, named after the capability rather than the role.
   *
   * Every screen asks one of these instead of comparing to a role, so adding a role
   * is one edit here rather than a hunt through the pages — which is exactly how
   * STORE_MANAGER arrived. These MIRROR the API's guards; they hide buttons, they
   * do not grant anything, and the server refuses regardless of what is rendered.
   */
  readonly role = computed(() => this._user()?.role ?? null);

  /** Company-level administration: users, stores, invitations, settings. */
  readonly isCompanyAdmin = computed(() => this.role() === 'COMPANY_ADMIN');

  /**
   * May correct inventory: edit a unit, set an absolute shelf quantity, bulk
   * expiration, mark lost, ask the ERP, approve cycle counts, and maintain
   * locations and the product catalog.
   */
  readonly canManageInventory = computed(
    () => this.role() === 'COMPANY_ADMIN' || this.role() === 'STORE_MANAGER',
  );

  /** Pinned to a single store: no store picker, no cross-store filters. */
  readonly isStoreScoped = computed(
    () => this.role() === 'STORE_USER' || this.role() === 'STORE_MANAGER',
  );

  /** `identifier` is a username or an email; the API tells them apart. */
  login(identifier: string, password: string): Observable<LoginResponse> {
    return this.http
      .post<LoginResponse>('/api/auth/login', { identifier, password })
      .pipe(tap((res) => this.persist(res)));
  }

  /**
   * Redeem a password-reset link. Signs in on success, like accept-invite, so the
   * user is not asked for the password they just chose.
   */
  resetPassword(token: string, newPassword: string): Observable<LoginResponse> {
    return this.http
      .post<LoginResponse>('/api/auth/reset-password', { token, newPassword })
      .pipe(tap((res) => this.persist(res)));
  }

  acceptInvite(
    token: string,
    username: string,
    password: string,
  ): Observable<LoginResponse> {
    return this.http
      .post<LoginResponse>('/api/auth/accept-invite', {
        token,
        username,
        password,
      })
      .pipe(tap((res) => this.persist(res)));
  }

  /**
   * Choose the active store (a user permitted several stores picks one at login).
   * Replaces the stored token with one scoped to that store.
   */
  selectStore(storeId: number): Observable<LoginResponse> {
    return this.http
      .post<LoginResponse>('/api/auth/select-store', { storeId })
      .pipe(tap((res) => this.persist(res)));
  }

  logout(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    this._user.set(null);
  }

  /**
   * Fold a change the user made to their own account into the cached session, so
   * the header and anything else reading `user()` update without a re-login. The
   * token is untouched: it carries id, company, store and role, none of which this
   * can change.
   */
  patchUser(patch: Partial<AuthUser>): void {
    const current = this._user();
    if (!current) return;
    const next = { ...current, ...patch };
    localStorage.setItem(USER_KEY, JSON.stringify(next));
    this._user.set(next);
  }

  get token(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  private persist(res: LoginResponse): void {
    localStorage.setItem(TOKEN_KEY, res.access_token);
    localStorage.setItem(USER_KEY, JSON.stringify(res.user));
    this._user.set(res.user);
  }

  private readStoredUser(): AuthUser | null {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AuthUser;
    } catch {
      return null;
    }
  }
}
