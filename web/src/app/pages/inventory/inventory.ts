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
  ProductStockRow,
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
import { MaxDecimalsDirective } from '../../shared/max-decimals';

type SubTab = 'stock' | 'locations' | 'pending';

/** Long enough to swallow a burst of typing, short enough to feel instant. */
const SEARCH_DEBOUNCE_MS = 300;

interface Column {
  label: string;
  field: StockSortField;
  /** Numeric column. Marks it; alignment is [center] below. */
  num?: boolean;
  /**
   * Centre this column. Only On hand: it is a bare count, and centring it under its
   * header sets it apart from the text columns without pushing it against the next one.
   * Weight stays left with the rest — "12.4 lbs" is a measurement that reads as text.
   */
  center?: boolean;
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
    MaxDecimalsDirective,
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
              Received from
              <input
                type="date"
                name="f-from"
                [ngModel]="receivedFrom"
                (ngModelChange)="receivedFrom = $event; onFilterChange()"
              />
            </label>
            <label class="f">
              Received to
              <input
                type="date"
                name="f-to"
                [ngModel]="receivedTo"
                (ngModelChange)="receivedTo = $event; onFilterChange()"
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
            <!-- One control for how the same stock is listed. The label states where you
                 ARE (so it doubles as a status) and the tooltip says what a click does. -->
            <div class="f-actions view-toggle">
              <button
                type="button"
                class="ghost"
                (click)="toggleViewMode()"
                [title]="
                  viewMode() === 'byProduct'
                    ? 'Showing one row per product — click to list every item ungrouped'
                    : 'Showing every item ungrouped — click to group them by product'
                "
              >
                View: {{ viewMode() === 'byProduct' ? 'By product' : 'All items' }}
              </button>
            </div>
          </form>

