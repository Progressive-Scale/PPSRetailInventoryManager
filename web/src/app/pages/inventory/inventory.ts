import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import {
  ExpiringItem,
  InventoryProductDetail,
  ItemStatus,
  QuantityInventoryDetail,
  SerializedInventoryDetail,
  Store,
  StoreInventoryRow,
  StoreLocation,
} from '../../core/models';
import { LocationsComponent } from './locations';

type ActionVerb = 'sell' | 'return' | 'adjust';
type SubTab = 'stock' | 'locations' | 'expiring';
type ExpFilter = 'expired' | 7 | 30 | 90 | 'all';

@Component({
  selector: 'app-inventory',
  imports: [FormsModule, DatePipe, LocationsComponent],
  template: `
    <main class="container">
      <div class="tabs">
        <button [class.active]="tab() === 'stock'" (click)="tab.set('stock')">Stock</button>
        <button [class.active]="tab() === 'expiring'" (click)="selectExpiring()">Expiring</button>
        <button [class.active]="tab() === 'locations'" (click)="tab.set('locations')">Locations</button>
      </div>

      @if (tab() === 'locations') {
        <app-locations />
      } @else if (tab() === 'expiring') {
        <section class="card">
          <div class="row-between">
            <h2>Expiring stock</h2>
            <div class="filters">
              @if (isCompanyAdmin) {
                <label class="inline">
                  Store
                  <select [ngModel]="storeFilter()" (ngModelChange)="onStoreFilter($event)" name="ef-sf">
                    <option [ngValue]="null">All</option>
                    @for (s of stores(); track s.id) {
                      <option [ngValue]="s.id">{{ s.name }}</option>
                    }
                  </select>
                </label>
              }
              <button class="ghost" (click)="loadExpiring()" [disabled]="expLoading()">Refresh</button>
            </div>
          </div>
          <div class="chips">
            <button class="chip" [class.active]="expFilter() === 'expired'" (click)="setExpFilter('expired')">Expired</button>
            <button class="chip" [class.active]="expFilter() === 7" (click)="setExpFilter(7)">≤ 7 days</button>
            <button class="chip" [class.active]="expFilter() === 30" (click)="setExpFilter(30)">≤ 30 days</button>
            <button class="chip" [class.active]="expFilter() === 90" (click)="setExpFilter(90)">≤ 90 days</button>
            <button class="chip" [class.active]="expFilter() === 'all'" (click)="setExpFilter('all')">All dated</button>
          </div>

          @if (expLoading()) {
            <p class="muted">Loading…</p>
          } @else if (expError()) {
            <p class="error">{{ expError() }}</p>
          } @else if (expItems().length === 0) {
            <p class="muted">Nothing matches.</p>
          } @else {
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Expires</th>
                    <th>Serial</th>
                    <th>Product</th>
                    <th>Location</th>
                    @if (isCompanyAdmin) {
                      <th>Store</th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (it of expItems(); track it.id) {
                    <tr>
                      <td [class]="expClass(it.expirationDate)">
                        {{ it.expirationDate ? (it.expirationDate | date: 'shortDate') : '—' }}
                      </td>
                      <td class="mono">{{ it.serial }}</td>
                      <td>{{ it.name }} <span class="muted">{{ it.sku }}</span></td>
                      <td>
                        <span class="kind-badge" [class]="'k-' + it.locationKind">{{ it.locationName }}</span>
                      </td>
                      @if (isCompanyAdmin) {
                        <td class="muted">{{ storeName(it.storeId) }}</td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      } @else {
        <section class="card">
          <div class="row-between">
            <h2>Inventory</h2>
            <div class="filters">
              @if (isCompanyAdmin) {
                <label class="inline">
                  Store
                  <select [ngModel]="storeFilter()" (ngModelChange)="onStoreFilter($event)" name="sf">
                    <option [ngValue]="null">All</option>
                    @for (s of stores(); track s.id) {
                      <option [ngValue]="s.id">{{ s.name }}</option>
                    }
                  </select>
                </label>
              }
              <form class="inline search" (ngSubmit)="onSearch()">
                <label class="inline">
                  Search
                  <input name="q" [(ngModel)]="searchTerm" placeholder="Name, SKU, barcode or serial" />
                </label>
                <button type="submit" class="ghost" [disabled]="loading()">Search</button>
              </form>
              <button class="ghost" (click)="reload()" [disabled]="loading()">Refresh</button>
            </div>
          </div>

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
                </tr>
              </thead>
              <tbody>
                @for (row of rows(); track rowKey(row)) {
                  <tr>
                    <td>
                      <button class="link" (click)="toggleRow(row)">
                        {{ expandedKey() === rowKey(row) ? '▾' : '▸' }}
                      </button>
                    </td>
                    <td>{{ row.sku }}</td>
                    <td class="muted">{{ row.upc || '—' }}</td>
                    <td>
                      {{ row.name }}
                      @if (row.matchedSerial) {
                        <span class="matched">matched {{ row.matchedSerial }}</span>
                      }
                    </td>
                    <td>
                      <span class="type-badge" [class]="'tt-' + row.trackingType">
                        {{ row.trackingType }}
                      </span>
                    </td>
                    @if (isCompanyAdmin) {
                      <td class="muted">{{ storeName(row.storeId) }}</td>
                    }
                    <td class="num">{{ row.onHand }}</td>
                  </tr>

                  @if (expandedKey() === rowKey(row)) {
                    <tr class="sub-row">
                      <td></td>
                      <td [attr.colspan]="colspan()">
                        @if (detailLoading()) {
                          <p class="muted">Loading…</p>
                        } @else if (detailError()) {
                          <p class="error">{{ detailError() }}</p>
                        } @else if (serializedDetail(); as d) {
                          @if (d.units.length === 0) {
                            <p class="muted">No units.</p>
                          } @else {
                            @if (selectedUnitIds().size > 0) {
                              <div class="move-bar">
                                <span>{{ selectedUnitIds().size }} selected — move to</span>
                                <select [(ngModel)]="moveTargetLocationId" name="mv-target">
                                  <option [ngValue]="null">Location…</option>
                                  @for (l of activeLocations(); track l.id) {
                                    <option [ngValue]="l.id">{{ l.name }}</option>
                                  }
                                </select>
                                <button (click)="moveSelectedUnits(d)" [disabled]="saving() || moveTargetLocationId === null">Move</button>
                                <button class="ghost" (click)="clearSelection()">Clear</button>
                              </div>
                            }
                            <table class="sub">
                              <thead>
                                <tr>
                                  <th></th>
                                  <th>Serial</th>
                                  <th>Status</th>
                                  <th>Location</th>
                                  <th>Expires</th>
                                  <th>Received</th>
                                  <th class="actions">Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                @for (u of d.units; track u.id) {
                                  <tr>
                                    <td>
                                      @if (u.status === 'ON_HAND') {
                                        <input type="checkbox" [checked]="selectedUnitIds().has(u.id)" (change)="toggleUnit(u.id)" />
                                      }
                                    </td>
                                    <td class="mono">{{ u.serial }}</td>
                                    <td><span class="status">{{ statusLabel(u.status) }}</span></td>
                                    <td>
                                      <span class="kind-badge" [class]="'k-' + u.locationKind">{{ u.locationName }}</span>
                                    </td>
                                    <td [class]="expClass(u.expirationDate)">
                                      {{ u.expirationDate ? (u.expirationDate | date: 'shortDate') : '—' }}
                                    </td>
                                    <td class="muted">
                                      {{ u.receivedAt ? (u.receivedAt | date: 'shortDate') : '—' }}
                                    </td>
                                    <td class="actions">
                                      @if (u.status === 'ON_HAND') {
                                        <button class="ghost sm" (click)="beginUnitAction(u.id, 'sell')">Sell</button>
                                      }
                                      @if (u.status === 'ON_HAND' || u.status === 'SOLD') {
                                        <button class="ghost sm" (click)="beginUnitAction(u.id, 'return')">Return</button>
                                        <button class="ghost sm" (click)="beginUnitAction(u.id, 'adjust')">Adjust</button>
                                      }
                                    </td>
                                  </tr>
                                  @if (unitAction() && unitAction()!.unitId === u.id) {
                                    <tr class="action-row">
                                      <td [attr.colspan]="7">
                                        <form class="note-form" (ngSubmit)="commitUnitAction()">
                                          <span class="note-label">{{ verbLabel(unitAction()!.verb) }} — optional note:</span>
                                          <input name="note" [(ngModel)]="actionNote" placeholder="Note" />
                                          <button type="submit" [disabled]="saving()">Confirm</button>
                                          <button type="button" class="ghost" (click)="cancelUnitAction()">Cancel</button>
                                        </form>
                                      </td>
                                    </tr>
                                  }
                                }
                              </tbody>
                            </table>
                          }
                        } @else if (quantityDetail(); as d) {
                          <div class="qty-summary">
                            <h4>On hand by location</h4>
                            @if (d.stock.length === 0) {
                              <p class="muted">No stock.</p>
                            } @else {
                              <ul class="stock-list">
                                @for (st of d.stock; track st.id) {
                                  <li>
                                    <span class="kind-badge" [class]="'k-' + st.locationKind">{{ st.locationName }}</span>
                                    <strong>{{ st.quantityOnHand }}</strong>
                                    @if (isCompanyAdmin) {
                                      <span class="muted">· {{ storeName(st.storeId) }}</span>
                                    }
                                  </li>
                                }
                              </ul>
                            }
                          </div>

                          <div class="qty-actions">
                            @if (qtyAction()) {
                              <form class="note-form" (ngSubmit)="commitQtyAction(row)">
                                <span class="note-label">{{ verbLabel(qtyAction()!) }} — from</span>
                                <select [(ngModel)]="actionLocationId" name="qa-loc">
                                  <option [ngValue]="null">Location…</option>
                                  @for (l of activeLocations(); track l.id) {
                                    <option [ngValue]="l.id">{{ l.name }}</option>
                                  }
                                </select>
                                <input class="qty-input" name="qty" type="number" min="1" step="1" [(ngModel)]="actionQuantity" />
                                <input name="qnote" [(ngModel)]="actionNote" placeholder="Note" />
                                <button type="submit" [disabled]="saving()">Confirm</button>
                                <button type="button" class="ghost" (click)="cancelQtyAction()">Cancel</button>
                              </form>
                            } @else if (qtyMoveOpen()) {
                              <form class="note-form" (ngSubmit)="commitQtyMove(row)">
                                <span class="note-label">Move — from</span>
                                <select [(ngModel)]="moveFromLocationId" name="mf">
                                  <option [ngValue]="null">Location…</option>
                                  @for (l of activeLocations(); track l.id) {
                                    <option [ngValue]="l.id">{{ l.name }}</option>
                                  }
                                </select>
                                <span class="note-label">to</span>
                                <select [(ngModel)]="moveTargetLocationId" name="mt">
                                  <option [ngValue]="null">Location…</option>
                                  @for (l of activeLocations(); track l.id) {
                                    <option [ngValue]="l.id">{{ l.name }}</option>
                                  }
                                </select>
                                <input class="qty-input" name="mqty" type="number" min="1" step="1" [(ngModel)]="actionQuantity" />
                                <button type="submit" [disabled]="saving()">Move</button>
                                <button type="button" class="ghost" (click)="qtyMoveOpen.set(false)">Cancel</button>
                              </form>
                            } @else {
                              <button class="ghost sm" (click)="beginQtyAction('sell')">Sell</button>
                              <button class="ghost sm" (click)="beginQtyAction('return')">Return</button>
                              <button class="ghost sm" (click)="beginQtyAction('adjust')">Adjust</button>
                              <button class="ghost sm" (click)="beginQtyMove()">Move</button>
                            }
                          </div>

                          <div class="qty-ledger">
                            <h4>Recent activity</h4>
                            @if (d.ledger.length === 0) {
                              <p class="muted">No transactions.</p>
                            } @else {
                              <table class="sub">
                                <thead>
                                  <tr>
                                    <th>When</th>
                                    <th>Type</th>
                                    <th class="num">Δ Qty</th>
                                    <th>Movement</th>
                                    <th>Source</th>
                                    <th>Note</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  @for (tx of d.ledger; track tx.id) {
                                    <tr>
                                      <td class="muted">{{ tx.createdAt | date: 'short' }}</td>
                                      <td>{{ tx.type }}</td>
                                      <td class="num">{{ tx.quantityDelta }}</td>
                                      <td class="muted">{{ movementLabel(tx.locationFromId, tx.locationToId) }}</td>
                                      <td>
                                        <span class="src-badge" [class]="'src-' + tx.source">{{ tx.source }}</span>
                                      </td>
                                      <td class="muted">{{ tx.note }}</td>
                                    </tr>
                                  }
                                </tbody>
                              </table>
                            }
                          </div>
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
        max-width: 1100px;
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
      h4 {
        margin: 0.5rem 0 0.4rem;
        font-size: 0.82rem;
        color: var(--muted);
      }
      .row-between {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .filters {
        display: flex;
        align-items: flex-end;
        gap: 0.75rem;
        flex-wrap: wrap;
      }
      .filters .search {
        display: flex;
        align-items: flex-end;
        gap: 0.4rem;
      }
      .inline {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        font-size: 0.75rem;
        color: var(--muted);
      }
      .chips {
        display: flex;
        gap: 0.4rem;
        flex-wrap: wrap;
        margin-bottom: 0.85rem;
      }
      .chip {
        background: transparent;
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 0.25rem 0.7rem;
        font-size: 0.78rem;
        color: var(--muted);
        cursor: pointer;
      }
      .chip.active {
        color: var(--brand, var(--accent));
        border-color: var(--brand, var(--accent));
        background: var(--accent-soft);
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
      td.actions,
      th.actions {
        text-align: right;
        white-space: nowrap;
      }
      .mono {
        font-family: ui-monospace, monospace;
        font-size: 0.85rem;
      }
      .status {
        font-size: 0.78rem;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--brand, var(--accent));
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
        margin-left: 0.5rem;
        font-size: 0.7rem;
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
        margin-left: 0.25rem;
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
      table.sub {
        margin: 0;
      }
      table.sub th {
        font-size: 0.72rem;
        color: var(--muted);
      }
      .action-row td {
        background: var(--surface);
      }
      .move-bar {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.4rem 0;
        font-size: 0.85rem;
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
      .qty-summary,
      .qty-actions,
      .qty-ledger {
        margin: 0.4rem 0;
      }
      .stock-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem 1.5rem;
        font-size: 0.85rem;
      }
      .stock-list li {
        display: flex;
        gap: 0.4rem;
        align-items: center;
      }
      .pager {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.75rem;
        margin-top: 0.85rem;
        font-size: 0.85rem;
      }
      .src-badge {
        display: inline-block;
        font-size: 0.7rem;
        font-weight: 600;
        letter-spacing: 0.02em;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        border: 1px solid transparent;
      }
      .src-PORTAL {
        background: #eff4ff;
        color: #1d4ed8;
        border-color: #c7d7fe;
      }
      .src-SYNC {
        background: #ecfdf3;
        color: #067647;
        border-color: #abefc6;
      }
      .src-CYCLE_COUNT {
        background: #fffaeb;
        color: #b54708;
        border-color: #fedf89;
      }
    `,
  ],
})
export class InventoryComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);

  readonly isCompanyAdmin = this.auth.user()?.role === 'COMPANY_ADMIN';

  readonly tab = signal<SubTab>('stock');

  readonly rows = signal<StoreInventoryRow[]>([]);
  readonly total = signal(0);
  readonly limit = signal(20);
  readonly offset = signal(0);

  readonly stores = signal<Store[]>([]);
  private readonly storeMap = computed(() => {
    const m = new Map<number, string>();
    for (const s of this.stores()) m.set(s.id, s.name);
    return m;
  });

  readonly storeFilter = signal<number | null>(null);
  searchTerm = '';
  readonly search = signal<string>('');

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly listError = signal<string | null>(null);

  readonly expandedKey = signal<string | null>(null);
  readonly detail = signal<InventoryProductDetail | null>(null);
  readonly detailLoading = signal(false);
  readonly detailError = signal<string | null>(null);

  // Locations for the expanded row's store (for move + quantity-op pickers).
  readonly detailLocations = signal<StoreLocation[]>([]);
  readonly activeLocations = computed(() => this.detailLocations().filter((l) => l.isActive));

  // Serialized per-unit action.
  readonly unitAction = signal<{ unitId: string; verb: ActionVerb } | null>(null);
  // Quantity action for the expanded row.
  readonly qtyAction = signal<ActionVerb | null>(null);
  readonly qtyMoveOpen = signal(false);
  // Serialized multi-select move.
  readonly selectedUnitIds = signal<Set<string>>(new Set());
  moveTargetLocationId: number | null = null;
  moveFromLocationId: number | null = null;

  actionNote = '';
  actionQuantity: number | null = null;
  actionLocationId: number | null = null;

  // Expiring tab.
  readonly expItems = signal<ExpiringItem[]>([]);
  readonly expFilter = signal<ExpFilter>(30);
  readonly expLoading = signal(false);
  readonly expError = signal<string | null>(null);

  readonly serializedDetail = computed<SerializedInventoryDetail | null>(() => {
    const d = this.detail();
    return d && d.trackingType === 'SERIALIZED' ? d : null;
  });
  readonly quantityDetail = computed<QuantityInventoryDetail | null>(() => {
    const d = this.detail();
    return d && d.trackingType === 'QUANTITY' ? d : null;
  });

  readonly colspan = computed(() => (this.isCompanyAdmin ? 6 : 5));

  readonly hasNext = computed(() => this.offset() + this.rows().length < this.total());
  readonly rangeLabel = computed(() => {
    const start = this.total() === 0 ? 0 : this.offset() + 1;
    const end = this.offset() + this.rows().length;
    return `${start}–${end} of ${this.total()}`;
  });

  ngOnInit(): void {
    if (this.isCompanyAdmin) {
      this.api.listStores().subscribe({
        next: (rows) => this.stores.set(rows),
        error: () => {
          /* stores optional for display */
        },
      });
    }
    this.reload();
  }

  rowKey(row: StoreInventoryRow): string {
    return `${row.storeId}:${row.productId}`;
  }

  reload(): void {
    this.loading.set(true);
    this.listError.set(null);
    this.collapse();
    this.api
      .listInventory({
        storeId: this.storeFilter() ?? undefined,
        search: this.search() || undefined,
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

  onStoreFilter(value: number | null): void {
    this.storeFilter.set(value);
    this.offset.set(0);
    this.reload();
    if (this.tab() === 'expiring') this.loadExpiring();
  }

  onSearch(): void {
    this.search.set(this.searchTerm.trim());
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

  toggleRow(row: StoreInventoryRow): void {
    const key = this.rowKey(row);
    if (this.expandedKey() === key) {
      this.collapse();
      return;
    }
    this.collapse();
    this.expandedKey.set(key);
    this.detailLoading.set(true);
    this.api.getInventoryProduct(row.productId).subscribe({
      next: (d) => {
        this.detail.set(d);
        this.detailLoading.set(false);
      },
      error: (err) => {
        this.detailLoading.set(false);
        this.detailError.set(messageFor(err));
      },
    });
    // Load this store's locations for move / quantity-op pickers.
    this.api.listLocations(row.storeId).subscribe({
      next: (locs) => this.detailLocations.set(locs),
      error: () => this.detailLocations.set([]),
    });
  }

  private collapse(): void {
    this.expandedKey.set(null);
    this.detail.set(null);
    this.detailError.set(null);
    this.detailLocations.set([]);
    this.unitAction.set(null);
    this.qtyAction.set(null);
    this.qtyMoveOpen.set(false);
    this.selectedUnitIds.set(new Set());
    this.actionNote = '';
    this.actionQuantity = null;
    this.actionLocationId = null;
    this.moveTargetLocationId = null;
    this.moveFromLocationId = null;
  }

  private refreshDetail(productId: number): void {
    this.api.getInventoryProduct(productId).subscribe({
      next: (d) => this.detail.set(d),
      error: () => {
        /* keep prior detail */
      },
    });
  }

  // ---- serialized unit actions ----
  beginUnitAction(unitId: string, verb: ActionVerb): void {
    this.actionNote = '';
    this.unitAction.set({ unitId, verb });
  }

  cancelUnitAction(): void {
    this.unitAction.set(null);
  }

  commitUnitAction(): void {
    const a = this.unitAction();
    if (!a) return;
    const note = this.actionNote.trim() || undefined;
    const body = { itemId: a.unitId, note };
    const call =
      a.verb === 'sell'
        ? this.api.sellInventory(body)
        : a.verb === 'return'
          ? this.api.returnInventory(body)
          : this.api.adjustInventory(body);
    this.saving.set(true);
    this.detailError.set(null);
    call.subscribe({
      next: () => {
        this.saving.set(false);
        this.unitAction.set(null);
        const d = this.detail();
        if (d) this.refreshDetail(d.product.id);
        this.reloadCounts();
      },
      error: (err) => {
        this.saving.set(false);
        this.detailError.set(messageFor(err));
      },
    });
  }

  // ---- serialized multi-select move ----
  toggleUnit(id: string): void {
    const next = new Set(this.selectedUnitIds());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selectedUnitIds.set(next);
  }

  clearSelection(): void {
    this.selectedUnitIds.set(new Set());
    this.moveTargetLocationId = null;
  }

  moveSelectedUnits(d: SerializedInventoryDetail): void {
    if (this.moveTargetLocationId === null || this.selectedUnitIds().size === 0) return;
    this.saving.set(true);
    this.detailError.set(null);
    this.api
      .moveInventory({
        itemIds: [...this.selectedUnitIds()],
        toLocationId: this.moveTargetLocationId,
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.clearSelection();
          this.refreshDetail(d.product.id);
        },
        error: (err) => {
          this.saving.set(false);
          this.detailError.set(messageFor(err));
        },
      });
  }

  // ---- quantity actions ----
  beginQtyAction(verb: ActionVerb): void {
    this.actionNote = '';
    this.actionQuantity = null;
    this.actionLocationId = null;
    this.qtyMoveOpen.set(false);
    this.qtyAction.set(verb);
  }

  cancelQtyAction(): void {
    this.qtyAction.set(null);
  }

  commitQtyAction(row: StoreInventoryRow): void {
    const verb = this.qtyAction();
    if (!verb) return;
    const qty = Number(this.actionQuantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      this.detailError.set('Enter a quantity greater than zero.');
      return;
    }
    if (this.actionLocationId === null) {
      this.detailError.set('Choose a location.');
      return;
    }
    const body = {
      productId: row.productId,
      quantity: qty,
      locationId: this.actionLocationId,
      storeId: row.storeId,
      note: this.actionNote.trim() || undefined,
    };
    const call =
      verb === 'sell'
        ? this.api.sellInventory(body)
        : verb === 'return'
          ? this.api.returnInventory(body)
          : this.api.adjustInventory(body);
    this.saving.set(true);
    this.detailError.set(null);
    call.subscribe({
      next: () => {
        this.saving.set(false);
        this.qtyAction.set(null);
        this.refreshDetail(row.productId);
        this.reloadCounts();
      },
      error: (err) => {
        this.saving.set(false);
        this.detailError.set(messageFor(err));
      },
    });
  }

  // ---- quantity move between locations ----
  beginQtyMove(): void {
    this.actionQuantity = null;
    this.moveFromLocationId = null;
    this.moveTargetLocationId = null;
    this.qtyAction.set(null);
    this.qtyMoveOpen.set(true);
  }

  commitQtyMove(row: StoreInventoryRow): void {
    const qty = Number(this.actionQuantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      this.detailError.set('Enter a quantity greater than zero.');
      return;
    }
    if (this.moveFromLocationId === null || this.moveTargetLocationId === null) {
      this.detailError.set('Choose source and destination locations.');
      return;
    }
    if (this.moveFromLocationId === this.moveTargetLocationId) {
      this.detailError.set('Source and destination must differ.');
      return;
    }
    this.saving.set(true);
    this.detailError.set(null);
    this.api
      .moveInventory({
        productId: row.productId,
        fromLocationId: this.moveFromLocationId,
        toLocationId: this.moveTargetLocationId,
        quantity: qty,
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.qtyMoveOpen.set(false);
          this.refreshDetail(row.productId);
        },
        error: (err) => {
          this.saving.set(false);
          this.detailError.set(messageFor(err));
        },
      });
  }

  /** Refresh on-hand totals in the product list without collapsing the row. */
  private reloadCounts(): void {
    this.api
      .listInventory({
        storeId: this.storeFilter() ?? undefined,
        search: this.search() || undefined,
        limit: this.limit(),
        offset: this.offset(),
      })
      .subscribe({
        next: (res) => {
          this.rows.set(res.data);
          this.total.set(res.total);
        },
        error: () => {
          /* keep current rows */
        },
      });
  }

  // ---- expiring tab ----
  selectExpiring(): void {
    this.tab.set('expiring');
    if (this.expItems().length === 0) this.loadExpiring();
  }

  setExpFilter(f: ExpFilter): void {
    this.expFilter.set(f);
    this.loadExpiring();
  }

  loadExpiring(): void {
    this.expLoading.set(true);
    this.expError.set(null);
    const f = this.expFilter();
    const opts: {
      storeId?: number;
      expiringWithinDays?: number;
      expiresBefore?: string;
      hasExpiration?: boolean;
    } = { storeId: this.storeFilter() ?? undefined };
    if (f === 'expired') {
      opts.expiresBefore = new Date().toISOString().slice(0, 10);
    } else if (f === 'all') {
      opts.hasExpiration = true;
    } else {
      opts.expiringWithinDays = f;
    }
    this.api.listItems({ ...opts, limit: 200 }).subscribe({
      next: (res) => {
        this.expItems.set(res.data);
        this.expLoading.set(false);
      },
      error: (err) => {
        this.expLoading.set(false);
        this.expError.set(messageFor(err));
      },
    });
  }

  // ---- helpers ----
  storeName(id: number): string {
    return this.storeMap().get(id) ?? `#${id}`;
  }

  private locName(id: number | null): string {
    if (id == null) return '—';
    return this.detailLocations().find((l) => l.id === id)?.name ?? `#${id}`;
  }

  movementLabel(fromId: number | null, toId: number | null): string {
    if (fromId && toId) return `${this.locName(fromId)} → ${this.locName(toId)}`;
    if (toId) return `→ ${this.locName(toId)}`;
    if (fromId) return `${this.locName(fromId)} →`;
    return '—';
  }

  /** '' | 'warn' (≤30d) | 'expired' (past) for the expiration cell. */
  expClass(date: string | null): string {
    if (!date) return '';
    const parsed = new Date(`${date}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return '';
    const now = new Date();
    const days = Math.round((parsed.getTime() - now.getTime()) / 86_400_000);
    if (days < 0) return 'expired';
    if (days <= 30) return 'warn';
    return '';
  }

  verbLabel(verb: ActionVerb): string {
    return verb.charAt(0).toUpperCase() + verb.slice(1);
  }

  statusLabel(status: ItemStatus): string {
    switch (status) {
      case 'ON_HAND':
        return 'On hand';
      case 'SOLD':
        return 'Sold';
      case 'RETURNED_TO_WAREHOUSE':
        return 'Returned';
      case 'ADJUSTED_OUT':
        return 'Adjusted out';
    }
  }
}
