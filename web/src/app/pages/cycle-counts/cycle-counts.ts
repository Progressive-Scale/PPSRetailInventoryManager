import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { messageFor } from '../../core/http-error';
import {
  CycleCount,
  CycleCountDetail,
  CycleCountLine,
  CycleCountResolution,
  CycleCountStatus,
  Store,
} from '../../core/models';

interface ResolutionGroup {
  key: CycleCountResolution;
  label: string;
  items: string[];
  prominent: boolean;
}

@Component({
  selector: 'app-cycle-counts',
  imports: [DatePipe, FormsModule],
  template: `
    <main class="container">
      <section class="card">
        <h2>Cycle counts</h2>

        <div class="filters">
          <label class="f">
            Status
            <select
              name="cc-status"
              [ngModel]="statusFilter()"
              (ngModelChange)="setStatusFilter($event)"
            >
              <option [ngValue]="null">All</option>
              <option [ngValue]="'OPEN'">Open</option>
              <option [ngValue]="'CLOSED'">Closed</option>
              <option [ngValue]="'CANCELLED'">Cancelled</option>
            </select>
          </label>
          @if (isCompanyAdmin) {
            <label class="f">
              Store
              <select
                name="cc-store"
                [ngModel]="storeFilter()"
                (ngModelChange)="setStoreFilter($event)"
              >
                <option [ngValue]="null">All</option>
                @for (s of stores(); track s.id) {
                  <option [ngValue]="s.id">{{ s.name }}</option>
                }
              </select>
            </label>
          }
          <div class="f-actions">
            <button type="button" class="ghost" (click)="clearFilters()" [disabled]="!filtersActive()">
              Clear
            </button>
            <button type="button" class="ghost" (click)="reload()" [disabled]="loading()">
              Refresh
            </button>
          </div>
        </div>

        @if (loading()) {
          <p class="muted">Loading…</p>
        } @else if (listError()) {
          <p class="error">{{ listError() }}</p>
        } @else if (counts().length === 0) {
          <p class="muted">No cycle counts yet.</p>
        } @else {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Status</th>
                  <th>Opened</th>
                  <th class="num">Expected</th>
                  <th class="num">Scanned</th>
                  <th class="num">Sold</th>
                </tr>
              </thead>
              <tbody>
                @for (c of counts(); track c.id) {
                  <tr
                    class="clickable"
                    [class.selected]="selectedId() === c.id"
                    (click)="select(c)"
                  >
                    <td>{{ c.id }}</td>
                    <td>
                      <span class="status" [class]="'st-' + c.status">{{ statusLabel(c.status) }}</span>
                    </td>
                    <td class="muted">{{ c.openedAt | date: 'short' }}</td>
                    <td class="num">{{ c.expectedCount }}</td>
                    <td class="num">{{ c.scannedCount }}</td>
                    <td class="num">{{ c.soldGeneratedCount }}</td>
                  </tr>
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

      @if (selectedId() !== null) {
        <section class="card">
          <div class="row-between">
            <h2>Count #{{ selectedId() }}</h2>
            <button class="ghost" (click)="closeDetail()">Close</button>
          </div>

          @if (detailLoading()) {
            <p class="muted">Loading detail…</p>
          } @else if (detailError()) {
            <p class="error">{{ detailError() }}</p>
          } @else if (detail(); as d) {
            <div class="tallies">
              <div class="tally">
                <span class="tally-num">{{ d.cycleCount.expectedCount }}</span>
                <span class="tally-label">Expected</span>
              </div>
              <div class="tally">
                <span class="tally-num">{{ d.cycleCount.scannedCount }}</span>
                <span class="tally-label">Scanned</span>
              </div>
              <div class="tally warn">
                <span class="tally-num">{{ d.cycleCount.soldGeneratedCount }}</span>
                <span class="tally-label">Marked sold</span>
              </div>
            </div>

            @for (g of groups(); track g.key) {
              <div class="group" [class.prominent]="g.prominent">
                <h3>
                  {{ g.label }}
                  <span class="count-pill" [class.warn]="g.prominent">{{ g.items.length }}</span>
                </h3>
                @if (g.items.length === 0) {
                  <p class="muted sm">None.</p>
                } @else {
                  <ul class="serials">
                    @for (s of g.items; track $index) {
                      <li>{{ s }}</li>
                    }
                  </ul>
                }
              </div>
            }

            @if (d.notCounted.length > 0) {
              <div class="group not-counted">
                <h3>
                  Not counted
                  <span class="count-pill warn">{{ d.notCounted.length }}</span>
                </h3>
                <p class="muted sm">
                  These quantity products weren't counted during this cycle.
                </p>
                <ul class="serials">
                  @for (n of d.notCounted; track n.productId) {
                    <li>{{ n.sku }} {{ n.name }} — {{ n.quantityOnHand }} on hand</li>
                  }
                </ul>
              </div>
            }
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
      h3 {
        margin: 0 0 0.5rem;
        font-size: 0.9rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
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
      /* Keeps Clear/Refresh level with the inputs beside them. */
      .filters select,
      .filters .f-actions button {
        height: 2.25rem;
        box-sizing: border-box;
      }
      .filters select {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
        font-family: inherit;
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
      tr.clickable {
        cursor: pointer;
      }
      tr.clickable:hover td {
        background: var(--bg);
      }
      tr.selected td {
        background: var(--accent-soft);
      }
      .status {
        font-size: 0.78rem;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--brand, var(--accent));
      }
      .status.st-OPEN {
        background: #eff4ff;
        color: #1d4ed8;
      }
      .status.st-CLOSED {
        background: #ecfdf3;
        color: #067647;
      }
      .status.st-CANCELLED {
        background: #f2f4f7;
        color: #667085;
      }
      .muted {
        color: var(--muted);
      }
      .sm {
        font-size: 0.82rem;
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
      .tallies {
        display: flex;
        gap: 1rem;
        flex-wrap: wrap;
        margin-bottom: 1.25rem;
      }
      .tally {
        flex: 1 1 120px;
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 0.75rem 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
      }
      .tally-num {
        font-size: 1.4rem;
        font-weight: 700;
      }
      .tally-label {
        font-size: 0.78rem;
        color: var(--muted);
      }
      .tally.warn {
        background: #fffaeb;
        border-color: #fedf89;
      }
      .tally.warn .tally-num {
        color: #b54708;
      }
      .group {
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 0.85rem 1rem;
        margin-bottom: 0.85rem;
      }
      .group.prominent {
        background: #fef3f2;
        border-color: #fecdca;
      }
      .group.prominent h3 {
        color: #b42318;
      }
      .group.not-counted {
        background: #fffaeb;
        border-color: #fedf89;
      }
      .group.not-counted h3 {
        color: #b54708;
      }
      .count-pill {
        font-size: 0.72rem;
        font-weight: 600;
        padding: 0.05rem 0.45rem;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--brand, var(--accent));
      }
      .count-pill.warn {
        background: #fee4e2;
        color: #b42318;
      }
      .serials {
        margin: 0;
        padding-left: 1.1rem;
        display: flex;
        flex-wrap: wrap;
        gap: 0.15rem 1.5rem;
        font-size: 0.85rem;
        font-family: ui-monospace, monospace;
      }
      .serials li {
        min-width: 120px;
      }
    `,
  ],
})
export class CycleCountsComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  private static readonly ORDER: { key: CycleCountResolution; label: string }[] = [
    { key: 'SCANNED', label: 'Scanned' },
    { key: 'COUNTED_BY_UPC', label: 'Counted by UPC' },
    { key: 'MARKED_SOLD', label: 'Marked sold' },
    { key: 'NEW_ITEM', label: 'New item' },
  ];

  readonly isCompanyAdmin = this.auth.user()?.role === 'COMPANY_ADMIN';
  readonly stores = signal<Store[]>([]);

  // Filtered server-side: the list is paginated, so narrowing the loaded page
  // would leave the total and the pager describing a different set.
  readonly statusFilter = signal<CycleCountStatus | null>(null);
  readonly storeFilter = signal<number | null>(null);
  readonly filtersActive = computed(
    () => this.statusFilter() !== null || this.storeFilter() !== null,
  );

  readonly counts = signal<CycleCount[]>([]);
  readonly total = signal(0);
  readonly limit = signal(20);
  readonly offset = signal(0);
  readonly loading = signal(false);
  readonly listError = signal<string | null>(null);

  readonly selectedId = signal<number | null>(null);
  readonly detail = signal<CycleCountDetail | null>(null);
  readonly detailLoading = signal(false);
  readonly detailError = signal<string | null>(null);

  readonly hasNext = computed(() => this.offset() + this.counts().length < this.total());
  readonly rangeLabel = computed(() => {
    const start = this.total() === 0 ? 0 : this.offset() + 1;
    const end = this.offset() + this.counts().length;
    return `${start}–${end} of ${this.total()}`;
  });

  readonly groups = computed<ResolutionGroup[]>(() => {
    const d = this.detail();
    if (!d) return [];
    return CycleCountsComponent.ORDER.map(({ key, label }) => ({
      key,
      label,
      items: (d.linesByResolution?.[key] ?? []).map((l) => this.formatLine(l)),
      prominent: key === 'MARKED_SOLD',
    }));
  });

  private formatLine(line: CycleCountLine): string {
    if (line.resolution === 'COUNTED_BY_UPC') {
      // Quantity products counted by scanning the UPC.
      return `${line.sku} ${line.name} — counted ${line.quantity ?? 0}`;
    }
    if (line.resolution === 'NEW_ITEM' && line.serial == null && line.quantity != null) {
      // Quantity product newly seen this cycle.
      return `${line.sku} — +${line.quantity}`;
    }
    // Serialized lines (SCANNED / MARKED_SOLD / serialized NEW_ITEM).
    if (line.serial) return `${line.serial} — ${line.sku}`;
    return `${line.sku} ${line.name}`.trim();
  }

  ngOnInit(): void {
    if (this.isCompanyAdmin) {
      this.api.listStores().subscribe({ next: (rows) => this.stores.set(rows) });
    }
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.listError.set(null);
    this.api
      .listCycleCounts({
        limit: this.limit(),
        offset: this.offset(),
        status: this.statusFilter() ?? undefined,
        storeId: this.storeFilter() ?? undefined,
      })
      .subscribe({
        next: (res) => {
          this.counts.set(res.data);
          this.total.set(res.total);
          this.loading.set(false);
        },
        error: (err) => {
          this.loading.set(false);
          this.listError.set(messageFor(err));
        },
      });
  }

  setStatusFilter(status: CycleCountStatus | null): void {
    this.statusFilter.set(status);
    this.refilter();
  }

  setStoreFilter(storeId: number | null): void {
    this.storeFilter.set(storeId);
    this.refilter();
  }

  clearFilters(): void {
    this.statusFilter.set(null);
    this.storeFilter.set(null);
    this.refilter();
  }

  /**
   * Any filter change restarts at page one — the open detail is closed because
   * the count it describes may no longer be in the narrowed list.
   */
  private refilter(): void {
    this.offset.set(0);
    this.closeDetail();
    this.reload();
  }

  select(c: CycleCount): void {
    this.selectedId.set(c.id);
    this.detail.set(null);
    this.detailError.set(null);
    this.detailLoading.set(true);
    this.api.getCycleCount(c.id).subscribe({
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

  closeDetail(): void {
    this.selectedId.set(null);
    this.detail.set(null);
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

  statusLabel(status: CycleCountStatus): string {
    switch (status) {
      case 'OPEN':
        return 'Open';
      case 'CLOSED':
        return 'Closed';
      case 'CANCELLED':
        return 'Cancelled';
    }
  }
}
