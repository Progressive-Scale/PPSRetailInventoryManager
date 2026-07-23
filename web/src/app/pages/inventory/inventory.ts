import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import {
  CreateInventoryItem,
  InventoryItem,
  ItemStatus,
  Store,
  Transaction,
} from '../../core/models';

type StatusFilter = 'ALL' | ItemStatus;

interface NewItemModel {
  serial: string;
  sku: string;
  name: string;
  description: string;
  price: string;
  storeId: number | null;
}

@Component({
  selector: 'app-inventory',
  imports: [FormsModule, DatePipe],
  template: `
    <main class="container">
      <section class="card">
        <h2>New item</h2>
        <form class="add-form" (ngSubmit)="add()">
          <input placeholder="Serial" name="serial" [(ngModel)]="draft.serial" required />
          <input placeholder="SKU" name="sku" [(ngModel)]="draft.sku" required />
          <input placeholder="Name" name="name" [(ngModel)]="draft.name" required />
          <input placeholder="Description" name="description" [(ngModel)]="draft.description" />
          <input placeholder="Price" name="price" [(ngModel)]="draft.price" />
          @if (isCompanyAdmin) {
            <select name="store" [(ngModel)]="draft.storeId" required>
              <option [ngValue]="null" disabled>Select store…</option>
              @for (s of stores(); track s.id) {
                <option [ngValue]="s.id">{{ s.name }}</option>
              }
            </select>
          }
          <button type="submit" [disabled]="saving()">Add</button>
        </form>
        @if (formError()) {
          <p class="error">{{ formError() }}</p>
        }
      </section>

      <section class="card">
        <div class="row-between">
          <h2>Inventory</h2>
          <div class="filters">
            @if (isCompanyAdmin) {
              <label class="inline">
                Store
                <select [ngModel]="storeFilter()" (ngModelChange)="onStoreFilter($event)" name="sf">
                  <option [ngValue]="null">All</option>
                  @for (s of stores(); track s.id) {
                    <option [ngValue]="s.id">{{ s.name }}</option>
                  }
                </select>
              </label>
            }
            <label class="inline">
              Status
              <select [ngModel]="statusFilter()" (ngModelChange)="onStatusFilter($event)" name="stf">
                <option value="ALL">All</option>
                <option value="ON_HAND">On hand</option>
                <option value="SOLD">Sold</option>
                <option value="RETURNED_TO_WAREHOUSE">Returned</option>
                <option value="ADJUSTED_OUT">Adjusted out</option>
              </select>
            </label>
            <button class="ghost" (click)="reload()" [disabled]="loading()">Refresh</button>
          </div>
        </div>

        @if (loading()) {
          <p class="muted">Loading…</p>
        } @else if (listError()) {
          <p class="error">{{ listError() }}</p>
        } @else if (items().length === 0) {
          <p class="muted">No items match.</p>
        } @else {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>Serial</th>
                  <th>SKU</th>
                  <th>Name</th>
                  @if (isCompanyAdmin) {
                    <th>Store</th>
                  }
                  <th class="num">Price</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th class="actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (item of items(); track item.id) {
                  <tr>
                    <td>
                      <button class="link" (click)="toggleLedger(item)">
                        {{ expandedId() === item.id ? '▾' : '▸' }}
                      </button>
                    </td>
                    <td>{{ item.serial }}</td>
                    <td>{{ item.sku }}</td>
                    <td>{{ item.name }}</td>
                    @if (isCompanyAdmin) {
                      <td class="muted">{{ storeName(item.storeId) }}</td>
                    }
                    <td class="num">{{ money(item.price) }}</td>
                    <td><span class="status">{{ statusLabel(item.status) }}</span></td>
                    <td class="muted">{{ item.updatedAt | date: 'short' }}</td>
                    <td class="actions">
                      @if (item.status === 'ON_HAND') {
                        <button class="ghost sm" (click)="beginAction(item, 'sell')">Sell</button>
                      }
                      @if (item.status === 'ON_HAND' || item.status === 'SOLD') {
                        <button class="ghost sm" (click)="beginAction(item, 'return')">Return</button>
                        <button class="ghost sm" (click)="beginAction(item, 'adjust')">Adjust</button>
                      }
                    </td>
                  </tr>

                  @if (action() && action()!.itemId === item.id) {
                    <tr class="sub-row">
                      <td></td>
                      <td [attr.colspan]="colspan()">
                        <form class="note-form" (ngSubmit)="commitAction()">
                          <span class="note-label">{{ actionVerb() }} — optional note:</span>
                          <input name="note" [(ngModel)]="actionNote" placeholder="Note" />
                          <button type="submit" [disabled]="saving()">Confirm</button>
                          <button type="button" class="ghost" (click)="cancelAction()">Cancel</button>
                        </form>
                      </td>
                    </tr>
                  }

                  @if (expandedId() === item.id) {
                    <tr class="sub-row">
                      <td></td>
                      <td [attr.colspan]="colspan()">
                        @if (ledgerLoading()) {
                          <p class="muted">Loading ledger…</p>
                        } @else if (ledger().length === 0) {
                          <p class="muted">No transactions.</p>
                        } @else {
                          <table class="ledger">
                            <thead>
                              <tr>
                                <th>When</th>
                                <th>Type</th>
                                <th class="num">Δ Qty</th>
                                <th>Source</th>
                                <th>Note</th>
                              </tr>
                            </thead>
                            <tbody>
                              @for (tx of ledger(); track tx.id) {
                                <tr>
                                  <td class="muted">{{ tx.createdAt | date: 'short' }}</td>
                                  <td>{{ tx.type }}</td>
                                  <td class="num">{{ tx.quantityDelta }}</td>
                                  <td class="muted">{{ tx.source }}</td>
                                  <td class="muted">{{ tx.note }}</td>
                                </tr>
                              }
                            </tbody>
                          </table>
                        }
                      </td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>

          <div class="pager">
            <button class="ghost" (click)="prevPage()" [disabled]="offset() === 0 || loading()">
              Prev
            </button>
            <span class="muted">{{ rangeLabel() }}</span>
            <button class="ghost" (click)="nextPage()" [disabled]="!hasNext() || loading()">
              Next
            </button>
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
      .filters {
        display: flex;
        align-items: flex-end;
        gap: 0.75rem;
        flex-wrap: wrap;
      }
      .inline {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        font-size: 0.75rem;
        color: var(--muted);
      }
      .add-form {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        align-items: center;
      }
      input,
      select {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
      }
      .add-form input {
        flex: 1 1 130px;
        min-width: 110px;
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
      .status {
        font-size: 0.78rem;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--brand, var(--accent));
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
      button.link {
        background: transparent;
        border: none;
        color: var(--muted);
        padding: 0.1rem 0.3rem;
      }
      .sub-row td {
        background: var(--bg);
      }
      .note-form {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        flex-wrap: wrap;
      }
      .note-form input {
        flex: 1 1 200px;
      }
      .note-label {
        font-size: 0.85rem;
        color: var(--muted);
      }
      table.ledger {
        margin: 0;
      }
      table.ledger th {
        font-size: 0.72rem;
        color: var(--muted);
      }
      .pager {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.75rem;
        margin-top: 0.85rem;
        font-size: 0.85rem;
      }
    `,
  ],
})
export class InventoryComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);

  readonly isCompanyAdmin = this.auth.user()?.role === 'COMPANY_ADMIN';

  readonly items = signal<InventoryItem[]>([]);
  readonly total = signal(0);
  readonly limit = signal(20);
  readonly offset = signal(0);

  readonly stores = signal<Store[]>([]);
  private readonly storeMap = computed(() => {
    const m = new Map<number, string>();
    for (const s of this.stores()) m.set(s.id, s.name);
    return m;
  });

  readonly statusFilter = signal<StatusFilter>('ALL');
  readonly storeFilter = signal<number | null>(null);

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly listError = signal<string | null>(null);
  readonly formError = signal<string | null>(null);

  readonly expandedId = signal<string | null>(null);
  readonly ledger = signal<Transaction[]>([]);
  readonly ledgerLoading = signal(false);

  readonly action = signal<{ itemId: string; verb: 'sell' | 'return' | 'adjust' } | null>(null);
  actionNote = '';

  draft: NewItemModel = this.emptyDraft();

  readonly colspan = computed(() => (this.isCompanyAdmin ? 7 : 6));

  readonly hasNext = computed(() => this.offset() + this.items().length < this.total());
  readonly rangeLabel = computed(() => {
    const start = this.total() === 0 ? 0 : this.offset() + 1;
    const end = this.offset() + this.items().length;
    return `${start}–${end} of ${this.total()}`;
  });

  ngOnInit(): void {
    if (this.isCompanyAdmin) {
      this.api.listStores().subscribe({
        next: (rows) => this.stores.set(rows),
        error: () => {
          /* stores optional for display */
        },
      });
    }
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.listError.set(null);
    this.expandedId.set(null);
    this.action.set(null);
    const status = this.statusFilter();
    this.api
      .listInventory({
        status: status === 'ALL' ? undefined : status,
        storeId: this.storeFilter() ?? undefined,
        limit: this.limit(),
        offset: this.offset(),
      })
      .subscribe({
        next: (res) => {
          this.items.set(res.data);
          this.total.set(res.total);
          this.loading.set(false);
        },
        error: (err) => {
          this.loading.set(false);
          this.listError.set(messageFor(err));
        },
      });
  }

  onStatusFilter(value: StatusFilter): void {
    this.statusFilter.set(value);
    this.offset.set(0);
    this.reload();
  }

  onStoreFilter(value: number | null): void {
    this.storeFilter.set(value);
    this.offset.set(0);
    this.reload();
  }

  prevPage(): void {
    if (this.offset() === 0) return;
    this.offset.set(Math.max(0, this.offset() - this.limit()));
    this.reload();
  }

  nextPage(): void {
    if (!this.hasNext()) return;
    this.offset.set(this.offset() + this.limit());
    this.reload();
  }

  add(): void {
    if (!this.draft.serial || !this.draft.sku || !this.draft.name) {
      this.formError.set('Serial, SKU and name are required.');
      return;
    }
    if (this.isCompanyAdmin && this.draft.storeId == null) {
      this.formError.set('Please select a store.');
      return;
    }
    const dto: CreateInventoryItem = {
      serial: this.draft.serial,
      sku: this.draft.sku,
      name: this.draft.name,
    };
    if (this.draft.description) dto.description = this.draft.description;
    if (this.draft.price) dto.price = this.draft.price;
    if (this.isCompanyAdmin && this.draft.storeId != null) dto.storeId = this.draft.storeId;

    this.saving.set(true);
    this.formError.set(null);
    this.api.createInventory(dto).subscribe({
      next: () => {
        this.saving.set(false);
        this.draft = this.emptyDraft();
        this.offset.set(0);
        this.reload();
      },
      error: (err) => {
        this.saving.set(false);
        this.formError.set(messageFor(err));
      },
    });
  }

  beginAction(item: InventoryItem, verb: 'sell' | 'return' | 'adjust'): void {
    this.expandedId.set(null);
    this.actionNote = '';
    this.action.set({ itemId: item.id, verb });
  }

  cancelAction(): void {
    this.action.set(null);
  }

  actionVerb(): string {
    const a = this.action();
    if (!a) return '';
    return a.verb.charAt(0).toUpperCase() + a.verb.slice(1);
  }

  commitAction(): void {
    const a = this.action();
    if (!a) return;
    const note = this.actionNote.trim() || undefined;
    const call =
      a.verb === 'sell'
        ? this.api.sellItem(a.itemId, note)
        : a.verb === 'return'
          ? this.api.returnItem(a.itemId, note)
          : this.api.adjustItem(a.itemId, note);
    this.saving.set(true);
    this.listError.set(null);
    call.subscribe({
      next: () => {
        this.saving.set(false);
        this.action.set(null);
        this.reload();
      },
      error: (err) => {
        this.saving.set(false);
        this.listError.set(messageFor(err));
      },
    });
  }

  toggleLedger(item: InventoryItem): void {
    this.action.set(null);
    if (this.expandedId() === item.id) {
      this.expandedId.set(null);
      return;
    }
    this.expandedId.set(item.id);
    this.ledger.set([]);
    this.ledgerLoading.set(true);
    this.api.listTransactions({ itemId: item.id, limit: 50, offset: 0 }).subscribe({
      next: (res) => {
        this.ledger.set(res.data);
        this.ledgerLoading.set(false);
      },
      error: () => {
        this.ledgerLoading.set(false);
      },
    });
  }

  storeName(id: number): string {
    return this.storeMap().get(id) ?? `#${id}`;
  }

  money(price: string): string {
    const n = Number(price);
    return Number.isFinite(n) ? n.toFixed(2) : price;
  }

  statusLabel(status: ItemStatus): string {
    switch (status) {
      case 'ON_HAND':
        return 'On hand';
      case 'SOLD':
        return 'Sold';
      case 'RETURNED_TO_WAREHOUSE':
        return 'Returned';
      case 'ADJUSTED_OUT':
        return 'Adjusted out';
    }
  }

  private emptyDraft(): NewItemModel {
    return { serial: '', sku: '', name: '', description: '', price: '', storeId: null };
  }
}
