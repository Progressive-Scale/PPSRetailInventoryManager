import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Observable } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import { Store, StoreLocation, StockRow, TrackingType } from '../../core/models';
import { LocationsComponent } from './locations';

type ActionVerb = 'sell' | 'return' | 'adjust' | 'move';
type SubTab = 'stock' | 'locations';

@Component({
  selector: 'app-inventory',
  imports: [FormsModule, DatePipe, LocationsComponent],
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

          <!-- Filters -->
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

          @if (loading()) {
            <p class="muted">Loading…</p>
          } @else if (listError()) {
            <p class="error">{{ listError() }}</p>
          } @else if (rows().length === 0) {
            <p class="muted">No inventory matches.</p>
          } @else {
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>SKU</th>
                    <th>Barcode</th>
                    <th>Name</th>
                    <th>Type</th>
                    @if (isCompanyAdmin) {
                      <th>Store</th>
                    }
                    <th class="num">On hand</th>
                    <th>Location</th>
                    <th>Expiration</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of rows(); track row.rowId) {
                    <tr>
                      <td>
                        <button class="link" (click)="toggleRow(row)">
                          {{ expandedRowId() === row.rowId ? '▾' : '▸' }}
                        </button>
                      </td>
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
                      </td>
                      <td class="muted">{{ row.createdAt | date: 'shortDate' }}</td>
                    </tr>

                    @if (expandedRowId() === row.rowId) {
                      <tr class="sub-row">
                        <td></td>
                        <td [attr.colspan]="colspan()">
                          @if (actionVerb()) {
                            <form class="note-form" (ngSubmit)="commitAction(row)">
                              <span class="note-label">{{ verbLabel(actionVerb()!) }}</span>
                              @if (actionVerb() === 'move') {
                                <span class="note-label">to</span>
                                <select [(ngModel)]="actionTargetLocationId" name="a-target">
                                  <option [ngValue]="null">Location…</option>
                                  @for (l of rowLocations(); track l.id) {
                                    <option [ngValue]="l.id" [disabled]="l.id === row.locationId">{{ l.name }}</option>
                                  }
                                </select>
                              }
                              @if (row.rowKind === 'stock') {
                                <input class="qty-input" name="a-qty" type="number" min="1" step="1"
                                  [max]="actionVerb() === 'move' || actionVerb() === 'sell' || actionVerb() === 'return' ? row.onHand : null"
                                  [(ngModel)]="actionQuantity" placeholder="Qty" />
                              }
                              @if (row.rowKind === 'unit') {
                                <input name="a-note" [(ngModel)]="actionNote" placeholder="Note (optional)" />
                              }
                              <button type="submit" [disabled]="saving()">Confirm</button>
                              <button type="button" class="ghost" (click)="cancelAction()">Cancel</button>
                            </form>
                          } @else {
                            <div class="verb-bar">
                              <button class="ghost sm" (click)="beginAction('sell')">Sell</button>
                              <button class="ghost sm" (click)="beginAction('return')">Return</button>
                              <button class="ghost sm" (click)="beginAction('adjust')">Adjust</button>
                              <button class="ghost sm" (click)="beginAction('move')">Move</button>
                            </div>
                          }
                          @if (detailError()) {
                            <p class="error">{{ detailError() }}</p>
                          }
                        </td>
                      </tr>
                    }
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
      button.sm {
        padding: 0.3rem 0.55rem;
        font-size: 0.8rem;
      }
      button.link {
        background: transparent;
        border: none;
        color: var(--muted);
        padding: 0.1rem 0.3rem;
      }
      .sub-row td {
        background: var(--bg);
      }
      .verb-bar {
        display: flex;
        gap: 0.4rem;
        flex-wrap: wrap;
      }
      .note-form {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        flex-wrap: wrap;
      }
      .note-form input {
        flex: 1 1 160px;
      }
      .note-form input.qty-input {
        flex: 0 0 90px;
        max-width: 90px;
      }
      .note-label {
        font-size: 0.85rem;
        color: var(--muted);
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
  createdFrom = '';
  createdTo = '';

  // Locations for the location filter (for the currently selected store).
  readonly filterLocations = signal<StoreLocation[]>([]);

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly listError = signal<string | null>(null);
  readonly detailError = signal<string | null>(null);

  // Per-row action expansion.
  readonly expandedRowId = signal<string | null>(null);
  readonly rowLocations = signal<StoreLocation[]>([]);
  readonly actionVerb = signal<ActionVerb | null>(null);
  actionQuantity: number | null = null;
  actionTargetLocationId: number | null = null;
  actionNote = '';

  readonly colspan = computed(() => (this.isCompanyAdmin ? 10 : 9));

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
      // STORE_USER: preload their store's locations for the location filter.
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
    this.collapse();
    this.api
      .listStock({
        storeId: this.storeFilter() ?? undefined,
        search: this.searchTerm.trim() || undefined,
        locationId: this.locationFilter ?? undefined,
        type: this.typeFilter ?? undefined,
        createdFrom: this.createdFrom || undefined,
        createdTo: this.createdTo || undefined,
        limit: this.limit(),
        offset: this.offset(),
      })
      .subscribe({
        next: (res) => {
          this.rows.set(res.data);
          this.total.set(res.total);
          this.loading.set(false);
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

  toggleRow(row: StockRow): void {
    if (this.expandedRowId() === row.rowId) {
      this.collapse();
      return;
    }
    this.collapse();
    this.expandedRowId.set(row.rowId);
    // Load this row's store locations for the Move target picker.
    this.api.listLocations(row.storeId).subscribe({
      next: (locs) => this.rowLocations.set(locs.filter((l) => l.isActive)),
      error: () => this.rowLocations.set([]),
    });
  }

  private collapse(): void {
    this.expandedRowId.set(null);
    this.rowLocations.set([]);
    this.actionVerb.set(null);
    this.detailError.set(null);
    this.actionQuantity = null;
    this.actionTargetLocationId = null;
    this.actionNote = '';
  }

  beginAction(verb: ActionVerb): void {
    this.detailError.set(null);
    this.actionQuantity = null;
    this.actionTargetLocationId = null;
    this.actionNote = '';
    this.actionVerb.set(verb);
  }

  cancelAction(): void {
    this.actionVerb.set(null);
  }

  commitAction(row: StockRow): void {
    const verb = this.actionVerb();
    if (!verb) return;
    this.detailError.set(null);

    // Quantity rows need an amount for every verb.
    let qty = 0;
    if (row.rowKind === 'stock') {
      qty = Number(this.actionQuantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        this.detailError.set('Enter a quantity greater than zero.');
        return;
      }
      if ((verb === 'sell' || verb === 'return' || verb === 'move') && qty > row.onHand) {
        this.detailError.set(`Only ${row.onHand} on hand at this location.`);
        return;
      }
    }

    if (verb === 'move') {
      if (this.actionTargetLocationId == null) {
        this.detailError.set('Choose a destination location.');
        return;
      }
      const body =
        row.rowKind === 'unit'
          ? { itemIds: [row.itemId!], toLocationId: this.actionTargetLocationId }
          : {
              productId: row.productId,
              fromLocationId: row.locationId,
              toLocationId: this.actionTargetLocationId,
              quantity: qty,
            };
      this.run(this.api.moveInventory(body));
      return;
    }

    const body =
      row.rowKind === 'unit'
        ? { itemId: row.itemId!, note: this.actionNote.trim() || undefined }
        : {
            productId: row.productId,
            quantity: qty,
            locationId: row.locationId,
            storeId: row.storeId,
          };
    const call =
      verb === 'sell'
        ? this.api.sellInventory(body)
        : verb === 'return'
          ? this.api.returnInventory(body)
          : this.api.adjustInventory(body);
    this.run(call);
  }

  private run(obs: Observable<unknown>): void {
    this.saving.set(true);
    obs.subscribe({
      next: () => {
        this.saving.set(false);
        this.reload();
      },
      error: (err) => {
        this.saving.set(false);
        this.detailError.set(messageFor(err));
      },
    });
  }

  storeName(id: number): string {
    return this.storeMap().get(id) ?? `#${id}`;
  }

  /** '' | 'warn' (≤30d) | 'expired' (past) for the expiration cell. */
  expClass(date: string | null): string {
    if (!date) return '';
    const parsed = new Date(`${date}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return '';
    const days = Math.round((parsed.getTime() - Date.now()) / 86_400_000);
    if (days < 0) return 'expired';
    if (days <= 30) return 'warn';
    return '';
  }

  verbLabel(verb: ActionVerb): string {
    return verb.charAt(0).toUpperCase() + verb.slice(1);
  }
}
