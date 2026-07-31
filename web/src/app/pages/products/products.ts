import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import { CreateProduct, Product, TrackingType, UpdateProduct } from '../../core/models';
import { NeedsReviewComponent } from '../needs-review/needs-review';

type SubTab = 'catalog' | 'review';

@Component({
  selector: 'app-products',
  imports: [FormsModule, NeedsReviewComponent],
  template: `
    <main class="container">
      <div class="tabs">
        <button [class.active]="tab() === 'catalog'" (click)="select('catalog')">Catalog</button>
        <button [class.active]="tab() === 'review'" (click)="select('review')">Review</button>
      </div>

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      <!-- CATALOG -->
      @if (tab() === 'catalog') {
        <section class="card">
          <div class="section-head">
            <h2>Products</h2>
            <button (click)="openAddProduct()">Add product</button>
          </div>
          <div class="filters">
            <label class="f">
              Search
              <input
                name="p-search"
                placeholder="SKU, name, UPC"
                [ngModel]="search()"
                (ngModelChange)="search.set($event)"
              />
            </label>
            <label class="f">
              Type
              <select name="p-type" [ngModel]="typeFilter()" (ngModelChange)="typeFilter.set($event)">
                <option [ngValue]="null">All</option>
                <option [ngValue]="'SERIALIZED'">Serialized</option>
                <option [ngValue]="'QUANTITY'">UPC</option>
              </select>
            </label>
            <label class="f">
              Active
              <select name="p-active" [ngModel]="activeFilter()" (ngModelChange)="activeFilter.set($event)">
                <option [ngValue]="null">All</option>
                <option [ngValue]="'active'">Active</option>
                <option [ngValue]="'inactive'">Inactive</option>
              </select>
            </label>
            <div class="f-actions">
              <button type="button" class="ghost" (click)="clearFilters()" [disabled]="!filtersActive()">
                Clear
              </button>
              <button type="button" class="ghost" (click)="loadProducts()" [disabled]="loading()">
                Refresh
              </button>
            </div>
          </div>
          @if (loading()) {
            <p class="muted">Loading…</p>
          } @else if (products().length === 0) {
            <p class="muted">No products yet.</p>
          } @else if (filteredProducts().length === 0) {
            <p class="muted">No products match these filters.</p>
          } @else {
            <div class="table-scroll">
              <table class="fixed">
                <thead>
                  <tr>
                    <th class="col-sku">SKU</th>
                    <th class="col-name">Name</th>
                    <th class="col-type">Type</th>
                    <th class="col-upc">UPC</th>
                    <th class="col-active">Active</th>
                    <th class="actions col-actions"></th>
                  </tr>
                </thead>
                <tbody>
                  @for (p of filteredProducts(); track p.id) {
                    <tr [class.inactive-row]="!p.active">
                      @if (editProductId() === p.id) {
                        <td><input class="cell-input" name="ep-sku" [(ngModel)]="productEdit.sku" /></td>
                        <td><input class="cell-input" name="ep-name" [(ngModel)]="productEdit.name" /></td>
                        <td>
                          <span class="type-badge" [class]="'tt-' + p.trackingType">
                            {{ typeLabel(p.trackingType) }}
                          </span>
                        </td>
                        <td><input class="cell-input" name="ep-upc" [(ngModel)]="productEdit.upc" /></td>
                        <td>
                          <select class="cell-input" name="ep-active" [(ngModel)]="productEdit.active">
                            <option [ngValue]="true">Active</option>
                            <option [ngValue]="false">Inactive</option>
                          </select>
                        </td>
                        <td class="actions">
                          <button class="sm" (click)="saveProduct(p)" [disabled]="saving()">Save</button>
                          <button class="sm ghost" (click)="editProductId.set(null)">Cancel</button>
                          <button class="sm danger" (click)="askDeleteProduct(p)" [disabled]="saving()">
                            Delete
                          </button>
                        </td>
                      } @else {
                        <td>{{ p.sku }}</td>
                        <td>{{ p.name }}</td>
                        <td>
                          <span class="type-badge" [class]="'tt-' + p.trackingType">
                            {{ typeLabel(p.trackingType) }}
                          </span>
                        </td>
                        <td class="muted">{{ p.upc || '—' }}</td>
                        <td>{{ p.active ? 'Active' : 'Inactive' }}</td>
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

        <!-- Add product modal -->
        @if (showAddModal()) {
          <div class="overlay" (click)="closeAddProduct()">
            <div class="modal" (click)="$event.stopPropagation()">
              <h2>Add product</h2>
              @if (modalError()) {
                <p class="error">{{ modalError() }}</p>
              }
              <form class="stacked-form" (ngSubmit)="createProduct()">
                <label>
                  SKU <span class="req">*</span>
                  <input name="m-sku" [(ngModel)]="productDraft.sku" required />
                </label>
                <label>
                  Name <span class="req">*</span>
                  <input name="m-name" [(ngModel)]="productDraft.name" required />
                </label>
                <label>
                  Tracking type <span class="req">*</span>
                  <select name="m-tracking" [(ngModel)]="productDraft.trackingType" required>
                    <option value="SERIALIZED">Serialized</option>
                    <option value="QUANTITY">UPC</option>
                  </select>
                </label>
                <label>
                  UPC
                  <input name="m-upc" [(ngModel)]="productDraft.upc" />
                </label>
                <label>
                  Description
                  <input name="m-desc" [(ngModel)]="productDraft.description" />
                </label>
                <div class="modal-actions">
                  <button class="ghost" type="button" (click)="closeAddProduct()">Cancel</button>
                  <button type="submit" [disabled]="saving()">Confirm</button>
                </div>
              </form>
            </div>
          </div>
        }

        <!-- Delete confirmation -->
        @if (deleteTarget(); as target) {
          <div class="overlay" (click)="cancelDeleteProduct()">
            <div class="modal" (click)="$event.stopPropagation()">
              <h2>Delete product</h2>
              @if (deleteError()) {
                <!-- The delete was refused (usually: the product still has
                     inventory). Stay open so the reason is read where it happened. -->
                <p class="error">{{ deleteError() }}</p>
                <div class="modal-actions">
                  <button class="ghost" type="button" (click)="cancelDeleteProduct()">Close</button>
                </div>
              } @else {
                <p>Delete product {{ target.sku }}? This can't be undone.</p>
                <div class="modal-actions">
                  <button class="ghost" type="button" (click)="cancelDeleteProduct()">Cancel</button>
                  <button class="danger" type="button" (click)="confirmDeleteProduct()" [disabled]="saving()">
                    {{ saving() ? 'Deleting…' : 'Delete' }}
                  </button>
                </div>
              }
            </div>
          </div>
        }
      }

      <!-- REVIEW -->
      @if (tab() === 'review') {
        <app-needs-review />
      }
    </main>
  `,
  styles: [
    `
      .container {
        max-width: 1320px;
        margin: 1.5rem auto;
        padding: 0 1rem;
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
      }
      /* Chrome-style tabs connected to the form below. */
      .tabs {
        display: flex;
        gap: 4px;
        padding-left: 6px;
        margin-bottom: calc(-1.25rem - 1px);
        position: relative;
        z-index: 2;
      }
      .tabs button {
        background: #e6e9ef;
        color: var(--muted);
        border: 1px solid var(--border);
        border-radius: 10px 10px 0 0;
        padding: 0.5rem 1.15rem;
        font-size: 0.88rem;
        cursor: pointer;
      }
      .tabs button:hover:not(.active) {
        background: #dce0e7;
        color: #1f2937;
      }
      .tabs button.active {
        background: var(--surface);
        border-bottom-color: var(--surface);
        color: var(--brand, var(--accent));
        font-weight: 600;
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
      input,
      select {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
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
      .filters {
        display: flex;
        align-items: flex-end;
        gap: 0.75rem;
        flex-wrap: wrap;
        margin: 0.85rem 0 1rem;
      }
      .f {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        font-size: 0.75rem;
        color: var(--muted);
      }
      .f-actions {
        display: flex;
        gap: 0.4rem;
      }
      /* One height for every control in the bar. */
      .filters input,
      .filters select,
      .filters .f-actions button {
        height: 2.25rem;
        box-sizing: border-box;
      }
      .filters .f-actions button {
        padding: 0 0.75rem;
        font-size: 0.85rem;
        font-family: inherit;
        border-radius: 8px;
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
      .section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
      }
      .section-head h2 {
        margin: 0;
      }
      /* Fixed-layout table so column widths + row height stay stable
         between view and edit mode. */
      table.fixed {
        table-layout: fixed;
      }
      table.fixed th,
      table.fixed td {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* Widths must sum to 100% across every column — Price was removed. */
      .col-sku {
        width: 15%;
      }
      .col-name {
        width: 28%;
      }
      .col-type {
        width: 14%;
      }
      .col-upc {
        width: 15%;
      }
      .col-active {
        width: 10%;
      }
      .col-actions {
        width: 18%;
      }
      .type-badge {
        display: inline-block;
        font-size: 0.7rem;
        font-weight: 600;
        letter-spacing: 0.02em;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        border: 1px solid transparent;
      }
      .type-badge.tt-SERIALIZED {
        background: #eff4ff;
        color: #1d4ed8;
        border-color: #c7d7fe;
      }
      .type-badge.tt-QUANTITY {
        background: #ecfdf3;
        color: #067647;
        border-color: #abefc6;
      }
      /* Inline edit inputs match the surrounding display text so the row
         does not grow when switching to edit mode. */
      .cell-input {
        box-sizing: border-box;
        width: 100%;
        min-width: 0;
        margin: 0;
        padding: 0.1rem 0.3rem;
        font: inherit;
        border: 1px solid var(--border);
        border-radius: 6px;
      }
      td.actions {
        overflow: visible;
      }
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
        z-index: 50;
      }
      .modal {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 1.25rem;
        width: 100%;
        max-width: 420px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
      }
      .stacked-form {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
      }
      .stacked-form label {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.85rem;
        color: var(--muted);
      }
      .stacked-form input {
        font-size: 0.9rem;
      }
      .req {
        color: #b42318;
      }
      .modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        margin-top: 0.5rem;
      }
    `,
  ],
})
export class ProductsComponent implements OnInit {
  private readonly api = inject(ApiService);

