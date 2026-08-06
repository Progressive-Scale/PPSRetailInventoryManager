import { DatePipe } from '@angular/common';
import { Component, Input, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Subject, debounceTime } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import {
  AdminUser,
  AdminUserQuery,
  Company,
  Role,
  Store,
  TenantRole,
} from '../../core/models';

const PAGE = 50;

/**
 * Every user in every company, with the few actions a platform admin needs when a
 * tenant cannot help themselves: suspend or reactivate, fix a role or store
 * assignment, and issue a password-reset link.
 *
 * Platform-admin rows are listed but not actionable — demoting or suspending one
 * from here is how you end up locked out of this very screen.
 */
@Component({
  selector: 'app-platform-users',
  imports: [FormsModule, DatePipe],
  template: `
    <section class="card">
      <div class="row-between">
        <h2>Users</h2>
        <span class="muted small">{{ rangeLabel() }}</span>
      </div>

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      <div class="filters">
        <select name="u-company" [(ngModel)]="companyId" (ngModelChange)="reload(true)">
          <option [ngValue]="null">All companies</option>
          @for (c of companies; track c.id) {
            <option [ngValue]="c.id">{{ c.name }}</option>
          }
        </select>
        <select name="u-role" [(ngModel)]="role" (ngModelChange)="reload(true)">
          <option [ngValue]="null">Any role</option>
          <option value="COMPANY_ADMIN">Company admin</option>
          <option value="STORE_MANAGER">Store manager</option>
          <option value="STORE_USER">Store user</option>
          <option value="PLATFORM_ADMIN">Platform admin</option>
        </select>
        <select name="u-status" [(ngModel)]="status" (ngModelChange)="reload(true)">
          <option [ngValue]="null">Any status</option>
          <option value="ACTIVE">Active</option>
          <option value="SUSPENDED">Suspended</option>
        </select>
        <input
          placeholder="Search username or email"
          name="u-q"
          [(ngModel)]="search"
          (ngModelChange)="onSearch()"
        />
        <button
          type="button"
          class="ghost"
          (click)="clearFilters()"
          [disabled]="loading() || !filtersActive()"
        >
          Clear
        </button>
        <button type="button" class="ghost" (click)="reload()" [disabled]="loading()">
          Refresh
        </button>
      </div>

      @if (resetLink(); as link) {
        <div class="link-box">
          <span class="muted">
            Reset link for {{ resetFor() }}
            @if (!resetEmailed()) {
              — the email failed, so hand this over directly
            }
            :
          </span>
          <code>{{ link }}</code>
          <button class="sm ghost" type="button" (click)="copy(link)">Copy</button>
        </div>
      }

      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else if (users().length === 0) {
        <p class="muted">No users match.</p>
      } @else {
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Username</th>
                <th>Email</th>
                <th>Role</th>
                <th>Stores</th>
                <th>Status</th>
                <th>Created</th>
                <th class="actions"></th>
              </tr>
            </thead>
            <tbody>
              @for (u of users(); track u.id) {
                <tr [class.suspended-row]="u.status === 'SUSPENDED'">
                  <td>{{ u.companyName ?? '—' }}</td>
                  <td>{{ u.username }}</td>
                  <td class="muted">{{ u.email }}</td>
                  <td class="muted">{{ roleLabel(u.role) }}</td>
                  <td class="muted">{{ storeLabel(u) }}</td>
                  <td>
                    <span class="status" [class.suspended]="u.status === 'SUSPENDED'">
                      {{ u.status }}
                    </span>
                  </td>
                  <td class="muted">{{ u.createdAt | date: 'shortDate' }}</td>
                  <td class="actions">
                    @if (u.role === 'PLATFORM_ADMIN') {
                      <span class="muted small">platform</span>
                    } @else {
                      <button class="sm ghost" (click)="edit(u)" [disabled]="saving()">
                        Edit
                      </button>
                      <button
                        class="sm ghost"
                        (click)="toggleStatus(u)"
                        [disabled]="saving()"
                      >
                        {{ u.status === 'ACTIVE' ? 'Suspend' : 'Reactivate' }}
                      </button>
                      <button
                        class="sm ghost"
                        (click)="sendReset(u)"
                        [disabled]="saving() || u.status !== 'ACTIVE'"
                        title="Issue a password-reset link for this user"
                      >
                        Reset link
                      </button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        <div class="pager">
          <button
            type="button"
            class="ghost"
            (click)="page(-1)"
            [disabled]="loading() || offset() === 0"
          >
            Previous
          </button>
          <button
            type="button"
            class="ghost"
            (click)="page(1)"
            [disabled]="loading() || !hasNext()"
          >
            Next
          </button>
        </div>
      }
    </section>

    @if (editing(); as u) {
      <div class="overlay" (click)="cancelEdit()">
        <div class="modal" (click)="$event.stopPropagation()">
          <h3>{{ u.username }}</h3>
          <p class="muted small">{{ u.email }} — {{ u.companyName }}</p>

          @if (editError(); as e) {
            <p class="error">{{ e }}</p>
          }

          <label class="field">
            Role
            <select name="e-role" [(ngModel)]="editRole">
              <option value="COMPANY_ADMIN">Company admin</option>
              <option value="STORE_MANAGER">Store manager</option>
              <option value="STORE_USER">Store user</option>
            </select>
          </label>

          <label class="field">
            Status
            <select name="e-status" [(ngModel)]="editStatus">
              <option value="ACTIVE">Active</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </label>

          <div class="field">
            <span>Stores</span>
            @if (editStores().length === 0) {
              <span class="muted small">This company has no stores.</span>
            } @else {
              <div class="stores">
                @for (s of editStores(); track s.id) {
                  <label class="chk">
                    <input
                      type="checkbox"
                      [checked]="editPicked().has(s.id)"
                      (change)="togglePick(s.id)"
                    />
                    {{ s.name }}
                  </label>
                }
              </div>
            }
          </div>

          <div class="modal-actions">
            <button type="button" class="ghost" (click)="cancelEdit()">Cancel</button>
            <button type="button" (click)="saveEdit()" [disabled]="saving()">Save</button>
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
      h2 {
        margin: 0 0 0.85rem;
        font-size: 1.05rem;
      }
      .row-between {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        align-items: center;
        margin-bottom: 0.5rem;
      }
      input,
      select {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
      }
      .filters input {
        flex: 1 1 200px;
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
      td.actions,
      th.actions {
        text-align: right;
        white-space: nowrap;
      }
      tr.suspended-row td {
        background: color-mix(in srgb, var(--bg) 70%, transparent);
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
      .small {
        font-size: 0.8rem;
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
      .pager {
        display: flex;
        gap: 0.5rem;
        justify-content: flex-end;
        margin-top: 0.75rem;
      }
      .link-box {
        margin: 0.5rem 0 0.85rem;
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
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
        z-index: 50;
      }
      .modal {
        background: var(--surface);
        border-radius: 12px;
        padding: 1.25rem;
        width: min(420px, 100%);
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
      }
      .modal h3 {
        margin: 0;
        font-size: 1rem;
      }
      .modal p {
        margin: 0;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        font-size: 0.85rem;
      }
      .stores {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
        max-height: 190px;
        overflow-y: auto;
      }
      .chk {
        display: flex;
        align-items: center;
        gap: 0.35rem;
      }
      .modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        margin-top: 0.3rem;
      }
    `,
  ],
})
export class PlatformUsersComponent {
  private readonly api = inject(ApiService);

