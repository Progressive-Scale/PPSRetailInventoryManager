import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Observable } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import { ExpiringItem, ImportCheckStatus, Product } from '../../core/models';

/**
 * Everything a scan produced that the catalog could not explain, in one place.
 *
 * Two shapes live here because a scan can fail to identify a thing in two different
 * ways, and they need different fixes:
 *
 *   UNITS   — an unknown SERIAL. A serial names one physical object and says nothing
 *             about what it is, so the unit is created with NO product. Fixing it
 *             means identifying it: let PPS look it up, or attach a product by hand.
 *   PRODUCTS— an unknown UPC. A UPC does name a product, so a real (if empty) catalog
 *             row was created; fixing it means filling in its details.
 *
 * A unit leaves on its own the moment it is identified — by a PPS match or by hand.
 */
@Component({
  selector: 'app-count-needs-review',
  imports: [FormsModule, DatePipe],
  template: `
    <section class="card">
      <div class="section-head">
        <h2>Review</h2>
        <button class="ghost sm" (click)="reload()" [disabled]="loading()">Refresh</button>
      </div>
      <p class="muted small intro">
        Scans the catalog could not explain. Units with an unknown serial have no
        product yet; products came from an unknown UPC and need their details.
      </p>

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      <!-- ---------------- unidentified units ---------------- -->
      <h3>
        Unidentified units
        <span class="pill" [class.warn]="items().length > 0">{{ items().length }}</span>
      </h3>
      @if (loading()) {
        <p class="muted sm">Loading…</p>
      } @else if (items().length === 0) {
        <p class="muted sm">None — every scanned serial is identified.</p>
      } @else {
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th class="c-serial">Serial</th>
                <th class="c-where">Found</th>
                <th class="c-when">Scanned</th>
                <th class="c-check">PPS check</th>
                <th class="c-act actions"></th>
              </tr>
            </thead>
            <tbody>
              @for (it of items(); track it.id) {
                <tr>
                  <td class="mono">{{ it.serial }}</td>
                  <td class="muted">{{ it.locationName ?? '—' }}</td>
                  <td class="muted">{{ it.createdAt | date: 'MMM d' }}</td>
                  <td>
                    @if (it.importCheckStatus) {
                      <button
                        type="button"
                        class="badge"
                        [class]="'ic-' + it.importCheckStatus"
                        (click)="toggleDetail(it.id)"
                        [title]="checkTitle(it.importCheckStatus)"
                      >
                        {{ checkLabel(it.importCheckStatus) }}
                      </button>
                    } @else {
                      <span class="muted sm">not asked</span>
                    }
                  </td>
                  <td class="actions">
                    @if (it.importCheckStatus !== 'REQUESTED') {
                      <button
                        class="sm ghost"
                        (click)="askPps(it)"
                        [disabled]="busyId() === it.id"
                      >
                        {{ it.importCheckStatus ? 'Ask PPS again' : 'Check PPS' }}
                      </button>
                    }
                    <button class="sm ghost" (click)="startAssign(it)" [disabled]="busyId() === it.id">
                      Identify…
                    </button>
                  </td>
                </tr>
                @if (openDetail() === it.id && it.importCheckStatus) {
                  <tr class="detail-row">
                    <td colspan="5">
                      <p class="detail">{{ checkTitle(it.importCheckStatus) }}</p>
                      @if (detailFor(it); as extra) {
                        <pre class="payload">{{ extra }}</pre>
                      }
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </div>
      }

      <!-- ---------------- needs-review products ---------------- -->
      <h3 class="spaced">
        Products missing details
        <span class="pill" [class.warn]="reviewProducts().length > 0">
          {{ reviewProducts().length }}
        </span>
      </h3>
      @if (reviewProducts().length === 0) {
        <p class="muted sm">None.</p>
      } @else {
        <p class="muted sm hint">
          Click a row to open it in the catalog, where its name and details can be
          edited. "Mark reviewed" clears the flag without changing anything.
        </p>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Name</th>
                <th>UPC</th>
                <th>Type</th>
                <th class="actions"></th>
              </tr>
            </thead>
            <tbody>
              @for (p of reviewProducts(); track p.id) {
                <tr
                  class="clickable"
                  (click)="editInCatalog(p)"
                  [title]="'Edit ' + p.sku + ' in the catalog'"
                >
                  <td class="mono link">{{ p.sku }}</td>
                  <td class="ctext">{{ p.name }}</td>
                  <td class="muted">{{ p.upc ?? '—' }}</td>
                  <td class="muted">{{ p.trackingType === 'QUANTITY' ? 'UPC' : 'Serialized' }}</td>
                  <td class="actions">
                    <!-- Stops the row's own click: this row does two things and the
                         button is the one that does not navigate away. -->
                    <button
                      class="sm ghost"
                      (click)="$event.stopPropagation(); completeProduct(p)"
                      [disabled]="busySku() === p.sku"
                    >
                      Mark reviewed
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>

    <!-- ---------------- identify dialog ---------------- -->
    @if (assigning(); as target) {
      <div class="overlay" (click)="cancelAssign()">
        <div class="modal" (click)="$event.stopPropagation()">
          <h3>Identify {{ target.serial }}</h3>
          <p class="muted sm">
            Attach this unit to a catalog product. Serialized products only — a unit
            cannot belong to something counted by quantity.
          </p>
          <label>
            Product
            <select name="assign-product" [(ngModel)]="assignProductId">
              <option [ngValue]="null">Choose…</option>
              @for (p of serializedProducts(); track p.id) {
                <option [ngValue]="p.id">{{ p.sku }} — {{ p.name }}</option>
              }
            </select>
          </label>
          @if (assignError()) {
            <p class="error">{{ assignError() }}</p>
          }
          <div class="modal-actions">
            <button (click)="confirmAssign()" [disabled]="assignProductId == null || busyId() !== null">
              Identify
            </button>
            <button class="ghost" (click)="cancelAssign()">Cancel</button>
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
        margin: 0.35rem 0 1rem;
        max-width: 66ch;
        line-height: 1.45;
      }
      h3 {
        margin: 0 0 0.5rem;
        font-size: 0.92rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      h3.spaced {
        margin-top: 1.5rem;
      }
      .pill {
        font-size: 0.72rem;
        font-weight: 600;
        padding: 0.05rem 0.45rem;
        border-radius: 999px;
        background: var(--accent-soft, #eef2ff);
      }
      .pill.warn {
        background: #fef3c7;
        color: #92400e;
      }
      .muted {
        color: var(--muted);
      }
      .sm,
      .small {
        font-size: 0.8rem;
      }
      .error {
        color: #b42318;
        font-size: 0.85rem;
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
        padding: 0.45rem 0.6rem;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      td.actions,
      th.actions {
        text-align: right;
        white-space: nowrap;
      }
      button.sm {
        padding: 0.28rem 0.5rem;
        font-size: 0.78rem;
        margin-left: 0.25rem;
      }
      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.85rem;
      }
      .ctext {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .hint {
        margin: 0.35rem 0 0.6rem;
      }
      /* A product row is a link into the catalog, so it looks like one. */
      tr.clickable {
        cursor: pointer;
      }
      tr.clickable:hover td {
        background: #f8fafc;
      }
      tr.clickable .link {
        color: var(--brand, var(--accent));
        text-decoration: underline;
        text-decoration-style: dotted;
      }
      /* The badge is a button: the payload behind Discrepancy is the useful part. */
      .badge {
        font-size: 0.72rem;
        font-weight: 600;
        padding: 0.1rem 0.5rem;
        border-radius: 999px;
        border: 1px solid transparent;
        cursor: pointer;
        font-family: inherit;
      }
      .ic-REQUESTED {
        background: #eff6ff;
        color: #1d4ed8;
        border-color: #c7d7fe;
      }
      .ic-NOT_FOUND {
        background: #f3f4f6;
        color: #4b5563;
        border-color: #e5e7eb;
      }
      .ic-DISCREPANCY {
        background: #fef3c7;
        color: #92400e;
        border-color: #fcd34d;
      }
      .ic-MATCHED {
        background: #ecfdf3;
        color: #067647;
        border-color: #abefc6;
      }
      .detail-row td {
        background: #fafafa;
      }
      .detail {
        margin: 0 0 0.4rem;
        font-size: 0.85rem;
      }
      .payload {
        margin: 0;
        font-size: 0.75rem;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--muted);
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
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.8rem;
        color: var(--muted);
      }
      select {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
        font-family: inherit;
      }
      .modal-actions {
        display: flex;
        gap: 0.5rem;
        margin-top: 0.25rem;
      }
      .modal-actions button {
        padding: 0.45rem 0.9rem;
        border-radius: 8px;
        font-family: inherit;
        font-size: 0.9rem;
        cursor: pointer;
      }
      .modal-actions button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `,
  ],
})
export class CountNeedsReviewComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  readonly items = signal<ExpiringItem[]>([]);
  readonly allProducts = signal<Product[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly busyId = signal<string | null>(null);
  readonly busySku = signal<string | null>(null);
  readonly openDetail = signal<string | null>(null);

  readonly assigning = signal<ExpiringItem | null>(null);
  assignProductId: number | null = null;
  readonly assignError = signal<string | null>(null);

  /** Scanner-created catalog rows still missing their details. */
  readonly reviewProducts = computed(() =>
    this.allProducts().filter((p) => p.needsReview),
  );

  /** A unit can only belong to a serialized product. */
  readonly serializedProducts = computed(() =>
    this.allProducts()
      .filter((p) => p.trackingType === 'SERIALIZED')
      .sort((a, b) => a.sku.localeCompare(b.sku)),
  );

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.listItems({ status: 'ON_HAND', needsReview: true, limit: 200 }).subscribe({
      next: (res) => {
        this.items.set(res.data);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(messageFor(err));
      },
    });
    this.api.listProducts({}).subscribe({
      next: (rows) => this.allProducts.set(rows),
      error: () => {
        /* the units table is still usable without the catalog */
      },
    });
  }

  toggleDetail(id: string): void {
    this.openDetail.set(this.openDetail() === id ? null : id);
  }

  checkLabel(s: ImportCheckStatus): string {
    switch (s) {
      case 'REQUESTED':
        return 'Checking…';
      case 'NOT_FOUND':
        return 'Not found in PPS';
      case 'DISCREPANCY':
        return 'Discrepancy';
      case 'MATCHED':
        return 'Matched';
    }
  }

  checkTitle(s: ImportCheckStatus): string {
    switch (s) {
      case 'REQUESTED':
        return 'Waiting for PPS to identify this serial.';
      case 'NOT_FOUND':
        return 'PPS has no record of this serial. Identify it by hand, or ask again later.';
      case 'DISCREPANCY':
        return 'PPS knows this serial but something disagrees — see the detail below.';
      case 'MATCHED':
        return 'PPS identified it; this unit is on its way out of the queue.';
    }
  }

  /** The stored agent payload, pretty-printed. Only DISCREPANCY carries detail. */
  detailFor(it: ExpiringItem): string | null {
    const r = it.importCheckResult;
    if (!r) return null;
    return JSON.stringify(r, null, 2);
  }

  askPps(it: ExpiringItem): void {
    this.run(it.id, this.api.requestImportCheck(it.id));
  }

  startAssign(it: ExpiringItem): void {
    this.assignProductId = null;
    this.assignError.set(null);
    this.assigning.set(it);
  }

  cancelAssign(): void {
    this.assigning.set(null);
    this.assignError.set(null);
  }

  confirmAssign(): void {
    const it = this.assigning();
    const productId = this.assignProductId;
    if (!it || productId == null) return;
    this.busyId.set(it.id);
    this.assignError.set(null);
    this.api.updateItem(it.id, { productId }).subscribe({
      next: () => {
        this.busyId.set(null);
        this.assigning.set(null);
        this.reload();
      },
      error: (err) => {
        this.busyId.set(null);
        // Kept inside the dialog: the reason (wrong tracking type, say) is about the
        // choice just made, so it belongs next to the choice.
        this.assignError.set(messageFor(err));
      },
    });
  }

  /**
   * Open this product in the catalog, ready to edit. The name is the usual thing
   * wrong with a scanner-created product, and the catalog is where names are
   * edited — duplicating that editor here would give two places to change one field.
   */
  editInCatalog(p: Product): void {
    void this.router.navigate(['/products'], { queryParams: { edit: p.id } });
  }

  completeProduct(p: Product): void {
    this.busySku.set(p.sku);
    this.api.updateProduct(p.id, { needsReview: false }).subscribe({
      next: () => {
        this.busySku.set(null);
        this.reload();
      },
      error: (err) => {
        this.busySku.set(null);
        this.error.set(messageFor(err));
      },
    });
  }

  private run(id: string, obs: Observable<unknown>): void {
    this.busyId.set(id);
    this.error.set(null);
    obs.subscribe({
      next: () => {
        this.busyId.set(null);
        this.reload();
      },
      error: (err) => {
        this.busyId.set(null);
        this.error.set(messageFor(err));
      },
    });
  }
}