  readonly tab = signal<SubTab>('catalog');
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly products = signal<Product[]>([]);

  productDraft: {
    sku: string;
    name: string;
    price: number | null;
    upc: string;
    description: string;
    trackingType: TrackingType;
  } = { sku: '', name: '', price: null, upc: '', description: '', trackingType: 'SERIALIZED' };
  // Filters run client-side over the loaded catalog, so they apply as you type.
  readonly search = signal('');
  readonly typeFilter = signal<TrackingType | null>(null);
  readonly activeFilter = signal<string | null>(null);

  readonly filtersActive = computed(
    () =>
      this.search().trim().length > 0 ||
      this.typeFilter() !== null ||
      this.activeFilter() !== null,
  );

  readonly filteredProducts = computed(() => {
    const term = this.search().trim().toLowerCase();
    const type = this.typeFilter();
    const active = this.activeFilter();
    return this.products().filter((p) => {
      if (type && p.trackingType !== type) return false;
      if (active === 'active' && !p.active) return false;
      if (active === 'inactive' && p.active) return false;
      if (!term) return true;
      // Search spans the columns shown, matching the displayed labels.
      return [p.sku, p.name, p.upc ?? '', this.typeLabel(p.trackingType),
        p.active ? 'active' : 'inactive']
        .join(' ')
        .toLowerCase()
        .includes(term);
    });
  });

