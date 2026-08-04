import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  HostListener,
  inject,
  Input,
  OnInit,
  Output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import { Reorder, Store } from '../../core/models';

/**
 * Ask for more of one product.
 *
 * Opens by finding out whether that store already has a live request, because pressing
 * Reorder twice should show who asked and let you cancel — not raise a second request
 * and not fail with a duplicate error. Shared by the Products catalog (an admin picks
 * the store) and the Inventory grid (the row already knows it).
 */
@Component({
  selector: 'app-reorder-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="overlay" (click)="close.emit(false)">
      <div class="modal" (click)="$event.stopPropagation()">
        <h3>Reorder {{ productName }}</h3>
        <p class="muted sku">{{ sku }}</p>

        @if (error()) {
          <p class="error">{{ error() }}</p>
        }

        @if (loading()) {
          <p class="muted">Checking for an existing request…</p>
        } @else if (existing(); as ex) {
          <div class="existing">
            <p>
              <strong>Already requested.</strong>
              {{ ex.requestedBy || 'Someone' }} asked for
              {{ ex.quantityRequested == null ? 'more' : ex.quantityRequested }}
              at {{ ex.storeName }} on {{ ex.createdAt | date: 'medium' }}.
            </p>
            @if (ex.note) {
              <p class="note">“{{ ex.note }}”</p>
            }
            <p class="muted small">
              It stays open until the warehouse system picks it up, so there is nothing
              to add — unless it was a mistake.
            </p>
          </div>
          <div class="modal-actions">
            <button type="button" class="ghost" (click)="close.emit(false)">Close</button>
            <button type="button" class="danger" (click)="cancelExisting(ex)" [disabled]="busy()">
              Cancel request
            </button>
          </div>
        } @else {
          <form class="stacked-form" (ngSubmit)="submit()">
            @if (needsStorePick) {
              <label>
                Store <span class="req">*</span>
                <select name="ro-store" [(ngModel)]="chosenStoreId" (ngModelChange)="onStoreChange()">
                  @for (s of stores; track s.id) {
                    <option [ngValue]="s.id">{{ s.name }}</option>
                  }
                </select>
              </label>
            }
            <label>
              Quantity
              <input
                type="number"
                name="ro-qty"
                min="1"
                placeholder="Leave blank for “some”"
                [(ngModel)]="quantity"
              />
            </label>
            <label>
              Note
              <input
                type="text"
                name="ro-note"
                maxlength="500"
                placeholder="Why, or anything the warehouse should know"
                [(ngModel)]="note"
              />
            </label>
            <div class="modal-actions">
              <button type="button" class="ghost" (click)="close.emit(false)">Cancel</button>
              <button type="submit" [disabled]="busy()">
                {{ busy() ? 'Requesting…' : 'Request reorder' }}
              </button>
            </div>
          </form>
        }
      </div>
    </div>
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
        max-width: 440px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
      }
      h3 {
        margin: 0 0 0.1rem;
      }
      .sku {
        margin: 0 0 0.9rem;
        font-size: 0.85rem;
      }
      .muted {
        color: var(--muted);
      }
      .small {
        font-size: 0.8rem;
      }
      .error {
        color: #b42318;
        font-size: 0.85rem;
      }
      .existing p {
        margin: 0 0 0.5rem;
        font-size: 0.9rem;
      }
      .note {
        font-style: italic;
        color: var(--muted);
      }
      .stacked-form {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
      }
      .stacked-form label {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.85rem;
        color: var(--muted);
      }
      .req {
        color: #b42318;
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
export class ReorderDialogComponent implements OnInit {
  private readonly api = inject(ApiService);

  @Input({ required: true }) productId!: number;
  @Input({ required: true }) productName!: string;
  @Input({ required: true }) sku!: string;
  /** Known up front on the Inventory grid; null on the catalog, where the user picks. */
  @Input() storeId: number | null = null;
  /** Only used when storeId is null. */
  @Input() stores: Store[] = [];

  /** True when anything changed server-side, so the caller knows to reload. */
  @Output() close = new EventEmitter<boolean>();

  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly existing = signal<Reorder | null>(null);

  quantity: number | null = null;
  note = '';
  chosenStoreId: number | null = null;

  /**
   * Only when there is a choice to offer. A store user arrives with no storeId AND no
   * store list — the API scopes them to their own store — and rendering an empty select
   * for them would look broken.
   */
  get needsStorePick(): boolean {
    return this.storeId == null && this.stores.length > 0;
  }

  ngOnInit(): void {
    this.chosenStoreId = this.storeId ?? this.stores[0]?.id ?? null;
    this.checkExisting();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close.emit(false);
  }

  /** Re-check when the admin switches store: "already open" is per store. */
  onStoreChange(): void {
    this.checkExisting();
  }

  private checkExisting(): void {
    const storeId = this.chosenStoreId ?? undefined;
    this.loading.set(true);
    this.error.set(null);
    this.api
      .listReorders({ status: 'OPEN', storeId, productId: this.productId, limit: 1 })
      .subscribe({
        next: (page) => {
          this.existing.set(page.data[0] ?? null);
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(messageFor(err));
          this.loading.set(false);
        },
      });
  }

  submit(): void {
    if (this.busy()) return;
    const qty = this.quantity;
    if (qty != null && (!Number.isFinite(qty) || qty < 1)) {
      this.error.set('Quantity must be 1 or more, or left blank.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.api
      .createReorder({
        productId: this.productId,
        quantity: qty ?? undefined,
        note: this.note.trim() || undefined,
        storeId: this.chosenStoreId ?? undefined,
      })
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          if (res.created) {
            this.close.emit(true);
            return;
          }
          // Lost the race with somebody else pressing the same button. Show theirs
          // rather than pretending this one was raised.
          this.existing.set(res.request);
          this.error.set('Somebody just requested this — showing their request.');
        },
        error: (err) => {
          this.busy.set(false);
          this.error.set(messageFor(err));
        },
      });
  }

  cancelExisting(request: Reorder): void {
    this.busy.set(true);
    this.error.set(null);
    this.api.cancelReorder(request.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.close.emit(true);
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(messageFor(err));
      },
    });
  }
}
