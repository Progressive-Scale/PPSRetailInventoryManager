import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import {
  AdminInvite,
  ApiKey,
  Branding,
  Company,
  CreateCompany,
  CreateInventoryItem,
  CycleCount,
  CycleCountDetail,
  CreateInvitation,
  CreateStore,
  HealthResponse,
  InventoryItem,
  Invitation,
  ItemStatus,
  Paginated,
  Product,
  CreateProduct,
  UpdateProduct,
  Store,
  Transaction,
  TxType,
  UpdateCompany,
  UpdateInventoryItem,
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

  // ---- inventory ----
  listInventory(opts: {
    status?: ItemStatus;
    storeId?: number;
    needsReview?: boolean;
    limit?: number;
    offset?: number;
  }): Observable<Paginated<InventoryItem>> {
    let params = new HttpParams();
    if (opts.status) params = params.set('status', opts.status);
    if (opts.storeId != null) params = params.set('storeId', String(opts.storeId));
    if (opts.needsReview != null) params = params.set('needsReview', String(opts.needsReview));
    if (opts.limit != null) params = params.set('limit', String(opts.limit));
    if (opts.offset != null) params = params.set('offset', String(opts.offset));
    return this.http.get<Paginated<InventoryItem>>('/api/inventory', { params });
  }

  getInventoryItem(id: string): Observable<InventoryItem> {
    return this.http.get<InventoryItem>(`/api/inventory/${id}`);
  }

  createInventory(dto: CreateInventoryItem): Observable<InventoryItem> {
    return this.http.post<InventoryItem>('/api/inventory', dto);
  }

  updateInventory(id: string, dto: UpdateInventoryItem): Observable<InventoryItem> {
    return this.http.patch<InventoryItem>(`/api/inventory/${id}`, dto);
  }

  deleteItem(id: string): Observable<{ deleted: true; id: string }> {
    return this.http.delete<{ deleted: true; id: string }>(`/api/inventory/${id}`);
  }

  sellItem(id: string, note?: string): Observable<InventoryItem> {
    return this.http.post<InventoryItem>(`/api/inventory/${id}/sell`, { note });
  }

  returnItem(id: string, note?: string): Observable<InventoryItem> {
    return this.http.post<InventoryItem>(`/api/inventory/${id}/return`, { note });
  }

  adjustItem(id: string, note?: string): Observable<InventoryItem> {
    return this.http.post<InventoryItem>(`/api/inventory/${id}/adjust`, { note });
  }

  // ---- transactions ----
  listTransactions(opts: {
    itemId?: string;
    type?: TxType;
    storeId?: number;
    limit?: number;
    offset?: number;
  }): Observable<Paginated<Transaction>> {
    let params = new HttpParams();
    if (opts.itemId) params = params.set('itemId', opts.itemId);
    if (opts.type) params = params.set('type', opts.type);
    if (opts.storeId != null) params = params.set('storeId', String(opts.storeId));
    if (opts.limit != null) params = params.set('limit', String(opts.limit));
    if (opts.offset != null) params = params.set('offset', String(opts.offset));
    return this.http.get<Paginated<Transaction>>('/api/transactions', { params });
  }

  // ---- cycle counts ----
  listCycleCounts(params?: {
    limit?: number;
    offset?: number;
    storeId?: number;
  }): Observable<Paginated<CycleCount>> {
    let p = new HttpParams();
    if (params?.limit != null) p = p.set('limit', String(params.limit));
    if (params?.offset != null) p = p.set('offset', String(params.offset));
    if (params?.storeId != null) p = p.set('storeId', String(params.storeId));
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
  listProducts(active?: boolean): Observable<Product[]> {
    let params = new HttpParams();
    if (active != null) params = params.set('active', String(active));
    return this.http.get<Product[]>('/api/products', { params });
  }

  createProduct(dto: CreateProduct): Observable<Product> {
    return this.http.post<Product>('/api/products', dto);
  }

  updateProduct(id: number, dto: UpdateProduct): Observable<Product> {
    return this.http.patch<Product>(`/api/products/${id}`, dto);
  }

  // ---- users (company admin) ----
  listUsers(): Observable<User[]> {
    return this.http.get<User[]>('/api/users');
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