  /** For the company filter. The parent already has them loaded. */
  @Input() companies: Company[] = [];

  readonly users = signal<AdminUser[]>([]);
  readonly total = signal(0);
  readonly offset = signal(0);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly resetLink = signal<string | null>(null);
  readonly resetFor = signal<string | null>(null);
  readonly resetEmailed = signal(true);

  readonly editing = signal<AdminUser | null>(null);
  readonly editStores = signal<Store[]>([]);
  readonly editPicked = signal<Set<number>>(new Set());
  readonly editError = signal<string | null>(null);
  editRole: TenantRole = 'STORE_USER';
  editStatus: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE';

  companyId: number | null = null;
  role: Role | null = null;
  status: 'ACTIVE' | 'SUSPENDED' | null = null;
  search = '';

  private readonly typed = new Subject<void>();

  readonly hasNext = computed(() => this.offset() + this.users().length < this.total());

  readonly rangeLabel = computed(() => {
    const t = this.total();
    if (t === 0) return 'No users';
    const from = this.offset() + 1;
    const to = this.offset() + this.users().length;
    return `${from}–${to} of ${t}`;
  });

  constructor() {
    // Typing filters as you go, but not a request per keystroke.
    this.typed
      .pipe(debounceTime(250), takeUntilDestroyed())
      .subscribe(() => this.reload(true));
    this.reload();
  }

