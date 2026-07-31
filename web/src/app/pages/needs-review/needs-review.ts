import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Observable } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import { Product, TrackingType, UpdateProduct } from '../../core/models';

interface EditModel {
  sku: string;
  name: string;
  description: string;
  upc: string;
}

@Component({
  selector: 'app-needs-review',
  imports: [FormsModule],
  template: `
    <section class="card">
        <div class="row-between">
          <h2>Needs review</h2>
          <span class="muted small">{{ filtered().length }} of {{ products().length }}</span>
        </div>

        <div class="filters">
          <label class="f">
            Search
            <input
              name="nr-search"
              placeholder="SKU, name, description, UPC"
              [ngModel]="search()"
              (ngModelChange)="search.set($event)"
            />
          </label>
          <label class="f">
            Type
            <select name="nr-type" [ngModel]="typeFilter()" (ngModelChange)="typeFilter.set($event)">
              <option [ngValue]="null">All</option>
              <option [ngValue]="'SERIALIZED'">Serialized</option>
              <option [ngValue]="'QUANTITY'">UPC</option>
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

        @if (loading()) {
          <p class="muted">Loading…</p>
        } @else if (listError()) {
          <p class="error">{{ listError() }}</p>
        } @else if (products().length === 0) {
          <p class="muted">Nothing needs review. 🎉</p>
        } @else if (filtered().length === 0) {
          <p class="muted">No products match these filters.</p>
        } @else {
          @if (actionError()) {
            <p class="error">{{ actionError() }}</p>
          }
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Description</th>
                  <th>UPC</th>
                  <th class="actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (p of filtered(); track p.id) {
                  <tr>
                    <td><input name="sku-{{ p.id }}" [(ngModel)]="edits[p.id].sku" /></td>
                    <td><input name="name-{{ p.id }}" [(ngModel)]="edits[p.id].name" /></td>
                    <td>
                      <span class="type-badge" [class]="'tt-' + p.trackingType">
                        {{ typeLabel(p) }}
                      </span>
                    </td>
                    <td>
                      <input name="desc-{{ p.id }}" [(ngModel)]="edits[p.id].description" />
                    </td>
                    <td><input name="upc-{{ p.id }}" [(ngModel)]="edits[p.id].upc" /></td>
                    <td class="actions">
                      <button class="ghost sm" (click)="save(p)" [disabled]="busyId() === p.id">
                        Save
                      </button>
                      <button class="ghost sm" (click)="complete(p)" [disabled]="busyId() === p.id">
                        Complete review
                      </button>
                      <button class="ghost sm danger" (click)="askDelete(p)" [disabled]="busyId() === p.id">
                        Delete
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      @if (deleting(); as target) {
        <div class="overlay" (click)="cancelDelete()">
          <div class="modal" (click)="$event.stopPropagation()">
            <h3>Delete product</h3>
            <p class="confirm-text">
              Delete {{ target.sku }} ({{ target.name }})? This cannot be undone.
            </p>
            @if (deleteError()) {
              <p class="error">{{ deleteError() }}</p>
            }
            <div class="modal-actions">
              <button class="danger-btn" (click)="confirmDelete()" [disabled]="busyId() !== null">
                {{ busyId() !== null ? 'Deleting…' : 'Delete' }}
              </button>
              <button class="ghost" (click)="cancelDelete()" [disabled]="busyId() !== null">
                Cancel
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
      h2 {
        margin: 0 0 0.85rem;
        font-size: 1.05rem;
      }
      .row-between {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .small {
        font-size: 0.8rem;
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
      .filters select {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
        font-family: inherit;
      }
      .filters input {
        min-width: 220px;
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
      td.actions,
      th.actions {
        text-align: right;
        white-space: nowrap;
      }
      input {
        padding: 0.4rem 0.5rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.88rem;
        width: 100%;
        min-width: 90px;
      }
      input.price {
        text-align: right;
        max-width: 90px;
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
export class NeedsReviewComponent implements OnInit {
  private readonly api = inject(ApiService);

  readonly products = signal<Product[]>([]);
  readonly loading = signal(false);
  readonly listError = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly busyId = signal<number | null>(null);

  readonly search = signal('');
  readonly typeFilter = signal<TrackingType | null>(null);

  /** The product awaiting delete confirmation, if any. */
  readonly deleting = signal<Product | null>(null);
  readonly deleteError = signal<string | null>(null);

  readonly filtersActive = computed(
    () => this.search().trim().length > 0 || this.typeFilter() !== null,
  );

  // The endpoint returns the whole review queue in one response, so filtering
  // client-side stays consistent with the count shown above the table.
  readonly filtered = computed(() => {
    const term = this.search().trim().toLowerCase();
    const type = this.typeFilter();
    return this.products().filter((p) => {
      if (type && p.trackingType !== type) return false;
      if (!term) return true;
      return [p.sku, p.name, p.description, p.upc]
        .filter((v): v is string => !!v)
        .join(' ')
        .toLowerCase()
        .includes(term);
    });
  });

  edits: Record<number, EditModel> = {};

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.listError.set(null);
    this.actionError.set(null);
    this.api.listProducts({ needsReview: true }).subscribe({
      next: (rows) => {
        this.products.set(rows);
        this.edits = {};
        for (const p of rows) {
          this.edits[p.id] = {
            sku: p.sku ?? '',
            name: p.name ?? '',
            description: p.description ?? '',
            upc: p.upc ?? '',
          };
        }
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.listError.set(messageFor(err));
      },
    });
  }

  clearFilters(): void {
    this.search.set('');
    this.typeFilter.set(null);
  }

  /** QUANTITY products are identified by UPC, which is what staff call them. */
  typeLabel(p: Product): string {
    return p.trackingType === 'QUANTITY' ? 'UPC' : 'Serialized';
  }

  save(p: Product): void {
    const e = this.edits[p.id];
    if (!e) return;
    // price is deliberately absent: pricing is hidden across the product screens
    // and the API leaves a stored price untouched when the field is omitted.
    const dto: UpdateProduct = {
      sku: e.sku,
      name: e.name,
      description: e.description,
      upc: e.upc.trim() === '' ? undefined : e.upc.trim(),
    };
    this.run(p, this.api.updateProduct(p.id, dto));
  }

  complete(p: Product): void {
    this.run(p, this.api.updateProduct(p.id, { needsReview: false }));
  }

  askDelete(p: Product): void {
    this.deleteError.set(null);
    this.deleting.set(p);
  }

  cancelDelete(): void {
    this.deleting.set(null);
    this.deleteError.set(null);
  }

  /**
   * A 409 here means the product still has inventory. The reason belongs in the
   * dialog the user is looking at, not in a banner at the top of the page, so the
   * dialog stays open and shows it.
   */
  confirmDelete(): void {
    const p = this.deleting();
    if (!p) return;
    this.busyId.set(p.id);
    this.deleteError.set(null);
    this.api.deleteProduct(p.id).subscribe({
      next: () => {
        this.busyId.set(null);
        this.deleting.set(null);
        this.reload();
      },
      error: (err: unknown) => {
        this.busyId.set(null);
        this.deleteError.set(messageFor(err));
      },
    });
  }

  private run(p: Product, obs: Observable<unknown>): void {
    this.busyId.set(p.id);
    this.actionError.set(null);
    obs.subscribe({
      next: () => {
        this.busyId.set(null);
        this.reload();
      },
      error: (err: unknown) => {
        this.busyId.set(null);
        this.actionError.set(messageFor(err));
      },
    });
  }
}
