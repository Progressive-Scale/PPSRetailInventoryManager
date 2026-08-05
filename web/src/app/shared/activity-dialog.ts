import { Component, EventEmitter, Input, Output } from '@angular/core';
import { ActivityLogComponent } from './activity-log';

/**
 * A row's history in a popup, for the list screens that have no detail view of their own
 * (locations, reorders, invitations, products). Same overlay/modal shell as the other
 * dialogs so it does not read as a new kind of thing.
 */
@Component({
  selector: 'app-activity-dialog',
  imports: [ActivityLogComponent],
  template: `
    <div class="overlay" (click)="close.emit()">
      <div class="modal" (click)="$event.stopPropagation()">
        <div class="modal-head">
          <div>
            <h2>History</h2>
            <span class="muted">{{ subtitle }}</span>
          </div>
          <button class="ghost" (click)="close.emit()">Close</button>
        </div>
        <app-activity-log [entityType]="entityType" [entityId]="entityId" />
      </div>
    </div>
  `,
  styles: [
    `
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: 3rem 1rem;
        z-index: 90;
        overflow-y: auto;
      }
      .modal {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        width: 100%;
        max-width: 720px;
        padding: 1.25rem;
      }
      .modal-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1rem;
        margin-bottom: 0.75rem;
      }
      h2 {
        margin: 0;
        font-size: 1.05rem;
        display: inline;
      }
      .muted {
        color: var(--muted);
        font-size: 0.85rem;
        margin-left: 0.4rem;
      }
    `,
  ],
})
export class ActivityDialogComponent {
  @Input({ required: true }) entityType!: string;
  @Input({ required: true }) entityId!: string | number;
  /** What this history is about, e.g. a SKU or a location name. */
  @Input() subtitle = '';
  @Output() close = new EventEmitter<void>();
}
