import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import {
  Store,
  StoreLocation,
  StockRow,
  StockSortField,
  StockStatusFilter,
  TrackingType,
} from '../../core/models';
import { LocationsComponent } from './locations';
import { ItemDetailComponent } from './item-detail';

type SubTab = 'stock' | 'locations';

interface Column {
  label: string;
  field: StockSortField;
  num?: boolean;
  adminOnly?: boolean;
}

@Component({
  selector: 'app-inventory',
  imports: [FormsModule, DatePipe, LocationsComponent, ItemDetailComponent],
  template: `
    <main class="container">
      <div class="tabs">
        <button [class.active]="tab() === 'stock'" (click)="tab.set('stock')">Stock</button>
        <button [class.active]="tab() === 'locations'" (click)="tab.set('locations')">Locations</button>
      </div>

      @if (tab() === 'locations') {
        <app-locations />
      } @else {
        <section class="card">
          <h2>Inventory</h2>

          <form class="filters" (ngSubmit)="applyFilters()">
            @if (isCompanyAdmin) {
              <label class="f">
                Store
                <select [ngModel]="storeFilter()" (ngModelChange)="onStoreFilter($event)" name="f-store">
                  <option [ngValue]="null">All</option>
                  @for (s of stores(); track s.id) {
                    <option [ngValue]="s.id">{{ s.name }}</option>
                  }
                </select>
              </label>
            }
            <label class="f">
              Product name / ID
              <input name="f-search" [(ngModel)]="searchTerm" placeholder="Name, SKU, barcode or serial" />
            </label>
            <label class="f">
              Location
              <select [(ngModel)]="locationFilter" name="f-loc" [disabled]="filterLocations().length === 0">
                <option [ngValue]="null">All</option>
                @for (l of filterLocations(); track l.id) {
                  <option [ngValue]="l.id">{{ l.name }}</option>
                }
              </select>
            </label>
            <label class="f">
              Type
              <select [(ngModel)]="typeFilter" name="f-type">
                <option [ngValue]="null">All</option>
                <option [ngValue]="'SERIALIZED'">Serialized</option>
                <option [ngValue]="'QUANTITY'">Quantity</option>
              </select>
            </label>
            <label class="f">
              Status
              <select [(ngModel)]="statusFilter" name="f-status">
                <option [ngValue]="'ON_HAND'">On hand</option>
                <option [ngValue]="'SOLD'">Sold</option>
                <option [ngValue]="'ALL'">All</option>
              </select>
            </label>
            <label class="f">
              Created from
              <input type="date" name="f-from" [(ngModel)]="createdFrom" />
            </label>
            <label class="f">
              Created to
              <input type="date" name="f-to" [(ngModel)]="createdTo" />
            </label>
            <div class="f-actions">
              <button type="submit" [disabled]="loading()">Apply</button>
              <button type="button" class="ghost" (click)="clearFilters()" [disabled]="loading()">Clear</button>
            </div>
          </form>

          @if (listError()) {
            <p class="error">{{ listError() }}</p>
          } @else if (loading() && !loaded()) {
            <p class="muted">Loading…</p>
          } @else if (loaded() && rows().length === 0) {
            <p class="muted">No inventory matches.</p>
          } @else {
            <div class="table-scroll" [class.busy]="loading()">
              <table>
                <thead>
                  <tr>
                    @for (col of columns(); track col.field) {
                      <th [class.num]="col.num" class="sortable" (click)="sort(col.field)">
                        {{ col.label }}<span class="arrow">{{ sortIcon(col.field) }}</span>
                      </th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (row of rows(); track row.rowId) {
                    <tr class="clickable" (click)="openRow(row)">
                      <td>
                        {{ row.sku }}
                        @if (row.serial) {
                          <span class="matched">{{ row.serial }}</span>
                        }
                      </td>
                      <td class="muted">{{ row.upc || '—' }}</td>
                      <td>{{ row.name }}</td>
                      <td>
                        <span class="type-badge" [class]="'tt-' + row.trackingType">{{ row.trackingType }}</span>
                      </td>
                      @if (isCompanyAdmin) {
                        <td class="muted">{{ storeName(row.storeId) }}</td>
                      }
                      <td class="num">{{ row.onHand }}</td>
                      <td>
                        <span class="kind-badge" [class]="'k-' + row.locationKind">{{ row.locationName }}</span>
                      </td>
                      <td [class]="expClass(row.expirationDate)">
                        {{ row.expirationDate ? (row.expirationDate | date: 'shortDate') : '—' }}
                        @if (row.rowKind === 'unit' && row.status !== 'ON_HAND') {
                          <span class="st">{{ statusLabel(row.status) }}</span>
                        }
                      </td>
                      <td class="muted">{{ row.createdAt | date: 'shortDate' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>

            <div class="pager">
              <button class="ghost" (click)="prevPage()" [disabled]="offset() === 0 || loading()">Prev</button>
              <span class="muted">{{ rangeLabel() }}</span>
              <button class="ghost" (click)="nextPage()" [disabled]="!hasNext() || loading()">Next</button>
            </div>
          }
        </section>
      }
    </main>

    @if (selectedRow(); as row) {
      <app-item-detail
        [row]="row"
        [isCompanyAdmin]="isCompanyAdmin"
        [storeName]="storeName(row.storeId)"
        [locations]="rowLocations()"
        (close)="selectedRow.set(null)"
        (changed)="reload()"
      />
    }
  `,
  styles: [
    `
      .container {
        max-width: 1180px;
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
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.4rem 0.9rem;
        font-size: 0.88rem;
        color: var(--muted);
        cursor: pointer;
      }
      .tabs button.active {
        color: var(--brand, var(--accent));
        border-color: var(--brand, var(--accent));
        background: var(--accent-soft);
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
      .filters {
        display: flex;
        align-items: flex-end;
        gap: 0.75rem;
        flex-wrap: wrap;
        margin-bottom: 1rem;
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
      input,
      select {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
      }
      .table-scroll {
        overflow-x: auto;
        transition: opacity 0.12s ease;
      }
      .table-scroll.busy {
        opacity: 0.55;
        pointer-events: none;
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
      th.num,
      td.num {
        text-align: right;
      }
      th.sortable {
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
      }
      th.sortable:hover {
        color: var(--brand, var(--accent));
      }
      .arrow {
        display: inline-block;
        width: 1em;
        color: var(--brand, var(--accent));
      }
      tr.clickable {
        cursor: pointer;
      }
      tr.clickable:hover td {
        background: var(--bg);
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
      .kind-badge {
        display: inline-block;
        font-size: 0.7rem;
        font-weight: 600;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        border: 1px solid transparent;
      }
      .k-BACKROOM {
        background: #eff4ff;
        color: #1d4ed8;
        border-color: #c7d7fe;
      }
      .k-ONFLOOR {
        background: #ecfdf3;
        color: #067647;
        border-color: #abefc6;
      }
      .k-CUSTOM {
        background: #f4f4f5;
        color: #52525b;
        border-color: #e4e4e7;
      }
      .matched {
        margin-left: 0.4rem;
        font-size: 0.72rem;
        color: var(--muted);
        font-family: ui-monospace, monospace;
      }
      .st {
        margin-left: 0.4rem;
        font-size: 0.68rem;
        color: var(--muted);
        text-transform: uppercase;
      }
      .muted {
        color: var(--muted);
      }
      td.expired {
        color: #b42318;
        font-weight: 600;
      }
      td.warn {
        color: #b54708;
        font-weight: 600;
      }
      .error {
        color: #b42318;
        font-size: 0.85rem;
      }
      .pager {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.75rem;
        margin-top: 0.85rem;
        font-size: 0.85rem;
      }
    `,
  ],
})
export class InventoryComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);

  readonly isCompanyAdmin = this.auth.user()?.role === 'COMPANY_ADMIN';

  readonly tab = signal<SubTab>('stock');

  readonly rows = signal<StockRow[]>([]);
  readonly total = signal(0);
  readonly limit = signal(25);
  readonly offset = signal(0);

  readonly stores = signal<Store[]>([]);
  private readonly storeMap = computed(() => {
    const m = new Map<number, string>();
    for (const s of this.stores()) m.set(s.id, s.name);
    return m;
  });

  // Filters.
  readonly storeFilter = signal<number | null>(null);
  searchTerm = '';
  locationFilter: number | null = null;
  typeFilter: TrackingType | null = null;
  statusFilter: StockStatusFilter = 'ON_HAND';
  createdFrom = '';
  createdTo = '';

  // Sort.
  readonly sortBy = signal<StockSortField>('name');
  readonly sortDir = signal<'asc' | 'desc'>('asc');

  readonly filterLocations = signal<StoreLocation[]>([]);

  readonly loading = signal(false);
  readonly loaded = signal(false);
  readonly listError = signal<string | null>(null);

  // Item detail modal.
  readonly selectedRow = signal<StockRow | null>(null);
  readonly rowLocations = signal<StoreLocation[]>([]);

  readonly columns = computed<Column[]>(() => {
    const cols: Column[] = [
      { label: 'SKU', field: 'sku' },
      { label: 'Barcode', field: 'barcode' },
      { label: 'Name', field: 'name' },
      { label: 'Type', field: 'type' },
    ];
    if (this.isCompanyAdmin) cols.push({ label: 'Store', field: 'store' });
    cols.push(
      { label: 'On hand', field: 'onHand', num: true },
      { label: 'Location', field: 'location' },
      { label: 'Expiration', field: 'expiration' },
      { label: 'Created', field: 'created' },
    );
    return cols;
  });

  readonly hasNext = computed(() => this.offset() + this.rows().length < this.total());
  readonly rangeLabel = computed(() => {
    const start = this.total() === 0 ? 0 : this.offset() + 1;
    const end = this.offset() + this.rows().length;
    return `${start}–${end} of ${this.total()}`;
  });

  ngOnInit(): void {
    if (this.isCompanyAdmin) {
      this.api.listStores().subscribe({ next: (rows) => this.stores.set(rows) });
    } else {
      this.loadFilterLocations(this.auth.user()?.storeId ?? null);
    }
    this.reload();
  }

  private loadFilterLocations(storeId: number | null): void {
    if (storeId == null) {
      this.filterLocations.set([]);
      return;
    }
    this.api.listLocations(storeId).subscribe({
      next: (locs) => this.filterLocations.set(locs.filter((l) => l.isActive)),
      error: () => this.filterLocations.set([]),
    });
  }

  reload(): void {
    this.loading.set(true);
    this.listError.set(null);
    this.api
      .listStock({
        storeId: this.storeFilter() ?? undefined,
        search: this.searchTerm.trim() || undefined,
        locationId: this.locationFilter ?? undefined,
        type: this.typeFilter ?? undefined,
        status: this.statusFilter,
        createdFrom: this.createdFrom || undefined,
        createdTo: this.createdTo || undefined,
        sortBy: this.sortBy(),
        sortDir: this.sortDir(),
        limit: this.limit(),
        offset: this.offset(),
      })
      .subscribe({
        next: (res) => {
          this.rows.set(res.data);
          this.total.set(res.total);
          this.loading.set(false);
          this.loaded.set(true);
        },
        error: (err) => {
          this.loading.set(false);
          this.listError.set(messageFor(err));
        },
      });
  }

  applyFilters(): void {
    this.offset.set(0);
    this.reload();
  }

  clearFilters(): void {
    this.searchTerm = '';
    this.locationFilter = null;
    this.typeFilter = null;
    this.statusFilter = 'ON_HAND';
    this.createdFrom = '';
    this.createdTo = '';
    this.offset.set(0);
    this.reload();
  }

  onStoreFilter(value: number | null): void {
    this.storeFilter.set(value);
    this.locationFilter = null;
    this.loadFilterLocations(value);
    this.offset.set(0);
    this.reload();
  }

  sort(field: StockSortField): void {
    if (this.sortBy() === field) {
      this.sortDir.update((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortBy.set(field);
      this.sortDir.set('asc');
    }
    this.offset.set(0);
    this.reload();
  }

  sortIcon(field: StockSortField): string {
    if (this.sortBy() !== field) return '';
    return this.sortDir() === 'asc' ? '▲' : '▼';
  }

  prevPage(): void {
    if (this.offset() === 0) return;
    this.offset.set(Math.max(0, this.offset() - this.limit()));
    this.reload();
  }

  nextPage(): void {
    if (!this.hasNext()) return;
    this.offset.set(this.offset() + this.limit());
    this.reload();
  }

  openRow(row: StockRow): void {
    this.selectedRow.set(row);
    this.rowLocations.set([]);
    this.api.listLocations(row.storeId).subscribe({
      next: (locs) => this.rowLocations.set(locs.filter((l) => l.isActive)),
      error: () => this.rowLocations.set([]),
    });
  }

  storeName(id: number): string {
    return this.storeMap().get(id) ?? `#${id}`;
  }

  expClass(date: string | null): string {
    if (!date) return '';
    const parsed = new Date(`${date}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return '';
    const days = Math.round((parsed.getTime() - Date.now()) / 86_400_000);
    if (days < 0) return 'expired';
    if (days <= 30) return 'warn';
    return '';
  }

  statusLabel(status: string | null): string {
    switch (status) {
      case 'SOLD':
        return 'Sold';
      case 'RETURNED_TO_WAREHOUSE':
        return 'Returned';
      case 'ADJUSTED_OUT':
        return 'Adjusted';
      default:
        return '';
    }
  }
}
