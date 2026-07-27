import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import {
  InventoryProductDetail,
  ItemStatus,
  QuantityInventoryDetail,
  SerializedInventoryDetail,
  Store,
  StoreInventoryRow,
} from '../../core/models';

type ActionVerb = 'sell' | 'return' | 'adjust';

@Component({
  selector: 'app-inventory',
  imports: [FormsModule, DatePipe],
  template: `
    <main class="container">
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
                <input
                  name="q"
                  [(ngModel)]="searchTerm"
                  placeholder="Name, SKU, UPC or serial"
                />
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
                  <th>UPC</th>
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
                            <table class="sub">
                              <thead>
                                <tr>
                                  <th>Serial</th>
                                  <th>Status</th>
                                  <th>Expires</th>
                                  <th>Received</th>
                                  <th class="actions">Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                @for (u of d.units; track u.id) {
                                  <tr>
                                    <td>{{ u.serial }}</td>
                                    <td><span class="status">{{ statusLabel(u.status) }}</span></td>
                                    <td class="muted" [class.expired]="isExpired(u.expirationDate)">
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
                                      <td [attr.colspan]="5">
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
                            <h4>On hand</h4>
                            @if (d.stock.length === 0) {
                              <p class="muted">No stock.</p>
                            } @else {
                              <ul class="stock-list">
                                @for (st of d.stock; track st.id) {
                                  <li>
                                    <span class="muted">{{ storeName(st.storeId) }}</span>
                                    <strong>{{ st.quantityOnHand }}</strong>
                                  </li>
                                }
                              </ul>
                            }
                          </div>

                          <div class="qty-actions">
                            @if (qtyAction()) {
                              <form class="note-form" (ngSubmit)="commitQtyAction(row)">
                                <span class="note-label">{{ verbLabel(qtyAction()!) }} — quantity:</span>
                                <input
                                  class="qty-input"
                                  name="qty"
                                  type="number"
                                  min="1"
                                  step="1"
                                  [(ngModel)]="actionQuantity"
                                />
                                <input name="qnote" [(ngModel)]="actionNote" placeholder="Note" />
                                <button type="submit" [disabled]="saving()">Confirm</button>
                                <button type="button" class="ghost" (click)="cancelQtyAction()">Cancel</button>
                              </form>
                            } @else {
                              <button class="ghost sm" (click)="beginQtyAction('sell')">Sell</button>
                              <button class="ghost sm" (click)="beginQtyAction('return')">Return</button>
                              <button class="ghost sm" (click)="beginQtyAction('adjust')">Adjust</button>
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
            <button class="ghost" (click)="prevPage()" [disabled]="offset() === 0 || loading()">
              Prev
            </button>
            <span class="muted">{{ rangeLabel() }}</span>
            <button class="ghost" (click)="nextPage()" [disabled]="!hasNext() || loading()">
              Next
            </button>
          </div>
        }
      </section>
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
      .note-form {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        flex-wrap: wrap;
      }
      .note-form input {
        flex: 1 1 200px;
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
        align-items: baseline;
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

  // Serialized per-unit action.
  readonly unitAction = signal<{ unitId: string; verb: ActionVerb } | null>(null);
  // Quantity action for the expanded row.
  readonly qtyAction = signal<ActionVerb | null>(null);
  actionNote = '';
  actionQuantity: number | null = null;

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
  }

  private collapse(): void {
    this.expandedKey.set(null);
    this.detail.set(null);
    this.detailError.set(null);
    this.unitAction.set(null);
    this.qtyAction.set(null);
    this.actionNote = '';
    this.actionQuantity = null;
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

  // ---- quantity actions ----
  beginQtyAction(verb: ActionVerb): void {
    this.actionNote = '';
    this.actionQuantity = null;
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
    const body = {
      productId: row.productId,
      quantity: qty,
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

  storeName(id: number): string {
    return this.storeMap().get(id) ?? `#${id}`;
  }

  isExpired(date: string | null): boolean {
    if (!date) return false;
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) return false;
    return parsed.getTime() < Date.now();
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
