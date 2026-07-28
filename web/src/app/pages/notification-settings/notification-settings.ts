import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { NotificationStore } from '../../core/notification.store';
import { messageFor } from '../../core/http-error';
import { NotificationSetting, Store } from '../../core/models';

@Component({
  selector: 'app-notification-settings',
  imports: [FormsModule],
  template: `
    <main class="container">
      <section class="card">
        <div class="section-head">
          <h2>Expiration Alerts</h2>
          <button class="ghost" (click)="runScan()" [disabled]="scanning()">
            {{ scanning() ? 'Scanning…' : 'Run scan now' }}
          </button>
        </div>
        <p class="hint">
          On-floor serialized items nearing their expiration date raise alerts so staff can
          rotate stock. Choose how many days ahead to warn. Backroom stock is not alerted.
        </p>

        @if (message()) {
          <p class="ok">{{ message() }}</p>
        }
        @if (error()) {
          <p class="error">{{ error() }}</p>
        }

        @if (loading()) {
          <p class="muted">Loading…</p>
        } @else {
          <div class="setting-block">
            <h3>Company default</h3>
            <form class="row-form" (ngSubmit)="saveDefault()">
              <label class="inline">
                Warn within (days)
                <input type="number" min="1" max="3650" name="days" [(ngModel)]="defaultDays" />
              </label>
              <label class="chk">
                <input type="checkbox" name="enabled" [(ngModel)]="defaultEnabled" />
                Enabled
              </label>
              <button type="submit" [disabled]="saving()">Save default</button>
            </form>
          </div>

          <div class="setting-block">
            <h3>Per-store overrides</h3>
            @if (overrides().length === 0) {
              <p class="muted">No per-store overrides. All stores use the company default.</p>
            } @else {
              <ul class="override-list">
                @for (o of overrides(); track o.id) {
                  <li>
                    <span>{{ storeName(o.storeId) }}</span>
                    <span class="muted">{{ o.expirationAlertDays }} days · {{ o.enabled ? 'on' : 'off' }}</span>
                  </li>
                }
              </ul>
            }
            <form class="row-form" (ngSubmit)="saveOverride()">
              <label class="inline">
                Store
                <select name="ostore" [(ngModel)]="overrideStoreId">
                  <option [ngValue]="null">Select…</option>
                  @for (s of stores(); track s.id) {
                    <option [ngValue]="s.id">{{ s.name }}</option>
                  }
                </select>
              </label>
              <label class="inline">
                Days
                <input type="number" min="1" max="3650" name="odays" [(ngModel)]="overrideDays" />
              </label>
              <label class="chk">
                <input type="checkbox" name="oenabled" [(ngModel)]="overrideEnabled" />
                Enabled
              </label>
              <button type="submit" [disabled]="saving() || overrideStoreId === null">Save override</button>
            </form>
          </div>
        }
      </section>
    </main>
  `,
  styles: [
    `
      .container {
        max-width: 760px;
        margin: 1.5rem auto;
        padding: 0 1rem;
      }
      .card {
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--surface);
        padding: 1.25rem;
      }
      .section-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        margin-bottom: 0.5rem;
      }
      h2 {
        margin: 0;
        font-size: 1.05rem;
      }
      h3 {
        margin: 0 0 0.5rem;
        font-size: 0.9rem;
      }
      .hint {
        color: var(--muted);
        font-size: 0.82rem;
        margin: 0 0 1rem;
      }
      .setting-block {
        border-top: 1px solid var(--border);
        padding-top: 1rem;
        margin-top: 1rem;
      }
      .row-form {
        display: flex;
        align-items: flex-end;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .inline {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        font-size: 0.75rem;
        color: var(--muted);
      }
      .chk {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.85rem;
      }
      input,
      select {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
      }
      input[type='number'] {
        width: 110px;
      }
      .override-list {
        list-style: none;
        margin: 0 0 0.75rem;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        font-size: 0.9rem;
      }
      .override-list li {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        max-width: 360px;
      }
      .muted {
        color: var(--muted);
      }
      .ok {
        color: #067647;
        font-size: 0.85rem;
      }
      .error {
        color: #b42318;
        font-size: 0.85rem;
      }
    `,
  ],
})
export class NotificationSettingsComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly notifications = inject(NotificationStore);

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly scanning = signal(false);
  readonly error = signal<string | null>(null);
  readonly message = signal<string | null>(null);

  readonly stores = signal<Store[]>([]);
  readonly overrides = signal<NotificationSetting[]>([]);

  defaultDays = 30;
  defaultEnabled = true;

  overrideStoreId: number | null = null;
  overrideDays = 30;
  overrideEnabled = true;

  ngOnInit(): void {
    this.api.listStores().subscribe({ next: (rows) => this.stores.set(rows) });
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.api.getNotificationSettings().subscribe({
      next: (res) => {
        if (res.companyDefault) {
          this.defaultDays = res.companyDefault.expirationAlertDays;
          this.defaultEnabled = res.companyDefault.enabled;
        }
        this.overrides.set(res.overrides);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  saveDefault(): void {
    this.persist({ expirationAlertDays: Number(this.defaultDays), enabled: this.defaultEnabled });
  }

  saveOverride(): void {
    if (this.overrideStoreId === null) return;
    this.persist({
      storeId: this.overrideStoreId,
      expirationAlertDays: Number(this.overrideDays),
      enabled: this.overrideEnabled,
    });
  }

  private persist(dto: { storeId?: number; expirationAlertDays: number; enabled: boolean }): void {
    this.saving.set(true);
    this.error.set(null);
    this.message.set(null);
    this.api.putNotificationSettings(dto).subscribe({
      next: () => {
        this.saving.set(false);
        this.message.set('Saved.');
        this.load();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  runScan(): void {
    this.scanning.set(true);
    this.error.set(null);
    this.message.set(null);
    this.api.runExpirationScan().subscribe({
      next: (r) => {
        this.scanning.set(false);
        this.message.set(`Scan complete — ${r.created} new alert(s) created.`);
        this.notifications.refreshCount();
      },
      error: (err) => {
        this.scanning.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  storeName(id: number | null): string {
    if (id == null) return 'All stores';
    return this.stores().find((s) => s.id === id)?.name ?? `#${id}`;
  }
}
