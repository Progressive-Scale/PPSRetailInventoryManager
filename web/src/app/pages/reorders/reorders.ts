import { DatePipe } from '@angular/common';
import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, ParamMap } from '@angular/router';
import { skip } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { messageFor } from '../../core/http-error';
import { Reorder, ReorderStatus, Store } from '../../core/models';
import { ReorderNewDialogComponent } from './reorder-new-dialog';

type StatusFilter = ReorderStatus | 'ALL';

const STATUS_FILTERS: StatusFilter[] = ['OPEN', 'ACKNOWLEDGED', 'CANCELLED', 'ALL'];

/**
 * The reorder queue: what the shops asked for and what happened to each request.
 *
 * Visible to store users as well as admins — the person who raised a request is the
 * one who wants to know whether it turned into an order — and scoped to their own
 * store by the API rather than by anything here.
 */
@Component({
  selector: 'app-reorders',
  imports: [DatePipe, FormsModule, ReorderNewDialogComponent],
  template: `
    <main class="container">
      <section class="card">
        <h2>Reorders</h2>

        <div class="filters">
          <label class="f">
            Status
            <select name="ro-status" [ngModel]="statusFilter()" (ngModelChange)="setStatus($event)">
              <option value="OPEN">Open</option>
              <option value="ACKNOWLEDGED">Acknowledged</option>
              <option value="CANCELLED">Cancelled</option>
              <option value="ALL">All</option>
            </select>
          </label>
          @if (isCompanyAdmin) {
            <label class="f">
              Store
              <select name="ro-store" [ngModel]="storeFilter()" (ngModelChange)="setStore($event)">
                <option [ngValue]="null">All</option>
                @for (s of stores(); track s.id) {
                  <option [ngValue]="s.id">{{ s.name }}</option>
                }
              </select>
            </label>
          }
          <div class="f-actions">
            <button type="button" class="ghost" (click)="clear()">Clear</button>
            <button type="button" class="ghost" (click)="load()" [disabled]="loading()">
              Refresh
            </button>
          </div>
          <!-- Right-aligned: raising a reorder is the page's action, not a filter. -->
          <div class="f-actions right">
            <button type="button" (click)="newOpen.set(true)">New reorder</button>
          </div>
        </div>

        @if (error()) {
          <p class="error">{{ error() }}</p>
        }

        @if (loading()) {
          <p class="muted">Loading…</p>
        } @else if (rows().length === 0) {
          <p class="muted">Nothing here. Reorders are raised from Products or Inventory.</p>
        } @else {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  @if (isCompanyAdmin) {
                    <th>Store</th>
                  }
                  <th class="num">Qty</th>
                  <th>Requested</th>
                  <th>By</th>
                  <th>Status</th>
                  <th>Order</th>
                  <th class="actions"></th>
                </tr>
              </thead>
              <tbody>
                @for (r of rows(); track r.id) {
                  <tr>
                    <td>
                      {{ r.productName }}
                      <span class="sku">{{ r.sku }}</span>
                      @if (r.note) {
                        <span class="note" [title]="r.note">“{{ r.note }}”</span>
                      }
                    </td>
                    @if (isCompanyAdmin) {
                      <td class="muted">{{ r.storeName }}</td>
                    }
                    <td class="num">{{ r.quantityRequested ?? '—' }}</td>
                    <td class="muted">{{ r.createdAt | date: 'short' }}</td>
                    <td class="muted">{{ r.requestedBy || '—' }}</td>
                    <td>
                      <span class="badge" [class]="'st-' + r.status">{{ label(r.status) }}</span>
                      @if (r.status === 'ACKNOWLEDGED' && r.acknowledgedAt) {
                        <span class="when">{{ r.acknowledgedAt | date: 'short' }}</span>
                      }
                      @if (r.status === 'CANCELLED' && r.cancelledAt) {
                        <span class="when">{{ r.cancelledAt | date: 'short' }}</span>
                      }
                    </td>
                    <td>
                      @if (r.externalOrderRef) {
                        <span class="ref">PPS order #{{ r.externalOrderRef }}</span>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="actions">
                      @if (r.status === 'OPEN') {
                        <button class="sm danger" (click)="cancel(r)" [disabled]="busyId() === r.id">
                          Cancel
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>

          <div class="pager">
            <button class="ghost" (click)="prev()" [disabled]="offset() === 0 || loading()">
              Prev
            </button>
            <span class="muted">{{ rangeLabel() }}</span>
            <button class="ghost" (click)="next()" [disabled]="!hasNext() || loading()">Next</button>
          </div>
        }
      </section>

      @if (newOpen()) {
        <app-reorder-new-dialog (close)="onNewClosed($event)" />
      }
    </main>
  `,
  styles: [
    `
      .container {
        max-width: 1100px;
        margin: 0 auto;
        padding: 1rem;
      }
      .card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 1rem 1.25rem;
      }
      h2 {
        margin: 0 0 1rem;
      }
      .filters {
        display: flex;
        align-items: flex-end;
        gap: 0.75rem;
        flex-wrap: wrap;
        margin: 0 0 1rem;
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
      /* Keeps New reorder on the right however many filters precede it. */
      .f-actions.right {
        margin-left: auto;
      }
      .filters select,
      .filters .f-actions button {
        height: 2.25rem;
        box-sizing: border-box;
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
        padding: 0.45rem 0.5rem;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      th {
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted);
      }
      .num {
        text-align: right;
      }
      td.actions,
      th.actions {
        text-align: right;
      }
      .muted {
        color: var(--muted);
      }
      .error {
        color: #b42318;
        font-size: 0.85rem;
      }
      .sku,
      .note,
      .when {
        display: block;
        font-size: 0.75rem;
        color: var(--muted);
      }
      .note {
        font-style: italic;
        max-width: 22rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ref {
        font-variant-numeric: tabular-nums;
        font-size: 0.85rem;
      }
      .badge {
        display: inline-block;
        padding: 0.05rem 0.4rem;
        border-radius: 999px;
        font-size: 0.72rem;
        font-weight: 600;
        border: 1px solid var(--border);
      }
      .st-OPEN {
        background: #fff7ed;
        color: #9a3412;
        border-color: #fed7aa;
      }
      .st-ACKNOWLEDGED {
        background: #ecfdf5;
        color: #065f46;
        border-color: #a7f3d0;
      }
      .st-CANCELLED {
        background: var(--surface);
        color: var(--muted);
      }
      button.sm {
        font-size: 0.78rem;
        padding: 0.15rem 0.5rem;
      }
      button.danger {
        border-color: #f0a9a3;
        color: #b42318;
      }
      .pager {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.75rem;
        margin-top: 0.75rem;
        font-size: 0.85rem;
      }
    `,
  ],
})
export class ReordersComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly isCompanyAdmin = this.auth.user()?.role === 'COMPANY_ADMIN';
  readonly stores = signal<Store[]>([]);
  readonly rows = signal<Reorder[]>([]);
  readonly total = signal(0);
  readonly offset = signal(0);
  readonly limit = 50;
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly busyId = signal<number | null>(null);
  readonly newOpen = signal(false);

  readonly statusFilter = signal<StatusFilter>('OPEN');
  readonly storeFilter = signal<number | null>(null);

  readonly hasNext = computed(() => this.offset() + this.rows().length < this.total());
  readonly rangeLabel = computed(() => {
    const start = this.total() === 0 ? 0 : this.offset() + 1;
    return `${start}–${this.offset() + this.rows().length} of ${this.total()}`;
  });

  ngOnInit(): void {
    if (this.isCompanyAdmin) {
      this.api.listStores().subscribe({ next: (rows) => this.stores.set(rows) });
    }
    // ngOnInit does NOT re-run when only the query string changes, so a second click
    // on a notification while already here would otherwise do nothing visible.
    this.applyDeepLink(this.route.snapshot.queryParamMap);
    this.route.queryParamMap
      .pipe(skip(1), takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        if (this.applyDeepLink(params)) this.load();
      });
    this.load();
  }

  /** `?status=` / `?storeId=` from a notification click-through. */
  private applyDeepLink(params: ParamMap): boolean {
    let changed = false;
    const status = params.get('status');
    if (status && STATUS_FILTERS.includes(status as StatusFilter)) {
      if (this.statusFilter() !== status) changed = true;
      this.statusFilter.set(status as StatusFilter);
    }
    const store = params.get('storeId');
    if (store) {
      const id = Number(store);
      if (Number.isFinite(id) && this.storeFilter() !== id) {
        this.storeFilter.set(id);
        changed = true;
      }
    }
    if (changed) this.offset.set(0);
    return changed;
  }

  setStatus(value: StatusFilter): void {
    this.statusFilter.set(value);
    this.offset.set(0);
    this.load();
  }

  setStore(value: number | null): void {
    this.storeFilter.set(value);
    this.offset.set(0);
    this.load();
  }

  clear(): void {
    this.statusFilter.set('OPEN');
    this.storeFilter.set(null);
    this.offset.set(0);
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    const status = this.statusFilter();
    this.api
      .listReorders({
        status: status === 'ALL' ? undefined : status,
        storeId: this.storeFilter() ?? undefined,
        limit: this.limit,
        offset: this.offset(),
      })
      .subscribe({
        next: (page) => {
          this.rows.set(page.data);
          this.total.set(page.total);
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(messageFor(err));
          this.loading.set(false);
        },
      });
  }

  onNewClosed(changed: boolean): void {
    this.newOpen.set(false);
    if (!changed) return;
    // A new request is OPEN, so show that filter — otherwise someone looking at
    // Acknowledged raises one and sees nothing happen.
    if (this.statusFilter() !== 'OPEN' && this.statusFilter() !== 'ALL') {
      this.statusFilter.set('OPEN');
      this.offset.set(0);
    }
    this.load();
  }

  cancel(row: Reorder): void {
    this.busyId.set(row.id);
    this.error.set(null);
    this.api.cancelReorder(row.id).subscribe({
      next: () => {
        this.busyId.set(null);
        this.load();
      },
      error: (err) => {
        this.busyId.set(null);
        this.error.set(messageFor(err));
      },
    });
  }

  prev(): void {
    this.offset.set(Math.max(0, this.offset() - this.limit));
    this.load();
  }

  next(): void {
    if (!this.hasNext()) return;
    this.offset.set(this.offset() + this.limit);
    this.load();
  }

  label(status: ReorderStatus): string {
    switch (status) {
      case 'OPEN':
        return 'Open';
      case 'ACKNOWLEDGED':
        return 'Acknowledged';
      case 'CANCELLED':
        return 'Cancelled';
    }
  }
}
