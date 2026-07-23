import { DatePipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import { companyAcceptUrl } from '../../core/tenant';
import { ApiKey, Company, CreateCompany, HealthRow } from '../../core/models';

@Component({
  selector: 'app-platform',
  imports: [FormsModule, DatePipe],
  template: `
    <main class="container">
      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      <section class="card">
        <h2>Create company</h2>
        <form class="inline-form" (ngSubmit)="createCompany()">
          <input placeholder="Name" name="c-name" [(ngModel)]="draft.name" required />
          <input placeholder="Slug" name="c-slug" [(ngModel)]="draft.slug" required />
          <label class="color">
            Color
            <input type="color" name="c-color" [(ngModel)]="draft.primaryColor" />
          </label>
          <button type="submit" [disabled]="saving()">Create</button>
        </form>
      </section>

      <section class="card">
        <h2>Companies</h2>
        @if (loading()) {
          <p class="muted">Loading…</p>
        } @else if (companies().length === 0) {
          <p class="muted">No companies yet.</p>
        } @else {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Slug</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th class="actions"></th>
                </tr>
              </thead>
              <tbody>
                @for (c of companies(); track c.id) {
                  <tr [class.selected]="selected()?.id === c.id">
                    <td>{{ c.name }}</td>
                    <td class="muted">{{ c.slug }}</td>
                    <td>
                      <span class="status" [class.suspended]="c.status === 'SUSPENDED'">
                        {{ c.status }}
                      </span>
                    </td>
                    <td class="muted">{{ c.createdAt | date: 'short' }}</td>
                    <td class="actions">
                      <button class="sm ghost" (click)="selectCompany(c)">Manage</button>
                      <button class="sm ghost" (click)="toggleStatus(c)" [disabled]="saving()">
                        {{ c.status === 'ACTIVE' ? 'Suspend' : 'Reactivate' }}
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      @if (selected(); as c) {
        <section class="card">
          <h2>{{ c.name }} — API keys</h2>
          <form class="inline-form" (ngSubmit)="createKey()">
            <input placeholder="Key name" name="k-name" [(ngModel)]="keyName" required />
            <button type="submit" [disabled]="saving()">Create key</button>
          </form>
          @if (newKey()) {
            <div class="link-box">
              <span class="muted">Copy this key now — it will not be shown again:</span>
              <code>{{ newKey() }}</code>
              <button class="sm ghost" (click)="copy(newKey()!)">Copy</button>
            </div>
          }
          @if (keys().length === 0) {
            <p class="muted">No API keys.</p>
          } @else {
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Created</th>
                    <th class="actions"></th>
                  </tr>
                </thead>
                <tbody>
                  @for (k of keys(); track k.id) {
                    <tr>
                      <td>{{ k.name }}</td>
                      <td class="muted">{{ k.createdAt | date: 'short' }}</td>
                      <td class="actions">
                        <button class="sm danger" (click)="revokeKey(k)" [disabled]="saving()">
                          Revoke
                        </button>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <section class="card">
          <h2>{{ c.name }} — First admin invite</h2>
          <form class="inline-form" (ngSubmit)="sendAdminInvite()">
            <input
              placeholder="Admin email"
              name="ai-email"
              type="email"
              [(ngModel)]="adminEmail"
              required
            />
            <button type="submit" [disabled]="saving()">Invite admin</button>
          </form>
          @if (adminInviteUrl()) {
            <div class="link-box">
              <span class="muted">Accept link:</span>
              <code>{{ adminInviteUrl() }}</code>
              <button class="sm ghost" (click)="copy(adminInviteUrl()!)">Copy</button>
            </div>
          }
        </section>
      }

      <section class="card">
        <div class="row-between">
          <h2>Health</h2>
          <button class="ghost" (click)="loadHealth()" [disabled]="healthLoading()">Refresh</button>
        </div>
        @if (healthLoading()) {
          <p class="muted">Loading…</p>
        } @else if (health().length === 0) {
          <p class="muted">No data.</p>
        } @else {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Slug</th>
                  <th>Status</th>
                  <th>Last agent sync</th>
                  <th class="num">Undelivered returns</th>
                  <th class="num">Items</th>
                  <th class="num">Transactions</th>
                </tr>
              </thead>
              <tbody>
                @for (h of health(); track h.id) {
                  <tr>
                    <td>{{ h.slug }}</td>
                    <td>{{ h.status }}</td>
                    <td class="muted">
                      {{ h.last_agent_sync ? (h.last_agent_sync | date: 'short') : 'never' }}
                    </td>
                    <td class="num">{{ h.undelivered_returns }}</td>
                    <td class="num">{{ h.items }}</td>
                    <td class="num">{{ h.transactions }}</td>
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
        max-width: 1050px;
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
      .inline-form {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        align-items: center;
      }
      input {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
      }
      .inline-form input[type='text'],
      .inline-form input[type='email'],
      .inline-form input:not([type]) {
        flex: 1 1 160px;
      }
      .color {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        font-size: 0.8rem;
        color: var(--muted);
      }
      .color input {
        padding: 0;
        width: 36px;
        height: 32px;
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
      tr.selected td {
        background: var(--accent-soft);
      }
      .status {
        font-size: 0.78rem;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
      }
      .status.suspended {
        background: #fef2f2;
        color: #b42318;
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
      .link-box {
        margin: 0.85rem 0;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
        padding: 0.6rem;
        background: var(--bg);
        border-radius: 8px;
      }
      .link-box code {
        font-size: 0.8rem;
        word-break: break-all;
      }
    `,
  ],
})
export class PlatformComponent implements OnInit {
  private readonly api = inject(ApiService);

