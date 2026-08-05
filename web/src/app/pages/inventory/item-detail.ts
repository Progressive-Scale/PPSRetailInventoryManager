import { DatePipe } from '@angular/common';
import {
  Component,
  EventEmitter,
  inject,
  Input,
  OnInit,
  Output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import { ReorderDialogComponent } from '../reorders/reorder-dialog';
import { ItemAudit, StockRow, StoreLocation, Transaction } from '../../core/models';

type Mgmt = 'sold' | 'move' | 'expiration' | 'weight' | 'setqty' | null;

@Component({
  selector: 'app-item-detail',
  imports: [FormsModule, DatePipe, ReorderDialogComponent],
  template: `
    <div class="overlay" (click)="close.emit()">
      <div class="modal" (click)="$event.stopPropagation()">
        <div class="modal-head">
          <div>
            <h2>{{ row.name }}</h2>
            <span class="muted">{{ row.sku }}</span>
            <span class="type-badge" [class]="'tt-' + row.trackingType">{{ row.trackingType === 'QUANTITY' ? 'UPC' : 'SERIALIZED' }}</span>
            @if (row.reorderOpen) {
              <span class="ro-badge" title="This store already has an open reorder">Reorder open</span>
            }
          </div>
          <div class="head-actions">
            <!-- Every role: flagging an empty shelf is shop-floor work, and the Manage
                 block below is admin-only. -->
            <button class="ghost" (click)="reorderOpen.set(true)">Reorder</button>
            <button class="ghost" (click)="close.emit()">Close</button>
          </div>
        </div>

        @if (reorderOpen()) {
          <app-reorder-dialog
            [productId]="row.productId"
            [productName]="row.name"
            [sku]="row.sku"
            [storeId]="row.storeId"
            (close)="onReorderClosed($event)"
          />
        }

        <!-- INFO -->
        <section class="block">
          <h3>Info</h3>
          <dl class="info">
            <div><dt>Barcode</dt><dd>{{ row.upc || '—' }}</dd></div>
            <div><dt>Store</dt><dd>{{ storeName || '#' + row.storeId }}</dd></div>
            <div><dt>Location</dt><dd><span class="kind-badge" [class]="'k-' + row.locationKind">{{ row.locationName }}</span></dd></div>
            <div><dt>On hand</dt><dd>{{ row.onHand }}</dd></div>
            @if (row.rowKind === 'unit') {
              <div><dt>Serial</dt><dd class="mono">{{ row.serial }}</dd></div>
              <div><dt>Status</dt><dd>{{ statusLabel(row.status) }}</dd></div>
              <!-- Only when there is one: on an on-hand unit the Status field above
                   already says "not sold", so an empty Sold row would just be noise. -->
              @if (row.soldAt) {
                <div><dt>Sold on</dt><dd>{{ row.soldAt | date: 'medium' }}</dd></div>
              }
              <div><dt>Expiration</dt><dd [class]="expClass(row.expirationDate)">{{ row.expirationDate ? (row.expirationDate | date: 'mediumDate') : '—' }}</dd></div>
              <!-- Random-weight goods: this unit's own weight, not the product's. -->
              <div><dt>Weight</dt><dd>{{ weightLabel() }}</dd></div>
            }
            <div><dt>Created</dt><dd>{{ row.createdAt | date: 'medium' }}</dd></div>
          </dl>
        </section>

        <!-- HISTORY -->
        <section class="block">
          <h3>History</h3>
          @if (historyLoading()) {
            <p class="muted">Loading…</p>
          } @else if (history().length === 0 && audit().length === 0) {
            <p class="muted">No activity.</p>
          } @else {
            @if (audit().length > 0) {
              <ul class="audit">
                @for (a of audit(); track a.id) {
                  <li>
                    <span class="muted">{{ a.createdAt | date: 'short' }}</span>
                    {{ auditFieldLabel(a.field) }} {{ a.oldValue || '—' }} → {{ a.newValue || '—' }}
                    <span class="muted">
                      · {{ a.changedByEmail || 'system' }} · {{ auditSourceLabel(a.source) }}
                    </span>
                  </li>
                }
              </ul>
            }
            @if (history().length > 0) {
              <table class="hist">
                <thead>
                  <tr><th>When</th><th>Type</th><th class="num">Δ Qty</th><th>Movement</th><th>Source</th><th>Note</th></tr>
                </thead>
                <tbody>
                  @for (t of history(); track t.id) {
                    <tr>
                      <td class="muted">{{ t.createdAt | date: 'short' }}</td>
                      <td>{{ t.type }}</td>
                      <td class="num">{{ t.quantityDelta }}</td>
                      <td class="muted">{{ movement(t) }}</td>
                      <td><span class="src-badge" [class]="'src-' + t.source">{{ t.source }}</span></td>
                      <td class="muted">{{ t.note }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          }
        </section>

        <!-- MANAGEMENT (admin only) -->
        @if (isCompanyAdmin) {
          <section class="block">
            <h3>Manage</h3>
            @if (mgmtError()) {
              <p class="error">{{ mgmtError() }}</p>
            }
            <div class="verb-bar">
              @if (row.rowKind === 'unit') {
                @if (row.status === 'ON_HAND') {
                  <button class="ghost sm" (click)="open('sold')">Mark sold</button>
                  <button class="ghost sm" (click)="open('move')">Move</button>
                }
                <button class="ghost sm" (click)="open('expiration')">Edit expiration</button>
                <button class="ghost sm" (click)="open('weight')">Edit weight</button>
              } @else {
                <button class="ghost sm" (click)="open('setqty')">Set on-hand</button>
                <button class="ghost sm" (click)="open('move')">Move</button>
              }
            </div>

            @if (mgmt() === 'sold') {
              <form class="mgmt-form" (ngSubmit)="markSold()">
                <span>Mark this unit as sold?</span>
                <button type="submit" [disabled]="saving()">Confirm sold</button>
                <button type="button" class="ghost" (click)="mgmt.set(null)">Cancel</button>
              </form>
            } @else if (mgmt() === 'move') {
              <form class="mgmt-form" (ngSubmit)="doMove()">
                <span>Move to</span>
                <select [(ngModel)]="targetLocationId" name="m-loc">
                  <option [ngValue]="null">Location…</option>
                  @for (l of locations; track l.id) {
                    <option [ngValue]="l.id" [disabled]="l.id === row.locationId">{{ l.name }}</option>
                  }
                </select>
                @if (row.rowKind === 'stock') {
                  <input class="qty" type="number" min="1" [max]="row.onHand" [(ngModel)]="qty" name="m-qty" placeholder="Qty" />
                }
                <button type="submit" [disabled]="saving()">Move</button>
                <button type="button" class="ghost" (click)="mgmt.set(null)">Cancel</button>
              </form>
            } @else if (mgmt() === 'expiration') {
              <form class="mgmt-form" (ngSubmit)="saveExpiration()">
                <span>Expiration</span>
                <input type="date" [(ngModel)]="expirationDate" name="m-exp" />
                <button type="submit" [disabled]="saving()">Save</button>
                <button type="button" class="ghost" (click)="clearExpiration()" [disabled]="saving()">Clear</button>
                <button type="button" class="ghost" (click)="mgmt.set(null)">Cancel</button>
              </form>
            } @else if (mgmt() === 'weight') {
              <form class="mgmt-form" (ngSubmit)="saveWeight()">
                <span>Weight (lbs)</span>
                <input class="qty" type="number" step="0.001" [(ngModel)]="weightLbs" name="m-wt" />
                <button type="submit" [disabled]="saving()">Save</button>
                <button type="button" class="ghost" (click)="clearWeight()" [disabled]="saving()">Clear</button>
                <button type="button" class="ghost" (click)="mgmt.set(null)">Cancel</button>
              </form>
            } @else if (mgmt() === 'setqty') {
              <form class="mgmt-form" (ngSubmit)="saveQuantity()">
                <span>Set on-hand at {{ row.locationName }} to</span>
                <input class="qty" type="number" min="0" [(ngModel)]="qty" name="s-qty" />
                <button type="submit" [disabled]="saving()">Save</button>
                <button type="button" class="ghost" (click)="mgmt.set(null)">Cancel</button>
              </form>
            }
          </section>
        }
      </div>
    </div>
  `,
  styles: [
    `
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: 3rem 1rem;
        z-index: 80;
        overflow-y: auto;
      }
      .modal {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        width: 100%;
        max-width: 680px;
        padding: 1.25rem;
      }
      .modal-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1rem;
        margin-bottom: 0.5rem;
      }
      .head-actions {
        display: flex;
        gap: 0.4rem;
        flex-shrink: 0;
      }
      .ro-badge {
        display: inline-block;
        margin-left: 0.35rem;
        font-size: 0.68rem;
        font-weight: 600;
        padding: 0.05rem 0.4rem;
        border-radius: 999px;
        background: #fff7ed;
        color: #9a3412;
        border: 1px solid #fed7aa;
        white-space: nowrap;
      }
      h2 {
        margin: 0;
        font-size: 1.1rem;
        display: inline;
      }
      h3 {
        margin: 0 0 0.5rem;
        font-size: 0.85rem;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .block {
        border-top: 1px solid var(--border);
        padding-top: 0.85rem;
        margin-top: 0.85rem;
      }
      .info {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 0.6rem 1rem;
        margin: 0;
      }
      .info div {
        display: flex;
        flex-direction: column;
      }
      dt {
        font-size: 0.72rem;
        color: var(--muted);
      }
      dd {
        margin: 0;
        font-size: 0.9rem;
      }
      .mono {
        font-family: ui-monospace, monospace;
      }
      table.hist {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.82rem;
      }
      table.hist th,
      table.hist td {
        text-align: left;
        padding: 0.35rem 0.5rem;
        border-bottom: 1px solid var(--border);
      }
      table.hist th.num,
      table.hist td.num {
        text-align: right;
      }
      .audit {
        list-style: none;
        margin: 0 0 0.6rem;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        font-size: 0.82rem;
      }
      .audit li {
        border-bottom: 1px dashed var(--border);
        padding-bottom: 0.3rem;
      }
      .muted {
        color: var(--muted);
      }
      .error {
        color: #b42318;
        font-size: 0.85rem;
      }
      .expired {
        color: #b42318;
        font-weight: 600;
      }
      .warn {
        color: #b54708;
        font-weight: 600;
      }
      .type-badge {
        display: inline-block;
        font-size: 0.7rem;
        font-weight: 600;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        margin-left: 0.5rem;
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
      .src-badge {
        display: inline-block;
        font-size: 0.68rem;
        font-weight: 600;
        padding: 0.05rem 0.4rem;
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
      .verb-bar {
        display: flex;
        gap: 0.4rem;
        flex-wrap: wrap;
        margin-bottom: 0.5rem;
      }
      .mgmt-form {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        flex-wrap: wrap;
        font-size: 0.88rem;
      }
      button.sm {
        padding: 0.3rem 0.55rem;
        font-size: 0.8rem;
      }
      input,
      select {
        padding: 0.4rem 0.5rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.88rem;
      }
      input.qty {
        width: 90px;
      }
    `,
  ],
})
export class ItemDetailComponent implements OnInit {
  private readonly api = inject(ApiService);

  @Input({ required: true }) row!: StockRow;
  @Input() isCompanyAdmin = false;
  @Input() storeName = '';
  @Input() locations: StoreLocation[] = [];
  @Output() close = new EventEmitter<void>();
  @Output() changed = new EventEmitter<void>();

  readonly history = signal<Transaction[]>([]);
  readonly audit = signal<ItemAudit[]>([]);
  readonly historyLoading = signal(false);

  readonly mgmt = signal<Mgmt>(null);
  readonly reorderOpen = signal(false);
  readonly saving = signal(false);
  readonly mgmtError = signal<string | null>(null);

  targetLocationId: number | null = null;
  qty: number | null = null;
  expirationDate = '';
  weightLbs: number | string = '';

  ngOnInit(): void {
    this.loadHistory();
    if (this.row.rowKind === 'unit' && this.row.itemId) this.loadAudit();
    this.expirationDate = this.row.expirationDate ?? '';
    this.weightLbs = this.row.weightLbs ?? '';
  }

  private loadAudit(): void {
    if (!this.row.itemId) return;
    this.api.itemAudit(this.row.itemId).subscribe({
      next: (rows) => this.audit.set(rows),
      error: () => this.audit.set([]),
    });
  }

  auditSourceLabel(source: string): string {
    switch (source) {
      case 'BULK_EDIT':
        return 'bulk edit';
      case 'SINGLE_EDIT':
        return 'manual edit';
      case 'SYNC':
        return 'sync';
      default:
        return source;
    }
  }

  private loadHistory(): void {
    this.historyLoading.set(true);
    const opts =
      this.row.rowKind === 'unit'
        ? { itemId: this.row.itemId ?? undefined, limit: 50 }
        : {
            productId: this.row.productId,
            storeId: this.row.storeId,
            locationId: this.row.locationId,
            limit: 50,
          };
    this.api.listTransactions(opts).subscribe({
      next: (res) => {
        this.history.set(res.data);
        this.historyLoading.set(false);
      },
      error: () => this.historyLoading.set(false),
    });
  }

  open(m: Mgmt): void {
    this.mgmtError.set(null);
    this.targetLocationId = null;
    this.qty = this.row.rowKind === 'stock' ? this.row.onHand : null;
    this.expirationDate = this.row.expirationDate ?? '';
    this.weightLbs = this.row.weightLbs ?? '';
    this.mgmt.set(m);
  }

  /**
   * A raised or cancelled reorder changes the row's badge, so the grid behind has to
   * reload — but this popup closes with it, because `row` is an immutable snapshot and
   * leaving it open would keep showing the stale badge.
   */
  onReorderClosed(changed: boolean): void {
    this.reorderOpen.set(false);
    if (changed) {
      this.changed.emit();
      this.close.emit();
    }
  }

  private done(): void {
    this.saving.set(false);
    this.changed.emit();
    this.close.emit();
  }

  private fail(err: unknown): void {
    this.saving.set(false);
    this.mgmtError.set(messageFor(err));
  }

  markSold(): void {
    if (!this.row.itemId) return;
    this.saving.set(true);
    this.api.sellInventory({ itemId: this.row.itemId }).subscribe({
      next: () => this.done(),
      error: (e) => this.fail(e),
    });
  }

  doMove(): void {
    if (this.targetLocationId == null) {
      this.mgmtError.set('Choose a destination location.');
      return;
    }
    if (this.targetLocationId === this.row.locationId) {
      this.mgmtError.set('Choose a different location.');
      return;
    }
    this.saving.set(true);
    if (this.row.rowKind === 'unit') {
      this.api
        .moveInventory({ itemIds: [this.row.itemId!], toLocationId: this.targetLocationId })
        .subscribe({ next: () => this.done(), error: (e) => this.fail(e) });
    } else {
      const n = Number(this.qty);
      if (!Number.isFinite(n) || n <= 0 || n > this.row.onHand) {
        this.mgmtError.set(`Enter a quantity between 1 and ${this.row.onHand}.`);
        this.saving.set(false);
        return;
      }
      this.api
        .moveInventory({
          productId: this.row.productId,
          fromLocationId: this.row.locationId,
          toLocationId: this.targetLocationId,
          quantity: n,
        })
        .subscribe({ next: () => this.done(), error: (e) => this.fail(e) });
    }
  }

  /** This unit's weight, or an em dash. Quantity rows never reach here. */
  weightLabel(): string {
    if (this.row.weightLbs == null) return '—';
    const n = Number(this.row.weightLbs);
    return Number.isFinite(n) ? `${Number(n.toFixed(3))} lbs` : this.row.weightLbs;
  }

  /**
   * Which field an audit row is about. Weight joined expiration as an ERP-synced fact a
   * human may override, so the history can no longer assume every row is an expiration.
   */
  auditFieldLabel(field: string): string {
    if (field === 'weight_lbs') return 'Weight';
    if (field === 'expiration_date') return 'Expiration';
    return field;
  }

  saveWeight(): void {
    if (!this.row.itemId) return;
    const raw = String(this.weightLbs).trim();
    if (raw === '') {
      this.mgmtError.set('Enter a weight, or use Clear to remove it.');
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      this.mgmtError.set('Enter a number of pounds.');
      return;
    }
    this.saving.set(true);
    this.api
      .updateItem(this.row.itemId, { weightLbs: n })
      .subscribe({ next: () => this.done(), error: (e) => this.fail(e) });
  }

  /** Back to "not weighed" — null, not zero. */
  clearWeight(): void {
    if (!this.row.itemId) return;
    this.saving.set(true);
    this.api
      .updateItem(this.row.itemId, { weightLbs: null })
      .subscribe({ next: () => this.done(), error: (e) => this.fail(e) });
  }

  saveExpiration(): void {
    if (!this.row.itemId) return;
    this.saving.set(true);
    this.api
      .updateItem(this.row.itemId, { expirationDate: this.expirationDate.trim() || null })
      .subscribe({ next: () => this.done(), error: (e) => this.fail(e) });
  }

  clearExpiration(): void {
    if (!this.row.itemId) return;
    this.saving.set(true);
    this.api
      .updateItem(this.row.itemId, { expirationDate: null })
      .subscribe({ next: () => this.done(), error: (e) => this.fail(e) });
  }

  saveQuantity(): void {
    const n = Number(this.qty);
    if (!Number.isFinite(n) || n < 0) {
      this.mgmtError.set('Enter a non-negative quantity.');
      return;
    }
    this.saving.set(true);
    this.api
      .setQuantity({
        productId: this.row.productId,
        locationId: this.row.locationId,
        storeId: this.row.storeId,
        quantity: n,
      })
      .subscribe({ next: () => this.done(), error: (e) => this.fail(e) });
  }

  movement(t: Transaction): string {
    const name = (id: number | null) =>
      id == null ? null : (this.locations.find((l) => l.id === id)?.name ?? `#${id}`);
    const from = name(t.locationFromId);
    const to = name(t.locationToId);
    if (from && to) return `${from} → ${to}`;
    if (to) return `→ ${to}`;
    if (from) return `${from} →`;
    return '—';
  }

  statusLabel(status: string | null): string {
    switch (status) {
      case 'ON_HAND':
        return 'On hand';
      case 'SOLD':
        return 'Sold';
      case 'RETURNED_TO_WAREHOUSE':
        return 'Returned';
      case 'ADJUSTED_OUT':
        return 'Adjusted out';
      default:
        return '—';
    }
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
}
