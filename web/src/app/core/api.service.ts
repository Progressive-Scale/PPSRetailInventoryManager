import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import {
  AdminInvite,
  ApiKey,
  AppNotification,
  BulkExpirationResult,
  Branding,
  Company,
  CreateCompany,
  CreateLocation,
  ItemAudit,
  LoginResponse,
  CycleCount,
  CycleCountDetail,
  CycleCountStatus,
  CreateInvitation,
  CreateStore,
  ExpiringItem,
  StockRow,
  StockSortField,
  StockStatusFilter,
  HealthResponse,
  InventoryItem,
  InventoryOpBody,
  InventoryProductDetail,
  Invitation,
  InvitationStatus,
  MoveInventoryBody,
  MoveResult,
  NotificationSettingsResponse,
  NotificationStatus,
  NotificationType,
  Paginated,
  Product,
  Profile,
  ResetStatusResponse,
  CreateProduct,
  PutNotificationSettings,
  StoreLocation,
  UpdateLocation,
  UpdateProduct,
  Store,
  StoreInventoryRow,
  TrackingType,
  Transaction,
  TxType,
  UpdateCompany,
  UpdateStore,
  UpdateUser,
  User,
} from './models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  // ---- public / branding ----
  branding(): Observable<Branding> {
    return this.http.get<Branding>('/api/branding');
  }

  // ---- forgotten password (all unauthenticated) ----
  /** Ask for a reset link. 404 means no active account has that address. */
  forgotPassword(email: string): Observable<{ sent: boolean }> {
    return this.http.post<{ sent: boolean }>('/api/auth/forgot-password', { email });
  }

  /** Lifecycle of a reset link, so the page can explain a dead one before asking. */
  resetStatus(token: string): Observable<ResetStatusResponse> {
    return this.http.get<ResetStatusResponse>('/api/auth/reset-status', {
      params: new HttpParams().set('token', token),
    });
  }

  // ---- your own account ----
  // No id in any of these: the API acts on whoever the token belongs to.
  profile(): Observable<Profile> {
    return this.http.get<Profile>('/api/profile');
  }

  changeUsername(username: string): Observable<Profile> {
    return this.http.patch<Profile>('/api/profile/username', { username });
  }

  changePassword(
    currentPassword: string,
    newPassword: string,
  ): Observable<{ changed: true }> {
    return this.http.patch<{ changed: true }>('/api/profile/password', {
      currentPassword,
      newPassword,
    });
  }

  /** Update the current company's branding (COMPANY_ADMIN). Empty-string
   * logoUrl clears it. Returns the refreshed branding payload. */
  updateBranding(dto: { logoUrl?: string; primaryColor?: string }): Observable<Branding> {
    return this.http.patch<Branding>('/api/company/branding', dto);
  }

  // ---- inventory ----
  listInventory(opts: {
    storeId?: number;
    search?: string;
    limit?: number;
    offset?: number;
  }): Observable<Paginated<StoreInventoryRow>> {
    let params = new HttpParams();
    if (opts.storeId != null) params = params.set('storeId', String(opts.storeId));
    if (opts.search) params = params.set('search', opts.search);
    if (opts.limit != null) params = params.set('limit', String(opts.limit));
    if (opts.offset != null) params = params.set('offset', String(opts.offset));
    return this.http.get<Paginated<StoreInventoryRow>>('/api/inventory', { params });
  }

  getInventoryProduct(productId: number): Observable<InventoryProductDetail> {
    return this.http.get<InventoryProductDetail>(`/api/inventory/${productId}`);
  }

  /** Combined flat stock grid (one row per unit / per quantity stock-location). */
  listStock(opts: {
    storeId?: number;
    search?: string;
    locationId?: number;
    type?: TrackingType;
    status?: StockStatusFilter;
    createdFrom?: string;
    createdTo?: string;
    sortBy?: StockSortField;
    sortDir?: 'asc' | 'desc';
    limit?: number;
    offset?: number;
  }): Observable<Paginated<StockRow>> {
    let params = new HttpParams();
    if (opts.storeId != null) params = params.set('storeId', String(opts.storeId));
    if (opts.search) params = params.set('search', opts.search);
    if (opts.locationId != null) params = params.set('locationId', String(opts.locationId));
    if (opts.type) params = params.set('type', opts.type);
    if (opts.status) params = params.set('status', opts.status);
    if (opts.createdFrom) params = params.set('createdFrom', opts.createdFrom);
    if (opts.createdTo) params = params.set('createdTo', opts.createdTo);
    if (opts.sortBy) params = params.set('sortBy', opts.sortBy);
    if (opts.sortDir) params = params.set('sortDir', opts.sortDir);
    if (opts.limit != null) params = params.set('limit', String(opts.limit));
    if (opts.offset != null) params = params.set('offset', String(opts.offset));
    return this.http.get<Paginated<StockRow>>('/api/inventory/stock', { params });
  }

  /** Admin: edit a serialized unit's expiration date. */
  updateItem(itemId: string, dto: { expirationDate: string | null }): Observable<InventoryItem> {
    return this.http.patch<InventoryItem>(`/api/inventory/items/${itemId}`, dto);
  }

  /** Admin: set a quantity product's on-hand at a location to an exact value. */
  setQuantity(body: {
    productId: number;
    locationId: number;
    storeId?: number;
    quantity: number;
    note?: string;
  }): Observable<unknown> {
    return this.http.post('/api/inventory/set-quantity', body);
  }

  /** Serialized units with location + expiration (in-stock by expiration). */
  listItems(opts: {
    storeId?: number;
    locationId?: number;
    productId?: number;
    expiresBefore?: string;
    expiringWithinDays?: number;
    hasExpiration?: boolean;
    limit?: number;
    offset?: number;
  }): Observable<Paginated<ExpiringItem>> {
    let params = new HttpParams();
    if (opts.storeId != null) params = params.set('storeId', String(opts.storeId));
    if (opts.locationId != null) params = params.set('locationId', String(opts.locationId));
    if (opts.productId != null) params = params.set('productId', String(opts.productId));
    if (opts.expiresBefore) params = params.set('expiresBefore', opts.expiresBefore);
    if (opts.expiringWithinDays != null)
      params = params.set('expiringWithinDays', String(opts.expiringWithinDays));
    if (opts.hasExpiration != null) params = params.set('hasExpiration', String(opts.hasExpiration));
    if (opts.limit != null) params = params.set('limit', String(opts.limit));
    if (opts.offset != null) params = params.set('offset', String(opts.offset));
    return this.http.get<Paginated<ExpiringItem>>('/api/inventory/items', { params });
  }

  moveInventory(body: MoveInventoryBody): Observable<MoveResult> {
    return this.http.post<MoveResult>('/api/inventory/move', body);
  }

  /** Bulk-set expiration on serialized items (partial success). */
  bulkExpiration(
    itemIds: string[],
    expirationDate: string | null,
  ): Observable<BulkExpirationResult> {
    return this.http.patch<BulkExpirationResult>('/api/inventory/bulk-expiration', {
      itemIds,
      expirationDate,
    });
  }

  /** Bulk mark serialized items sold (partial success). */
  bulkSell(itemIds: string[], note?: string): Observable<BulkExpirationResult> {
    return this.http.post<BulkExpirationResult>('/api/inventory/bulk-sell', { itemIds, note });
  }

  /** Audit trail (expiration changes) for a serialized item. */
  itemAudit(itemId: string): Observable<ItemAudit[]> {
    return this.http.get<ItemAudit[]>(`/api/inventory/items/${itemId}/audit`);
  }

  sellInventory(body: InventoryOpBody): Observable<unknown> {
    return this.http.post('/api/inventory/sell', body);
  }

  returnInventory(body: InventoryOpBody): Observable<unknown> {
    return this.http.post('/api/inventory/return', body);
  }

  adjustInventory(body: InventoryOpBody): Observable<unknown> {
    return this.http.post('/api/inventory/adjust', body);
  }

  // ---- transactions ----
  listTransactions(opts: {
    itemId?: string;
    productId?: number;
    type?: TxType;
    storeId?: number;
    locationId?: number;
    limit?: number;
    offset?: number;
  }): Observable<Paginated<Transaction>> {
    let params = new HttpParams();
    if (opts.itemId) params = params.set('itemId', opts.itemId);
    if (opts.productId != null) params = params.set('productId', String(opts.productId));
    if (opts.type) params = params.set('type', opts.type);
    if (opts.storeId != null) params = params.set('storeId', String(opts.storeId));
    if (opts.locationId != null) params = params.set('locationId', String(opts.locationId));
    if (opts.limit != null) params = params.set('limit', String(opts.limit));
    if (opts.offset != null) params = params.set('offset', String(opts.offset));
    return this.http.get<Paginated<Transaction>>('/api/transactions', { params });
  }

  // ---- locations ----
  /**
   * Active locations only by default. The admin Locations screen passes
   * includeInactive to manage deactivated rows and receive the lifecycle flags.
   */
  listLocations(storeId?: number, includeInactive = false): Observable<StoreLocation[]> {
    let params = new HttpParams();
    if (storeId != null) params = params.set('storeId', String(storeId));
    if (includeInactive) params = params.set('includeInactive', '1');
    return this.http.get<StoreLocation[]>('/api/locations', { params });
  }

  deactivateLocation(id: number): Observable<StoreLocation> {
    return this.http.post<StoreLocation>(`/api/locations/${id}/deactivate`, {});
  }

  reactivateLocation(id: number): Observable<StoreLocation> {
    return this.http.post<StoreLocation>(`/api/locations/${id}/reactivate`, {});
  }

  createLocation(dto: CreateLocation): Observable<StoreLocation> {
    return this.http.post<StoreLocation>('/api/locations', dto);
  }

  updateLocation(id: number, dto: UpdateLocation): Observable<StoreLocation> {
    return this.http.patch<StoreLocation>(`/api/locations/${id}`, dto);
  }

  reorderLocations(storeId: number, orderedIds: number[]): Observable<StoreLocation[]> {
    return this.http.post<StoreLocation[]>('/api/locations/reorder', { storeId, orderedIds });
  }

  deleteLocation(id: number): Observable<{ deleted: boolean; id: number }> {
    return this.http.delete<{ deleted: boolean; id: number }>(`/api/locations/${id}`);
  }

  // ---- notifications ----
  listNotifications(opts?: {
    status?: NotificationStatus;
    type?: NotificationType;
    storeId?: number;
    limit?: number;
    offset?: number;
  }): Observable<Paginated<AppNotification>> {
    let params = new HttpParams();
    if (opts?.status) params = params.set('status', opts.status);
    if (opts?.type) params = params.set('type', opts.type);
    if (opts?.storeId != null) params = params.set('storeId', String(opts.storeId));
    if (opts?.limit != null) params = params.set('limit', String(opts.limit));
    if (opts?.offset != null) params = params.set('offset', String(opts.offset));
    return this.http.get<Paginated<AppNotification>>('/api/notifications', { params });
  }

  notificationsUnreadCount(storeId?: number): Observable<{ unread: number }> {
    let params = new HttpParams();
    if (storeId != null) params = params.set('storeId', String(storeId));
    return this.http.get<{ unread: number }>('/api/notifications/unread-count', { params });
  }

  updateNotification(id: number, status: NotificationStatus): Observable<AppNotification> {
    return this.http.patch<AppNotification>(`/api/notifications/${id}`, { status });
  }

  /** Apply one status to many notifications at once. */
  setNotificationStatus(
    ids: number[],
    status: NotificationStatus,
  ): Observable<{ updated: number }> {
    return this.http.post<{ updated: number }>('/api/notifications/status', {
      ids,
      status,
    });
  }

  /** Permanently remove notifications from the history. */
  deleteNotifications(ids: number[]): Observable<{ deleted: number }> {
    return this.http.post<{ deleted: number }>('/api/notifications/delete', { ids });
  }

  runExpirationScan(): Observable<{ created: number }> {
    return this.http.post<{ created: number }>('/api/notifications/run-expiration-scan', {});
  }

  getNotificationSettings(): Observable<NotificationSettingsResponse> {
    return this.http.get<NotificationSettingsResponse>('/api/notification-settings');
  }

  putNotificationSettings(dto: PutNotificationSettings): Observable<unknown> {
    return this.http.put('/api/notification-settings', dto);
  }

  // ---- cycle counts ----
  listCycleCounts(params?: {
    limit?: number;
    offset?: number;
    storeId?: number;
    status?: CycleCountStatus;
  }): Observable<Paginated<CycleCount>> {
    let p = new HttpParams();
    if (params?.limit != null) p = p.set('limit', String(params.limit));
    if (params?.offset != null) p = p.set('offset', String(params.offset));
    if (params?.storeId != null) p = p.set('storeId', String(params.storeId));
    if (params?.status) p = p.set('status', params.status);
    return this.http.get<Paginated<CycleCount>>('/api/cycle-counts', { params: p });
  }

  getCycleCount(id: number): Observable<CycleCountDetail> {
    return this.http.get<CycleCountDetail>(`/api/cycle-counts/${id}`);
  }

  // ---- stores (company admin) ----
  listStores(): Observable<Store[]> {
    return this.http.get<Store[]>('/api/stores');
  }

  createStore(dto: CreateStore): Observable<Store> {
    return this.http.post<Store>('/api/stores', dto);
  }

  updateStore(id: number, dto: UpdateStore): Observable<Store> {
    return this.http.patch<Store>(`/api/stores/${id}`, dto);
  }

  deleteStore(id: number): Observable<unknown> {
    return this.http.delete(`/api/stores/${id}`);
  }

  // ---- products (company admin) ----
  listProducts(opts?: { active?: boolean; needsReview?: boolean }): Observable<Product[]> {
    let params = new HttpParams();
    if (opts?.active != null) params = params.set('active', String(opts.active));
    if (opts?.needsReview != null) params = params.set('needsReview', String(opts.needsReview));
    return this.http.get<Product[]>('/api/products', { params });
  }

  createProduct(dto: CreateProduct): Observable<Product> {
    return this.http.post<Product>('/api/products', dto);
  }

  updateProduct(id: number, dto: UpdateProduct): Observable<Product> {
    return this.http.patch<Product>(`/api/products/${id}`, dto);
  }

  deleteProduct(id: number): Observable<{ deleted: boolean; id: number }> {
    return this.http.delete<{ deleted: boolean; id: number }>(`/api/products/${id}`);
  }

  // ---- users (company admin) ----
  listUsers(): Observable<User[]> {
    return this.http.get<User[]>('/api/users');
  }

  /** Choose the active store (multi-store users). Returns a fresh token. */
  selectStore(storeId: number): Observable<LoginResponse> {
    return this.http.post<LoginResponse>('/api/auth/select-store', { storeId });
  }

  updateUser(id: number, dto: UpdateUser): Observable<User> {
    return this.http.patch<User>(`/api/users/${id}`, dto);
  }

  // ---- invitations (company admin) ----
  listInvitations(): Observable<Invitation[]> {
    return this.http.get<Invitation[]>('/api/invitations');
  }

  createInvitation(dto: CreateInvitation): Observable<Invitation> {
    return this.http.post<Invitation>('/api/invitations', dto);
  }

  deleteInvitation(id: number): Observable<unknown> {
    return this.http.delete(`/api/invitations/${id}`);
  }

  /** Kill an unused invite link. Idempotent. */
  revokeInvitation(id: number): Observable<unknown> {
    return this.http.post(`/api/invitations/${id}/revoke`, {});
  }

  /** New token + fresh expiry + new email; returns the new accept URL. */
  resendInvitation(id: number): Observable<Invitation> {
    return this.http.post<Invitation>(`/api/invitations/${id}/resend`, {});
  }

  /** Public accept-page state for a token (no auth). */
  invitationStatus(token: string): Observable<InvitationStatus> {
    const params = new HttpParams().set('token', token);
    return this.http.get<InvitationStatus>('/api/invitations/status', { params });
  }

  // ---- platform admin: companies ----
  listCompanies(): Observable<Company[]> {
    return this.http.get<Company[]>('/api/admin/companies');
  }

  createCompany(dto: CreateCompany): Observable<Company> {
    return this.http.post<Company>('/api/admin/companies', dto);
  }

  updateCompany(id: number, dto: UpdateCompany): Observable<Company> {
    return this.http.patch<Company>(`/api/admin/companies/${id}`, dto);
  }

  // ---- platform admin: api keys ----
  listApiKeys(companyId: number): Observable<ApiKey[]> {
    return this.http.get<ApiKey[]>(`/api/admin/companies/${companyId}/api-keys`);
  }

  createApiKey(companyId: number, name: string): Observable<ApiKey> {
    return this.http.post<ApiKey>(`/api/admin/companies/${companyId}/api-keys`, { name });
  }

  deleteApiKey(id: number): Observable<unknown> {
    return this.http.delete(`/api/admin/api-keys/${id}`);
  }

  // ---- platform admin: admin invite ----
  adminInvite(companyId: number, email: string): Observable<AdminInvite> {
    return this.http.post<AdminInvite>(`/api/admin/companies/${companyId}/admin-invite`, { email });
  }

  // ---- platform admin: health ----
  health(): Observable<HealthResponse> {
    return this.http.get<HealthResponse>('/api/admin/health');
  }
}
