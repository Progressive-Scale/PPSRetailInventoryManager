import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Observable } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import { InventoryItem, UpdateInventoryItem } from '../../core/models';

interface EditModel {
  name: string;
  description: string;
  price: string;
  upc: string;
}

@Component({
  selector: 'app-needs-review',
  imports: [FormsModule],
  template: `
    <main class="container">
      <section class="card">
        <div class="row-between">
          <h2>Needs review</h2>
          <button class="ghost" (click)="reload()" [disabled]="loading()">Refresh</button>
        </div>

        @if (loading()) {
          <p class="muted">Loading…</p>
        } @else if (listError()) {
          <p class="error">{{ listError() }}</p>
        } @else if (items().length === 0) {
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
                  <th>Serial</th>
                  <th>Name</th>
                  <th>Description</th>
                  <th>UPC</th>
                  <th class="num">Price</th>
                  <th class="actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (item of items(); track item.id) {
                  <tr>
                    <td class="muted">{{ item.sku }}</td>
                    <td class="muted">{{ item.serial }}</td>
                    <td><input name="name-{{ item.id }}" [(ngModel)]="edits[item.id].name" /></td>
                    <td>
                      <input name="desc-{{ item.id }}" [(ngModel)]="edits[item.id].description" />
                    </td>
                    <td><input name="upc-{{ item.id }}" [(ngModel)]="edits[item.id].upc" /></td>
                    <td class="num">
                      <input class="price" name="price-{{ item.id }}" [(ngModel)]="edits[item.id].price" />
                    </td>
                    <td class="actions">
                      <button class="ghost sm" (click)="save(item)" [disabled]="busyId() === item.id">
                        Save
                      </button>
                      <button class="ghost sm" (click)="complete(item)" [disabled]="busyId() === item.id">
                        Complete
                      </button>
                      <button class="ghost sm danger" (click)="remove(item)" [disabled]="busyId() === item.id">
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

  readonly items = signal<InventoryItem[]>([]);
  readonly loading = signal(false);
  readonly listError = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly busyId = signal<string | null>(null);

  edits: Record<string, EditModel> = {};

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.listError.set(null);
    this.actionError.set(null);
    this.api.listInventory({ needsReview: true, limit: 100, offset: 0 }).subscribe({
      next: (res) => {
        this.items.set(res.data);
        this.edits = {};
        for (const it of res.data) {
          this.edits[it.id] = {
            name: it.name ?? '',
            description: it.description ?? '',
            price: it.price ?? '',
            upc: it.upc ?? '',
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

  save(item: InventoryItem): void {
    const e = this.edits[item.id];
    if (!e) return;
    const dto: UpdateInventoryItem = {
      name: e.name,
      description: e.description,
      price: e.price,
      upc: e.upc.trim() === '' ? null : e.upc.trim(),
    };
    this.run(item, this.api.updateInventory(item.id, dto));
  }

  complete(item: InventoryItem): void {
    this.run(item, this.api.updateInventory(item.id, { needsReview: false }));
  }

  remove(item: InventoryItem): void {
    if (!confirm(`Delete item ${item.sku} (serial ${item.serial})? This cannot be undone.`)) {
      return;
    }
    this.run(item, this.api.deleteItem(item.id));
  }

  private run(item: InventoryItem, obs: Observable<unknown>): void {
    this.busyId.set(item.id);
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