          @if (canManage && selectionCount() > 0) {
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
                <span class="tip-wrap">
                  <button
                    type="button"
                    class="icon-btn"
                    (click)="openPrice()"
                    [disabled]="busy() || !priceEnabled()"
                    [attr.aria-label]="priceBulkLabel()"
                  >
                    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58s1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41s-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z" /></svg>
                  </button>
                  <span class="tip-bubble">{{ priceBulkLabel() }}</span>
                </span>
                <button type="button" class="icon-btn clear-btn" (click)="clearSelection()" title="Clear selection">✕</button>
              </span>
              <span class="bulk-count">{{ selectionCount() }} selected</span>
              @if (canEscalate()) {
                <span class="bulk-escalate">
                  All {{ visibleUnits().length }} shown selected —
                  <button type="button" class="linkbtn" (click)="escalate()">
                    Select all {{ total() }} matching current filters
                  </button>
                </span>
              } @else if (filterScope()) {
                <span class="bulk-escalate">All {{ selectionCount() }} matching current filters selected</span>
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
          } @else if (loaded() && shownRowCount() === 0) {
            <p class="muted">No inventory matches.</p>
          } @else {
            <div class="table-scroll" [class.busy]="loading()">
              <table>
                <thead>
                  <tr>
                    @if (canManage) {
                      <th class="sel-col">
                        <input
                          type="checkbox"
                          [checked]="filterScope()"
                          [indeterminate]="!filterScope() && someSelected()"
                          (change)="toggleHeader($event)"
                          title="Select everything matching the current filters"
                        />
                      </th>
                    }
                    @for (col of columns(); track col.field) {
                      <th
                        [class.num]="col.num"
                        [class.center]="col.center"
                        class="sortable"
                        (click)="sort(col.field)"
                      >
                        {{ col.label }}<span class="arrow">{{ sortIcon(col.field) }}</span>
                      </th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @if (viewMode() === 'allItems') {
                    @for (row of flatRows(); track row.rowId) {
                      <tr class="clickable" (click)="openRow(row)">
                        @if (canManage) {
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
                        <td>
                          {{ row.name }}
                          @if (row.reorderOpen) {
                            <span class="ro-badge" title="This store has an open reorder for this product">
                              Reorder
                            </span>
                          }
                        </td>
                        <td>
                          <span class="type-badge" [class]="'tt-' + row.trackingType">{{ typeLabel(row.trackingType) }}</span>
                        </td>
                        @if (isCompanyAdmin) {
                          <td class="muted">{{ storeName(row.storeId) }}</td>
                        }
                        <td class="num center">{{ row.onHand }}</td>
                        <td>
                          <span class="kind-badge" [class]="'k-' + row.locationKind">{{ row.locationName }}</span>
                        </td>
                        <td [class]="expClass(row.expirationDate)">
                          {{ row.expirationDate ? (row.expirationDate | date: 'shortDate') : '—' }}
                          @if (row.rowKind === 'unit' && row.status !== 'ON_HAND') {
                            <span class="st">{{ statusLabel(row.status) }}</span>
                          }
                        </td>
                        <td class="muted">{{ row.receivedAt | date: 'shortDate' }}</td>
                        <td class="muted">{{ row.soldAt ? (row.soldAt | date: 'short') : '—' }}</td>
                        <td class="num">{{ unitWeight(row) }}</td>
                        <td class="num" [title]="priceTitle(row)">{{ unitPrice(row) }}</td>
                      </tr>
                    }
                  } @else {
                  @for (p of productRows(); track p.productId) {
                    <!-- Tier one: the product. The same columns as the rows beneath it,
                         each rolled up over whatever the filters admit. -->
                    <tr class="clickable prod-row" [class.open]="isExpanded(p)" (click)="onProductClick(p)">
                      @if (canManage) {
                        <td class="sel-col" (click)="$event.stopPropagation()">
                          <input
                            type="checkbox"
                            [checked]="productAllSelected(p)"
                            [indeterminate]="productPartlySelected(p)"
                            (change)="toggleProduct(p)"
                            [title]="'Select every row under ' + p.sku"
                          />
                        </td>
                      }
                      <td class="sku-cell">
                        @if (canExpand(p)) {
                          <span class="chev" [class.open]="isExpanded(p)" aria-hidden="true">›</span>
                        } @else {
                          <span class="chev-spacer" aria-hidden="true"></span>
                        }
                        {{ p.sku }}
                      </td>
                      <td class="muted">{{ p.upc || '—' }}</td>
                      <td>
                        {{ p.name }}
                        @if (p.pendingCount > 0) {
                          <span class="pending-badge" [title]="p.pendingCount + ' unit(s) shipped but not yet received'">
                            +{{ p.pendingCount }} pending
                          </span>
                        }
                      </td>
                      <td>
                        <span class="type-badge" [class]="'tt-' + p.trackingType">{{ typeLabel(p.trackingType) }}</span>
                      </td>
                      @if (isCompanyAdmin) {
                        <td class="muted">{{ productStoreLabel(p) }}</td>
                      }
                      <td class="num strong center">{{ p.onHand }}</td>
                      <td class="muted">{{ productLocationLabel(p) }}</td>
                      <td [class]="expClass(p.expirationFrom)">
                        {{ dateRange(p.expirationFrom, p.expirationTo) }}
                      </td>
                      <td class="muted">{{ dateRange(p.receivedFrom, p.receivedTo) }}</td>
                      <td class="muted">{{ dateRange(p.soldFrom, p.soldTo, true) }}</td>
                      <td class="num" [title]="weightTitle(p)">
                        {{ productWeight(p) }}
                      </td>
                      <td class="num">{{ productPrice(p) }}</td>
                    </tr>

                    <!-- Tier two: the actual rows, in the same columns. -->
                    @if (isExpanded(p)) {
                      @if (isUnitsLoading(p)) {
                        <tr class="sub-row">
                          <td [attr.colspan]="columnCount()" class="muted">Loading…</td>
                        </tr>
                      } @else if (unitsErrorFor(p); as err) {
                        <tr class="sub-row">
                          <td [attr.colspan]="columnCount()" class="error">{{ err }}</td>
                        </tr>
                      } @else {
                        @for (row of unitsFor(p); track row.rowId) {
                          <tr class="clickable sub-row" (click)="openRow(row)">
                            @if (canManage) {
                              <td class="sel-col" (click)="$event.stopPropagation()">
                                <input
                                  type="checkbox"
                                  [checked]="isRowSelected(row)"
                                  (change)="toggleRow(row)"
                                />
                              </td>
                            }
                            <td class="sku-cell sub-sku">
                              @if (row.serial) {
                                <span class="matched">{{ row.serial }}</span>
                              } @else {
                                <span class="muted">stock</span>
                              }
                            </td>
                            <td class="muted">{{ row.upc || '—' }}</td>
                            <td>
                              {{ row.name }}
                              @if (row.reorderOpen) {
                                <span class="ro-badge" title="This store has an open reorder for this product">
                                  Reorder
                                </span>
                              }
                            </td>
                            <td>
                              <span class="type-badge" [class]="'tt-' + row.trackingType">{{ typeLabel(row.trackingType) }}</span>
                            </td>
                            @if (isCompanyAdmin) {
                              <td class="muted">{{ storeName(row.storeId) }}</td>
                            }
                            <td class="num center">{{ row.onHand }}</td>
                            <td>
                              <span class="kind-badge" [class]="'k-' + row.locationKind">{{ row.locationName }}</span>
                            </td>
                            <td [class]="expClass(row.expirationDate)">
                              {{ row.expirationDate ? (row.expirationDate | date: 'shortDate') : '—' }}
                              @if (row.rowKind === 'unit' && row.status !== 'ON_HAND') {
                                <span class="st">{{ statusLabel(row.status) }}</span>
                              }
                            </td>
                            <td class="muted">{{ row.receivedAt | date: 'shortDate' }}</td>
                            <td class="muted">{{ row.soldAt ? (row.soldAt | date: 'short') : '—' }}</td>
                            <td class="num">{{ unitWeight(row) }}</td>
                            <td class="num" [title]="priceTitle(row)">{{ unitPrice(row) }}</td>
                          </tr>
                        }
                      }
                    }
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

    @if (selectedRow(); as row) {
      <app-item-detail
        [row]="row"
        [canManage]="canManage"
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

    @if (priceOpen()) {
      <div class="overlay" (click)="priceOpen.set(false)">
        <div class="modal" (click)="$event.stopPropagation()">
          <h3>Edit price</h3>
          @if (dialogError()) {
            <p class="error">{{ dialogError() }}</p>
          }
          <label class="chk">
            <input type="checkbox" [(ngModel)]="priceClear" name="price-clear" />
            Use default price
          </label>
          @if (!priceClear) {
            <label class="dlg-label">
              Price
              <input type="number" step="0.01" appMaxDecimals="2" [(ngModel)]="priceValue" name="price-value" />
            </label>
          }
          <p class="preview">
            {{ selectionCount() }} serialized items &rarr; {{ pricePreview() }}
          </p>
          <div class="modal-actions">
            <button (click)="commitPrice()" [disabled]="busy() || !priceReady()">
              {{ busy() ? 'Saving…' : 'Save' }}
            </button>
            <button class="ghost" (click)="priceOpen.set(false)" [disabled]="busy()">Cancel</button>
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
      /*
       * Scrolls in BOTH directions, and that is what makes the header pin.
       *
       * overflow-x: auto alone already made this a scroll container, so a sticky thead
       * inside it had nothing to stick to while the PAGE scrolled — the header just left
       * with the rows. Giving the container its own height moves the vertical scrolling in
       * here, where the header can hold position against it.
       *
       * The height is what is left of the viewport under the toolbar and the sticky filter
       * bar above it. dvh rather than vh so a phone's collapsing address bar does not leave
       * the last row permanently out of reach.
       */
      .table-scroll {
        overflow: auto;
        max-height: calc(100dvh - 19rem);
        /* Floor, for a short window or a tall filter bar: below this the grid shows so few
           rows that a pinned header costs more than it gives, and the page can scroll. */
        min-height: 18rem;
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
      /*
       * The column headings stay put while the rows move under them.
       *
       * Opaque background is not decoration: a sticky row with a transparent one would let
       * the rows scroll through it. border-collapse drops the cells' own borders when they
       * are sticky, so the underline is redrawn as a shadow — otherwise the heading floats
       * over the first row with nothing separating them.
       */
      thead th {
        position: sticky;
        top: 0;
        z-index: 3;
        background: var(--surface);
        box-shadow: inset 0 -1px 0 var(--border);
      }
      /* Numeric columns line up with every other column rather than against the next
         one. Right-aligning two columns in a table where nothing else is right-aligned
         read as a mistake, which is the only thing alignment has to avoid here — these
         are small counts and weights, not figures anyone scans down to compare digits.
         The class stays because it still marks the numeric columns (see td.num.strong). */
      th.num,
      td.num {
        text-align: left;
      }
      /* On hand only — see Column.center. */
      th.center,
      td.center {
        text-align: center;
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
      /* Tier one. Slightly heavier than a sub-row so the eye finds the products, with
         the chevron rotating on open — no new colours, just weight and a caret. */
      tr.prod-row > td {
        font-weight: 500;
      }
      tr.prod-row.open > td {
        border-bottom-color: transparent;
      }
      .chev {
        display: inline-block;
        width: 0.7rem;
        color: var(--muted);
        transition: transform 0.12s ease;
      }
      .chev.open {
        transform: rotate(90deg);
      }
      td.num.strong {
        font-weight: 600;
      }
      /* Tier two. Tinted and indented so a run of sub-rows reads as belonging to the
         product above it rather than as more products. */
      tr.sub-row > td {
        background: color-mix(in srgb, var(--border) 18%, transparent);
      }
      /* The chevron lives in the cell's own left padding rather than after it, so the
         SKU starts almost at the table edge and the row gains width for the columns
         that need it. */
      td.sku-cell {
        padding-left: 0.25rem;
      }
      /* Holds the SKU in line with the ones that do have a caret. */
      .chev-spacer {
        display: inline-block;
        width: 0.7rem;
      }
      /* Wide enough that the label swapping between the two names does not resize the
         button and shift what sits beside it. */
      .view-toggle button {
        min-width: 9.5rem;
      }
      /* Tier two is still indented — enough to read as belonging to the product above,
         no more. It was 1.9rem, which pushed the serial well clear of its own column. */
      td.sub-sku {
        padding-left: 0.95rem;
      }
      /* The serial's left margin exists for when it TRAILS a SKU on one line. Here it
         leads the cell, so the margin would only undo the tightening above. */
      td.sku-cell .matched {
        margin-left: 0;
      }
      .pending-badge {
        display: inline-block;
        margin-left: 0.35rem;
        font-size: 0.68rem;
        font-weight: 600;
        padding: 0.05rem 0.4rem;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
        white-space: nowrap;
      }
      .matched {
        margin-left: 0.4rem;
        font-size: 0.72rem;
        color: var(--muted);
        font-family: ui-monospace, monospace;
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

  /**
   * Two different questions, deliberately not one flag.
   *
   * isCompanyAdmin is about SCOPE — the store filter and the Store column only mean
   * something to somebody who can see more than one store. canManage is about ACTION
   * — the bulk bar, the selection checkboxes, the Manage block in the detail panel.
   * A store manager gets the second and not the first.
   */
  readonly isCompanyAdmin = this.auth.isCompanyAdmin();
  readonly canManage = this.auth.canManageInventory();

  readonly tab = signal<SubTab>('stock');

  /**
   * How the same stock is listed: grouped into products (default) or one row per item.
   * Kept in sessionStorage so it survives navigation without becoming a permanent
   * preference somebody set once and forgot.
   */
  readonly viewMode = signal<'byProduct' | 'allItems'>(
    sessionStorage.getItem('inv.viewMode') === 'allItems' ? 'allItems' : 'byProduct',
  );

  /** The grid's own rows: one per product. */
  readonly productRows = signal<ProductStockRow[]>([]);
  /** Ungrouped rows, for the All-items view. */
  readonly flatRows = signal<StockRow[]>([]);
  /**
   * Sub-rows per expanded product, keyed by productId — the SAME StockRow shape the
   * grid used to list flat, so every existing per-row behaviour (selection, the detail
   * popup, the bulk actions) works on them untouched.
   */
  readonly units = signal<Map<number, StockRow[]>>(new Map());
  readonly expanded = signal<Set<number>>(new Set());
  readonly unitsLoading = signal<Set<number>>(new Set());
  readonly unitsError = signal<Map<number, string>>(new Map());
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
  /**
   * Set only by the Products catalog's "View inventory" link. Not a visible control —
   * it is cleared by Clear like any other filter, and the search box remains the way a
   * person narrows to a product by hand.
   */
  productFilter: number | null = null;
  typeFilter: TrackingType | null = null;
  statusFilter: StockStatusFilter = 'ON_HAND';
  receivedFrom = '';
  receivedTo = '';

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
  /**
   * Unit count behind a filter-scope selection, or null until it arrives.
   *
   * Only meaningful while filterScope is on. See takeFilterScope() for why total()
   * cannot stand in for it in the grouped view.
   */
  readonly scopeTotal = signal<number | null>(null);
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

  // Price dialog. priceValue starts as '' so an empty box stays distinguishable
  // from a deliberate 0; appMaxDecimals writes a number back once one is typed.
  readonly priceOpen = signal(false);
  priceValue: string | number = '';
  priceClear = false;

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
  /**
   * Every sub-row currently on screen, flattened. Selection and the bulk actions work
   * on units, and units only exist inside an expansion — so "all on this page" means
   * all the rows the open expansions are showing.
   */
  readonly visibleUnits = computed(() => {
    // Ungrouped: every row on the page is selectable in its own right.
    if (this.viewMode() === 'allItems') return this.flatRows();
    const map = this.units();
    const out: StockRow[] = [];
    for (const id of this.expanded()) {
      const rows = map.get(id);
      if (rows) out.push(...rows);
    }
    return out;
  });
  readonly pageAllSelected = computed(() => {
    const rows = this.visibleUnits();
    if (rows.length === 0) return false;
    const sel = this.selectedRows();
    return rows.every((r) => sel.has(r.rowId));
  });
  // total() is the fallback only for the moment before the unit count lands, so the bar
  // and the action buttons never blink through zero.
  readonly selectionCount = computed(() =>
    this.filterScope() ? (this.scopeTotal() ?? this.total()) : this.selectedRows().size,
  );
  readonly canEscalate = computed(
    () => !this.filterScope() && this.pageAllSelected() && this.total() > this.shownRowCount(),
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

  // Price lives on the serialized unit, same as expiration: a quantity row has no
  // single unit to price, so a selection containing one disables the button.
  readonly priceEnabled = computed(
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
      { label: 'On hand', field: 'onHand', num: true, center: true },
      { label: 'Location', field: 'location' },
      { label: 'Expiration', field: 'expiration' },
      { label: 'Received', field: 'received' },
      { label: 'Sold', field: 'sold' },
      // ONE column for both tiers, because they share one header row: per-unit lbs on a
      // unit row, the product's total on a product row. Quantity stock has no weight in
      // either tier and shows an em dash.
      { label: 'Weight', field: 'weight', num: true },
      // Like Weight, one column serving both tiers: what a unit sells for on a unit
      // row, the catalog price on a product row. An overridden unit is marked rather
      // than coloured — the number is the point, the override is the footnote.
      { label: 'Price', field: 'price', num: true },
    );
    return cols;
  });

  /** Header cells including the checkbox column, for a sub-row's colspan. */
  /** Rows the grid is showing, whichever way it is listing them. */
  readonly shownRowCount = computed(() =>
    this.viewMode() === 'allItems' ? this.flatRows().length : this.productRows().length,
  );

  readonly columnCount = computed(
    () => this.columns().length + (this.canManage ? 1 : 0),
  );

  readonly hasNext = computed(() => this.offset() + this.shownRowCount() < this.total());
  readonly rangeLabel = computed(() => {
    const start = this.total() === 0 ? 0 : this.offset() + 1;
    const end = this.offset() + this.shownRowCount();
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
              const query = {
                ...this.currentFilters(),
                sortBy: this.sortBy(),
                sortDir: this.sortDir(),
                limit: this.limit(),
                offset: this.offset(),
              };
              // Cast to one observable type: the two reads return different row shapes,
              // and a union of observables makes .pipe() unresolvable. The subscriber
              // narrows again by viewMode, which is the only place the shape matters.
              const source = (
                this.viewMode() === 'byProduct'
                  ? this.api.listStockByProduct(query)
                  : this.api.listStock(query)
              ) as ReturnType<typeof this.api.listStock>;
              return source
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
        if (this.viewMode() === 'allItems') {
          this.flatRows.set(res.data as StockRow[]);
          this.productRows.set([]);
        } else {
          this.productRows.set(res.data as unknown as ProductStockRow[]);
          this.flatRows.set([]);
        }
        this.total.set(res.total);
        this.loading.set(false);
        this.loaded.set(true);
        // A new page of products invalidates every open expansion: the rows beneath a
        // product were loaded under the previous filters, and keeping them would show
        // sub-rows that the product's own On hand no longer counts.
        this.collapseAll();
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
    // ?productId= is the Products catalog's "View inventory" link: the catalog holds no
    // stock data at all, so it answers "how many?" by sending you here, narrowed to the
    // product asked about. Handled before itemId because it carries no unit to open.
    const productParam = params.get('productId');
    if (productParam) {
      const id = Number(productParam);
      if (Number.isFinite(id) && id > 0) {
        this.productFilter = id;
        // Show everything for that product, not just what is on hand — the question
        // being asked is "what stock do we have", and a sold-out product answering with
        // an empty table looks like a broken link.
        this.statusFilter = 'ALL';
        this.tab.set('stock');
        this.selectedRow.set(null);
        this.offset.set(0);
        return true;
      }
    }

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

  /**
   * Open the deep-linked unit once it is loaded. A unit now lives inside a product's
   * expansion, so this expands the product that owns it first and finishes the job when
   * its sub-rows arrive — the notification link has to end on the unit, not on a
   * collapsed row that merely contains it.
   */
  private openPendingItem(): void {
    const wanted = this.pendingItemId;
    if (!wanted) return;

    const loaded = this.visibleUnits().find((r) => r.itemId === wanted);
    if (loaded) {
      this.pendingItemId = null;
      this.openRow(loaded);
      return;
    }
    // Not loaded yet. The search brought back the owning product (the query matches a
    // serial), so expand the first product row and wait for its units.
    const first = this.productRows()[0];
    if (first && !this.expanded().has(first.productId)) this.toggleExpanded(first);
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
    this.receivedFrom = '';
    this.receivedTo = '';
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
      this.productFilter !== null ||
      this.typeFilter !== null ||
      this.statusFilter !== 'ON_HAND' ||
      this.receivedFrom !== '' ||
      this.receivedTo !== ''
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
    this.productFilter = null;
    this.typeFilter = null;
    this.statusFilter = 'ON_HAND';
    this.receivedFrom = '';
    this.receivedTo = '';
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

  async toggleRow(row: StockRow): Promise<void> {
    if (this.filterScope()) {
      // Drop out of filter scope: every matching row, minus this one.
      const m = await this.materializeScope();
      if (!m) return;
      m.delete(row.rowId);
      this.selectedRows.set(new Map(m));
      return;
    }
    const m = new Map(this.selectedRows());
    if (m.has(row.rowId)) m.delete(row.rowId);
    else m.set(row.rowId, row);
    this.selectedRows.set(m);
  }

  /**
   * All or nothing, against the filters — not against what happens to be on screen.
   *
   * The header box used to select the loaded rows and offer "select all matching" as a
   * second step, which read as a half-selection: in the grouped view it could only reach
   * units inside an open expansion, so ticking it with nothing expanded selected nothing.
   * One click now means every row the current filters describe, and a second means none.
   *
   * Anything already selected — by hand or in scope — makes the click mean clear. Growing
   * a hand-picked selection into everything is the one thing this box will not do, since
   * that is the click most likely to be a mistake and the hardest to notice.
   */
  toggleHeader(ev?: Event): void {
    if (this.someSelected()) this.clearSelection();
    else this.takeFilterScope();

    // Put the box back where the state says it belongs. Clicking it while it shows the
    // dash takes the bound value from false to false, so Angular writes nothing and the
    // browser's own tick survives a click that actually cleared the selection.
    const box = ev?.target as HTMLInputElement | null;
    if (box) {
      box.checked = this.filterScope();
      box.indeterminate = false;
    }
  }

  escalate(): void {
    this.takeFilterScope();
  }

  /**
   * Claim every row matching the filters, and find out how many that is.
   *
   * total() cannot answer that in the grouped view: there it counts product rows, while
   * the bulk actions resolve the scope into individual units — a dozen products can be
   * hundreds of units, and the bar would understate what a click is about to touch. The
   * flat list holds the real number, so ask it for a single row and keep the count.
   */
  private takeFilterScope(): void {
    this.selectedRows.set(new Map());
    this.filterScope.set(true);
    if (this.viewMode() === 'allItems') {
      this.scopeTotal.set(this.total());
      return;
    }
    this.scopeTotal.set(null);
    this.api.listStock({ ...this.currentFilters(), limit: 1, offset: 0 }).subscribe({
      // Ignored if the selection was dropped while this was in flight.
      next: (res) => {
        if (this.filterScope()) this.scopeTotal.set(res.total);
      },
    });
  }

  clearSelection(): void {
    this.selectedRows.set(new Map());
    this.filterScope.set(false);
    this.scopeTotal.set(null);
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
      // Included so "select all matching current filters" means the same set the grid
      // is showing — a product-narrowed grid must not escalate to the whole catalog.
      productId: this.productFilter ?? undefined,
      type: this.typeFilter ?? undefined,
      status: this.statusFilter,
      receivedFrom: this.receivedFrom || undefined,
      receivedTo: this.receivedTo || undefined,
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
    return this.fetchScopeRows();
  }

  /** Every row the current filters describe, paged out of the flat list and capped. */
  private async fetchScopeRows(): Promise<StockRow[]> {
    const CAP = 5000;
    // The API's shared pagination DTO rejects anything over 200 (common/pagination.ts).
    // This asked for 500 and every filter-scope bulk action died on the validator.
    const PAGE = 200;
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

  /**
   * Turn "everything matching the filters" into a concrete set of rows, so a single row
   * can then be dropped from it.
   *
   * Unticking one thing used to fall back to whatever was on screen, which in the grouped
   * view is only what somebody had expanded — so removing one product from a selection of
   * fifty-one silently threw away every unit nobody had opened. Fetching the real set
   * costs a request, and it is the only way the number after the click can be right.
   *
   * Returns null and leaves the scope alone if the fetch fails: an intact "all matching"
   * is a better answer than a selection quietly missing most of itself.
   */
  private async materializeScope(): Promise<Map<string, StockRow> | null> {
    this.busy.set(true);
    try {
      const rows = await this.fetchScopeRows();
      const m = new Map<string, StockRow>();
      for (const r of rows) m.set(r.rowId, r);
      this.filterScope.set(false);
      this.scopeTotal.set(null);
      this.selectedRows.set(m);
      return m;
    } catch (err) {
      this.bulkMessage.set(`Could not narrow the selection: ${messageFor(err)}`);
      return null;
    } finally {
      this.busy.set(false);
    }
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

  // ---- bulk: price ----
  openPrice(): void {
    this.dialogError.set(null);
    this.priceClear = false;
    this.priceValue = '';
    this.priceOpen.set(true);
  }

  /** Save goes live once there is something to send: a real number, or "use catalog". */
  priceReady(): boolean {
    return this.priceClear || (this.priceValue !== '' && Number.isFinite(Number(this.priceValue)));
  }

  pricePreview(): string {
    if (this.priceClear) return 'the default price of each product';
    return this.priceReady() ? this.formatMoney(String(this.priceValue)) : '…';
  }

  priceBulkLabel(): string {
    return this.priceEnabled() ? 'Edit price' : 'UPC items are priced on the product.';
  }

  async commitPrice(): Promise<void> {
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
      const byId = new Map(rows.map((r) => [r.itemId as string, r]));
      const ids = [...byId.keys()];
      // Round here rather than let the API reject the batch: a number input yields
      // things like 1.005 from arrow keys, and maxDecimalPlaces would 400 all of it.
      const price = this.priceClear ? null : Math.round(Number(this.priceValue) * 100) / 100;
      let ok = 0;
      const failures: string[] = [];
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const res = await firstValueFrom(this.api.bulkPrice(chunk, price));
        for (const r of res.results) {
          if (r.ok) ok++;
          else failures.push(`${byId.get(r.itemId)?.serial ?? r.itemId}: ${r.reason ?? 'skipped'}`);
        }
      }
      this.busy.set(false);
      this.priceOpen.set(false);
      this.bulkFailures.set(failures);
      this.bulkMessage.set(
        `Priced ${ok} item(s)${failures.length ? `, ${failures.length} skipped` : ''}.`,
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

  // ---- product rows and their expansions --------------------------------

  /**
   * What clicking a product row does, which depends on what the product IS.
   *
   * A serialized product expands: its units are individually identifiable, so there is
   * a lower tier worth showing. A UPC product has no units — selling one decrements a
   * counter — so there is nothing to expand TO, and the useful answer is its history.
   * When such a product sits in several locations there is no single history to open,
   * so it expands to those locations instead and each one opens its own.
   */
  onProductClick(p: ProductStockRow): void {
    if (p.trackingType === 'SERIALIZED' || p.rowCount > 1) {
      this.toggleExpanded(p);
      return;
    }
    // Exactly one stock row: open it straight away, which is the "goes to history" case.
    void this.openSoleStockRow(p);
  }

  isExpanded(p: ProductStockRow): boolean {
    return this.expanded().has(p.productId);
  }

  toggleExpanded(p: ProductStockRow): void {
    const open = new Set(this.expanded());
    if (open.has(p.productId)) {
      open.delete(p.productId);
      this.expanded.set(open);
      return;
    }
    this.expand(p);
    // Lazy: a product's rows are fetched the first time it is opened and then kept, so
    // closing and reopening costs nothing. A filter change drops the lot (collapseAll).
    void this.ensureUnits(p);
  }

  /**
   * Whether a product row has a lower tier at all. A UPC product with a single stock
   * row has none — a click opens its history instead — so it must not show a caret
   * promising an expansion that will not happen.
   */
  canExpand(p: ProductStockRow): boolean {
    return p.trackingType === 'SERIALIZED' || p.rowCount > 1;
  }

  toggleViewMode(): void {
    const mode = this.viewMode() === 'byProduct' ? 'allItems' : 'byProduct';
    this.viewMode.set(mode);
    sessionStorage.setItem('inv.viewMode', mode);
    // The two views count different things, so a page offset and a selection made in
    // one are meaningless in the other.
    this.collapseAll();
    this.clearSelection();
    this.offset.set(0);
    this.reload();
  }

  /**
   * A unit's own weight. Quantity stock rows have none — there is no unit to weigh — and
   * an unweighed unit has none either; both read as an em dash rather than 0 lbs.
   */
  unitWeight(row: StockRow): string {
    if (row.weightLbs == null) return '—';
    return `${this.formatLbs(row.weightLbs)} lbs`;
  }

  /**
   * What this unit actually sells for. The server already resolved the fallback, so
   * this never re-implements it — it only marks WHICH of the two it is.
   *
   * The dot means "somebody priced this unit deliberately"; without it the number is
   * the catalog's. Deliberately not a colour: an overridden price is not a warning,
   * and the grid already spends its colours on stock states that are.
   */
  unitPrice(row: StockRow): string {
    if (row.effectivePrice == null) return '—';
    const money = this.formatMoney(row.effectivePrice);
    return row.price != null ? `${money} •` : money;
  }

  /** Spells out what the dot means, and what it is overriding. */
  priceTitle(row: StockRow): string {
    if (row.effectivePrice == null) return 'No price set on this product';
    if (row.price == null) return 'Default price';
    const catalog =
      row.catalogPrice == null ? 'no default price' : this.formatMoney(row.catalogPrice);
    return `Priced on this unit — overrides ${catalog}`;
  }

  /** A product row shows the catalog price; its units may each differ underneath. */
  productPrice(p: ProductStockRow): string {
    return p.price == null ? '—' : this.formatMoney(p.price);
  }

  /** Currency-agnostic on purpose: no company currency exists yet to be wrong about. */
  private formatMoney(value: string): string {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(2) : value;
  }

  /**
   * A product's total weight, over exactly the units On hand counts.
   *
   * An asterisk marks a total that is incomplete because some of those units have no
   * recorded weight; the tooltip says how many. A partial sum presented as a whole number
   * of pounds is the one thing this column must never do.
   */
  productWeight(p: ProductStockRow): string {
    if (p.trackingType === 'QUANTITY') return '—';
    if (p.totalWeightLbs == null) return '—';
    const total = `${this.formatLbs(p.totalWeightLbs)} lbs`;
    return p.unweightedCount > 0 ? `${total}*` : total;
  }

  /** Explains the asterisk. Empty (no tooltip) when the total is complete. */
  weightTitle(p: ProductStockRow): string {
    if (p.trackingType === 'QUANTITY') return 'Quantity-tracked stock has no unit weight';
    if (p.unweightedCount === 0) return '';
    if (p.totalWeightLbs == null) {
      return `No recorded weight for any of the ${p.onHand} unit(s)`;
    }
    return `${p.unweightedCount} of ${p.onHand} units have no recorded weight`;
  }

  /**
   * Trims the numeric's trailing zeros without rounding away a real value: the column
   * mirrors an ERP decimal(18,8), so 12.4 shows as "12.4" and 0.125 keeps its precision.
   */
  private formatLbs(value: string): string {
    const n = Number(value);
    if (!Number.isFinite(n)) return value;
    return String(Number(n.toFixed(3)));
  }

  /** Open a product without closing it if it already is. */
  private expand(p: ProductStockRow): void {
    if (this.expanded().has(p.productId)) return;
    this.expanded.update((open) => new Set(open).add(p.productId));
  }

  /**
   * Tick a product = select everything under it.
   *
   * It expands as it selects, because a selection you cannot see is one you cannot
   * check before acting on it — and the bulk bar is about to offer to move or sell it.
   * The rows have to be loaded to be selected at all, so this awaits them.
   */
  async toggleProduct(p: ProductStockRow): Promise<void> {
    // Read the intent before the scope collapses: in scope the box is ticked, so the
    // click means "drop this product", and productAllSelected would say otherwise once
    // filterScope is off and this product's units are not loaded.
    const deselect = this.filterScope() || this.productAllSelected(p);

    // Leaving filter scope the same way a single row does: turn "all matching" into the
    // rows it actually stands for, so removing one product keeps the other fifty.
    if (this.filterScope() && !(await this.materializeScope())) return;
    this.expand(p);
    const rows = await this.ensureUnits(p);
    const next = new Map(this.selectedRows());
    for (const r of rows) {
      if (deselect) next.delete(r.rowId);
      else next.set(r.rowId, r);
    }
    this.selectedRows.set(next);
  }

  /**
   * How many rows of each product are selected, counted off the selection itself.
   *
   * The tri-state boxes used to ask units() — the rows an expansion had loaded — which
   * meant a product nobody had opened always read as unselected. After "select all" is
   * turned into concrete rows that is every product on the page: the count says fifty,
   * and all twenty-five boxes look empty. Each selected row knows its own product, so
   * the answer is already here without expanding anything.
   */
  private readonly selectedPerProduct = computed(() => {
    const counts = new Map<number, number>();
    for (const r of this.selectedRows().values()) {
      counts.set(r.productId, (counts.get(r.productId) ?? 0) + 1);
    }
    return counts;
  });

  /** Every row of this product, loaded or not, is selected. */
  productAllSelected(p: ProductStockRow): boolean {
    // Filter scope covers rows that were never fetched, so it answers for them too.
    if (this.filterScope()) return true;
    const n = this.selectedPerProduct().get(p.productId) ?? 0;
    return n > 0 && n >= p.rowCount;
  }

  /** Some but not all — drives the tri-state box. */
  productPartlySelected(p: ProductStockRow): boolean {
    if (this.filterScope()) return false;
    const n = this.selectedPerProduct().get(p.productId) ?? 0;
    return n > 0 && n < p.rowCount;
  }

  /** Collapse everything and forget the loaded sub-rows. */
  private collapseAll(): void {
    this.expanded.set(new Set());
    this.units.set(new Map());
    this.unitsLoading.set(new Set());
    this.unitsError.set(new Map());
  }

  unitsFor(p: ProductStockRow): StockRow[] {
    return this.units().get(p.productId) ?? [];
  }

  isUnitsLoading(p: ProductStockRow): boolean {
    return this.unitsLoading().has(p.productId);
  }

  unitsErrorFor(p: ProductStockRow): string | null {
    return this.unitsError().get(p.productId) ?? null;
  }

  /**
   * The sub-rows are the SAME query the grid ran, narrowed to this product — which is
   * what guarantees they are the rows its On hand counted. rowCount is the limit for
   * the same reason: it is how many the rollup said there would be.
   */
  private async ensureUnits(p: ProductStockRow): Promise<StockRow[]> {
    const cached = this.units().get(p.productId);
    if (cached) return cached;

    this.unitsLoading.update((m) => new Set(m).add(p.productId));
    this.unitsError.update((m) => {
      const next = new Map(m);
      next.delete(p.productId);
      return next;
    });
    try {
      const res = await firstValueFrom(
        this.api.listStock({
          ...this.currentFilters(),
          productId: p.productId,
          sortBy: 'expiration',
          sortDir: 'asc',
          limit: Math.max(p.rowCount, 1),
          offset: 0,
        }),
      );
      this.units.update((m) => new Map(m).set(p.productId, res.data));
      return res.data;
    } catch (err) {
      this.unitsError.update((m) => new Map(m).set(p.productId, messageFor(err)));
      return [];
    } finally {
      this.unitsLoading.update((m) => {
        const next = new Set(m);
        next.delete(p.productId);
        return next;
      });
    }
  }

  /** Fetch the single stock row behind a one-location UPC product and open its detail. */
  private async openSoleStockRow(p: ProductStockRow): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.api.listStock({ ...this.currentFilters(), productId: p.productId, limit: 1 }),
      );
      const row = res.data[0];
      if (row) this.openRow(row);
    } catch (err) {
      this.listError.set(messageFor(err));
    }
  }

  /** "N stores" / the store's name — the product row's rollup of a per-unit column. */
  productStoreLabel(p: ProductStockRow): string {
    return p.storeCount === 1 ? this.storeName(p.storeId) : `${p.storeCount} stores`;
  }

  productLocationLabel(p: ProductStockRow): string {
    if (p.locationCount === 1) return p.locationName ?? '—';
    return `${p.locationCount} locations`;
  }

  /**
   * A date column on a product row: one value when the range collapses, "a – b" when it
   * does not, so the row never implies a single date it does not have.
   */
  dateRange(from: string | null, to: string | null, withTime = false): string {
    if (!from && !to) return '—';
    const fmt = (v: string) => {
      // A date-only value (expiration) must be read as LOCAL, not UTC midnight:
      // new Date('2026-08-04') is UTC, so rendering it west of Greenwich showed the
      // 3rd. Angular's date pipe gets this right, which is why the unit rows were
      // correct while this helper was a day out.
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.exec(v);
      const d = dateOnly
        ? new Date(Number(v.slice(0, 4)), Number(v.slice(5, 7)) - 1, Number(v.slice(8, 10)))
        : new Date(v);
      return withTime ? d.toLocaleString() : d.toLocaleDateString();
    };
    if (!to || from === to) return fmt(from!);
    if (!from) return fmt(to);
    const a = fmt(from);
    const b = fmt(to);
    return a === b ? a : `${a} – ${b}`;
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
