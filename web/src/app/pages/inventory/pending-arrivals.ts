import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { messageFor } from '../../core/http-error';
import { ExpiringItem, Store } from '../../core/models';

/** The API caps a page at this. */
const PAGE_SIZE = 200;

/**
 * Units the ERP has shipped but nobody has physically scanned in yet.
 *
 * These are deliberately NOT stock: they have no location, they contribute nothing
 * to on-hand, they cannot be sold or moved, and they raise no expiration alerts.
 * This screen exists so "shipped but never arrived" is visible rather than silent —
 * a unit sitting here for weeks is a question for the warehouse, not inventory
 * shrink, which is exactly why a count never infers it sold.
 */
@Component({
  selector: 'app-pending-arrivals',
  imports: [FormsModule, DatePipe],
  template: `
    <section class="card">
      <div class="section-head">
        <h2>Pending arrival</h2>
        <span class="muted small">{{ filtered().length }} of {{ rows().length }}</span>
      </div>
      <p class="muted small intro">
        Shipped by the ERP, not yet received. A unit becomes stock when it is scanned
        during a cycle count — until then it has no location and cannot be sold or
        moved. Unscanned units stay here rather than being counted as sold.
      </p>

      <div class="filters">
        <label class="f">
          Search
          <input
            name="pa-search"
            placeholder="Serial, SKU, product"
            [ngModel]="search()"
            (ngModelChange)="search.set($event)"
          />
        </label>
        @if (isCompanyAdmin) {
          <label class="f">
            Store
            <select name="pa-store" [ngModel]="storeFilter()" (ngModelChange)="setStore($event)">
              <option [ngValue]="null">All</option>
              @for (s of stores(); track s.id) {
                <option [ngValue]="s.id">{{ s.name }}</option>
              }
            </select>
          </label>
        }
        <label class="f">
          Waiting
          <select name="pa-age" [ngModel]="minDays()" (ngModelChange)="minDays.set($event)">
            <option [ngValue]="0">Any</option>
            <option [ngValue]="3">3+ days</option>
            <option [ngValue]="7">7+ days</option>
            <option [ngValue]="30">30+ days</option>
          </select>
        </label>
        <div class="f-actions">
          <button type="button" class="ghost" (click)="clearFilters()" [disabled]="!filtersActive()">
            Clear
          </button>
          <button type="button" class="ghost" (click)="reload()" [disabled]="loading()">
            Refresh
          </button>
        </div>
      </div>

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else if (rows().length === 0) {
        <p class="muted">Nothing awaiting receipt. Everything shipped has been scanned in.</p>
      } @else if (filtered().length === 0) {
        <p class="muted">No pending units match these filters.</p>
      } @else {
        @if (total() > rows().length) {
          <p class="muted small">
            Showing the {{ rows().length }} oldest of {{ total() }}.
          </p>
        }
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th class="col-serial">Serial</th>
                <th class="col-sku">SKU</th>
                <th class="col-name">Product</th>
                <th class="col-store">Store</th>
                <th class="col-when">Handed off</th>
                <th class="col-days num">Waiting</th>
                @if (isCompanyAdmin) {
                  <th class="col-act actions"></th>
                }
              </tr>
            </thead>
            <tbody>
              @for (r of filtered(); track r.id) {
                <tr [class.stale]="(r.daysPending ?? 0) >= 7">
                  <td class="mono">{{ r.serial }}</td>
                  <td>{{ r.sku ?? '—' }}</td>
                  <td class="ctext" [title]="r.name ?? ''">{{ r.name ?? '—' }}</td>
                  <td class="muted">{{ storeName(r.storeId) }}</td>
                  <td class="muted">{{ r.createdAt | date: 'mediumDate' }}</td>
                  <td class="num" [class.warn]="(r.daysPending ?? 0) >= 7">
                    {{ dayLabel(r.daysPending) }}
                  </td>
                  @if (isCompanyAdmin) {
                    <td class="actions">
                      <button class="sm ghost" (click)="askLost(r)">Mark lost</button>
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>

    <!-- Marking something lost is a write-off, not a filter change, so it gets a
         confirmation and a place to say why. -->
    @if (losing(); as target) {
      <div class="overlay" (click)="cancelLost()">
        <div class="modal" (click)="$event.stopPropagation()">
          <h3>Mark {{ target.serial }} as lost?</h3>
          <p class="muted sm">
            {{ target.name ?? 'This unit' }} was handed over
            {{ dayLabel(target.daysPending) }} ago and never arrived. Marking it lost
            takes it off this list for good. It never became stock, so nothing is
            removed from on-hand — but the write-off is recorded against the unit.
          </p>
          <label class="field">
            Why (optional)
            <input
              name="lost-note"
              placeholder="e.g. never left the warehouse"
              [ngModel]="lostNote()"
              (ngModelChange)="lostNote.set($event)"
            />
          </label>
          @if (lostError()) {
            <p class="error">{{ lostError() }}</p>
          }
          <div class="modal-actions">
            <button class="ghost" (click)="cancelLost()" [disabled]="lostBusy()">
              Keep waiting
            </button>
            <button class="danger" (click)="confirmLost()" [disabled]="lostBusy()">
              {{ lostBusy() ? 'Marking…' : 'Mark lost' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .card {
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--surface);
        padding: 1.25rem;
      }
      .section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
      }
      .section-head h2 {
        margin: 0;
        font-size: 1.05rem;
      }
      .intro {
        margin: 0.35rem 0 0;
        max-width: 62ch;
        line-height: 1.45;
      }
      .small {
        font-size: 0.8rem;
      }
      .muted {
        color: var(--muted);
      }
      .error {
        color: #b42318;
        font-size: 0.85rem;
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
      /* Keeps Clear/Refresh level with the inputs beside them. */
      .filters input,
      .filters select,
      .filters .f-actions button {
        height: 2.25rem;
        box-sizing: border-box;
      }
      .filters input,
      .filters select {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
        font-family: inherit;
      }
      .filters input {
        min-width: 200px;
      }
      .filters .f-actions button {
        padding: 0 0.75rem;
        font-size: 0.85rem;
        font-family: inherit;
        border-radius: 8px;
      }
      .table-scroll {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.9rem;
        table-layout: fixed;
      }
      th,
      td {
        text-align: left;
        padding: 0.5rem 0.6rem;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      /* Widths sum to 100% — a column with none collapses under fixed layout.
         The actions column is admin-only; without it the rest simply share the
         freed space proportionally, which is what fixed layout does anyway. */
      .col-serial {
        width: 20%;
      }
      .col-sku {
        width: 14%;
      }
      .col-name {
        width: 22%;
      }
      .col-store {
        width: 12%;
      }
      .col-when {
        width: 12%;
      }
      .col-days {
        width: 8%;
      }
      .col-act {
        width: 12%;
      }
      th.num,
      td.num {
        text-align: right;
      }
      td.actions {
        text-align: right;
        white-space: nowrap;
      }
      td.actions button {
        font-family: inherit;
        cursor: pointer;
      }
      button.sm {
        padding: 0.25rem 0.55rem;
        font-size: 0.8rem;
        border-radius: 6px;
      }
      button.ghost {
        background: transparent;
        border: 1px solid var(--border);
        color: var(--muted);
      }
      button.ghost:hover:not(:disabled) {
        color: #1f2937;
        border-color: #cbd5e1;
      }
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 50;
      }
      .modal {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 1.25rem;
        width: min(32rem, calc(100vw - 2rem));
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
      }
      .modal h3 {
        margin: 0;
        font-size: 1rem;
      }
      .modal .sm {
        font-size: 0.85rem;
        line-height: 1.5;
        margin: 0;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.8rem;
        color: var(--muted);
      }
      .field input {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
        font-family: inherit;
      }
      .modal-actions {
        display: flex;
        gap: 0.5rem;
        justify-content: flex-end;
        margin-top: 0.25rem;
      }
      .modal-actions button {
        padding: 0.45rem 0.9rem;
        border-radius: 8px;
        font-family: inherit;
        font-size: 0.9rem;
        cursor: pointer;
      }
      .modal-actions .danger {
        background: #b42318;
        border: 1px solid #b42318;
        color: #fff;
      }
      .modal-actions .danger:disabled {
        opacity: 0.6;
      }
      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.85rem;
      }
      .ctext {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* A week is long enough that somebody should be asking the warehouse. */
      tr.stale td {
        background: #fffbeb;
      }
      td.warn {
        color: #92400e;
        font-weight: 600;
      }
    `,
  ],
})
export class PendingArrivalsComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  readonly isCompanyAdmin = this.auth.user()?.role === 'COMPANY_ADMIN';

  readonly rows = signal<ExpiringItem[]>([]);
  readonly total = signal(0);
  readonly stores = signal<Store[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly search = signal('');
  readonly storeFilter = signal<number | null>(null);
  readonly minDays = signal(0);

  readonly losing = signal<ExpiringItem | null>(null);
  readonly lostNote = signal('');
  readonly lostBusy = signal(false);
  readonly lostError = signal<string | null>(null);

  readonly filtersActive = computed(
    () =>
      this.search().trim().length > 0 ||
      this.storeFilter() !== null ||
      this.minDays() > 0,
  );

  readonly filtered = computed(() => {
    const term = this.search().trim().toLowerCase();
    const min = this.minDays();
    return this.rows().filter((r) => {
      if ((r.daysPending ?? 0) < min) return false;
      if (!term) return true;
      return [r.serial, r.sku, r.name]
        .filter((v): v is string => !!v)
        .join(' ')
        .toLowerCase()
        .includes(term);
    });
  });

  ngOnInit(): void {
    if (this.isCompanyAdmin) {
      this.api.listStores().subscribe({ next: (rows) => this.stores.set(rows) });
    }
    this.reload();
  }

  /** The store filter is server-side: it narrows which units are fetched. */
  setStore(storeId: number | null): void {
    this.storeFilter.set(storeId);
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api
      .listItems({
        status: 'PENDING',
        storeId: this.storeFilter() ?? undefined,
        limit: PAGE_SIZE,
        offset: 0,
      })
      .subscribe({
        next: (res) => {
          this.rows.set(res.data);
          this.total.set(res.total);
          this.loading.set(false);
        },
        error: (err) => {
          this.loading.set(false);
          this.error.set(messageFor(err));
        },
      });
  }

  clearFilters(): void {
    this.search.set('');
    this.minDays.set(0);
    if (this.storeFilter() !== null) {
      this.storeFilter.set(null);
      this.reload();
    }
  }

  storeName(id: number): string {
    return this.stores().find((s) => s.id === id)?.name ?? `#${id}`;
  }

  dayLabel(days: number | null): string {
    if (days == null) return '—';
    if (days === 0) return 'today';
    return days === 1 ? '1 day' : `${days} days`;
  }

  // ---- marking a never-arrived unit lost ---------------------------------

  askLost(row: ExpiringItem): void {
    this.losing.set(row);
    this.lostNote.set('');
    this.lostError.set(null);
  }

  cancelLost(): void {
    if (this.lostBusy()) return; // don't drop a request that is in flight
    this.losing.set(null);
    this.lostError.set(null);
  }

  confirmLost(): void {
    const target = this.losing();
    if (!target || this.lostBusy()) return;
    this.lostBusy.set(true);
    this.lostError.set(null);
    this.api.markItemLost(target.id, this.lostNote().trim() || undefined).subscribe({
      next: () => {
        this.lostBusy.set(false);
        this.losing.set(null);
        // The unit is no longer PENDING, so it drops off this list on reload.
        this.reload();
      },
      error: (err) => {
        this.lostBusy.set(false);
        // Reported inside the dialog: it is about the action just attempted, and
        // the dialog stays open so it can be retried or abandoned.
        this.lostError.set(messageFor(err));
      },
    });
  }
}
