import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Observable } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import { Product, UpdateProduct } from '../../core/models';

interface EditModel {
  sku: string;
  name: string;
  description: string;
  price: string;
  upc: string;
}

@Component({
  selector: 'app-needs-review',
  imports: [FormsModule],
  template: `
    <section class="card">
        <div class="row-between">
          <h2>Needs review</h2>
          <button class="ghost" (click)="reload()" [disabled]="loading()">Refresh</button>
        </div>

        @if (loading()) {
          <p class="muted">Loading…</p>
        } @else if (listError()) {
          <p class="error">{{ listError() }}</p>
        } @else if (products().length === 0) {
          <p class="muted">Nothing needs review. 🎉</p>
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
                  <th class="num">Price</th>
                  <th class="actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (p of products(); track p.id) {
                  <tr>
                    <td><input name="sku-{{ p.id }}" [(ngModel)]="edits[p.id].sku" /></td>
                    <td><input name="name-{{ p.id }}" [(ngModel)]="edits[p.id].name" /></td>
                    <td>
                      <span class="type-badge" [class]="'tt-' + p.trackingType">{{ p.trackingType }}</span>
                    </td>
                    <td>
                      <input name="desc-{{ p.id }}" [(ngModel)]="edits[p.id].description" />
                    </td>
                    <td><input name="upc-{{ p.id }}" [(ngModel)]="edits[p.id].upc" /></td>
                    <td class="num">
                      <input class="price" name="price-{{ p.id }}" [(ngModel)]="edits[p.id].price" />
                    </td>
                    <td class="actions">
                      <button class="ghost sm" (click)="save(p)" [disabled]="busyId() === p.id">
                        Save
                      </button>
                      <button class="ghost sm" (click)="complete(p)" [disabled]="busyId() === p.id">
                        Complete review
                      </button>
                      <button class="ghost sm danger" (click)="remove(p)" [disabled]="busyId() === p.id">
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
            price: p.price ?? '',
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

  save(p: Product): void {
    const e = this.edits[p.id];
    if (!e) return;
    const dto: UpdateProduct = {
      sku: e.sku,
      name: e.name,
      description: e.description,
      upc: e.upc.trim() === '' ? undefined : e.upc.trim(),
    };
    const price = Number(e.price);
    if (e.price.trim() !== '' && Number.isFinite(price)) dto.price = price;
    this.run(p, this.api.updateProduct(p.id, dto));
  }

  complete(p: Product): void {
    this.run(p, this.api.updateProduct(p.id, { needsReview: false }));
  }

  remove(p: Product): void {
    if (!confirm(`Delete product ${p.sku} (${p.name})? This cannot be undone.`)) {
      return;
    }
    // A 409 means the product still has inventory; messageFor surfaces it.
    this.run(p, this.api.deleteProduct(p.id));
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