  clearFilters(): void {
    this.search.set('');
    this.typeFilter.set(null);
    this.activeFilter.set(null);
  }

  /** QUANTITY products are barcode-counted, shown as "UPC" as in Inventory. */
  typeLabel(t: TrackingType): string {
    return t === 'QUANTITY' ? 'UPC' : 'Serialized';
  }
  readonly editProductId = signal<number | null>(null);
  productEdit: {
    sku: string;
    name: string;
    price: number | null;
    upc: string;
    description: string;
    active: boolean;
  } = { sku: '', name: '', price: null, upc: '', description: '', active: true };
  readonly showAddModal = signal(false);
  readonly modalError = signal<string | null>(null);
  readonly deleteTarget = signal<Product | null>(null);
  readonly deleteError = signal<string | null>(null);

  ngOnInit(): void {
    this.loadProducts();
  }

  select(tab: SubTab): void {
    this.tab.set(tab);
    this.error.set(null);
    if (tab === 'catalog') this.loadProducts();
  }

  loadProducts(): void {
    // Always fetch the whole catalog; the Active filter is applied client-side.
    this.loading.set(true);
    this.api.listProducts({}).subscribe({
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

  openAddProduct(): void {
    this.productDraft = { sku: '', name: '', price: null, upc: '', description: '', trackingType: 'SERIALIZED' };
    this.modalError.set(null);
    this.showAddModal.set(true);
  }

  closeAddProduct(): void {
    this.showAddModal.set(false);
    this.modalError.set(null);
  }

  createProduct(): void {
    if (!this.productDraft.sku || !this.productDraft.name) {
      this.modalError.set('Product SKU and name are required.');
      return;
    }
    const dto: CreateProduct = {
      sku: this.productDraft.sku,
      name: this.productDraft.name,
      trackingType: this.productDraft.trackingType,
    };
    if (this.productDraft.description) dto.description = this.productDraft.description;
    if (this.productDraft.price != null) dto.price = Number(this.productDraft.price);
    if (this.productDraft.upc) dto.upc = this.productDraft.upc;
    this.saving.set(true);
    this.modalError.set(null);
    this.api.createProduct(dto).subscribe({
      next: () => {
        this.saving.set(false);
        this.showAddModal.set(false);
        this.productDraft = { sku: '', name: '', price: null, upc: '', description: '', trackingType: 'SERIALIZED' };
        this.loadProducts();
      },
      error: (err) => {
        this.saving.set(false);
        this.modalError.set(messageFor(err));
      },
    });
  }

  askDeleteProduct(p: Product): void {
    this.error.set(null);
    this.deleteError.set(null);
    this.deleteTarget.set(p);
  }

  cancelDeleteProduct(): void {
    this.deleteTarget.set(null);
    this.deleteError.set(null);
  }

  confirmDeleteProduct(): void {
    const target = this.deleteTarget();
    if (!target) return;
    this.saving.set(true);
    this.error.set(null);
    this.api.deleteProduct(target.id).subscribe({
      next: () => {
        this.saving.set(false);
        this.deleteTarget.set(null);
        this.loadProducts();
      },
      error: (err) => {
        this.saving.set(false);
        // 409 = product still has inventory. Report it inside the dialog rather
        // than as a banner at the top of the page, and leave the dialog open.
        this.deleteError.set(messageFor(err));
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
}
