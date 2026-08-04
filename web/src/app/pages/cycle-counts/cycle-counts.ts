import { DatePipe } from '@angular/common';
import {
  Component,
  computed,
  HostListener,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { CountNeedsReviewComponent } from './needs-review';
import { messageFor } from '../../core/http-error';
import {
  CycleCount,
  CycleCountDetail,
  CycleCountLine,
  CycleCountResolution,
  CycleCountSortField,
  CycleCountStatus,
  Store,
} from '../../core/models';

/** One rendered line: what it says, plus an optional badge for what kind it is. */
interface GroupItem {
  text: string;
  /** e.g. "New product" — a line that creates stock rather than confirming it. */
  tag?: string;
}

interface ResolutionGroup {
  key: CycleCountResolution;
  label: string;
  items: GroupItem[];
  prominent: boolean;
}

@Component({
  selector: 'app-cycle-counts',
  imports: [DatePipe, FormsModule, CountNeedsReviewComponent],
  template: `
    <main class="container">
      @if (isCompanyAdmin) {
        <div class="tabs">
          <button [class.active]="tab() === 'counts'" (click)="tab.set('counts')">
            Counts
          </button>
          <button [class.active]="tab() === 'review'" (click)="tab.set('review')">
            Review
          </button>
        </div>
      }

      @if (tab() === 'review') {
        <app-count-needs-review />
      } @else {
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
              <option [ngValue]="'AWAITING_REVIEW'">Awaiting review</option>
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
                  @for (col of columns; track col.field) {
                    <th
                      [class.num]="col.num"
                      class="sortable"
                      (click)="sort(col.field)"
                    >
                      {{ col.label }}<span class="arrow">{{ sortIcon(col.field) }}</span>
                    </th>
                  }
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

      <!-- A dialog rather than a panel below the table: the detail is long enough to
           push the row you clicked off screen, so you lost your place in the list
           every time you looked at one. Backdrop click and Escape both dismiss. -->
      @if (selectedId() !== null && tab() === 'counts') {
        <div class="overlay" (click)="closeDetail()">
        <section class="card modal" (click)="$event.stopPropagation()">
          <div class="row-between">
            <h2>Count #{{ selectedId() }}</h2>
            <button class="ghost" (click)="closeDetail()">Close</button>
          </div>

          @if (detailLoading()) {
            <p class="muted">Loading detail…</p>
          } @else if (detailError()) {
            <p class="error">{{ detailError() }}</p>
          } @else if (detail(); as d) {
            <p class="scope">
              <strong>Scope:</strong>
              {{ d.scope.wholeStore ? 'Whole store' : d.scope.locationName }}
              @if (d.scope.productIds.length > 0) {
                <span class="muted">
                  — narrowed to {{ d.scope.productIds.length }} product(s)
                </span>
              }
              <span class="muted">
                · only units in this scope could be swept
              </span>
            </p>

            <div class="tallies">
              <div class="tally">
                <span class="tally-num">{{ d.cycleCount.expectedCount }}</span>
                <span class="tally-label">Expected</span>
              </div>
              <div class="tally">
                <span class="tally-num">{{ d.cycleCount.scannedCount }}</span>
                <span class="tally-label">Accounted for</span>
              </div>
              <div class="tally warn">
                <span class="tally-num">{{ d.destructive.inferredSales }}</span>
                <span class="tally-label">Would be sold</span>
              </div>
              <div class="tally warn">
                <span class="tally-num">{{ d.destructive.zeroedStockLines }}</span>
                <span class="tally-label">Shelves zeroed</span>
              </div>
            </div>

            @if (d.awaitingReview) {
              <!-- The reviewer's whole job is here: what this count REMOVES. It is
                   stated before the routine lines because that is the part nobody can
                   undo for quantity stock. -->
              <div class="review-box">
                <h3>Waiting for your approval — nothing has been applied yet</h3>
                @if (d.destructive.inferredSales + d.destructive.zeroedStockLines > 0) {
                  <p class="destructive">
                    Approving will mark
                    <strong>{{ d.destructive.inferredSales }}</strong>
                    unit(s) sold and set
                    <strong>{{ d.destructive.zeroedStockLines }}</strong>
                    stock line(s) to zero.
                    @if (d.destructive.zeroedStockLines > 0) {
                      Zeroed quantity stock has no per-unit record, so it cannot be
                      reinstated the way a serialized unit can — check those lines
                      before approving.
                    }
                  </p>
                } @else {
                  <p class="muted sm">
                    This count removes nothing: everything in scope was accounted for.
                  </p>
                }
                @if (reviewError()) {
                  <p class="error">{{ reviewError() }}</p>
                }
                @if (isCompanyAdmin) {
                  <div class="review-actions">
                    <button (click)="approve()" [disabled]="reviewBusy()">
                      {{ reviewBusy() ? 'Applying…' : 'Approve & apply' }}
                    </button>
                    <button class="ghost" (click)="reject()" [disabled]="reviewBusy()">
                      Send back for recount
                    </button>
                  </div>
                } @else {
                  <p class="muted sm">
                    A company admin has to approve this. Nothing you counted is lost —
                    it is stored until they do.
                  </p>
                }
              </div>
            }

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
                      <li>
                        {{ s.text }}
                        @if (s.tag) {
                          <span class="line-tag">{{ s.tag }}</span>
                        }
                      </li>
                    }
                  </ul>
                }
              </div>
            }


          }
        </section>
        </div>
      }
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
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: 1.5rem 1rem;
        z-index: 50;
        overflow-y: auto;
      }
      /* Wider than the app's form dialogs because this one holds tables of serials,
         and capped in height so a count with hundreds of lines scrolls inside the
         dialog instead of stretching the page behind it. */
      .modal {
        width: 100%;
        max-width: 820px;
        max-height: calc(100vh - 3rem);
        overflow-y: auto;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
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
      /* Chrome-style tabs, matching Inventory and Manage: inactive tabs sit a
         shade darker than the page and the active tab shares the card's surface,
         so it reads as attached to the form below rather than floating above it. */
      .tabs {
        display: flex;
        gap: 4px;
        padding-left: 6px;
        /* Cancels the container's row gap, then 1px more so the active tab's
           bottom border lands on the card's top border instead of above it. */
        margin-bottom: calc(-1.25rem - 1px);
        position: relative;
        z-index: 2;
      }
      .tabs button {
        background: #e6e9ef;
        border: 1px solid var(--border);
        border-radius: 10px 10px 0 0;
        padding: 0.5rem 1.15rem;
        font-family: inherit;
        font-size: 0.88rem;
        color: var(--muted);
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
      .scope {
        margin: 0 0 0.85rem;
        font-size: 0.88rem;
      }
      .review-box {
        border: 1px solid #fcd34d;
        background: #fffbeb;
        border-radius: 10px;
        padding: 0.9rem 1rem;
        margin: 0 0 1rem;
      }
      .review-box h3 {
        margin: 0 0 0.5rem;
        font-size: 0.95rem;
      }
      .destructive {
        margin: 0 0 0.75rem;
        font-size: 0.88rem;
        line-height: 1.5;
        color: #92400e;
      }
      .review-actions {
        display: flex;
        gap: 0.5rem;
      }
      .review-actions button {
        padding: 0.45rem 0.9rem;
        border-radius: 8px;
        font-family: inherit;
        font-size: 0.9rem;
        cursor: pointer;
      }
      .review-actions button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .st-AWAITING_REVIEW {
        background: #fef3c7;
        color: #92400e;
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
      /* Says what a line will DO, next to the line itself rather than as a heading
         over a separate list. */
      .line-tag {
        font-family: system-ui, sans-serif;
        font-size: 0.7rem;
        font-weight: 600;
        margin-left: 0.4rem;
        padding: 0.05rem 0.4rem;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--brand, var(--accent));
        white-space: nowrap;
      }
    `,
  ],
})
export class CycleCountsComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  private static readonly ORDER: { key: CycleCountResolution; label: string }[] = [
    { key: 'SCANNED', label: 'Scanned' },
    { key: 'MOVED_IN', label: 'Found here (moved in)' },
    { key: 'RECEIVED', label: 'Received (shipped units scanned in)' },
    { key: 'REINSTATED', label: 'Reinstated (found after being sold)' },
    // NEW_ITEM has no group of its own: a code the counter found IS something they
    // counted, so it belongs in Scanned, badged for what it will create. A separate
    // "New / unidentified" list read like a side note about work that had not happened.
    { key: 'COUNTED_BY_UPC', label: 'Counted by UPC' },
    { key: 'MARKED_SOLD', label: 'Missing — would be marked sold' },
    { key: 'PENDING_NOT_RECEIVED', label: 'Shipped, not yet received' },
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

  /** 'counts' is the history/review list; 'review' is the needs-review queue. */
  readonly tab = signal<'counts' | 'review'>('counts');

  readonly reviewBusy = signal(false);
  readonly reviewError = signal<string | null>(null);

  readonly selectedId = signal<number | null>(null);
  readonly detail = signal<CycleCountDetail | null>(null);
  readonly detailLoading = signal(false);
  readonly detailError = signal<string | null>(null);

  /** Column order in the table, and the field each header sorts by. */
  readonly columns: { field: CycleCountSortField; label: string; num?: boolean }[] = [
    { field: 'id', label: '#' },
    { field: 'status', label: 'Status' },
    { field: 'openedAt', label: 'Opened' },
    { field: 'expectedCount', label: 'Expected', num: true },
    { field: 'scannedCount', label: 'Scanned', num: true },
    { field: 'soldGeneratedCount', label: 'Sold', num: true },
  ];

  /** Newest first, matching the API's default. */
  readonly sortBy = signal<CycleCountSortField>('id');
  readonly sortDir = signal<'asc' | 'desc'>('desc');

  readonly hasNext = computed(() => this.offset() + this.counts().length < this.total());
  readonly rangeLabel = computed(() => {
    const start = this.total() === 0 ? 0 : this.offset() + 1;
    const end = this.offset() + this.counts().length;
    return `${start}–${end} of ${this.total()}`;
  });

  readonly groups = computed<ResolutionGroup[]>(() => {
    const d = this.detail();
    if (!d) return [];
    // Unrecognised codes join Scanned, badged. They were counted like everything else,
    // and the tally above now counts them, so a separate list would say otherwise.
    const newItems = (d.linesByResolution?.NEW_ITEM ?? []).map((l) => ({
      text: this.formatLine(l),
      tag: l.serial == null ? 'New product' : 'New serial',
    }));
    return CycleCountsComponent.ORDER.map(({ key, label }) => {
      const items: GroupItem[] = (d.linesByResolution?.[key] ?? []).map((l) => ({
        text: this.formatLine(l),
      }));
      return {
        key,
        label,
        items: key === 'SCANNED' ? [...items, ...newItems] : items,
        // Highlighted because these are the lines that REMOVE stock.
        prominent: key === 'MARKED_SOLD',
      };
    });
  });

  private formatLine(line: CycleCountLine): string {
    // A serial with no product behind it. The badge says it is new, so the text does
    // not repeat it — it carries the one thing the badge cannot: who is identifying it.
    if (line.productId == null && line.serial) {
      return `${line.serial}${line.importCheckRequested ? ' — PPS check requested' : ''}`;
    }
    if (line.resolution === 'MOVED_IN' && line.serial) {
      return `${line.serial} — ${line.sku ?? ''} (moved to ${line.locationName ?? 'here'})`;
    }
    if (line.resolution === 'COUNTED_BY_UPC') {
      const where = line.locationName ? ` at ${line.locationName}` : '';
      return `${line.sku ?? ''} ${line.name ?? ''}${where} — counted ${line.quantity ?? 0}`;
    }
    if (line.resolution === 'NEW_ITEM' && line.serial == null && line.quantity != null) {
      // A quantity product newly seen this cycle. Worded like COUNTED_BY_UPC because it
      // is the same act — somebody counted a shelf — and the badge carries the difference.
      const where = line.locationName ? ` at ${line.locationName}` : '';
      return `${line.sku ?? ''} ${line.name ?? ''}${where} — counted ${line.quantity}`;
    }
    // Serialized lines (SCANNED / MARKED_SOLD / RECEIVED / REINSTATED / …).
    if (line.serial) return `${line.serial} — ${line.sku ?? 'unidentified'}`;
    return `${line.sku ?? ''} ${line.name ?? ''}`.trim();
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
        sortBy: this.sortBy(),
        sortDir: this.sortDir(),
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

  /**
   * Sort by a column, toggling direction when it is already the active one.
   *
   * Back to page one: after reordering, "page 2" describes a different set of rows, and
   * staying on it would land the user somewhere arbitrary in the new order.
   */
  sort(field: CycleCountSortField): void {
    if (this.sortBy() === field) {
      this.sortDir.update((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortBy.set(field);
      // Ids and dates are most useful newest-first; everything else reads better
      // ascending on the first click.
      this.sortDir.set(field === 'id' || field === 'openedAt' ? 'desc' : 'asc');
    }
    this.offset.set(0);
    this.reload();
  }

  sortIcon(field: CycleCountSortField): string {
    if (this.sortBy() !== field) return '';
    return this.sortDir() === 'asc' ? '▲' : '▼';
  }

  /** Escape closes the detail dialog, matching the rest of the app. */
  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.selectedId() !== null) this.closeDetail();
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
    this.reviewError.set(null);
  }

  /** Apply the proposals. Refreshes the list too: the status changes. */
  approve(): void {
    const id = this.selectedId();
    if (id == null) return;
    this.reviewBusy.set(true);
    this.reviewError.set(null);
    this.api.approveCycleCount(id).subscribe({
      next: (d) => {
        this.reviewBusy.set(false);
        this.detail.set(d);
        this.reload();
      },
      error: (err) => {
        this.reviewBusy.set(false);
        this.reviewError.set(messageFor(err));
      },
    });
  }

  /** Discard the proposals and reopen for a recount. Nothing was applied. */
  reject(): void {
    const id = this.selectedId();
    if (id == null) return;
    this.reviewBusy.set(true);
    this.reviewError.set(null);
    this.api.rejectCycleCount(id).subscribe({
      next: (d) => {
        this.reviewBusy.set(false);
        this.detail.set(d);
        this.reload();
      },
      error: (err) => {
        this.reviewBusy.set(false);
        this.reviewError.set(messageFor(err));
      },
    });
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
      case 'AWAITING_REVIEW':
        return 'Awaiting review';
      case 'CLOSED':
        return 'Closed';
      case 'CANCELLED':
        return 'Cancelled';
    }
  }
}
