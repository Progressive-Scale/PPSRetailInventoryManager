import { DatePipe } from '@angular/common';
import { Component, inject, Input, OnInit, signal } from '@angular/core';
import { ApiService } from '../core/api.service';
import { ActivityRow } from '../core/models';

/**
 * One entity's history, as a dense table in the same style as the item ledger it replaces.
 *
 * Deliberately dumb: it takes an entity, fetches its stream, and renders the `summary` the
 * server composed. Every detail view gets the same table that way, and a new event type
 * shows up everywhere without touching a component.
 */
@Component({
  selector: 'app-activity-log',
  imports: [DatePipe],
  template: `
    @if (loading()) {
      <p class="muted">Loading…</p>
    } @else if (error()) {
      <p class="muted">{{ error() }}</p>
    } @else if (rows().length === 0) {
      <p class="muted">No activity.</p>
    } @else {
      <table class="hist">
        <thead>
          <tr><th>When</th><th>Who</th><th>What</th><th>Source</th></tr>
        </thead>
        <tbody>
          @for (r of rows(); track r.id) {
            <tr>
              <td class="muted nowrap">{{ r.at | date: 'short' }}</td>
              <td [class.muted]="r.actorType !== 'USER'">{{ r.actor }}</td>
              <td>{{ r.summary }}</td>
              <td><span class="src-badge" [class]="'src-' + r.source">{{ r.source }}</span></td>
            </tr>
          }
        </tbody>
      </table>
      @if (total() > rows().length) {
        <p class="muted small">
          Showing the {{ rows().length }} most recent of {{ total() }}.
        </p>
      }
    }
  `,
  styles: [
    `
      table.hist {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.82rem;
      }
      table.hist th,
      table.hist td {
        text-align: left;
        padding: 0.35rem 0.5rem;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      .nowrap {
        white-space: nowrap;
      }
      .muted {
        color: var(--muted);
      }
      .small {
        font-size: 0.78rem;
        margin: 0.4rem 0 0;
      }
      .src-badge {
        display: inline-block;
        font-size: 0.68rem;
        font-weight: 600;
        padding: 0.05rem 0.4rem;
        border-radius: 999px;
        border: 1px solid transparent;
        white-space: nowrap;
      }
      .src-WEB {
        background: #eff4ff;
        color: #1d4ed8;
        border-color: #c7d7fe;
      }
      .src-SCANNER {
        background: #fffaeb;
        color: #b54708;
        border-color: #fedf89;
      }
      .src-SYNC {
        background: #ecfdf3;
        color: #067647;
        border-color: #abefc6;
      }
      .src-JOB {
        background: #f4f4f5;
        color: #52525b;
        border-color: #e4e4e7;
      }
    `,
  ],
})
export class ActivityLogComponent implements OnInit {
  private readonly api = inject(ApiService);

  @Input({ required: true }) entityType!: string;
  @Input({ required: true }) entityId!: string | number;
  @Input() limit = 50;

  readonly rows = signal<ActivityRow[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.entityActivity(this.entityType, this.entityId, { limit: this.limit }).subscribe({
      next: (res) => {
        this.rows.set(res.data);
        this.total.set(res.total);
        this.loading.set(false);
      },
      // A history nobody is allowed to see is not an error worth shouting about: the rest
      // of the detail view still works, so it says so quietly and stops.
      error: () => {
        this.rows.set([]);
        this.error.set('History is not available for your role.');
        this.loading.set(false);
      },
    });
  }
}
