import {
  ChangeDetectionStrategy,
  Component,
  computed,
  EventEmitter,
  HostListener,
  inject,
  OnInit,
  Output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { messageFor } from '../../core/http-error';
import { Product, Store } from '../../core/models';
import { ReorderDialogComponent } from './reorder-dialog';

/**
 * Raise a reorder from the Reorders page: pick a product, then set a quantity.
 *
 * Two steps rather than one long form, because picking out of a catalog and saying how
 * many are different questions — and only the first one needs a search box. Step two is
 * the same {@link ReorderDialogComponent} the Inventory popup uses, so the duplicate
 * guard, the note field and the create call have exactly one implementation.
 *
 * The list shows catalog identity only — no stock figure. It is fed by the products
 * endpoint, and that endpoint deliberately holds no inventory data; asking Inventory as
 * well, per product, to decorate a picker would be a lot of queries for a number the
 * person pressing Reorder is usually looking at a shelf to judge.
 */
@Component({
  selector: 'app-reorder-new-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ReorderDialogComponent],
  template: `
    @if (chosen(); as product) {
      <!-- Step 2. Same dialog as the Inventory popup uses. -->
      <app-reorder-dialog
        [productId]="product.id"
        [productName]="product.name"
        [sku]="product.sku"
        [storeId]="storeId()"
        (close)="onQuantityClosed($event)"
      />
    } @else {
      <div class="overlay" (click)="close.emit(false)">
        <div class="modal" (click)="$event.stopPropagation()">
          <h3>New reorder</h3>
          <p class="muted sub">Pick the product that needs restocking.</p>

          @if (error()) {
            <p class="error">{{ error() }}</p>
          }

          <div class="picker-head">
            @if (isCompanyAdmin) {
              <label class="f">
                Store
                <select name="rn-store" [ngModel]="storeId()" (ngModelChange)="setStore($event)">
                  @for (s of stores(); track s.id) {
                    <option [ngValue]="s.id">{{ s.name }}</option>
                  }
                </select>
              </label>
            }
            <label class="f grow">
              Search
              <input
                #searchBox
                name="rn-search"
                placeholder="Name, SKU or barcode"
                autocomplete="off"
                [ngModel]="search()"
                (ngModelChange)="search.set($event)"
              />
            </label>
          </div>

          @if (loading()) {
            <p class="muted">Loading products…</p>
          } @else if (matches().length === 0) {
            <p class="muted">
              {{ search().trim() ? 'No product matches that.' : 'No active products.' }}
            </p>
          } @else {
            <ul class="plist">
              @for (p of matches(); track p.id) {
                <li>
                  <button type="button" class="prow" (click)="choose(p)">
                    <span class="pmain">
                      <span class="pname">{{ p.name }}</span>
                      <span class="pmeta">
                        {{ p.sku }}
                        @if (p.upc) {
                          · {{ p.upc }}
                        }
                        · {{ p.trackingType === 'QUANTITY' ? 'UPC' : 'Serialized' }}
                      </span>
                    </span>
                    <span class="pright">
                      @if (openProductIds().has(p.id)) {
                        <span class="ro-badge">Already open</span>
                      }
                    </span>
                  </button>
                </li>
              }
            </ul>
            @if (truncated()) {
              <p class="muted small">
                Showing the first {{ maxRows }} of {{ filteredCount() }} — narrow the search.
              </p>
            }
          }

          <div class="modal-actions">
            <button type="button" class="ghost" (click)="close.emit(false)">Cancel</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
        z-index: 60;
      }
      .modal {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 1.25rem;
        width: 100%;
        max-width: 560px;
        max-height: 85vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
      }
      h3 {
        margin: 0 0 0.1rem;
      }
      .sub {
        margin: 0 0 0.9rem;
        font-size: 0.85rem;
      }
      .muted {
        color: var(--muted);
      }
      .small {
        font-size: 0.78rem;
      }
      .error {
        color: #b42318;
        font-size: 0.85rem;
      }
      .picker-head {
        display: flex;
        gap: 0.6rem;
        align-items: flex-end;
        margin-bottom: 0.75rem;
      }
      .f {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        font-size: 0.75rem;
        color: var(--muted);
      }
      .f.grow {
        flex: 1;
      }
      /* Same control look as every other filter bar and dialog in the app. */
      input,
      select {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
      }
      .f input,
      .f select {
        height: 2.25rem;
        box-sizing: border-box;
      }
      /* The list scrolls, not the dialog: the search box has to stay put while you type. */
      .plist {
        list-style: none;
        margin: 0;
        padding: 0;
        overflow-y: auto;
        border: 1px solid var(--border);
        border-radius: 8px;
      }
      .plist li + li {
        border-top: 1px solid var(--border);
      }
      .prow {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        width: 100%;
        background: none;
        border: 0;
        padding: 0.5rem 0.65rem;
        text-align: left;
        font: inherit;
        color: inherit;
        cursor: pointer;
      }
      .prow:hover,
      .prow:focus-visible {
        background: color-mix(in srgb, var(--border) 35%, transparent);
        outline: none;
      }
      .pmain {
        display: flex;
        flex-direction: column;
        gap: 0.1rem;
        min-width: 0;
      }
      .pname {
        font-size: 0.9rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pmeta {
        font-size: 0.72rem;
        color: var(--muted);
      }
      .pright {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        flex-shrink: 0;
      }
      .ro-badge {
        font-size: 0.66rem;
        font-weight: 600;
        padding: 0.05rem 0.4rem;
        border-radius: 999px;
        white-space: nowrap;
        border: 1px solid #fed7aa;
        background: #fff7ed;
        color: #9a3412;
      }
      .modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        margin-top: 0.75rem;
      }
    `,
  ],
})
export class ReorderNewDialogComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  /** True when anything was raised or cancelled, so the caller reloads. */
  @Output() close = new EventEmitter<boolean>();

  readonly isCompanyAdmin = this.auth.user()?.role === 'COMPANY_ADMIN';

  /** Long lists are pointless to render in full; the search box is the way through. */
  readonly maxRows = 60;

  readonly products = signal<Product[]>([]);
  readonly stores = signal<Store[]>([]);
  readonly openProductIds = signal<Set<number>>(new Set());
  readonly search = signal('');
  readonly chosen = signal<Product | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  /** Null for a store user — the API scopes them, so there is nothing to choose. */
  readonly storeId = signal<number | null>(null);

  private readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const rows = this.products();
    if (!q) return rows;
    return rows.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.upc ?? '').toLowerCase().includes(q),
    );
  });

  readonly filteredCount = computed(() => this.filtered().length);
  readonly matches = computed(() => this.filtered().slice(0, this.maxRows));
  readonly truncated = computed(() => this.filteredCount() > this.maxRows);

  ngOnInit(): void {
    // Active only: reordering something withdrawn from the catalog is a mistake, and the
    // API refuses it anyway.
    this.api.listProducts({ active: true }).subscribe({
      next: (rows) => {
        this.products.set(rows);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(messageFor(err));
        this.loading.set(false);
      },
    });

    if (this.isCompanyAdmin) {
      this.api.listStores().subscribe({
        next: (rows) => {
          this.stores.set(rows);
          if (this.storeId() == null && rows.length > 0) {
            this.storeId.set(rows[0].id);
            this.loadOpen();
          }
        },
      });
    } else {
      this.loadOpen();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    // Only closes the picker; step two owns its own Escape.
    if (this.chosen() === null) this.close.emit(false);
  }

  setStore(id: number | null): void {
    this.storeId.set(id);
    this.loadOpen();
  }

  /**
   * Which products this store has already asked for. Marking them in the list is what
   * stops somebody picking one only to be told it is a duplicate on the next screen.
   */
  private loadOpen(): void {
    this.api
      .listReorders({ status: 'OPEN', storeId: this.storeId() ?? undefined, limit: 200 })
      .subscribe({
        next: (page) => this.openProductIds.set(new Set(page.data.map((r) => r.productId))),
        error: () => this.openProductIds.set(new Set()),
      });
  }

  choose(p: Product): void {
    this.chosen.set(p);
  }

  onQuantityClosed(changed: boolean): void {
    if (changed) {
      this.close.emit(true);
      return;
    }
    // Cancelled the quantity step: back to the list rather than out of the flow, and
    // refresh the markers in case the step cancelled an existing request.
    this.chosen.set(null);
    this.loadOpen();
  }
}
