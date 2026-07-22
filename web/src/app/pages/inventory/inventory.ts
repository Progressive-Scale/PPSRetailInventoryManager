import { DatePipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../../core/auth.service';
import { InventoryService } from '../../core/inventory.service';
import {
  CreateInventoryItem,
  InventoryItem,
  UpdateInventoryItem,
} from '../../core/models';

interface EditModel {
  sku: string;
  name: string;
  description: string;
  quantity: number;
  price: number;
}

@Component({
  selector: 'app-inventory',
  imports: [FormsModule, DatePipe],
  template: `
    <header class="topbar">
      <div>
        <strong>PPS Retail Inventory</strong>
        @if (auth.user(); as u) {
          <span class="who">
            {{ u.email }}
            <span class="badge">{{ u.role === 'ADMIN' ? 'Admin' : 'Store ' + u.storeId }}</span>
          </span>
        }
      </div>
      <button class="ghost" (click)="logout()">Sign out</button>
    </header>

    <main class="container">
      <section class="card">
        <h2>Add item</h2>
        <form class="add-form" (ngSubmit)="add()">
          <input placeholder="SKU" name="sku" [(ngModel)]="draft.sku" required />
          <input placeholder="Name" name="name" [(ngModel)]="draft.name" required />
          <input placeholder="Description" name="description" [(ngModel)]="draft.description" />
          <input placeholder="Qty" name="quantity" type="number" min="0" [(ngModel)]="draft.quantity" />
          <input placeholder="Price" name="price" type="number" min="0" step="0.01" [(ngModel)]="draft.price" />
          <button type="submit" [disabled]="saving()">Add</button>
        </form>
        @if (error()) {
          <p class="error">{{ error() }}</p>
        }
      </section>

      <section class="card">
        <div class="row-between">
          <h2>Inventory</h2>
          <button class="ghost" (click)="reload()" [disabled]="loading()">Refresh</button>
        </div>

        @if (loading()) {
          <p class="muted">Loading…</p>
        } @else if (items().length === 0) {
          <p class="muted">No items yet. Add one above.</p>
        } @else {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Name</th>
                  <th>Description</th>
                  <th class="num">Qty</th>
                  <th class="num">Price</th>
                  <th>Updated</th>
                  <th class="actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (item of items(); track item.id) {
                  <tr>
                    @if (editingId() === item.id) {
                      <td><input name="e-sku" [(ngModel)]="edit.sku" /></td>
                      <td><input name="e-name" [(ngModel)]="edit.name" /></td>
                      <td><input name="e-desc" [(ngModel)]="edit.description" /></td>
                      <td class="num"><input class="num-input" type="number" name="e-qty" [(ngModel)]="edit.quantity" /></td>
                      <td class="num"><input class="num-input" type="number" step="0.01" name="e-price" [(ngModel)]="edit.price" /></td>
                      <td class="muted">{{ item.updatedAt | date: 'short' }}</td>
                      <td class="actions">
                        <button (click)="saveEdit(item)" [disabled]="saving()">Save</button>
                        <button class="ghost" (click)="cancelEdit()">Cancel</button>
                      </td>
                    } @else {
                      <td>{{ item.sku }}</td>
                      <td>{{ item.name }}</td>
                      <td class="muted">{{ item.description }}</td>
                      <td class="num">{{ item.quantity }}</td>
                      <td class="num">{{ item.price }}</td>
                      <td class="muted">{{ item.updatedAt | date: 'short' }}</td>
                      <td class="actions">
                        <button class="ghost" (click)="startEdit(item)">Edit</button>
                        <button class="danger" (click)="remove(item)" [disabled]="saving()">Delete</button>
                      </td>
                    }
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
      .topbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.75rem 1.25rem;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
      }
      .who {
        margin-left: 0.75rem;
        color: var(--muted);
        font-size: 0.85rem;
      }
      .badge {
        margin-left: 0.35rem;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 0.75rem;
      }
      .container {
        max-width: 1000px;
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
      }
      .add-form {
        display: grid;
        grid-template-columns: 1fr 1fr 1.5fr 80px 100px auto;
        gap: 0.5rem;
        align-items: center;
      }
      input {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
        width: 100%;
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
      .num-input {
        max-width: 90px;
      }
      td.actions,
      th.actions {
        text-align: right;
        white-space: nowrap;
      }
      .muted {
        color: var(--muted);
      }
      .error {
        color: #b42318;
        font-size: 0.85rem;
      }
      @media (max-width: 720px) {
        .add-form {
          grid-template-columns: 1fr 1fr;
        }
      }
    `,
  ],
})
export class InventoryComponent implements OnInit {
  readonly auth = inject(AuthService);
  private readonly inventory = inject(InventoryService);
  private readonly router = inject(Router);

  readonly items = signal<InventoryItem[]>([]);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly editingId = signal<string | null>(null);

  draft: CreateInventoryItem = this.emptyDraft();
  edit: EditModel = { sku: '', name: '', description: '', quantity: 0, price: 0 };

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.inventory.list().subscribe({
      next: (rows) => {
        this.items.set(rows);
        this.loading.set(false);
      },
      error: (err: HttpErrorResponse) => {
        this.loading.set(false);
        this.error.set(this.messageFor(err));
      },
    });
  }

  add(): void {
    if (!this.draft.sku || !this.draft.name) {
      this.error.set('SKU and name are required.');
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    this.inventory.create(this.draft).subscribe({
      next: () => {
        this.saving.set(false);
        this.draft = this.emptyDraft();
        this.reload();
      },
      error: (err: HttpErrorResponse) => {
        this.saving.set(false);
        this.error.set(this.messageFor(err));
      },
    });
  }

  startEdit(item: InventoryItem): void {
    this.editingId.set(item.id);
    this.edit = {
      sku: item.sku,
      name: item.name,
      description: item.description ?? '',
      quantity: item.quantity,
      price: Number(item.price),
    };
  }

  cancelEdit(): void {
    this.editingId.set(null);
  }

  saveEdit(item: InventoryItem): void {
    this.saving.set(true);
    this.error.set(null);
    const dto: UpdateInventoryItem = {
      sku: this.edit.sku,
      name: this.edit.name,
      description: this.edit.description,
      quantity: Number(this.edit.quantity),
      price: Number(this.edit.price),
    };
    this.inventory.update(item.id, dto).subscribe({
      next: () => {
        this.saving.set(false);
        this.editingId.set(null);
        this.reload();
      },
      error: (err: HttpErrorResponse) => {
        this.saving.set(false);
        this.error.set(this.messageFor(err));
      },
    });
  }

  remove(item: InventoryItem): void {
    if (!confirm(`Delete "${item.name}" (${item.sku})?`)) return;
    this.saving.set(true);
    this.error.set(null);
    this.inventory.remove(item.id).subscribe({
      next: () => {
        this.saving.set(false);
        this.reload();
      },
      error: (err: HttpErrorResponse) => {
        this.saving.set(false);
        this.error.set(this.messageFor(err));
      },
    });
  }

  logout(): void {
    this.auth.logout();
    void this.router.navigate(['/login']);
  }

  private emptyDraft(): CreateInventoryItem {
    return { sku: '', name: '', description: '', quantity: 0, price: 0 };
  }

  private messageFor(err: HttpErrorResponse): string {
    const msg = (err.error as { message?: string | string[] } | null)?.message;
    if (Array.isArray(msg)) return msg.join(', ');
    if (typeof msg === 'string') return msg;
    return 'Request failed. Please try again.';
  }
}
