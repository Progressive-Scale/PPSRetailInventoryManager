import { DatePipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import { localAcceptUrl } from '../../core/tenant';
import {
  CreateInvitation,
  CreateProduct,
  CreateStore,
  Invitation,
  Product,
  Role,
  Store,
  UpdateProduct,
  User,
} from '../../core/models';

type Tab = 'stores' | 'users' | 'invitations' | 'products';

@Component({
  selector: 'app-manage',
  imports: [FormsModule, DatePipe],
  template: `
    <main class="container">
      <div class="tabs">
        <button [class.active]="tab() === 'stores'" (click)="select('stores')">Stores</button>
        <button [class.active]="tab() === 'users'" (click)="select('users')">Users</button>
        <button [class.active]="tab() === 'invitations'" (click)="select('invitations')">
          Invitations
        </button>
        <button [class.active]="tab() === 'products'" (click)="select('products')">Products</button>
      </div>

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      <!-- STORES -->
      @if (tab() === 'stores') {
        <section class="card">
          <h2>Create store</h2>
          <form class="inline-form" (ngSubmit)="createStore()">
            <input placeholder="Name" name="s-name" [(ngModel)]="storeDraft.name" required />
            <input placeholder="Code" name="s-code" [(ngModel)]="storeDraft.code" required />
            <input
              placeholder="External building ID"
              name="s-ext"
              [(ngModel)]="storeDraft.externalBuildingId"
            />
            <button type="submit" [disabled]="saving()">Add store</button>
          </form>
        </section>

        <section class="card">
          <h2>Stores</h2>
          @if (loading()) {
            <p class="muted">Loading…</p>
          } @else if (stores().length === 0) {
            <p class="muted">No stores yet.</p>
          } @else {
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Code</th>
                    <th>External building</th>
                    <th class="actions"></th>
                  </tr>
                </thead>
                <tbody>
                  @for (s of stores(); track s.id) {
                    <tr>
                      @if (editStoreId() === s.id) {
                        <td><input name="es-name" [(ngModel)]="storeEdit.name" /></td>
                        <td><input name="es-code" [(ngModel)]="storeEdit.code" /></td>
                        <td><input name="es-ext" [(ngModel)]="storeEdit.externalBuildingId" /></td>
                        <td class="actions">
                          <button class="sm" (click)="saveStore(s)" [disabled]="saving()">Save</button>
                          <button class="sm ghost" (click)="editStoreId.set(null)">Cancel</button>
                        </td>
                      } @else {
                        <td>{{ s.name }}</td>
                        <td>{{ s.code }}</td>
                        <td class="muted">{{ s.externalBuildingId }}</td>
                        <td class="actions">
                          <button class="sm ghost" (click)="startEditStore(s)">Edit</button>
                          <button class="sm danger" (click)="deleteStore(s)" [disabled]="saving()">
                            Delete
                          </button>
                        </td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }

      <!-- USERS -->
      @if (tab() === 'users') {
        <section class="card">
          <h2>Users</h2>
          @if (loading()) {
            <p class="muted">Loading…</p>
          } @else if (users().length === 0) {
            <p class="muted">No users yet.</p>
          } @else {
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Store</th>
                    <th>Status</th>
                    <th class="actions"></th>
                  </tr>
                </thead>
                <tbody>
                  @for (u of users(); track u.id) {
                    <tr>
                      <td>{{ u.email }}</td>
                      <td>
                        <select [(ngModel)]="u.role" name="u-role-{{ u.id }}">
                          <option value="COMPANY_ADMIN">Company Admin</option>
                          <option value="STORE_USER">Store User</option>
                        </select>
                      </td>
                      <td>
                        <select [(ngModel)]="u.storeId" name="u-store-{{ u.id }}">
                          <option [ngValue]="null">—</option>
                          @for (s of stores(); track s.id) {
                            <option [ngValue]="s.id">{{ s.name }}</option>
                          }
                        </select>
                      </td>
                      <td>
                        <select [(ngModel)]="u.status" name="u-status-{{ u.id }}">
                          <option value="ACTIVE">Active</option>
                          <option value="SUSPENDED">Suspended</option>
                        </select>
                      </td>
                      <td class="actions">
                        <button class="sm" (click)="saveUser(u)" [disabled]="saving()">Save</button>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }

      <!-- INVITATIONS -->
      @if (tab() === 'invitations') {
        <section class="card">
          <h2>Invite a user</h2>
          <form class="inline-form" (ngSubmit)="createInvite()">
            <input placeholder="Email" name="i-email" type="email" [(ngModel)]="inviteDraft.email" required />
            <select name="i-role" [(ngModel)]="inviteDraft.role">
              <option value="STORE_USER">Store User</option>
              <option value="COMPANY_ADMIN">Company Admin</option>
            </select>
            <select name="i-store" [(ngModel)]="inviteStoreId">
              <option [ngValue]="null">No store</option>
              @for (s of stores(); track s.id) {
                <option [ngValue]="s.id">{{ s.name }}</option>
              }
            </select>
            <button type="submit" [disabled]="saving()">Send invite</button>
          </form>
          @if (lastInviteUrl()) {
            <div class="link-box">
              <span class="muted">Accept link:</span>
              <code>{{ lastInviteUrl() }}</code>
              <button class="sm ghost" (click)="copy(lastInviteUrl()!)">Copy</button>
            </div>
          }
        </section>

        <section class="card">
          <h2>Pending invitations</h2>
          @if (loading()) {
            <p class="muted">Loading…</p>
          } @else if (invitations().length === 0) {
            <p class="muted">No invitations.</p>
          } @else {
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Expires</th>
                    <th>Accepted</th>
                    <th>Link</th>
                    <th class="actions"></th>
                  </tr>
                </thead>
                <tbody>
                  @for (inv of invitations(); track inv.id) {
                    <tr>
                      <td>{{ inv.email }}</td>
                      <td>{{ inv.role }}</td>
                      <td class="muted">{{ inv.expiresAt | date: 'short' }}</td>
                      <td class="muted">{{ inv.acceptedAt ? 'Yes' : 'No' }}</td>
                      <td>
                        <button class="sm ghost" (click)="copy(inviteUrl(inv))">Copy link</button>
                      </td>
                      <td class="actions">
                        <button class="sm danger" (click)="revoke(inv)" [disabled]="saving()">
                          Revoke
                        </button>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }

      <!-- PRODUCTS -->
      @if (tab() === 'products') {
        <section class="card">
          <h2>Add product</h2>
          <form class="inline-form" (ngSubmit)="createProduct()">
            <input placeholder="SKU" name="p-sku" [(ngModel)]="productDraft.sku" required />
            <input placeholder="Name" name="p-name" [(ngModel)]="productDraft.name" required />
            <input
              placeholder="Price"
              name="p-price"
              type="number"
              step="0.01"
              min="0"
              [(ngModel)]="productDraft.price"
            />
            <input placeholder="UPC" name="p-upc" [(ngModel)]="productDraft.upc" />
            <input placeholder="Description" name="p-desc" [(ngModel)]="productDraft.description" />
            <button type="submit" [disabled]="saving()">Add product</button>
          </form>
        </section>

        <section class="card">
          <h2>Products</h2>
          <div class="filter-row">
            <label>
              Show:
              <select [(ngModel)]="productFilter" name="p-filter" (ngModelChange)="loadProducts()">
                <option [ngValue]="'all'">All</option>
                <option [ngValue]="'active'">Active only</option>
                <option [ngValue]="'inactive'">Inactive only</option>
              </select>
            </label>
          </div>
          @if (loading()) {
            <p class="muted">Loading…</p>
          } @else if (products().length === 0) {
            <p class="muted">No products yet.</p>
          } @else {
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Name</th>
                    <th>Price</th>
                    <th>UPC</th>
                    <th>Active</th>
                    <th class="actions"></th>
                  </tr>
                </thead>
                <tbody>
                  @for (p of products(); track p.id) {
                    <tr [class.inactive-row]="!p.active">
                      @if (editProductId() === p.id) {
                        <td><input name="ep-sku" [(ngModel)]="productEdit.sku" /></td>
                        <td><input name="ep-name" [(ngModel)]="productEdit.name" /></td>
                        <td>
                          <input
                            name="ep-price"
                            type="number"
                            step="0.01"
                            min="0"
                            [(ngModel)]="productEdit.price"
                          />
                        </td>
                        <td><input name="ep-upc" [(ngModel)]="productEdit.upc" /></td>
                        <td>
                          <label class="chk">
                            <input type="checkbox" name="ep-active" [(ngModel)]="productEdit.active" />
                            Active
                          </label>
                        </td>
                        <td class="actions">
                          <button class="sm" (click)="saveProduct(p)" [disabled]="saving()">Save</button>
                          <button class="sm ghost" (click)="editProductId.set(null)">Cancel</button>
                        </td>
                      } @else {
                        <td>{{ p.sku }}</td>
                        <td>{{ p.name }}</td>
                        <td>{{ formatPrice(p.price) }}</td>
                        <td class="muted">{{ p.upc || '—' }}</td>
                        <td>{{ p.active ? 'Yes' : 'No' }}</td>
                        <td class="actions">
                          <button class="sm ghost" (click)="startEditProduct(p)">Edit</button>
                        </td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }
    </main>
  `,
  styles: [
    `
      .container {
        max-width: 1000px;
        margin: 1.5rem auto;
        padding: 0 1rem;
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
      }
      .tabs {
        display: flex;
        gap: 0.4rem;
      }
      .tabs button {
        background: transparent;
        color: var(--muted);
        border: 1px solid var(--border);
      }
      .tabs button.active {
        background: var(--accent-soft);
        color: var(--brand, var(--accent));
        border-color: var(--brand, var(--accent));
      }
      .card {
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--surface);
        padding: 1.25rem;
      }
      h2 {
        margin: 0 0 0.85rem;
        font-size: 1.05rem;
      }
      .inline-form {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        align-items: center;
      }
      input,
      select {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
      }
      .inline-form input {
        flex: 1 1 160px;
      }
      .table-scroll {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.9rem;
      }
      th,
      td {
        text-align: left;
        padding: 0.5rem 0.6rem;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      td.actions,
      th.actions {
        text-align: right;
        white-space: nowrap;
      }
      .muted {
        color: var(--muted);
      }
      .error {
        color: #b42318;
        font-size: 0.85rem;
      }
      button.sm {
        padding: 0.3rem 0.55rem;
        font-size: 0.8rem;
        margin-left: 0.25rem;
      }
      .link-box {
        margin-top: 0.85rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
        padding: 0.6rem;
        background: var(--bg);
        border-radius: 8px;
      }
      .link-box code {
        font-size: 0.8rem;
        word-break: break-all;
      }
      .filter-row {
        margin-bottom: 0.85rem;
        font-size: 0.85rem;
        color: var(--muted);
      }
      .filter-row select {
        margin-left: 0.4rem;
      }
      tr.inactive-row td {
        color: var(--muted);
        opacity: 0.7;
      }
      label.chk {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        font-size: 0.85rem;
      }
      label.chk input {
        margin: 0;
      }
    `,
  ],
})
export class ManageComponent implements OnInit {
  private readonly api = inject(ApiService);

  readonly tab = signal<Tab>('stores');
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly stores = signal<Store[]>([]);
  readonly users = signal<User[]>([]);
  readonly invitations = signal<Invitation[]>([]);
  readonly products = signal<Product[]>([]);

  storeDraft: CreateStore = { name: '', code: '', externalBuildingId: '' };
  readonly editStoreId = signal<number | null>(null);
  storeEdit: CreateStore = { name: '', code: '', externalBuildingId: '' };

  inviteDraft: { email: string; role: Role } = { email: '', role: 'STORE_USER' };
  inviteStoreId: number | null = null;
  readonly lastInviteUrl = signal<string | null>(null);

  productDraft: {
    sku: string;
    name: string;
    price: number | null;
    upc: string;
    description: string;
  } = { sku: '', name: '', price: null, upc: '', description: '' };
  productFilter: 'all' | 'active' | 'inactive' = 'all';
  readonly editProductId = signal<number | null>(null);
  productEdit: {
    sku: string;
    name: string;
    price: number | null;
    upc: string;
    description: string;
    active: boolean;
  } = { sku: '', name: '', price: null, upc: '', description: '', active: true };

  ngOnInit(): void {
    // Stores are needed by every tab (user/invite store pickers) and are the
    // initial tab, so load them once up front.
    this.loadStores();
  }

  select(tab: Tab): void {
    this.tab.set(tab);
    this.error.set(null);
    if (tab === 'stores') this.loadStores();
    if (tab === 'users') {
      // Ensure the store picker options are available.
      if (this.stores().length === 0) this.loadStores();
      this.loadUsers();
    }
    if (tab === 'invitations') {
      if (this.stores().length === 0) this.loadStores();
      this.loadInvitations();
    }
    if (tab === 'products') this.loadProducts();
  }

  private loadStores(): void {
    this.loading.set(true);
    this.api.listStores().subscribe({
      next: (rows) => {
        this.stores.set(rows);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  private loadUsers(): void {
    this.loading.set(true);
    this.api.listUsers().subscribe({
      next: (rows) => {
        this.users.set(rows.map((u) => ({ ...u })));
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  private loadInvitations(): void {
    this.loading.set(true);
    this.api.listInvitations().subscribe({
      next: (rows) => {
        this.invitations.set(rows);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  // ---- stores ----
  createStore(): void {
    if (!this.storeDraft.name || !this.storeDraft.code) {
      this.error.set('Store name and code are required.');
      return;
    }
    const dto: CreateStore = { name: this.storeDraft.name, code: this.storeDraft.code };
    if (this.storeDraft.externalBuildingId) dto.externalBuildingId = this.storeDraft.externalBuildingId;
    this.saving.set(true);
    this.error.set(null);
    this.api.createStore(dto).subscribe({
      next: () => {
        this.saving.set(false);
        this.storeDraft = { name: '', code: '', externalBuildingId: '' };
        this.loadStores();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  startEditStore(s: Store): void {
    this.editStoreId.set(s.id);
    this.storeEdit = {
      name: s.name,
      code: s.code,
      externalBuildingId: s.externalBuildingId ?? '',
    };
  }

  saveStore(s: Store): void {
    this.saving.set(true);
    this.error.set(null);
    this.api
      .updateStore(s.id, {
        name: this.storeEdit.name,
        code: this.storeEdit.code,
        externalBuildingId: this.storeEdit.externalBuildingId,
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.editStoreId.set(null);
          this.loadStores();
        },
        error: (err) => {
          this.saving.set(false);
          this.error.set(messageFor(err));
        },
      });
  }

  deleteStore(s: Store): void {
    if (!confirm(`Delete store "${s.name}"?`)) return;
    this.saving.set(true);
    this.error.set(null);
    this.api.deleteStore(s.id).subscribe({
      next: () => {
        this.saving.set(false);
        this.loadStores();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  // ---- users ----
  saveUser(u: User): void {
    this.saving.set(true);
    this.error.set(null);
    this.api
      .updateUser(u.id, { role: u.role, status: u.status, storeId: u.storeId })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.loadUsers();
        },
        error: (err) => {
          this.saving.set(false);
          this.error.set(messageFor(err));
        },
      });
  }

  // ---- invitations ----
  createInvite(): void {
    if (!this.inviteDraft.email) {
      this.error.set('Email is required.');
      return;
    }
    const dto: CreateInvitation = { email: this.inviteDraft.email, role: this.inviteDraft.role };
    if (this.inviteStoreId != null) dto.storeId = this.inviteStoreId;
    this.saving.set(true);
    this.error.set(null);
    this.api.createInvitation(dto).subscribe({
      next: (inv) => {
        this.saving.set(false);
        this.inviteDraft = { email: '', role: 'STORE_USER' };
        this.inviteStoreId = null;
        this.lastInviteUrl.set(this.inviteUrl(inv));
        this.loadInvitations();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  revoke(inv: Invitation): void {
    if (!confirm(`Revoke invitation for ${inv.email}?`)) return;
    this.saving.set(true);
    this.error.set(null);
    this.api.deleteInvitation(inv.id).subscribe({
      next: () => {
        this.saving.set(false);
        this.loadInvitations();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  // ---- products ----
  loadProducts(): void {
    const active =
      this.productFilter === 'active' ? true : this.productFilter === 'inactive' ? false : undefined;
    this.loading.set(true);
    this.api.listProducts(active).subscribe({
      next: (rows) => {
        this.products.set(rows);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  createProduct(): void {
    if (!this.productDraft.sku || !this.productDraft.name) {
      this.error.set('Product SKU and name are required.');
      return;
    }
    const dto: CreateProduct = { sku: this.productDraft.sku, name: this.productDraft.name };
    if (this.productDraft.description) dto.description = this.productDraft.description;
    if (this.productDraft.price != null) dto.price = Number(this.productDraft.price);
    if (this.productDraft.upc) dto.upc = this.productDraft.upc;
    this.saving.set(true);
    this.error.set(null);
    this.api.createProduct(dto).subscribe({
      next: () => {
        this.saving.set(false);
        this.productDraft = { sku: '', name: '', price: null, upc: '', description: '' };
        this.loadProducts();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  startEditProduct(p: Product): void {
    this.editProductId.set(p.id);
    this.productEdit = {
      sku: p.sku,
      name: p.name,
      price: p.price != null ? Number(p.price) : null,
      upc: p.upc ?? '',
      description: p.description ?? '',
      active: p.active,
    };
  }

  saveProduct(p: Product): void {
    const dto: UpdateProduct = {
      sku: this.productEdit.sku,
      name: this.productEdit.name,
      description: this.productEdit.description,
      upc: this.productEdit.upc,
      active: this.productEdit.active,
    };
    if (this.productEdit.price != null) dto.price = Number(this.productEdit.price);
    this.saving.set(true);
    this.error.set(null);
    this.api.updateProduct(p.id, dto).subscribe({
      next: () => {
        this.saving.set(false);
        this.editProductId.set(null);
        this.loadProducts();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  formatPrice(price: string): string {
    const n = Number(price);
    return Number.isFinite(n) ? n.toFixed(2) : price;
  }

  inviteUrl(inv: Invitation): string {
    if (inv.acceptPath) return `${window.location.origin}${inv.acceptPath}`;
    return localAcceptUrl(inv.token);
  }

  copy(text: string): void {
    void navigator.clipboard?.writeText(text);
  }
}
