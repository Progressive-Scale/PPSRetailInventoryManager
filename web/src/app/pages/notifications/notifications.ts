import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { NotificationStore } from '../../core/notification.store';
import { messageFor } from '../../core/http-error';
import {
  AppNotification,
  NotificationStatus,
  roleLabel,
  Store,
} from '../../core/models';

/** The API rejects a page larger than this. */
const PAGE_SIZE = 200;

/**
 * Full notification history — everything ever raised, not just the unread items in
 * the bell. Rows can be selected and permanently removed with the same mechanics as
 * the inventory stock grid (per-row checkbox, header select-all, bulk action bar).
 */
@Component({
  selector: 'app-notifications',
  imports: [FormsModule, DatePipe],
  template: `
    <main class="container">
      <section class="card">
        <div class="section-head">
          <h2>Notifications</h2>
          <span class="muted small">{{ filtered().length }} of {{ rows().length }}</span>
        </div>
        @if (total() > rows().length) {
          <p class="muted small">
            Showing the {{ rows().length }} most recent of {{ total() }}. Delete some to
            see older ones.
          </p>
        }

        <div class="filters">
          <label class="f">
            Search
            <input
              name="n-search"
              placeholder="Product, serial, email"
              [ngModel]="search()"
              (ngModelChange)="search.set($event)"
            />
          </label>
          <label class="f">
            Type
            <select name="n-type" [ngModel]="typeFilter()" (ngModelChange)="typeFilter.set($event)">
              <option [ngValue]="null">All</option>
              <option [ngValue]="'EXPIRATION_WARNING'">Expiration</option>
              <option [ngValue]="'INVITE_ACCEPTED'">Invite accepted</option>
              <option [ngValue]="'REORDER_ACKNOWLEDGED'">Reorder acknowledged</option>
              <option [ngValue]="'CYCLE_COUNT_REVIEW'">Count needs review</option>
              <option [ngValue]="'ITEMS_NEED_REVIEW'">Items to identify</option>
              <option [ngValue]="'ITEMS_IDENTIFIED'">Identified by PPS</option>
              <option [ngValue]="'REORDER_DECLINED'">Reorder declined</option>
            </select>
          </label>
          <label class="f">
            Status
            <select name="n-status" [ngModel]="statusFilter()" (ngModelChange)="statusFilter.set($event)">
              <option [ngValue]="null">All</option>
              <option [ngValue]="'UNREAD'">Unread</option>
              <option [ngValue]="'READ'">Read</option>
              <option [ngValue]="'DISMISSED'">Dismissed</option>
            </select>
          </label>
          @if (isCompanyAdmin) {
            <label class="f">
              Store
              <select name="n-store" [ngModel]="storeFilter()" (ngModelChange)="storeFilter.set($event)">
                <option [ngValue]="null">All</option>
                <option [ngValue]="'none'">Company-wide</option>
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

        @if (error()) {
          <p class="error">{{ error() }}</p>
        }

        @if (selectionCount() > 0) {
          <div class="bulk-bar">
            <span class="bulk-actions">
              <span class="tip-wrap">
                <button
                  type="button"
                  class="icon-btn"
                  (click)="setStatus('READ')"
                  [disabled]="busy()"
                  aria-label="Mark as read"
                >
                  <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M21.99 8c0-.72-.37-1.35-.94-1.7L12 1 2.95 6.3C2.38 6.65 2 7.28 2 8v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2l-.01-10zM12 13L3.74 7.84 12 3l8.26 4.84L12 13z"
                    />
                  </svg>
                </button>
                <span class="tip-bubble">Mark as read</span>
              </span>
              <span class="tip-wrap">
                <button
                  type="button"
                  class="icon-btn"
                  (click)="setStatus('UNREAD')"
                  [disabled]="busy()"
                  aria-label="Mark as unread"
                >
                  <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"
                    />
                  </svg>
                </button>
                <span class="tip-bubble">Mark as unread</span>
              </span>
              <span class="tip-wrap">
                <button
                  type="button"
                  class="icon-btn"
                  (click)="setStatus('DISMISSED')"
                  [disabled]="busy()"
                  aria-label="Dismiss"
                >
                  <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"
                    />
                  </svg>
                </button>
                <span class="tip-bubble">Dismiss — hide it without deleting</span>
              </span>
              <span class="bulk-sep"></span>
              <span class="tip-wrap">
                <button
                  type="button"
                  class="icon-btn danger-icon"
                  (click)="askDelete()"
                  [disabled]="busy()"
                  aria-label="Delete from history"
                >
                  <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
                    />
                  </svg>
                </button>
                <span class="tip-bubble">Delete from history — permanent</span>
              </span>
              <span class="tip-wrap">
                <button
                  type="button"
                  class="icon-btn clear-btn"
                  (click)="clearSelection()"
                  aria-label="Clear selection"
                >
                  ✕
                </button>
                <span class="tip-bubble">Clear selection</span>
              </span>
            </span>
            <span class="bulk-count">{{ selectionCount() }} selected</span>
          </div>
        }

        @if (loading()) {
          <p class="muted">Loading…</p>
        } @else if (rows().length === 0) {
          <p class="muted">No notifications yet.</p>
        } @else if (filtered().length === 0) {
          <p class="muted">No notifications match these filters.</p>
        } @else {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th class="sel-col">
                    <input
                      type="checkbox"
                      [checked]="allSelected()"
                      [indeterminate]="someSelected() && !allSelected()"
                      (change)="toggleAll()"
                      title="Select all shown"
                    />
                  </th>
                  <th class="col-when">When</th>
                  <th class="col-type">Type</th>
                  <th class="col-what">Details</th>
                  <th class="col-store">Store</th>
                  <th class="col-status">Status</th>
                  <th class="actions col-actions"></th>
                </tr>
              </thead>
              <tbody>
                @for (n of filtered(); track n.id) {
                  <tr [class.read]="n.status !== 'UNREAD'">
                    <td class="sel-col">
                      <input type="checkbox" [checked]="isSelected(n)" (change)="toggle(n)" />
                    </td>
                    <td class="muted">{{ n.createdAt | date: 'short' }}</td>
                    <td>
                      <span class="type-badge" [class]="'nt-' + n.type">{{ typeLabel(n) }}</span>
                    </td>
                    <td class="what">{{ describe(n) }}</td>
                    <td class="muted">
                      {{ n.storeId == null ? 'Company-wide' : storeName(n.storeId) }}
                    </td>
                    <td class="muted">{{ statusLabel(n.status) }}</td>
                    <td class="actions">
                      <button class="sm ghost" (click)="open(n)">Open</button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      @if (confirming()) {
        <div class="overlay" (click)="confirming.set(false)">
          <div class="modal" (click)="$event.stopPropagation()">
            <h3>Delete from history</h3>
            <p class="confirm-text">
              Permanently remove {{ selectionCount() }}
              notification{{ selectionCount() === 1 ? '' : 's' }}? This only clears the
              history — the inventory and users they refer to are untouched.
            </p>
            @if (deleteError()) {
              <p class="error">{{ deleteError() }}</p>
            }
            <div class="modal-actions">
              <button class="danger-btn" (click)="confirmDelete()" [disabled]="busy()">
                {{ busy() ? 'Deleting…' : 'Delete' }}
              </button>
              <button class="ghost" (click)="confirming.set(false)" [disabled]="busy()">
                Cancel
              </button>
            </div>
          </div>
        </div>
      }
    </main>
  `,
  styles: [
    `
      .container {
        max-width: 1320px;
        margin: 1.5rem auto;
        padding: 0 1rem;
      }
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
      input,
      select {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
        font-family: inherit;
      }
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
      /* Widths sum to 100% so the layout stays put as rows come and go. */
      .sel-col {
        width: 3%;
      }
      .col-when {
        width: 14%;
      }
      .col-type {
        width: 12%;
      }
      .col-what {
        width: 39%;
      }
      .col-store {
        width: 14%;
      }
      .col-status {
        width: 10%;
      }
      .col-actions {
        width: 8%;
      }
      td.actions,
      th.actions {
        text-align: right;
        white-space: nowrap;
      }
      .what {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      /* Already-seen rows recede without becoming unreadable. */
      tr.read td {
        color: var(--muted);
      }
      .type-badge {
        display: inline-block;
        font-size: 0.7rem;
        font-weight: 600;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        white-space: nowrap;
      }
      .nt-EXPIRATION_WARNING {
        background: #fef3c7;
        color: #92400e;
      }
      .nt-CYCLE_COUNT_REVIEW {
        background: #fff4e5;
        color: #92400e;
        border-color: #fed7aa;
      }
      .nt-REORDER_DECLINED {
        background: #fef2f2;
        color: #b42318;
        border-color: #fecaca;
      }
      .nt-ITEMS_IDENTIFIED {
        background: #ecfdf3;
        color: #027a48;
        border-color: #a6f4c5;
      }
      .nt-ITEMS_NEED_REVIEW {
        background: #fef2f2;
        color: #b42318;
        border-color: #fecaca;
      }
      .nt-REORDER_ACKNOWLEDGED {
        background: #ecfdf5;
        color: #065f46;
        border-color: #a7f3d0;
      }
      .nt-INVITE_ACCEPTED {
        background: #e0e7ff;
        color: #3730a3;
      }
      .bulk-bar {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        flex-wrap: wrap;
        padding: 0.4rem 0 0.6rem;
        font-size: 0.85rem;
        border-top: 1px solid var(--border);
      }
      .bulk-actions {
        display: flex;
        align-items: center;
        gap: 0.35rem;
      }
      .bulk-count {
        font-weight: 600;
      }
      /* Keeps the reversible status actions visually apart from the destructive one. */
      .bulk-sep {
        width: 1px;
        height: 1.4rem;
        margin: 0 0.2rem;
        background: var(--border);
      }
      .icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        padding: 0;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: transparent;
        /* Required: the glyphs are filled with currentColor, and the inherited
           colour here is white, so without this they paint invisibly. */
        color: var(--muted);
        cursor: pointer;
      }
      .icon-btn:hover:not(:disabled) {
        color: var(--brand, var(--accent));
        border-color: var(--brand, var(--accent));
      }
      .icon-btn.danger-icon:hover:not(:disabled) {
        color: #b42318;
        border-color: #b42318;
      }
      .icon-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .icon-btn .ico {
        width: 18px;
        height: 18px;
        fill: currentColor;
      }
      /* Custom tooltip rather than a native title attribute: no ~1s delay, and it
         is styled to match the app instead of the OS. */
      .tip-wrap {
        display: inline-flex;
        position: relative;
      }
      .tip-bubble {
        position: absolute;
        left: 0;
        top: calc(100% + 6px);
        z-index: 90;
        width: max-content;
        max-width: 240px;
        background: var(--surface);
        border: 1px solid var(--border);
        color: var(--text);
        font-size: 0.75rem;
        line-height: 1.3;
        padding: 0.35rem 0.5rem;
        border-radius: 6px;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.14);
        opacity: 0;
        visibility: hidden;
        transform: translateY(-2px);
        transition: opacity 0.08s ease, transform 0.08s ease;
        pointer-events: none;
      }
      .tip-wrap:hover .tip-bubble,
      .tip-wrap:focus-within .tip-bubble {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
      }
      .clear-btn {
        font-size: 0.9rem;
        line-height: 1;
      }
      button.sm {
        padding: 0.3rem 0.55rem;
        font-size: 0.8rem;
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
        width: min(30rem, calc(100vw - 2rem));
      }
      .modal h3 {
        margin: 0 0 0.5rem;
      }
      .confirm-text {
        margin: 0 0 1rem;
        font-size: 0.9rem;
      }
      .modal-actions {
        display: flex;
        gap: 0.5rem;
      }
      .danger-btn {
        background: #b42318;
        color: #fff;
        border: none;
        border-radius: 8px;
        padding: 0.45rem 0.9rem;
        cursor: pointer;
      }
    `,
  ],
})
export class NotificationsComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly store = inject(NotificationStore);

  readonly isCompanyAdmin = this.auth.isCompanyAdmin();

  readonly rows = signal<AppNotification[]>([]);
  /** Everything in the history, which may exceed the page we loaded. */
  readonly total = signal(0);
  readonly stores = signal<Store[]>([]);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  readonly selected = signal<Set<number>>(new Set());
  readonly confirming = signal(false);
  readonly deleteError = signal<string | null>(null);

  readonly search = signal('');
  readonly typeFilter = signal<string | null>(null);
  readonly statusFilter = signal<string | null>(null);
  readonly storeFilter = signal<number | 'none' | null>(null);

  readonly filtersActive = computed(
    () =>
      this.search().trim().length > 0 ||
      this.typeFilter() !== null ||
      this.statusFilter() !== null ||
      this.storeFilter() !== null,
  );

  readonly filtered = computed(() => {
    const term = this.search().trim().toLowerCase();
    const type = this.typeFilter();
    const status = this.statusFilter();
    const store = this.storeFilter();
    return this.rows().filter((n) => {
      if (type && n.type !== type) return false;
      if (status && n.status !== status) return false;
      if (store === 'none' && n.storeId != null) return false;
      if (typeof store === 'number' && n.storeId !== store) return false;
      if (!term) return true;
      return [this.describe(n), this.typeLabel(n), n.storeId == null ? 'company-wide' : this.storeName(n.storeId)]
        .join(' ')
        .toLowerCase()
        .includes(term);
    });
  });

  readonly selectionCount = computed(() => this.selected().size);
  readonly allSelected = computed(() => {
    const shown = this.filtered();
    return shown.length > 0 && shown.every((n) => this.selected().has(n.id));
  });
  readonly someSelected = computed(() =>
    this.filtered().some((n) => this.selected().has(n.id)),
  );

  ngOnInit(): void {
    if (this.isCompanyAdmin) {
      this.api.listStores().subscribe({ next: (rows) => this.stores.set(rows) });
    }
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.error.set(null);
    // Most recent page of the history, any status; filters are client-side. The
    // API caps a page at PAGE_SIZE, so record the true total and say so when there
    // is more than one page rather than truncating silently.
    this.api.listNotifications({ limit: PAGE_SIZE, offset: 0 }).subscribe({
      next: (res) => {
        this.rows.set(res.data);
        this.total.set(res.total);
        this.loading.set(false);
        this.clearSelection();
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  clearFilters(): void {
    this.search.set('');
    this.typeFilter.set(null);
    this.statusFilter.set(null);
    this.storeFilter.set(null);
  }

  // ---- selection ---------------------------------------------------------

  isSelected(n: AppNotification): boolean {
    return this.selected().has(n.id);
  }

  toggle(n: AppNotification): void {
    const next = new Set(this.selected());
    next.has(n.id) ? next.delete(n.id) : next.add(n.id);
    this.selected.set(next);
  }

  /** Header checkbox acts on the rows currently shown, not the whole history. */
  toggleAll(): void {
    if (this.allSelected()) {
      this.clearSelection();
      return;
    }
    this.selected.set(new Set(this.filtered().map((n) => n.id)));
  }

  clearSelection(): void {
    this.selected.set(new Set());
  }

  // ---- status ------------------------------------------------------------

  /**
   * Apply one status to the whole selection. These are reversible, so they go
   * through without a confirmation — unlike delete. Rows are patched in place
   * instead of reloading so nothing jumps around, and the selection is kept for
   * anything still visible, which makes a mis-click easy to undo by pressing a
   * different status.
   */
  setStatus(status: NotificationStatus): void {
    const ids = [...this.selected()];
    if (ids.length === 0) return;
    this.busy.set(true);
    this.error.set(null);
    this.api.setNotificationStatus(ids, status).subscribe({
      next: () => {
        this.busy.set(false);
        const touched = new Set(ids);
        this.rows.update((rows) =>
          rows.map((n) => (touched.has(n.id) ? { ...n, status } : n)),
        );
        // With a status filter on, the changed rows leave the view; drop them
        // from the selection so the bulk bar never counts rows you cannot see.
        const visible = new Set(this.filtered().map((n) => n.id));
        this.selected.update(
          (sel) => new Set([...sel].filter((id) => visible.has(id))),
        );
        // The bell badge counts unread rows.
        this.store.refreshCount();
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  // ---- delete ------------------------------------------------------------

  askDelete(): void {
    this.deleteError.set(null);
    this.confirming.set(true);
  }

  confirmDelete(): void {
    const ids = [...this.selected()];
    if (ids.length === 0) return;
    this.busy.set(true);
    this.deleteError.set(null);
    this.api.deleteNotifications(ids).subscribe({
      next: () => {
        this.busy.set(false);
        this.confirming.set(false);
        this.reload();
        // The bell counts unread rows, so removing history can change it.
        this.store.refreshCount();
      },
      error: (err) => {
        this.busy.set(false);
        this.deleteError.set(messageFor(err));
      },
    });
  }

  // ---- display -----------------------------------------------------------

  typeLabel(n: AppNotification): string {
    switch (n.type) {
      case 'INVITE_ACCEPTED':
        return 'Invite';
      case 'REORDER_ACKNOWLEDGED':
        return 'Reorder';
      case 'CYCLE_COUNT_REVIEW':
        return 'Count';
      case 'ITEMS_NEED_REVIEW':
        return 'Review';
      case 'ITEMS_IDENTIFIED':
        return 'Identified';
      case 'REORDER_DECLINED':
        return 'Declined';
      default:
        return 'Expiration';
    }
  }

  statusLabel(s: NotificationStatus): string {
    if (s === 'UNREAD') return 'Unread';
    return s === 'READ' ? 'Read' : 'Dismissed';
  }

  describe(n: AppNotification): string {
    if (n.type === 'REORDER_ACKNOWLEDGED') {
      const what = n.payload.productName ?? `product #${n.payload.productId}`;
      return `Reorder for ${what} acknowledged — order ${n.payload.externalOrderRef}`;
    }
    if (n.type === 'INVITE_ACCEPTED') {
      const role = roleLabel(n.payload.role);
      return `${n.payload.email} accepted their invitation as ${role}`;
    }
    if (n.type === 'CYCLE_COUNT_REVIEW') {
      return (
        `Count #${n.payload.cycleCountId} at ${n.payload.storeName} is waiting for review` +
        ` — ${n.payload.scannedCount} of ${n.payload.expectedCount} accounted for`
      );
    }
    if (n.type === 'REORDER_DECLINED') {
      const what = n.payload.productName ?? `product #${n.payload.productId}`;
      const why = n.payload.reason ? ` — ${n.payload.reason}` : '';
      return `Reorder for ${what} was declined${why}`;
    }
    if (n.type === 'ITEMS_IDENTIFIED') {
      const where = n.payload.storeName ? ` at ${n.payload.storeName}` : '';
      if (n.payload.productName) {
        const serial = n.payload.serial ? ` ${n.payload.serial}` : '';
        return `PPS identified${serial} as ${n.payload.productName}${where}`;
      }
      const total = n.payload.identifiedCount ?? 0;
      const cases = n.payload.caseCount ?? 0;
      const fromCases = cases > 0 ? ` (from ${cases} case${cases === 1 ? '' : 's'})` : '';
      return `PPS identified ${total} item${total === 1 ? '' : 's'}${fromCases}${where}`;
    }
    if (n.type === 'ITEMS_NEED_REVIEW') {
      const items = n.payload.itemCount ?? 0;
      const products = n.payload.productCount ?? 0;
      const parts: string[] = [];
      if (items > 0) parts.push(`${items} item${items === 1 ? '' : 's'}`);
      if (products > 0) parts.push(`${products} product${products === 1 ? '' : 's'}`);
      // "1 item needs" but "2 items need" — and two kinds of thing is always plural.
      const verb = items + products === 1 ? 'needs' : 'need';
      return `${parts.join(' and ')} from count #${n.payload.cycleCountId} ${verb} identifying`;
    }
    const what = `${n.payload.productName} ${n.payload.serial}`;
    return n.payload.expired
      ? `${what} — expired ${n.payload.expirationDate}`
      : `${what} — expires in ${n.payload.daysLeft} day(s)`;
  }

  storeName(id: number): string {
    return this.stores().find((s) => s.id === id)?.name ?? `#${id}`;
  }

  /** Same destinations as the bell: the item, or the users list. */
  open(n: AppNotification): void {
    if (n.status === 'UNREAD') this.store.markRead(n.id);
    if (n.type === 'INVITE_ACCEPTED') {
      this.router.navigate(['/manage'], { queryParams: { tab: 'users' } });
      return;
    }
    if (n.type === 'REORDER_ACKNOWLEDGED') {
      // Straight to the request, where the order reference is shown in context.
      this.router.navigate(['/reorders'], { queryParams: { status: 'ACKNOWLEDGED' } });
      return;
    }
    if (n.type === 'CYCLE_COUNT_REVIEW') {
      this.router.navigate(['/cycle-counts'], {
        queryParams: { count: n.payload.cycleCountId },
      });
      return;
    }
    if (n.type === 'ITEMS_NEED_REVIEW') {
      this.router.navigate(['/cycle-counts'], { queryParams: { tab: 'review' } });
      return;
    }
    if (n.type === 'REORDER_DECLINED') {
      this.router.navigate(['/reorders'], { queryParams: { status: 'CANCELLED' } });
      return;
    }
    if (n.type === 'ITEMS_IDENTIFIED') {
      this.router.navigate(['/inventory'], {
        queryParams: n.payload.serial ? { serial: n.payload.serial } : {},
      });
      return;
    }
    this.router.navigate(['/inventory'], {
      queryParams: { itemId: n.payload.itemId, serial: n.payload.serial },
    });
  }
}