  readonly companies = signal<Company[]>([]);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly selected = signal<Company | null>(null);
  readonly keys = signal<ApiKey[]>([]);
  readonly newKey = signal<string | null>(null);
  keyName = '';
  adminEmail = '';
  readonly adminInviteUrl = signal<string | null>(null);

  readonly health = signal<HealthRow[]>([]);
  readonly healthLoading = signal(false);

  draft: CreateCompany = { name: '', slug: '', primaryColor: '#2563eb' };

  ngOnInit(): void {
    this.loadCompanies();
    this.loadHealth();
  }

  loadCompanies(): void {
    this.loading.set(true);
    this.api.listCompanies().subscribe({
      next: (rows) => {
        this.companies.set(rows);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  createCompany(): void {
    if (!this.draft.name || !this.draft.slug) {
      this.error.set('Name and slug are required.');
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    this.api
      .createCompany({
        name: this.draft.name,
        slug: this.draft.slug,
        primaryColor: this.draft.primaryColor,
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.draft = { name: '', slug: '', primaryColor: '#2563eb' };
          this.loadCompanies();
        },
        error: (err) => {
          this.saving.set(false);
          this.error.set(messageFor(err));
        },
      });
  }

  toggleStatus(c: Company): void {
    const status = c.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    this.saving.set(true);
    this.error.set(null);
    this.api.updateCompany(c.id, { status }).subscribe({
      next: () => {
        this.saving.set(false);
        this.loadCompanies();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  selectCompany(c: Company): void {
    this.selected.set(c);
    this.newKey.set(null);
    this.adminInviteUrl.set(null);
    this.keyName = '';
    this.adminEmail = '';
    this.loadKeys(c.id);
  }

  private loadKeys(companyId: number): void {
    this.keys.set([]);
    this.api.listApiKeys(companyId).subscribe({
      next: (rows) => this.keys.set(rows),
      error: (err) => this.error.set(messageFor(err)),
    });
  }

  createKey(): void {
    const c = this.selected();
    if (!c || !this.keyName) return;
    this.saving.set(true);
    this.error.set(null);
    this.api.createApiKey(c.id, this.keyName).subscribe({
      next: (k) => {
        this.saving.set(false);
        this.newKey.set(k.key ?? null);
        this.keyName = '';
        this.loadKeys(c.id);
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  revokeKey(k: ApiKey): void {
    const c = this.selected();
    if (!c) return;
    if (!confirm(`Revoke API key "${k.name}"?`)) return;
    this.saving.set(true);
    this.error.set(null);
    this.api.deleteApiKey(k.id).subscribe({
      next: () => {
        this.saving.set(false);
        this.loadKeys(c.id);
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  sendAdminInvite(): void {
    const c = this.selected();
    if (!c || !this.adminEmail) return;
    this.saving.set(true);
    this.error.set(null);
    this.api.adminInvite(c.id, this.adminEmail).subscribe({
      next: (inv) => {
        this.saving.set(false);
        this.adminInviteUrl.set(companyAcceptUrl(c.slug, inv.token));
        this.adminEmail = '';
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  loadHealth(): void {
    this.healthLoading.set(true);
    this.api.health().subscribe({
      next: (res) => {
        this.health.set(res.companies);
        this.healthLoading.set(false);
      },
      error: (err) => {
        this.healthLoading.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  copy(text: string): void {
    void navigator.clipboard?.writeText(text);
  }
}
