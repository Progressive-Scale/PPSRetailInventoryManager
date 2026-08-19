import { HttpClient, HttpParams, HttpResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import {
  AdminPasswordReset,
  AdminUpdateUser,
  AdminUser,
  AdminUserQuery,
  ApiKey,
  AppRelease,
  CreateRelease,
  CreatedRelease,
  FleetResponse,
  ReleaseChannel,
  UpdateChannel,
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
  CycleCountSortField,
  CycleCountStatus,
  CreateInvitation,
  CreateStore,
  ExpiringItem,
  StockRow,
  StockSortField,
  StockStatusFilter,
  HealthResponse,
  InventoryItem,
  ImportCheckStatus,
  InventoryOpBody,
  ItemStatus,
  InventoryProductDetail,
  Invitation,
  InvitationStatus,
  MoveInventoryBody,
  MoveResult,
  NotificationSettingsResponse,
  NotificationStatus,
  NotificationType,
  ActivityQuery,
  ActivityRow,
  Paginated,
  Product,
  ProductStockRow,
  Profile,
  Reorder,
  ReorderStatus,
  CreateReorder,
  CreateReorderResult,
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
  ReportKind,
  ReportFilters,
  SummaryReport,
  DetailReport,
  EmailReportRequest,
  EmailReportResult,
} from './models';

/**
 * Everything the stock grid filters by. One type for both reads, because a product row
 * and its expanded sub-rows have to be asking the same question.
 */
export interface StockQuery {
  storeId?: number;
  search?: string;
  locationId?: number;
  /** Narrow to one product — an expanded row, or the catalog's View-inventory link. */
  productId?: number;
  type?: TrackingType;
  status?: StockStatusFilter;
  receivedFrom?: string;
  receivedTo?: string;
  sortBy?: StockSortField;
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

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

  /**
   * Product-level rollup of the stock grid. Takes the SAME options as listStock on
   * purpose: a product row and the sub-rows it expands to must be answering one
   * question, so the caller passes one filter object to both.
   */
  listStockByProduct(opts: StockQuery): Observable<Paginated<ProductStockRow>> {
    return this.http.get<Paginated<ProductStockRow>>('/api/inventory/stock/by-product', {
      params: this.stockParams(opts),
    });
  }

  /** Combined flat stock grid (one row per unit / per quantity stock-location). */
  listStock(opts: StockQuery): Observable<Paginated<StockRow>> {
    return this.http.get<Paginated<StockRow>>('/api/inventory/stock', {
      params: this.stockParams(opts),
    });
  }

  private stockParams(opts: StockQuery): HttpParams {
    let params = new HttpParams();
    if (opts.storeId != null) params = params.set('storeId', String(opts.storeId));
    if (opts.search) params = params.set('search', opts.search);
    if (opts.locationId != null) params = params.set('locationId', String(opts.locationId));
    if (opts.productId != null) params = params.set('productId', String(opts.productId));
    if (opts.type) params = params.set('type', opts.type);
    if (opts.status) params = params.set('status', opts.status);
    if (opts.receivedFrom) params = params.set('receivedFrom', opts.receivedFrom);
    if (opts.receivedTo) params = params.set('receivedTo', opts.receivedTo);
    if (opts.sortBy) params = params.set('sortBy', opts.sortBy);
    if (opts.sortDir) params = params.set('sortDir', opts.sortDir);
    if (opts.limit != null) params = params.set('limit', String(opts.limit));
    if (opts.offset != null) params = params.set('offset', String(opts.offset));
    return params;
  }

  /**
   * Admin: edit a serialized unit. `expirationDate` corrects a date, `weightLbs` its
   * weight in pounds (null clears either back to "not recorded"); `productId` identifies
   * an unidentified unit (and takes it out of the review queue).
   *
   * Expiration and weight are both synced from the ERP, so a change to either writes an
   * item_audit row — a manual override of ERP data stays traceable.
   */
  updateItem(
    itemId: string,
    dto: {
      expirationDate?: string | null;
      weightLbs?: number | null;
      /** null clears the override so the unit inherits its product's price. */
      price?: number | null;
      productId?: number;
    },
  ): Observable<InventoryItem> {
    return this.http.patch<InventoryItem>(`/api/inventory/items/${itemId}`, dto);
  }

  /** Ask PPS to identify an unidentified unit, or ask again after an answer. */
  requestImportCheck(
    itemId: string,
  ): Observable<{ itemId: string; importCheckStatus: ImportCheckStatus }> {
    return this.http.post<{ itemId: string; importCheckStatus: ImportCheckStatus }>(
      `/api/inventory/items/${itemId}/import-check`,
      {},
    );
  }

  /**
   * Admin: write a unit off as lost — a pending arrival that is never coming, or a
   * unit missing off a shelf. The note is why, and is worth filling in.
   */
  markItemLost(itemId: string, note?: string): Observable<InventoryItem> {
    return this.http.post<InventoryItem>(`/api/inventory/items/${itemId}/lost`, {
      note,
    });
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
    /** Defaults server-side to ON_HAND; pass PENDING for the arrivals queue. */
    status?: ItemStatus;
    /** Only units awaiting identification (the Needs Review queue). */
    needsReview?: boolean;
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
    if (opts.status) params = params.set('status', opts.status);
    if (opts.needsReview != null)
      params = params.set('needsReview', String(opts.needsReview));
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

  /**
   * Bulk-set the price override on serialized items (partial success).
   * `price: null` clears each override back to the product's catalog price.
   */
  bulkPrice(itemIds: string[], price: number | null): Observable<BulkExpirationResult> {
    return this.http.patch<BulkExpirationResult>('/api/inventory/bulk-price', {
      itemIds,
      price,
    });
  }

  /** Bulk mark serialized items sold (partial success). */
  bulkSell(itemIds: string[], note?: string): Observable<BulkExpirationResult> {
    return this.http.post<BulkExpirationResult>('/api/inventory/bulk-sell', { itemIds, note });
  }

  /**
   * The company-wide activity stream (company admin). Filters are ANDed; omit them all
   * for "everything, newest first".
   */
  listActivity(q: ActivityQuery = {}): Observable<Paginated<ActivityRow>> {
    return this.http.get<Paginated<ActivityRow>>('/api/activity', {
      params: this.activityParams(q),
    });
  }

  /**
   * One entity's history: audit events and ledger movements interleaved. Open to store
   * users for the entities they work with, which is why the detail views can use it.
   */
  entityActivity(
    entityType: string,
    entityId: string | number,
    q: ActivityQuery = {},
  ): Observable<Paginated<ActivityRow>> {
    return this.http.get<Paginated<ActivityRow>>(
      `/api/activity/${entityType}/${encodeURIComponent(String(entityId))}`,
      { params: this.activityParams(q) },
    );
  }

  private activityParams(q: ActivityQuery): HttpParams {
    let params = new HttpParams();
    if (q.userId != null) params = params.set('userId', String(q.userId));
    if (q.entityType) params = params.set('entityType', q.entityType);
    if (q.action) params = params.set('action', q.action);
    if (q.storeId != null) params = params.set('storeId', String(q.storeId));
    if (q.search) params = params.set('search', q.search);
    if (q.source) params = params.set('source', q.source);
    if (q.from) params = params.set('from', q.from);
    if (q.to) params = params.set('to', q.to);
    if (q.limit != null) params = params.set('limit', String(q.limit));
    if (q.offset != null) params = params.set('offset', String(q.offset));
    return params;
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

  // ---- reorders ----
  listReorders(opts?: {
    status?: ReorderStatus;
    storeId?: number;
    productId?: number;
    limit?: number;
    offset?: number;
  }): Observable<Paginated<Reorder>> {
    let params = new HttpParams();
    if (opts?.status) params = params.set('status', opts.status);
    if (opts?.storeId != null) params = params.set('storeId', String(opts.storeId));
    if (opts?.productId != null) params = params.set('productId', String(opts.productId));
    if (opts?.limit != null) params = params.set('limit', String(opts.limit));
    if (opts?.offset != null) params = params.set('offset', String(opts.offset));
    return this.http.get<Paginated<Reorder>>('/api/reorders', { params });
  }

  /** Returns `created: false` with the live request when one is already open. */
  createReorder(dto: CreateReorder): Observable<CreateReorderResult> {
    return this.http.post<CreateReorderResult>('/api/reorders', dto);
  }

  cancelReorder(id: number): Observable<Reorder> {
    return this.http.post<Reorder>(`/api/reorders/${id}/cancel`, {});
  }

  // ---- cycle counts ----
  listCycleCounts(params?: {
    limit?: number;
    offset?: number;
    storeId?: number;
    status?: CycleCountStatus;
    /** Sorted server-side: reordering one page of twenty is not ordering the table. */
    sortBy?: CycleCountSortField;
    sortDir?: 'asc' | 'desc';
    /** Count number, store, or the username of whoever opened or submitted it. */
    search?: string;
  }): Observable<Paginated<CycleCount>> {
    let p = new HttpParams();
    if (params?.limit != null) p = p.set('limit', String(params.limit));
    if (params?.offset != null) p = p.set('offset', String(params.offset));
    if (params?.storeId != null) p = p.set('storeId', String(params.storeId));
    if (params?.status) p = p.set('status', params.status);
    if (params?.sortBy) p = p.set('sortBy', params.sortBy);
    if (params?.sortDir) p = p.set('sortDir', params.sortDir);
    if (params?.search) p = p.set('search', params.search);
    return this.http.get<Paginated<CycleCount>>('/api/cycle-counts', { params: p });
  }

  /** Apply a submitted count's proposals (COMPANY_ADMIN). */
  approveCycleCount(id: number): Observable<CycleCountDetail> {
    return this.http.post<CycleCountDetail>(`/api/cycle-counts/${id}/approve`, {});
  }

  /** Send a submitted count back for a recount; discards the proposals. */
  rejectCycleCount(id: number, reason?: string): Observable<CycleCountDetail> {
    return this.http.post<CycleCountDetail>(`/api/cycle-counts/${id}/reject`, {
      reason,
    });
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

  // ---- platform admin: users across every company ----
  adminListUsers(query: AdminUserQuery = {}): Observable<Paginated<AdminUser>> {
    let params = new HttpParams();
    if (query.companyId != null) params = params.set('companyId', query.companyId);
    if (query.role) params = params.set('role', query.role);
    if (query.status) params = params.set('status', query.status);
    if (query.q) params = params.set('q', query.q);
    if (query.limit != null) params = params.set('limit', query.limit);
    if (query.offset != null) params = params.set('offset', query.offset);
    return this.http.get<Paginated<AdminUser>>('/api/admin/users', { params });
  }

  adminUpdateUser(id: number, dto: AdminUpdateUser): Observable<User> {
    return this.http.patch<User>(`/api/admin/users/${id}`, dto);
  }

  /** Issues a reset link for a tenant user and returns it (also emailed). */
  adminPasswordReset(id: number): Observable<AdminPasswordReset> {
    return this.http.post<AdminPasswordReset>(
      `/api/admin/users/${id}/password-reset`,
      {},
    );
  }

  adminListCompanyStores(companyId: number): Observable<Store[]> {
    return this.http.get<Store[]>(`/api/admin/companies/${companyId}/stores`);
  }

  // ---- platform admin: invitations into any company ----
  adminListInvitations(companyId: number): Observable<Invitation[]> {
    return this.http.get<Invitation[]>(
      `/api/admin/companies/${companyId}/invitations`,
    );
  }

  adminCreateInvitation(
    companyId: number,
    dto: CreateInvitation,
  ): Observable<Invitation> {
    return this.http.post<Invitation>(
      `/api/admin/companies/${companyId}/invitations`,
      dto,
    );
  }

  adminResendInvitation(id: number): Observable<Invitation> {
    return this.http.post<Invitation>(`/api/admin/invitations/${id}/resend`, {});
  }

  adminRevokeInvitation(id: number): Observable<unknown> {
    return this.http.post(`/api/admin/invitations/${id}/revoke`, {});
  }

  // ---- platform admin: health ----
  health(): Observable<HealthResponse> {
    return this.http.get<HealthResponse>('/api/admin/health');
  }

  // ---- platform admin: scanner releases ----
  listReleases(): Observable<AppRelease[]> {
    return this.http.get<AppRelease[]>('/api/admin/releases');
  }

  createRelease(dto: CreateRelease): Observable<CreatedRelease> {
    return this.http.post<CreatedRelease>('/api/admin/releases', dto);
  }

  listChannels(): Observable<ReleaseChannel[]> {
    return this.http.get<ReleaseChannel[]>('/api/admin/channels');
  }

  updateChannel(id: number, dto: UpdateChannel): Observable<ReleaseChannel> {
    return this.http.patch<ReleaseChannel>(`/api/admin/channels/${id}`, dto);
  }

  fleetVersions(): Observable<FleetResponse> {
    return this.http.get<FleetResponse>('/api/admin/device-versions');
  }

  // ---- reports ----

  /** Query string shared by every report call, so the screen and the file agree. */
  private reportParams(f: ReportFilters): HttpParams {
    let p = new HttpParams();
    // One value per id rather than a comma list: both are accepted server-side, and
    // repeated params are what a reader of the network tab expects.
    for (const id of f.storeIds ?? []) p = p.append('storeIds', String(id));
    if (f.locationId != null) p = p.set('locationId', String(f.locationId));
    if (f.productId != null) p = p.set('productId', String(f.productId));
    if (f.from) p = p.set('from', f.from);
    if (f.to) p = p.set('to', f.to);
    return p;
  }

  private reportPath(kind: ReportKind): string {
    if (kind === 'SUMMARY') return '/api/reports/inventory-summary';
    if (kind === 'DETAIL') return '/api/reports/inventory-detail';
    return '/api/reports/items-sold';
  }

  inventorySummaryReport(f: ReportFilters): Observable<SummaryReport> {
    return this.http.get<SummaryReport>(this.reportPath('SUMMARY'), {
      params: this.reportParams(f),
    });
  }

  inventoryDetailReport(f: ReportFilters): Observable<DetailReport> {
    return this.http.get<DetailReport>(this.reportPath('DETAIL'), {
      params: this.reportParams(f),
    });
  }

  itemsSoldReport(f: ReportFilters): Observable<DetailReport> {
    return this.http.get<DetailReport>(this.reportPath('SOLD'), {
      params: this.reportParams(f),
    });
  }

  /** The bytes, so the caller can save them under the server's chosen name. */
  downloadReport(
    kind: ReportKind,
    f: ReportFilters,
    format: 'pdf' | 'csv',
  ): Observable<HttpResponse<Blob>> {
    return this.http.get(this.reportPath(kind), {
      params: this.reportParams(f).set('format', format),
      responseType: 'blob',
      observe: 'response',
    });
  }

  emailReport(dto: EmailReportRequest): Observable<EmailReportResult> {
    return this.http.post<EmailReportResult>('/api/reports/email', dto);
  }
}
