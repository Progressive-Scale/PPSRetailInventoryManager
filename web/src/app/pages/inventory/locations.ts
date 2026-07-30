import {
  Component,
  computed,
  EventEmitter,
  inject,
  OnInit,
  Output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import { LocationKind, Store, StoreLocation } from '../../core/models';

type SortField = 'name' | 'store' | 'kind' | 'active';

@Component({
  selector: 'app-locations',
  imports: [FormsModule],
  template: `
    <section class="card">
      <div class="section-head">
        <h2>Locations</h2>
        <div class="head-controls">
          @if (isCompanyAdmin) {
            <button (click)="openAdd()">Add location</button>
          }
        </div>
      </div>

      <div class="filters">
        <label class="f">
          Search
          <input
            name="lf-search"
            placeholder="Name, type, status, store"
            [ngModel]="search()"
            (ngModelChange)="search.set($event)"
          />
        </label>
        <label class="f">
          Status
          <select name="lf-status" [ngModel]="statusFilter()" (ngModelChange)="statusFilter.set($event)">
            <option [ngValue]="null">All</option>
            <option [ngValue]="'active'">Active</option>
            <option [ngValue]="'inactive'">Inactive</option>
          </select>
        </label>
        @if (isCompanyAdmin) {
          <label class="f">
            Store
            <select name="lf-store" [ngModel]="storeFilter()" (ngModelChange)="storeFilter.set($event)">
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

      @if (error()) {
        <p class="error">
          {{ error() }}
          @if (blockedLoc(); as loc) {
            <button class="sm ghost" (click)="viewStockAt(loc)">View these items</button>
          }
        </p>
      }

      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else {
        <div class="table-scroll" [class.busy]="saving()">
          <table>
            <thead>
              <tr>
                <th class="sortable col-name" (click)="sort('name')">Name<span class="arrow">{{ icon('name') }}</span></th>
                <th class="sortable col-store" (click)="sort('store')">Store<span class="arrow">{{ icon('store') }}</span></th>
                <th class="sortable col-type" (click)="sort('kind')">Type<span class="arrow">{{ icon('kind') }}</span></th>
                <th class="sortable col-status" (click)="sort('active')">Status<span class="arrow">{{ icon('active') }}</span></th>
                @if (isCompanyAdmin) {
                  <th class="actions col-actions"></th>
                }
              </tr>
            </thead>
            <tbody>
              @for (loc of displayLocations(); track loc.id) {
                <tr [class.inactive-row]="!loc.isActive">
                  <td class="name-cell">
                    @if (editId() === loc.id) {
                      <input class="cell-input" name="edit-name" [(ngModel)]="editName" />
                      @if (loc.isLastOfRequiredKind) {
                        <div class="sys-tip" role="note">
                          {{ lastOfKindTip(loc) }} Add another before removing this one.
                        </div>
                      }
                    } @else {
                      {{ loc.name }}
                    }
                  </td>
                  <td class="muted store-cell" [title]="storeName(loc.storeId)">
                    {{ storeName(loc.storeId) }}
                  </td>
                  <td>
                    <span class="kind-badge" [class]="'k-' + loc.kind">{{ kindLabel(loc.kind) }}</span>
                  </td>
                  <td>
                    @if (editId() === loc.id) {
                      <select class="cell-input" name="edit-active" [(ngModel)]="editActive">
                        <option [ngValue]="true">Active</option>
                        <option [ngValue]="false">Inactive</option>
                      </select>
                    } @else {
                      <span class="muted">{{ loc.isActive ? 'Active' : 'Inactive' }}</span>
                    }
                  </td>
                  @if (isCompanyAdmin) {
                    <td class="actions">
                      @if (editId() === loc.id) {
                        <button class="sm" (click)="save(loc)" [disabled]="saving()">Save</button>
                        <button class="sm ghost" (click)="editId.set(null)">Cancel</button>
                        <!-- Always offered. Whether it can actually go, and why not,
                             is explained in the confirmation dialog. -->
                        <button class="sm danger" (click)="askDelete(loc)" [disabled]="saving()">
                          Delete
                        </button>
                      } @else {
                        <button class="sm ghost" (click)="startEdit(loc)">Edit</button>
                      }
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
          @if (displayLocations().length === 0) {
            <p class="muted empty">
              @if (locations().length === 0) {
                No locations yet.
              } @else {
                No locations match these filters.
              }
            </p>
          }
        </div>

      }

      @if (showAdd()) {
        <div class="overlay" (click)="closeAdd()">
          <div class="modal" (click)="$event.stopPropagation()">
            <h3>Add location</h3>
            @if (addError()) {
              <p class="error">{{ addError() }}</p>
            }
            <form class="stacked" (ngSubmit)="create()">
              <label>
                Store
                <select name="a-store" [(ngModel)]="newStoreId">
                  <option [ngValue]="null">Choose a store…</option>
                  @for (s of stores(); track s.id) {
                    <option [ngValue]="s.id">{{ s.name }}</option>
                  }
                </select>
              </label>
              <label>
                Name
                <input name="a-name" [(ngModel)]="newName" placeholder="e.g. Aisle 3" autofocus />
              </label>
              <label>
                Type
                <select name="a-kind" [(ngModel)]="newKind">
                  <option [ngValue]="'CUSTOM'">Custom</option>
                  <option [ngValue]="'BACKROOM'">Backroom</option>
                  <option [ngValue]="'ONFLOOR'">On Floor</option>
                </select>
              </label>
              <p class="muted note">
                A store can have several Backroom or On Floor locations. Type is fixed
                once the location is created.
              </p>
              <label>
                Status
                <select name="a-active" [(ngModel)]="newActive">
                  <option [ngValue]="true">Active</option>
                  <option [ngValue]="false">Inactive</option>
                </select>
              </label>
              <div class="modal-actions">
                <button
                  type="submit"
                  [disabled]="saving() || !newName.trim() || newStoreId == null"
                >
                  Create
                </button>
                <button type="button" class="ghost" (click)="closeAdd()">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      }

      @if (pendingDelete(); as loc) {
        <div class="overlay" (click)="cancelDelete()">
          <div class="modal" (click)="$event.stopPropagation()">
            <h3>Delete location</h3>
            @if (loc.isLastOfRequiredKind) {
              <p class="confirm-text">
                {{ lastOfKindTip(loc) }} Add another {{ kindLabel(loc.kind) }} location to
                this store before removing <strong>{{ loc.name }}</strong>.
              </p>
            } @else if (loc.hasStock) {
              <p class="confirm-text">
                <strong>{{ loc.name }}</strong> still holds
                {{ loc.stockCount }} item{{ loc.stockCount === 1 ? '' : 's' }} on hand.
                Move them out first, then it can be deleted or made inactive.
              </p>
            } @else if (loc.itemCount) {
              <p class="confirm-text">
                <strong>{{ loc.name }}</strong> still has
                {{ loc.itemCount }} item{{ loc.itemCount === 1 ? '' : 's' }} recorded
                against it@if (loc.soldCount) { — {{ loc.soldCount }} of them sold }. Every
                item has to be moved off a location before it can be deleted.
                @if (loc.isActive) {
                  Make it inactive instead to take it out of use and keep the records.
                }
              </p>
            } @else if (loc.hasLedger && loc.isActive) {
              <p class="confirm-text">
                <strong>{{ loc.name }}</strong> is empty, but past movements still refer to
                it, so deleting it would lose that history. Make it inactive instead: it
                disappears from dropdowns and move targets while old records keep showing
                its name.
              </p>
            } @else if (loc.hasLedger || loc.itemCount) {
              <p class="confirm-text">
                <strong>{{ loc.name }}</strong> can't be deleted because records still refer
                to it. It is already inactive, so it is hidden everywhere except those
                historical records.
              </p>
            } @else {
              <p class="confirm-text">
                Delete <strong>{{ loc.name }}</strong>? It has never been used, so this
                removes it completely and cannot be undone.
              </p>
            }
            @if (deleteError()) {
              <p class="error">{{ deleteError() }}</p>
            }
            <div class="modal-actions">
              @if (loc.isLastOfRequiredKind) {
                <!-- nothing to offer but Cancel -->
              } @else if (loc.hasStock) {
                <!-- live stock blocks BOTH actions: the items must move first -->
                <button (click)="viewStockAt(loc)">View these items</button>
              } @else if ((loc.itemCount || loc.hasLedger) && loc.isActive) {
                <button (click)="viewStockAt(loc)">View these items</button>
                <button class="danger-btn" (click)="deactivateFromDialog(loc)" [disabled]="saving()">
                  {{ saving() ? 'Working…' : 'Make inactive' }}
                </button>
              } @else if (loc.itemCount || loc.hasLedger) {
                <!-- already inactive: nothing to offer but Cancel -->
              } @else {
                <button class="danger-btn" (click)="confirmDelete()" [disabled]="saving()">
                  {{ saving() ? 'Deleting…' : 'Delete' }}
                </button>
              }
              <button class="ghost" (click)="cancelDelete()" [disabled]="saving()">Cancel</button>
            </div>
          </div>
        </div>
      }
    </section>
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
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;
        margin-bottom: 0.5rem;
      }
      h2 {
        margin: 0;
        font-size: 1.05rem;
      }
      .head-controls {
        display: flex;
        align-items: flex-end;
        gap: 0.6rem;
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
      /* One height for every control in the bar. */
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
      .empty {
        margin: 0.75rem 0 0;
      }
      /* Deactivated rows read as muted but stay legible. */
      tr.inactive-row td {
        color: var(--muted);
      }
      /* Tooltip for a disabled action (a disabled button fires no events, so the
         bubble hangs off the wrapper). */
      .tip-wrap {
        position: relative;
        display: inline-block;
      }
      .act-tip {
        position: absolute;
        right: 0;
        bottom: calc(100% + 6px);
        z-index: 5;
        width: max-content;
        max-width: 15rem;
        padding: 0.4rem 0.55rem;
        background: var(--surface);
        color: var(--text, inherit);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: 0 8px 20px rgba(16, 24, 40, 0.12);
        font-size: 0.75rem;
        text-align: left;
        white-space: normal;
        opacity: 0;
        pointer-events: none;
        transition: opacity 80ms ease-in;
      }
      .tip-wrap:hover .act-tip {
        opacity: 1;
      }
      .inline {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        font-size: 0.75rem;
        color: var(--muted);
      }
      .name-cell {
        position: relative;
      }
      .sys-tip {
        position: absolute;
        left: 0.6rem;
        top: calc(100% - 2px);
        z-index: 5;
        width: 240px;
        max-width: 70vw;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.14);
        padding: 0.5rem 0.6rem;
        font-size: 0.75rem;
        line-height: 1.35;
        color: var(--muted);
      }
      .sys-tip::before {
        content: '';
        position: absolute;
        top: -5px;
        left: 16px;
        width: 9px;
        height: 9px;
        background: var(--surface);
        border-left: 1px solid var(--border);
        border-top: 1px solid var(--border);
        transform: rotate(45deg);
      }
      .table-scroll {
        /* visible (not auto) so the system-location edit tooltip can extend past
           the last row without being clipped; the fixed-layout table never
           overflows horizontally, so no scroll is needed here. */
        overflow: visible;
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
        table-layout: fixed;
      }
      th,
      td {
        text-align: left;
        padding: 0.5rem 0.6rem;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      /* Fixed widths so entering edit mode never reflows the columns. These must
         sum to 100% across ALL columns — an unsized column in a fixed-layout table
         collapses to zero and its text overlaps the next one. */
      .col-name {
        width: 28%;
      }
      .col-store {
        width: 22%;
      }
      .col-type {
        width: 14%;
      }
      .col-status {
        width: 14%;
      }
      .col-actions {
        width: 22%;
      }
      /* Long store names ellipsize rather than bleeding into Type. */
      td.store-cell {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      td.actions,
      th.actions {
        text-align: right;
        white-space: nowrap;
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
      input,
      select {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
      }
      .cell-input {
        width: 100%;
        max-width: none;
        box-sizing: border-box;
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
      .muted {
        color: var(--muted);
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
      button.danger {
        color: #b42318;
      }
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: 4rem 1rem;
        z-index: 80;
      }
      .modal {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        width: 100%;
        max-width: 380px;
        padding: 1.25rem;
      }
      .modal h3 {
        margin: 0 0 0.75rem;
        font-size: 1rem;
      }
      .stacked {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .stacked label {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.8rem;
        color: var(--muted);
      }
      .modal-actions {
        display: flex;
        gap: 0.5rem;
        margin-top: 0.5rem;
      }
      .confirm-text {
        font-size: 0.9rem;
        margin: 0 0 0.75rem;
      }
      .danger-btn {
        background: #b42318;
        border: 1px solid #b42318;
        color: #fff;
      }
      .danger-btn:hover {
        background: #99200f;
        border-color: #99200f;
      }
    `,
  ],
})
export class LocationsComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);

  readonly isCompanyAdmin = this.auth.user()?.role === 'COMPANY_ADMIN';

  /** Asks the parent to show the stock grid filtered to this location. */
  @Output() showStockAt = new EventEmitter<StoreLocation>();

  readonly stores = signal<Store[]>([]);
  readonly storeId = signal<number | null>(this.auth.user()?.storeId ?? null);
  readonly locations = signal<StoreLocation[]>([]);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly editId = signal<number | null>(null);
  editName = '';
  editActive = true;

  // Filters.
  readonly search = signal('');
  readonly statusFilter = signal<string | null>(null);
  readonly storeFilter = signal<number | null>(null);

  readonly filtersActive = computed(
    () =>
      this.search().trim().length > 0 ||
      this.statusFilter() !== null ||
      this.storeFilter() !== null,
  );

  clearFilters(): void {
    this.search.set('');
    this.statusFilter.set(null);
    this.storeFilter.set(null);
  }

  storeName(id: number): string {
    return this.stores().find((s) => s.id === id)?.name ?? `#${id}`;
  }

  // Add-location modal. The store is chosen here rather than page-wide, so a
  // location is always deliberately attached to one store.
  readonly showAdd = signal(false);
  readonly addError = signal<string | null>(null);
  newStoreId: number | null = null;
  newName = '';
  newKind: LocationKind = 'CUSTOM';
  newActive = true;

  // Delete-confirmation modal.
  readonly pendingDelete = signal<StoreLocation | null>(null);
  readonly deleteError = signal<string | null>(null);

  /** Set when a save was refused because the location still holds stock. */
  readonly blockedLoc = signal<StoreLocation | null>(null);

  private clearError(): void {
    this.error.set(null);
    this.blockedLoc.set(null);
  }

  lastOfKindTip(loc: StoreLocation): string {
    return `Every store needs at least one active ${this.kindLabel(loc.kind)} location.`;
  }

  /**
   * Offered when a delete is refused because the location has history: retire it in
   * one step rather than making the user close the dialog and use the Status
   * dropdown. The server runs the same guards.
   */
  deactivateFromDialog(loc: StoreLocation): void {
    this.saving.set(true);
    this.deleteError.set(null);
    this.api.deactivateLocation(loc.id).subscribe({
      next: () => {
        this.saving.set(false);
        this.pendingDelete.set(null);
        this.editId.set(null);
        this.reload();
      },
      error: (err) => {
        this.saving.set(false);
        this.deleteError.set(messageFor(err));
      },
    });
  }

  /** Jump to the stock grid filtered to this location so the items can be moved. */
  viewStockAt(loc: StoreLocation): void {
    this.pendingDelete.set(null);
    this.showStockAt.emit(loc);
  }

  // Client-side sort (the list is small — no round-trip needed).
  readonly sortField = signal<SortField | null>(null);
  readonly sortDir = signal<'asc' | 'desc'>('asc');

  private static readonly KIND_ORDER: Record<string, number> = {
    BACKROOM: 0,
    ONFLOOR: 1,
    CUSTOM: 2,
  };

  readonly displayLocations = computed(() => {
    const term = this.search().trim().toLowerCase();
    const status = this.statusFilter();
    const store = this.storeFilter();
    const list = this.locations().filter((l) => {
      if (status === 'active' && !l.isActive) return false;
      if (status === 'inactive' && l.isActive) return false;
      if (store != null && l.storeId !== store) return false;
      if (!term) return true;
      // Search spans every column shown, using the displayed labels.
      return [
        l.name,
        this.storeName(l.storeId),
        this.kindLabel(l.kind),
        l.isActive ? 'active' : 'inactive',
      ]
        .join(' ')
        .toLowerCase()
        .includes(term);
    });
    const field = this.sortField();
    if (!field) return list; // server order (storeId, sortOrder, id)
    const dir = this.sortDir() === 'asc' ? 1 : -1;
    return list.sort((a, b) => {
      let cmp = 0;
      if (field === 'name') cmp = a.name.localeCompare(b.name);
      else if (field === 'store')
        cmp = this.storeName(a.storeId).localeCompare(this.storeName(b.storeId));
      else if (field === 'kind')
        cmp = LocationsComponent.KIND_ORDER[a.kind] - LocationsComponent.KIND_ORDER[b.kind];
      else cmp = Number(a.isActive) - Number(b.isActive);
      return cmp * dir;
    });
  });

  ngOnInit(): void {
    if (this.isCompanyAdmin) {
      // Stores are needed for the Store column, the store filter and the Add
      // modal; locations then load for every store at once.
      this.api.listStores().subscribe({
        next: (rows) => {
          this.stores.set(rows);
          this.reload();
        },
        error: (err) => this.error.set(messageFor(err)),
      });
    } else {
      this.reload();
    }
  }

  reload(): void {
    // A company admin sees every store's locations (hence the Store column); a
    // store user is pinned to their own store server-side.
    const sid = this.isCompanyAdmin ? undefined : (this.storeId() ?? undefined);
    if (!this.isCompanyAdmin && sid === undefined) return;
    this.loading.set(true);
    this.error.set(null);
    // includeInactive: the admin screen manages deactivated rows and needs the
    // hasStock / hasHistory / isLastOfRequiredKind flags to pick each row's action.
    this.api.listLocations(sid, true).subscribe({
      next: (rows) => {
        this.locations.set(rows);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  sort(field: SortField): void {
    if (this.sortField() === field) {
      this.sortDir.update((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortField.set(field);
      this.sortDir.set('asc');
    }
  }

  icon(field: SortField): string {
    if (this.sortField() !== field) return '';
    return this.sortDir() === 'asc' ? '▲' : '▼';
  }

  startEdit(loc: StoreLocation): void {
    this.editName = loc.name;
    this.editActive = loc.isActive;
    this.clearError();
    this.editId.set(loc.id);
  }

  save(loc: StoreLocation): void {
    const name = this.editName.trim();
    if (!name) return;
    // Rename and/or flip Active. The server runs the lifecycle guards on the
    // isActive change (live stock, last-active-of-a-required-kind), so a rejected
    // switch comes back as a message rather than being silently applied.
    const dto: { name: string; isActive?: boolean } = { name };
    if (this.editActive !== loc.isActive) dto.isActive = this.editActive;
    this.saving.set(true);
    this.clearError();
    this.api.updateLocation(loc.id, dto).subscribe({
      next: () => {
        this.saving.set(false);
        this.editId.set(null);
        this.reload();
      },
      error: (err) => {
        this.saving.set(false);
        const text = messageFor(err);
        this.error.set(text);
        // Offer the shortcut only when the blocker is stock the user must move.
        if (/move the \d+ item/i.test(text)) this.blockedLoc.set(loc);
      },
    });
  }

  askDelete(loc: StoreLocation): void {
    this.deleteError.set(null);
    this.pendingDelete.set(loc);
  }

  cancelDelete(): void {
    this.pendingDelete.set(null);
  }

  confirmDelete(): void {
    const loc = this.pendingDelete();
    if (!loc) return;
    this.saving.set(true);
    this.deleteError.set(null);
    this.api.deleteLocation(loc.id).subscribe({
      next: () => {
        this.saving.set(false);
        this.pendingDelete.set(null);
        this.editId.set(null);
        this.reload();
      },
      error: (err) => {
        this.saving.set(false);
        this.deleteError.set(messageFor(err));
      },
    });
  }

  openAdd(): void {
    this.newName = '';
    this.newKind = 'CUSTOM';
    this.newActive = true;
    // Preselect when there is only one store, or when a store filter is applied.
    const only = this.stores().length === 1 ? this.stores()[0].id : null;
    this.newStoreId = this.storeFilter() ?? only ?? this.storeId();
    this.addError.set(null);
    this.showAdd.set(true);
  }

  closeAdd(): void {
    this.showAdd.set(false);
  }

  create(): void {
    const sid = this.newStoreId;
    const name = this.newName.trim();
    if (sid == null || !name) return;
    this.saving.set(true);
    this.addError.set(null);
    this.api
      .createLocation({ storeId: sid, name, kind: this.newKind, isActive: this.newActive })
      .subscribe({
      next: () => {
        this.saving.set(false);
        this.showAdd.set(false);
        this.reload();
      },
      error: (err) => {
        this.saving.set(false);
        this.addError.set(messageFor(err));
      },
    });
  }

  /**
   * Label for a KIND (badge + guard text). Not the location's name — a renamed
   * backroom still shows the Backroom type.
   */
  kindLabel(kind: string): string {
    switch (kind) {
      case 'BACKROOM':
        return 'Backroom';
      case 'ONFLOOR':
        return 'On Floor';
      default:
        return 'Custom';
    }
  }
}