  onSearch(): void {
    this.typed.next();
  }

  filtersActive(): boolean {
    return (
      this.companyId != null || this.role != null || this.status != null || !!this.search
    );
  }

  clearFilters(): void {
    this.companyId = null;
    this.role = null;
    this.status = null;
    this.search = '';
    this.reload(true);
  }

  /** `fromFirstPage` because a filter change makes the current offset meaningless. */
  reload(fromFirstPage = false): void {
    if (fromFirstPage) this.offset.set(0);
    const query: AdminUserQuery = {
      limit: PAGE,
      offset: this.offset(),
      ...(this.companyId != null ? { companyId: this.companyId } : {}),
      ...(this.role ? { role: this.role } : {}),
      ...(this.status ? { status: this.status } : {}),
      ...(this.search.trim() ? { q: this.search.trim() } : {}),
    };
    this.loading.set(true);
    this.error.set(null);
    this.api.adminListUsers(query).subscribe({
      next: (res) => {
        this.users.set(res.data);
        this.total.set(res.total);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  page(direction: 1 | -1): void {
    const next = Math.max(0, this.offset() + direction * PAGE);
    this.offset.set(next);
    this.reload();
  }

  roleLabel(role: Role): string {
    switch (role) {
      case 'PLATFORM_ADMIN':
        return 'Platform admin';
      case 'COMPANY_ADMIN':
        return 'Company admin';
      case 'STORE_MANAGER':
        return 'Store manager';
      default:
        return 'Store user';
    }
  }

  storeLabel(u: AdminUser): string {
    if (u.role !== 'STORE_USER' && u.role !== 'STORE_MANAGER')
      return 'All (admin)';
    if (u.storeNames.length === 0) return 'none';
    return u.storeNames.join(', ');
  }

  toggleStatus(u: AdminUser): void {
    const status = u.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    const verb = status === 'SUSPENDED' ? 'Suspend' : 'Reactivate';
    if (!confirm(`${verb} ${u.username} (${u.companyName})?`)) return;
    this.saving.set(true);
    this.error.set(null);
    this.api.adminUpdateUser(u.id, { status }).subscribe({
      next: () => {
        this.saving.set(false);
        this.reload();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  sendReset(u: AdminUser): void {
    if (
      !confirm(
        `Issue a password-reset link for ${u.username}? Any earlier link stops working.`,
      )
    ) {
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    this.resetLink.set(null);
    this.api.adminPasswordReset(u.id).subscribe({
      next: (res) => {
        this.saving.set(false);
        this.resetLink.set(res.resetUrl);
        this.resetFor.set(`${res.username} (${res.email})`);
        this.resetEmailed.set(res.emailSent);
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  edit(u: AdminUser): void {
    this.editing.set(u);
    this.editError.set(null);
    // PLATFORM_ADMIN has no tenant role to edit; anything else round-trips as itself.
    this.editRole = u.role === 'PLATFORM_ADMIN' ? 'STORE_USER' : u.role;
    this.editStatus = u.status;
    this.editPicked.set(new Set(u.storeIds));
    this.editStores.set([]);
    if (u.companyId != null) {
      this.api.adminListCompanyStores(u.companyId).subscribe({
        next: (rows) => this.editStores.set(rows),
        error: (err) => this.editError.set(messageFor(err)),
      });
    }
  }

  togglePick(id: number): void {
    this.editPicked.update((set) => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  saveEdit(): void {
    const u = this.editing();
    if (!u) return;
    this.saving.set(true);
    this.editError.set(null);
    this.api
      .adminUpdateUser(u.id, {
        role: this.editRole,
        status: this.editStatus,
        storeIds: [...this.editPicked()],
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.editing.set(null);
          this.reload();
        },
        error: (err) => {
          this.saving.set(false);
          this.editError.set(messageFor(err));
        },
      });
  }

  cancelEdit(): void {
    this.editing.set(null);
    this.editError.set(null);
  }

  copy(text: string): void {
    void navigator.clipboard?.writeText(text);
  }
}
