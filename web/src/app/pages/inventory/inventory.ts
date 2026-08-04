import { DatePipe } from '@angular/common';
import {
  Component,
  computed,
  DestroyRef,
  HostListener,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, ParamMap } from '@angular/router';
import {
  catchError,
  EMPTY,
  firstValueFrom,
  skip,
  Subject,
  switchMap,
  timer,
} from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import {
  Store,
  StoreLocation,
  StockRow,
  StockSortField,
  StockStatusFilter,
  TrackingType,
} from '../../core/models';
import { LocationsComponent } from './locations';
import { PendingArrivalsComponent } from './pending-arrivals';
import { ItemDetailComponent } from './item-detail';

type SubTab = 'stock' | 'locations' | 'pending';

/** Long enough to swallow a burst of typing, short enough to feel instant. */
const SEARCH_DEBOUNCE_MS = 300;

interface Column {
  label: string;
  field: StockSortField;
  num?: boolean;
  adminOnly?: boolean;
}

@Component({
  selector: 'app-inventory',
  imports: [
    FormsModule,
    DatePipe,
    LocationsComponent,
    PendingArrivalsComponent,
    ItemDetailComponent,
  ],
  template: `
    <main class="container">
      <div class="tabs">
        <button [class.active]="tab() === 'stock'" (click)="tab.set('stock')">Stock</button>
        <button [class.active]="tab() === 'locations'" (click)="tab.set('locations')">Locations</button>
        <button [class.active]="tab() === 'pending'" (click)="tab.set('pending')">
          Pending arrival
        </button>
      </div>

      @if (tab() === 'pending') {
        <app-pending-arrivals />
      } @else if (tab() === 'locations') {
        <app-locations (showStockAt)="showStockAt($event)" />
      } @else {
        <section class="card">
          <h2>Inventory</h2>

          <div class="sticky-head">
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
              <input
                name="f-search"
                [ngModel]="searchTerm"
                (ngModelChange)="onSearchChange($event)"
                placeholder="Name, SKU, barcode or serial"
              />
            </label>
            <label class="f">
              Location
              <select
                [ngModel]="locationFilter"
                (ngModelChange)="locationFilter = $event; onFilterChange()"
                name="f-loc"
                [disabled]="filterLocations().length === 0"
              >
                <option [ngValue]="null">All</option>
                @for (l of filterLocations(); track l.id) {
                  <option [ngValue]="l.id">{{ l.name }}</option>
                }
              </select>
            </label>
            <label class="f">
              Type
              <select
                [ngModel]="typeFilter"
                (ngModelChange)="typeFilter = $event; onFilterChange()"
                name="f-type"
              >
                <option [ngValue]="null">All</option>
                <option [ngValue]="'SERIALIZED'">Serialized</option>
                <option [ngValue]="'QUANTITY'">UPC</option>
              </select>
            </label>
            <label class="f">
              Status
              <select
                [ngModel]="statusFilter"
                (ngModelChange)="statusFilter = $event; onFilterChange()"
                name="f-status"
              >
                <option [ngValue]="'ON_HAND'">On hand</option>
                <option [ngValue]="'SOLD'">Sold</option>
                <option [ngValue]="'ALL'">All</option>
              </select>
            </label>
            <label class="f">
              Created from
              <input
                type="date"
                name="f-from"
                [ngModel]="createdFrom"
                (ngModelChange)="createdFrom = $event; onFilterChange()"
              />
            </label>
            <label class="f">
              Created to
              <input
                type="date"
                name="f-to"
                [ngModel]="createdTo"
                (ngModelChange)="createdTo = $event; onFilterChange()"
              />
            </label>
            <div class="f-actions">
              <button
                type="button"
                class="ghost"
                (click)="clearFilters()"
                [disabled]="loading() || !filtersActive()"
              >
                Clear
              </button>
              <button type="button" class="ghost" (click)="refresh()" [disabled]="loading()">
                Refresh
              </button>
            </div>
          </form>

          @if (isCompanyAdmin && selectionCount() > 0) {
            <div class="bulk-bar">
              <span class="bulk-actions">
                <button type="button" class="icon-btn" (click)="openMove()" [disabled]="busy()" title="Move to location">
                  <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z" /></svg>
                </button>
                <button type="button" class="icon-btn" (click)="openSold()" [disabled]="busy()" title="Mark as sold">
                  <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z" /></svg>
                </button>
                <span class="tip-wrap">
                  <button
                    type="button"
                    class="icon-btn"
                    (click)="openExp()"
                    [disabled]="busy() || !expirationEnabled()"
                    [attr.aria-label]="expLabel()"
                  >
                    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 3h-1V1h-2v2H7V1H5v2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 18H4V8h16v13zM9 12H7v-2h2v2zm4 0h-2v-2h2v2zm4 0h-2v-2h2v2z" /></svg>
                  </button>
                  <span class="tip-bubble">{{ expLabel() }}</span>
                </span>
                <button type="button" class="icon-btn clear-btn" (click)="clearSelection()" title="Clear selection">✕</button>
              </span>
              <span class="bulk-count">{{ selectionCount() }} selected</span>
              @if (canEscalate()) {
                <span class="bulk-escalate">
                  All {{ rows().length }} on this page selected —
                  <button type="button" class="linkbtn" (click)="escalate()">
                    Select all {{ total() }} matching current filters
                  </button>
                </span>
              } @else if (filterScope()) {
                <span class="bulk-escalate">All {{ total() }} matching current filters selected</span>
              }
            </div>
          }

          @if (bulkMessage()) {
            <div class="bulk-result">
              <span>{{ bulkMessage() }}</span>
              @if (bulkFailures().length > 0) {
                <details>
                  <summary>{{ bulkFailures().length }} skipped</summary>
                  <ul>
                    @for (f of bulkFailures(); track f) {
                      <li>{{ f }}</li>
                    }
                  </ul>
                </details>
              }
              <button type="button" class="linkbtn" (click)="bulkMessage.set(null)">Dismiss</button>
            </div>
          }
          </div>

          @if (listError()) {
            <p class="error">{{ listError() }}</p>
          } @else if (loading() && !loaded()) {
            <p class="muted">Loading…</p>
          } @else if (loaded() && rows().length === 0) {
            <p class="muted">No inventory matches.</p>
          } @else {
            <div class="table-scroll" [class.busy]="loading()">
              <table>
                <thead>
                  <tr>
                    @if (isCompanyAdmin) {
                      <th class="sel-col">
                        <input
                          type="checkbox"
                          [checked]="filterScope() || pageAllSelected()"
                          [indeterminate]="!filterScope() && someSelected() && !pageAllSelected()"
                          (change)="toggleHeader()"
                          title="Select all on this page"
                        />
                      </th>
                    }
                    @for (col of columns(); track col.field) {
                      <th [class.num]="col.num" class="sortable" (click)="sort(col.field)">
                        {{ col.label }}<span class="arrow">{{ sortIcon(col.field) }}</span>
                      </th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (row of rows(); track row.rowId) {
                    <tr class="clickable" (click)="openRow(row)">
                      @if (isCompanyAdmin) {
                        <td class="sel-col" (click)="$event.stopPropagation()">
                          <input
                            type="checkbox"
                            [checked]="isRowSelected(row)"
                            (change)="toggleRow(row)"
                          />
                        </td>
                      }
                      <td>
                        {{ row.sku }}
                        @if (row.serial) {
                          <span class="matched">{{ row.serial }}</span>
                        }
                      </td>
                      <td class="muted">{{ row.upc || '—' }}</td>
                      <td>{{ row.name }}</td>
                      <td>
                        <span class="type-badge" [class]="'tt-' + row.trackingType">{{ typeLabel(row.trackingType) }}</span>
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
                        @if (row.rowKind === 'unit' && row.status !== 'ON_HAND') {
                          <span class="st">{{ statusLabel(row.status) }}</span>
                        }
                      </td>
                      <td class="muted">{{ row.createdAt | date: 'shortDate' }}</td>
                      <td class="muted">{{ row.soldAt ? (row.soldAt | date: 'short') : '—' }}</td>
                    </tr>
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

    @if (selectedRow(); as row) {
      <app-item-detail
        [row]="row"
        [isCompanyAdmin]="isCompanyAdmin"
        [storeName]="storeName(row.storeId)"
        [locations]="rowLocations()"
        (close)="selectedRow.set(null)"
        (changed)="reload()"
      />
    }

    @if (moveOpen()) {
      <div class="overlay" (click)="moveOpen.set(false)">
        <div class="modal" (click)="$event.stopPropagation()">
          <h3>Move {{ selectionCount() }} item(s)</h3>
          @if (dialogError()) {
            <p class="error">{{ dialogError() }}</p>
          }
          @if (moveStoreId() == null) {
            <p class="muted">
              Your selection spans multiple stores — filter to a single store to bulk-move.
            </p>
          } @else {
            <label class="dlg-label">
              Move to
              <select [(ngModel)]="moveTargetLocationId" name="mv-loc">
                <option [ngValue]="null">Location…</option>
                @for (l of moveLocations(); track l.id) {
                  <option [ngValue]="l.id">{{ l.name }}</option>
                }
              </select>
            </label>
            <p class="preview">Move {{ selectionCount() }} items to {{ moveTargetName() || '…' }}?</p>
            <p class="muted small">
              Serialized units move directly; UPC products move their full on-hand from
              each row's current location.
            </p>
          }
          <div class="modal-actions">
            <button (click)="commitMove()" [disabled]="busy() || moveTargetLocationId == null || moveStoreId() == null">
              {{ busy() ? 'Moving…' : 'Move' }}
            </button>
            <button class="ghost" (click)="moveOpen.set(false)" [disabled]="busy()">Cancel</button>
          </div>
        </div>
      </div>
    }

    @if (expOpen()) {
      <div class="overlay" (click)="expOpen.set(false)">
        <div class="modal" (click)="$event.stopPropagation()">
          <h3>Edit expiration</h3>
          @if (dialogError()) {
            <p class="error">{{ dialogError() }}</p>
          }
          <label class="chk">
            <input type="checkbox" [(ngModel)]="expClear" name="exp-clear" />
            Clear expiration date
          </label>
          @if (!expClear) {
            <label class="dlg-label">
              Expiration date
              <input type="date" [(ngModel)]="expDate" name="exp-date" />
            </label>
          }
          <p class="preview">
            {{ selectionCount() }} serialized items → {{ expClear ? 'no date' : (expDate || '…') }}
          </p>
          <div class="modal-actions">
            <button (click)="commitExp()" [disabled]="busy() || (!expClear && !expDate)">
              {{ busy() ? 'Saving…' : 'Save' }}
            </button>
            <button class="ghost" (click)="expOpen.set(false)" [disabled]="busy()">Cancel</button>
          </div>
        </div>
      </div>
    }

    @if (soldOpen()) {
      <div class="overlay" (click)="soldOpen.set(false)">
        <div class="modal" (click)="$event.stopPropagation()">
          <h3>Mark items as sold</h3>
          @if (dialogError()) {
            <p class="error">{{ dialogError() }}</p>
          }
          @if (soldLoading()) {
            <p class="muted">Loading…</p>
          } @else {
            @if (soldSerialCount > 0) {
              <p class="preview">{{ soldSerialCount }} serialized unit(s) will be marked sold.</p>
            }
            @if (soldLines.length > 0) {
              <p class="muted small">Choose how many to mark sold for each UPC product:</p>
              <div class="sold-lines">
                @for (line of soldLines; track line.row.rowId) {
                  <div class="sold-line">
                    <span class="sold-line-name">
                      {{ line.row.name }} <span class="muted">@ {{ line.row.locationName }}</span>
                    </span>
                    <input
                      type="number"
                      min="1"
                      [max]="line.row.onHand"
                      [(ngModel)]="line.qty"
                      [name]="'sold-' + line.row.rowId"
                    />
                    <span class="muted small">/ {{ line.row.onHand }}</span>
                  </div>
                }
              </div>
            }
            @if (soldSerialCount === 0 && soldLines.length === 0) {
              <p class="muted">Nothing to sell.</p>
            }
          }
          <div class="modal-actions">
            <button
              class="danger-btn"
              (click)="commitSold()"
              [disabled]="busy() || soldLoading() || (soldSerialCount === 0 && soldLines.length === 0)"
            >
              {{ busy() ? 'Working…' : 'Mark sold' }}
            </button>
            <button class="ghost" (click)="soldOpen.set(false)" [disabled]="busy()">Cancel</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .container {
        max-width: 1320px;
        margin: 1.5rem auto;
        padding: 0 1rem;
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
      }
      /* Chrome-style tabs: inactive tabs sit a shade darker than the page and
         the active tab shares the card's surface so it connects to the form. */
      .tabs {
        display: flex;
        gap: 4px;
        padding-left: 6px;
        margin-bottom: calc(-1.25rem - 1px);
        position: relative;
        z-index: 2;
      }
      .tabs button {
        background: #e6e9ef;
        border: 1px solid var(--border);
        border-radius: 10px 10px 0 0;
        padding: 0.5rem 1.15rem;
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
      /* One height for every control in the bar, so Clear/Refresh line up with
         the inputs (dates and selects otherwise render slightly different). */
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
      input,
      select {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
      }
      .table-scroll {
        overflow-x: auto;
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
      tr.clickable {
        cursor: pointer;
      }
      tr.clickable:hover td {
        background: var(--bg);
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
      .st {
        margin-left: 0.4rem;
        font-size: 0.68rem;
        color: var(--muted);
        text-transform: uppercase;
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
      .pager {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.75rem;
        margin-top: 0.85rem;
        font-size: 0.85rem;
      }
      /* Filters + bulk action row stay pinned while the table scrolls. */
      .sticky-head {
        position: sticky;
        top: 0;
        z-index: 20;
        background: var(--surface);
        padding-top: 0.25rem;
      }
      /* Slim selection checkbox column, styled to match table cells. */
      .sel-col {
        width: 34px;
        text-align: center;
        padding-left: 0.4rem;
        padding-right: 0.4rem;
      }
      .sel-col input {
        cursor: pointer;
      }
      .bulk-bar {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        flex-wrap: wrap;
        padding: 0.4rem 0 0.6rem;
        font-size: 0.85rem;
        border-top: 1px solid var(--border);
        margin-top: 0.25rem;
      }
      .bulk-count {
        font-weight: 600;
      }
      .bulk-escalate {
        color: var(--muted);
      }
      .linkbtn {
        background: transparent;
        border: none;
        color: var(--brand, var(--accent));
        cursor: pointer;
        padding: 0;
        font: inherit;
        text-decoration: underline;
      }
      .bulk-actions {
        display: flex;
        align-items: center;
        gap: 0.35rem;
      }
      /* Fast custom tooltip on the wrapper — shows even over a disabled button,
         with no native title delay. */
      .tip-wrap {
        display: inline-flex;
        position: relative;
      }
      .tip-bubble {
        position: absolute;
        right: 0;
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
      .tip-wrap:hover .tip-bubble {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
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
        color: var(--muted);
        cursor: pointer;
      }
      .icon-btn:hover:not(:disabled) {
        color: var(--brand, var(--accent));
        border-color: var(--brand, var(--accent));
      }
      .icon-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .icon-btn .ico {
        width: 18px;
        height: 18px;
        fill: currentColor;
      }
      .clear-btn {
        font-size: 0.95rem;
        line-height: 1;
      }
      .bulk-result {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        flex-wrap: wrap;
        padding: 0.4rem 0 0.6rem;
        font-size: 0.85rem;
      }
      .bulk-result ul {
        margin: 0.3rem 0 0;
        padding-left: 1.1rem;
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
        max-width: 400px;
        padding: 1.25rem;
      }
      .modal h3 {
        margin: 0 0 0.75rem;
        font-size: 1rem;
      }
      .dlg-label {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.8rem;
        color: var(--muted);
        margin-bottom: 0.5rem;
      }
      .preview {
        font-size: 0.9rem;
        margin: 0.5rem 0;
      }
      .small {
        font-size: 0.78rem;
      }
      .chk {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.85rem;
        margin-bottom: 0.5rem;
      }
      .modal-actions {
        display: flex;
        gap: 0.5rem;
        margin-top: 0.75rem;
      }
      .sold-lines {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        max-height: 40vh;
        overflow-y: auto;
        margin: 0.3rem 0 0.5rem;
      }
      .sold-line {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.85rem;
      }
      .sold-line-name {
        flex: 1 1 auto;
        min-width: 0;
      }
      .sold-line input {
        flex: 0 0 72px;
        width: 72px;
      }
      .danger-btn {
        background: #b42318;
        border: 1px solid #b42318;
        color: #fff;
      }
      .danger-btn:hover:not(:disabled) {
        background: #99200f;
        border-color: #99200f;
      }
    `,
  ],
})
export class InventoryComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);

  /** Unit id from a notification link, selected once its row loads. */
  private pendingItemId: string | null = null;

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
  statusFilter: StockStatusFilter = 'ON_HAND';
  createdFrom = '';
  createdTo = '';

  // Sort.
  readonly sortBy = signal<StockSortField>('name');
  readonly sortDir = signal<'asc' | 'desc'>('asc');

  readonly filterLocations = signal<StoreLocation[]>([]);

  readonly loading = signal(false);
  readonly loaded = signal(false);
  readonly listError = signal<string | null>(null);

  // Item detail modal.
  readonly selectedRow = signal<StockRow | null>(null);
  readonly rowLocations = signal<StoreLocation[]>([]);

  // ---- bulk selection ----
  readonly selectedRows = signal<Map<string, StockRow>>(new Map());
  readonly filterScope = signal(false);
  readonly busy = signal(false);
  readonly bulkMessage = signal<string | null>(null);
  readonly bulkFailures = signal<string[]>([]);

  // Move dialog.
  readonly moveOpen = signal(false);
  readonly moveLocations = signal<StoreLocation[]>([]);
  readonly moveStoreId = signal<number | null>(null);
  moveTargetLocationId: number | null = null;
  readonly dialogError = signal<string | null>(null);

  // Expiration dialog.
  readonly expOpen = signal(false);
  expDate = '';
  expClear = false;

  // Sold confirmation dialog.
  readonly soldOpen = signal(false);
  readonly soldLoading = signal(false);
  soldSerialCount = 0;
  soldSerialIds: string[] = [];
  private readonly soldSerialLabel = new Map<string, string>();
  soldLines: { row: StockRow; qty: number }[] = [];

  readonly someSelected = computed(
    () => this.filterScope() || this.selectedRows().size > 0,
  );
  readonly pageAllSelected = computed(() => {
    const rows = this.rows();
    if (rows.length === 0) return false;
    const sel = this.selectedRows();
    return rows.every((r) => sel.has(r.rowId));
  });
  readonly selectionCount = computed(() =>
    this.filterScope() ? this.total() : this.selectedRows().size,
  );
  readonly canEscalate = computed(
    () => !this.filterScope() && this.pageAllSelected() && this.total() > this.rows().length,
  );
  /** Any quantity row in scope → expiration edit is not allowed. */
  readonly hasQuantitySelected = computed(() => {
    if (this.filterScope()) return this.typeFilter !== 'SERIALIZED';
    for (const r of this.selectedRows().values()) {
      if (r.trackingType === 'QUANTITY') return true;
    }
    return false;
  });
  readonly expirationEnabled = computed(
    () => this.selectionCount() > 0 && !this.hasQuantitySelected(),
  );

  readonly columns = computed<Column[]>(() => {
    const cols: Column[] = [
      { label: 'SKU', field: 'sku' },
      { label: 'Barcode', field: 'barcode' },
      { label: 'Name', field: 'name' },
      { label: 'Type', field: 'type' },
    ];
    if (this.isCompanyAdmin) cols.push({ label: 'Store', field: 'store' });
    cols.push(
      { label: 'On hand', field: 'onHand', num: true },
      { label: 'Location', field: 'location' },
      { label: 'Expiration', field: 'expiration' },
      { label: 'Created', field: 'created' },
      { label: 'Sold', field: 'sold' },
    );
    return cols;
  });

  readonly hasNext = computed(() => this.offset() + this.rows().length < this.total());
  readonly rangeLabel = computed(() => {
    const start = this.total() === 0 ? 0 : this.offset() + 1;
    const end = this.offset() + this.rows().length;
    return `${start}–${end} of ${this.total()}`;
  });

  ngOnInit(): void {
    this.startReloadPipeline();
    // The link in the address bar right now.
    this.applyDeepLink(this.route.snapshot.queryParamMap);
    // And every later one. Angular REUSES this component when only the query params
    // change, so ngOnInit does not run again — clicking a notification while already on
    // Inventory updated the address bar and did nothing else, which is why it appeared to
    // need a manual Enter (that forces a full page load, which does re-run ngOnInit).
    // skip(1) because the current value was just handled from the snapshot above.
    this.route.queryParamMap
      .pipe(skip(1), takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        if (this.applyDeepLink(params)) this.reload();
      });
    if (this.isCompanyAdmin) {
      this.api.listStores().subscribe({ next: (rows) => this.stores.set(rows) });
    } else {
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

  /**
   * Filters apply as you interact — there is no Apply button. Every request goes
   * through one switchMap pipeline, so a newer change CANCELS the pending debounce
   * and any in-flight HTTP request. Typing therefore costs one request per settled
   * input, not one per keystroke.
   */
  private readonly reloadTrigger = new Subject<number>();

  private startReloadPipeline(): void {
    this.reloadTrigger
      .pipe(
        switchMap((debounceMs) =>
          timer(debounceMs).pipe(
            switchMap(() => {
              this.loading.set(true);
              this.listError.set(null);
              return this.api
                .listStock({
                  storeId: this.storeFilter() ?? undefined,
                  search: this.searchTerm.trim() || undefined,
                  locationId: this.locationFilter ?? undefined,
                  type: this.typeFilter ?? undefined,
                  status: this.statusFilter,
                  createdFrom: this.createdFrom || undefined,
                  createdTo: this.createdTo || undefined,
                  sortBy: this.sortBy(),
                  sortDir: this.sortDir(),
                  limit: this.limit(),
                  offset: this.offset(),
                })
                .pipe(
                  catchError((err) => {
                    this.loading.set(false);
                    this.listError.set(messageFor(err));
                    return EMPTY;
                  }),
                );
            }),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.rows.set(res.data);
        this.total.set(res.total);
        this.loading.set(false);
        this.loaded.set(true);
        this.openPendingItem();
      });
  }

  reload(): void {
    this.reloadTrigger.next(0);
  }

  /** Re-run the current query without touching the filters. */
  refresh(): void {
    this.clearSelection();
    this.reload();
  }

  /**
   * Opened from a notification: ?itemId=&serial= searches for that unit and opens
   * its detail once the row arrives. The serial drives the search because the stock
   * query has no by-id filter; the id then picks the exact row.
   *
   * @returns whether a link was found, so the caller knows if a reload is warranted.
   */
  private applyDeepLink(params: ParamMap): boolean {
    const itemId = params.get('itemId');
    const serial = params.get('serial');
    if (!itemId) return false;
    this.pendingItemId = itemId;
    if (serial) this.searchTerm = serial;
    // Sold units must be reachable too, so do not restrict by status.
    this.statusFilter = 'ALL';
    // The link points at a unit, which only the stock grid shows. Arriving on Locations
    // or Pending would land on a page with no sign of the thing that was clicked.
    this.tab.set('stock');
    // Any previously open detail belongs to a different unit.
    this.selectedRow.set(null);
    this.offset.set(0);
    return true;
  }

  /** Select the deep-linked unit once it appears in the loaded rows. */
  private openPendingItem(): void {
    const wanted = this.pendingItemId;
    if (!wanted) return;
    const row = this.rows().find((r) => r.itemId === wanted);
    if (row) {
      this.pendingItemId = null;
      this.selectedRow.set(row);
    }
  }

  /**
   * Jump from Locations to the stock grid filtered to one location, so the items
   * blocking a deactivate/delete can be moved out.
   */
  showStockAt(loc: StoreLocation): void {
    this.tab.set('stock');
    this.clearSelection();
    this.searchTerm = '';
    this.typeFilter = null;
    this.createdFrom = '';
    this.createdTo = '';
    // Show everything at that location, sold units included.
    this.statusFilter = 'ALL';
    this.storeFilter.set(loc.storeId);
    this.loadFilterLocations(loc.storeId);
    this.locationFilter = loc.id;
    this.offset.set(0);
    this.reload();
  }

  /** Selects and dates apply immediately. */
  onFilterChange(): void {
    this.clearSelection();
    this.offset.set(0);
    this.reload();
  }

  /** Text search waits for typing to settle. */
  onSearchChange(value: string): void {
    this.searchTerm = value;
    this.clearSelection();
    this.offset.set(0);
    this.reloadTrigger.next(SEARCH_DEBOUNCE_MS);
  }

  /** True when anything differs from the default view. */
  filtersActive(): boolean {
    return (
      this.searchTerm.trim().length > 0 ||
      this.locationFilter !== null ||
      this.typeFilter !== null ||
      this.statusFilter !== 'ON_HAND' ||
      this.createdFrom !== '' ||
      this.createdTo !== ''
    );
  }

  applyFilters(): void {
    this.clearSelection();
    this.offset.set(0);
    this.reload();
  }

  clearFilters(): void {
    this.searchTerm = '';
    this.locationFilter = null;
    this.typeFilter = null;
    this.statusFilter = 'ON_HAND';
    this.createdFrom = '';
    this.createdTo = '';
    this.clearSelection();
    this.offset.set(0);
    this.reload();
  }

  onStoreFilter(value: number | null): void {
    this.storeFilter.set(value);
    this.locationFilter = null;
    this.loadFilterLocations(value);
    this.clearSelection();
    this.offset.set(0);
    this.reload();
  }

  sort(field: StockSortField): void {
    if (this.sortBy() === field) {
      this.sortDir.update((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortBy.set(field);
      this.sortDir.set('asc');
    }
    this.offset.set(0);
    this.reload();
  }

  sortIcon(field: StockSortField): string {
    if (this.sortBy() !== field) return '';
    return this.sortDir() === 'asc' ? '▲' : '▼';
  }

  prevPage(): void {
    if (this.offset() === 0) return;
    this.clearSelection();
    this.offset.set(Math.max(0, this.offset() - this.limit()));
    this.reload();
  }

  nextPage(): void {
    if (!this.hasNext()) return;
    this.clearSelection();
    this.offset.set(this.offset() + this.limit());
    this.reload();
  }

  // ---- selection ----
  isRowSelected(row: StockRow): boolean {
    return this.filterScope() || this.selectedRows().has(row.rowId);
  }

  toggleRow(row: StockRow): void {
    if (this.filterScope()) {
      // Drop out of filter-scope: materialize the current page, minus this row.
      const m = new Map<string, StockRow>();
      for (const r of this.rows()) m.set(r.rowId, r);
      m.delete(row.rowId);
      this.filterScope.set(false);
      this.selectedRows.set(m);
      return;
    }
    const m = new Map(this.selectedRows());
    if (m.has(row.rowId)) m.delete(row.rowId);
    else m.set(row.rowId, row);
    this.selectedRows.set(m);
  }

  toggleHeader(): void {
    if (this.filterScope() || this.pageAllSelected()) {
      this.clearSelection();
      return;
    }
    const m = new Map(this.selectedRows());
    for (const r of this.rows()) m.set(r.rowId, r);
    this.selectedRows.set(m);
  }

  escalate(): void {
    this.filterScope.set(true);
  }

  clearSelection(): void {
    this.selectedRows.set(new Map());
    this.filterScope.set(false);
  }

  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.moveOpen()) {
      this.moveOpen.set(false);
      return;
    }
    if (this.expOpen()) {
      this.expOpen.set(false);
      return;
    }
    if (this.soldOpen()) {
      this.soldOpen.set(false);
      return;
    }
    if (this.selectionCount() > 0) this.clearSelection();
  }

  private currentFilters() {
    return {
      storeId: this.storeFilter() ?? undefined,
      search: this.searchTerm.trim() || undefined,
      locationId: this.locationFilter ?? undefined,
      type: this.typeFilter ?? undefined,
      status: this.statusFilter,
      createdFrom: this.createdFrom || undefined,
      createdTo: this.createdTo || undefined,
      sortBy: this.sortBy(),
      sortDir: this.sortDir(),
    };
  }

  /**
   * Resolve the current selection to concrete rows. Page-scope returns the
   * selected row objects; filter-scope pages through listStock with the current
   * filters (capped) so bulk actions hit every matching row, not just the page.
   */
  private async resolveSelection(): Promise<StockRow[]> {
    if (!this.filterScope()) return [...this.selectedRows().values()];
    const CAP = 5000;
    const PAGE = 500;
    const out: StockRow[] = [];
    for (let offset = 0; offset < CAP; offset += PAGE) {
      const res = await firstValueFrom(
        this.api.listStock({ ...this.currentFilters(), limit: PAGE, offset }),
      );
      out.push(...res.data);
      if (out.length >= res.total || res.data.length < PAGE) break;
    }
    return out;
  }

  // ---- bulk: move ----
  openMove(): void {
    this.dialogError.set(null);
    this.moveTargetLocationId = null;
    let storeId: number | null = this.storeFilter();
    if (storeId == null && !this.filterScope()) {
      const stores = new Set([...this.selectedRows().values()].map((r) => r.storeId));
      storeId = stores.size === 1 ? [...stores][0] : null;
    }
    this.moveStoreId.set(storeId);
    this.moveLocations.set([]);
    if (storeId != null) {
      this.api
        .listLocations(storeId)
        .subscribe({ next: (l) => this.moveLocations.set(l.filter((x) => x.isActive)) });
    }
    this.moveOpen.set(true);
  }

  moveTargetName(): string {
    return this.moveLocations().find((l) => l.id === this.moveTargetLocationId)?.name ?? '';
  }

  async commitMove(): Promise<void> {
    const target = this.moveTargetLocationId;
    const storeId = this.moveStoreId();
    if (target == null || storeId == null) return;
    this.busy.set(true);
    this.dialogError.set(null);
    try {
      const rows = (await this.resolveSelection()).filter((r) => r.storeId === storeId);
      const serialIds = rows
        .filter((r) => r.rowKind === 'unit' && r.itemId)
        .map((r) => r.itemId as string);
      const qtyRows = rows.filter((r) => r.rowKind === 'stock');
      let moved = 0;
      const failures: string[] = [];

      for (let i = 0; i < serialIds.length; i += 200) {
        const chunk = serialIds.slice(i, i + 200);
        const res = await firstValueFrom(
          this.api.moveInventory({ itemIds: chunk, toLocationId: target }),
        );
        if (res.mode === 'serial') {
          moved += res.moved;
          res.results
            .filter((x) => x.status === 'error')
            .forEach((x) => failures.push(`${x.itemId}: ${x.reason ?? 'error'}`));
        }
      }
      for (const r of qtyRows) {
        if (r.locationId === target) continue; // already there — nothing to do
        try {
          await firstValueFrom(
            this.api.moveInventory({
              productId: r.productId,
              fromLocationId: r.locationId,
              toLocationId: target,
              quantity: r.onHand,
            }),
          );
          moved++;
        } catch (e) {
          failures.push(`${r.name} @ ${r.locationName}: ${messageFor(e)}`);
        }
      }

      this.busy.set(false);
      this.moveOpen.set(false);
      this.bulkFailures.set(failures);
      this.bulkMessage.set(
        `Moved ${moved} item(s)/line(s)${failures.length ? `, ${failures.length} skipped` : ''}.`,
      );
      this.clearSelection();
      this.reload();
    } catch (e) {
      this.busy.set(false);
      this.dialogError.set(messageFor(e));
    }
  }

  // ---- bulk: expiration ----
  openExp(): void {
    this.dialogError.set(null);
    this.expClear = false;
    this.expDate = '';
    this.expOpen.set(true);
  }

  async commitExp(): Promise<void> {
    this.busy.set(true);
    this.dialogError.set(null);
    try {
      const rows = (await this.resolveSelection()).filter(
        (r) => r.rowKind === 'unit' && r.itemId,
      );
      if (rows.length === 0) {
        this.busy.set(false);
        this.dialogError.set('No serialized items in the selection.');
        return;
      }
      const bySerial = new Map(rows.map((r) => [r.itemId as string, r]));
      const ids = [...bySerial.keys()];
      const date = this.expClear ? null : this.expDate || null;
      let ok = 0;
      const failures: string[] = [];
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const res = await firstValueFrom(this.api.bulkExpiration(chunk, date));
        for (const r of res.results) {
          if (r.ok) ok++;
          else failures.push(`${bySerial.get(r.itemId)?.serial ?? r.itemId}: ${r.reason ?? 'skipped'}`);
        }
      }
      this.busy.set(false);
      this.expOpen.set(false);
      this.bulkFailures.set(failures);
      this.bulkMessage.set(
        `Updated ${ok} item(s)${failures.length ? `, ${failures.length} skipped` : ''}.`,
      );
      this.clearSelection();
      this.reload();
    } catch (e) {
      this.busy.set(false);
      this.dialogError.set(messageFor(e));
    }
  }

  // ---- bulk: mark sold ----
  async openSold(): Promise<void> {
    this.dialogError.set(null);
    this.soldSerialCount = 0;
    this.soldSerialIds = [];
    this.soldSerialLabel.clear();
    this.soldLines = [];
    this.soldOpen.set(true);
    this.soldLoading.set(true);
    try {
      const rows = await this.resolveSelection();
      const serialRows = rows.filter((r) => r.rowKind === 'unit' && r.itemId);
      for (const r of serialRows) this.soldSerialLabel.set(r.itemId as string, r.serial ?? (r.itemId as string));
      this.soldSerialIds = serialRows.map((r) => r.itemId as string);
      this.soldSerialCount = this.soldSerialIds.length;
      // UPC lines get an editable quantity, defaulting to (and capped at) on-hand.
      this.soldLines = rows
        .filter((r) => r.rowKind === 'stock')
        .map((r) => ({ row: r, qty: r.onHand }));
    } catch (e) {
      this.dialogError.set(messageFor(e));
    }
    this.soldLoading.set(false);
  }

  async commitSold(): Promise<void> {
    this.busy.set(true);
    this.dialogError.set(null);
    try {
      let sold = 0;
      const failures: string[] = [];

      for (let i = 0; i < this.soldSerialIds.length; i += 500) {
        const chunk = this.soldSerialIds.slice(i, i + 500);
        const res = await firstValueFrom(this.api.bulkSell(chunk));
        for (const r of res.results) {
          if (r.ok) sold++;
          else failures.push(`${this.soldSerialLabel.get(r.itemId) ?? r.itemId}: ${r.reason ?? 'skipped'}`);
        }
      }
      for (const line of this.soldLines) {
        const qty = Math.floor(Number(line.qty));
        if (!Number.isFinite(qty) || qty < 1 || qty > line.row.onHand) {
          failures.push(`${line.row.name} @ ${line.row.locationName}: enter 1–${line.row.onHand}`);
          continue;
        }
        try {
          await firstValueFrom(
            this.api.sellInventory({
              productId: line.row.productId,
              quantity: qty,
              locationId: line.row.locationId,
              storeId: line.row.storeId,
            }),
          );
          sold++;
        } catch (e) {
          failures.push(`${line.row.name} @ ${line.row.locationName}: ${messageFor(e)}`);
        }
      }

      this.busy.set(false);
      this.soldOpen.set(false);
      this.bulkFailures.set(failures);
      this.bulkMessage.set(
        `Sold ${sold} item(s)/line(s)${failures.length ? `, ${failures.length} skipped` : ''}.`,
      );
      this.clearSelection();
      this.reload();
    } catch (e) {
      this.busy.set(false);
      this.dialogError.set(messageFor(e));
    }
  }

  openRow(row: StockRow): void {
    this.selectedRow.set(row);
    this.rowLocations.set([]);
    this.api.listLocations(row.storeId).subscribe({
      next: (locs) => this.rowLocations.set(locs.filter((l) => l.isActive)),
      error: () => this.rowLocations.set([]),
    });
  }

  storeName(id: number): string {
    return this.storeMap().get(id) ?? `#${id}`;
  }

  /** Display label for a tracking type (quantity products are shown as "UPC"). */
  typeLabel(type: TrackingType): string {
    return type === 'QUANTITY' ? 'UPC' : 'SERIALIZED';
  }

  /** Tooltip for the bulk edit-expiration button (also its aria-label). */
  expLabel(): string {
    return this.expirationEnabled()
      ? 'Edit expiration date'
      : 'UPC items cannot have an expiration date.';
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

  statusLabel(status: string | null): string {
    switch (status) {
      case 'SOLD':
        return 'Sold';
      case 'RETURNED_TO_WAREHOUSE':
        return 'Returned';
      case 'ADJUSTED_OUT':
        return 'Adjusted';
      default:
        return '';
    }
  }
}
