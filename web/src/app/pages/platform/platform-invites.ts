import { DatePipe } from '@angular/common';
import { Component, Input, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import { Company, Invitation, Role, Store } from '../../core/models';

type InviteRole = 'COMPANY_ADMIN' | 'STORE_USER';

/**
 * Invite people into one company, on that company's behalf.
 *
 * This exists for when the tenant cannot do it themselves — no admin yet, the admin
 * has lost access, or their invitation email never arrives. It is deliberately the
 * same form their own Manage screen offers (role + stores), because anything more
 * would be a second way to create users that only the platform admin can audit.
 */
@Component({
  selector: 'app-platform-invites',
  imports: [FormsModule, DatePipe],
  template: `
    <section class="card">
      <div class="row-between">
        <h2>{{ company.name }} — Invitations</h2>
        <button class="ghost" (click)="load()" [disabled]="loading()">Refresh</button>
      </div>

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      <form class="inline-form" (ngSubmit)="send()">
        <input
          placeholder="Email"
          name="inv-email"
          type="email"
          [(ngModel)]="email"
          required
        />
        <select name="inv-role" [(ngModel)]="role">
          <option value="COMPANY_ADMIN">Company admin</option>
          <option value="STORE_USER">Store user</option>
        </select>
        <button type="submit" [disabled]="saving() || !email">Send invite</button>
      </form>

      @if (stores().length > 0) {
        <div class="stores">
          <span class="muted">Stores granted on accept:</span>
          @for (s of stores(); track s.id) {
            <label class="chk">
              <input
                type="checkbox"
                [checked]="picked().has(s.id)"
                (change)="togglePick(s.id)"
              />
              {{ s.name }}
            </label>
          }
        </div>
      } @else {
        <p class="muted small">
          This company has no stores yet — invite a company admin, who can create them.
        </p>
      }

      @if (lastLink(); as link) {
        <div class="link-box">
          <span class="muted">Accept link for {{ lastEmail() }}:</span>
          <code>{{ link }}</code>
          <button class="sm ghost" type="button" (click)="copy(link)">Copy</button>
        </div>
      }
      @if (warning(); as w) {
        <p class="warn">{{ w }}</p>
      }

      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else if (invitations().length === 0) {
        <p class="muted">No invitations for this company.</p>
      } @else {
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Stores</th>
                <th>State</th>
                <th>Email</th>
                <th>Expires</th>
                <th class="actions"></th>
              </tr>
            </thead>
            <tbody>
              @for (i of invitations(); track i.id) {
                <tr>
                  <td>{{ i.email }}</td>
                  <td class="muted">{{ roleLabel(i.role) }}</td>
                  <td class="muted">{{ storeLabel(i) }}</td>
                  <td>
                    <span class="status" [class]="'st-' + state(i)">{{ state(i) }}</span>
                  </td>
                  <td class="muted" [title]="i.emailError || ''">
                    {{ i.emailStatus }}
                  </td>
                  <td class="muted">{{ i.expiresAt | date: 'short' }}</td>
                  <td class="actions">
                    @if (state(i) !== 'accepted') {
                      <button class="sm ghost" (click)="resend(i)" [disabled]="saving()">
                        Resend
                      </button>
                    }
                    @if (state(i) === 'live' || state(i) === 'expired') {
                      <button class="sm danger" (click)="revoke(i)" [disabled]="saving()">
                        Revoke
                      </button>
                    }
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
      }
      .inline-form {
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
      .inline-form input[type='email'] {
        flex: 1 1 200px;
      }
      .stores {
        display: flex;
        flex-wrap: wrap;
        gap: 0.6rem;
        align-items: center;
        margin: 0.7rem 0 0.2rem;
        font-size: 0.85rem;
      }
      .chk {
        display: flex;
        align-items: center;
        gap: 0.3rem;
      }
      .table-scroll {
        overflow-x: auto;
        margin-top: 0.85rem;
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
      .status {
        font-size: 0.78rem;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
      }
      .status.st-accepted {
        background: #ecfdf3;
        color: #067647;
      }
      .status.st-revoked,
      .status.st-expired {
        background: #fef2f2;
        color: #b42318;
      }
      .muted {
        color: var(--muted);
      }
      .small {
        font-size: 0.85rem;
      }
      .error {
        color: #b42318;
        font-size: 0.85rem;
      }
      .warn {
        color: #b54708;
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
export class PlatformInvitesComponent {
  private readonly api = inject(ApiService);

  private current!: Company;

  /** Reloading on assignment: the parent keeps one instance and swaps companies. */
  @Input({ required: true })
  set company(c: Company) {
    const changed = this.current?.id !== c.id;
    this.current = c;
    if (changed) {
      this.reset();
      this.load();
    }
  }
  get company(): Company {
    return this.current;
  }

  readonly invitations = signal<Invitation[]>([]);
  readonly stores = signal<Store[]>([]);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly warning = signal<string | null>(null);
  readonly lastLink = signal<string | null>(null);
  readonly lastEmail = signal<string | null>(null);
  readonly picked = signal<Set<number>>(new Set());

  email = '';
  role: InviteRole = 'COMPANY_ADMIN';

  private readonly storeNames = computed(() => {
    const map = new Map<number, string>();
    for (const s of this.stores()) map.set(s.id, s.name);
    return map;
  });

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    const id = this.current.id;
    this.api.adminListInvitations(id).subscribe({
      next: (rows) => {
        this.invitations.set(rows);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(messageFor(err));
      },
    });
    this.api.adminListCompanyStores(id).subscribe({
      next: (rows) => this.stores.set(rows),
      error: (err) => this.error.set(messageFor(err)),
    });
  }

  send(): void {
    if (!this.email) return;
    this.saving.set(true);
    this.error.set(null);
    this.warning.set(null);
    this.api
      .adminCreateInvitation(this.current.id, {
        email: this.email,
        role: this.role,
        storeIds: [...this.picked()],
      })
      .subscribe({
        next: (inv) => {
          this.saving.set(false);
          this.show(inv);
          this.email = '';
          this.picked.set(new Set());
          this.load();
        },
        error: (err) => {
          this.saving.set(false);
          this.error.set(messageFor(err));
        },
      });
  }

  resend(i: Invitation): void {
    this.saving.set(true);
    this.error.set(null);
    this.warning.set(null);
    this.api.adminResendInvitation(i.id).subscribe({
      next: (inv) => {
        this.saving.set(false);
        this.show(inv);
        this.load();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  revoke(i: Invitation): void {
    if (!confirm(`Revoke the invitation for ${i.email}? Their link stops working.`)) {
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    this.api.adminRevokeInvitation(i.id).subscribe({
      next: () => {
        this.saving.set(false);
        this.lastLink.set(null);
        this.load();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  togglePick(id: number): void {
    this.picked.update((set) => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /**
   * Lifecycle in the same precedence the API uses: revoked beats accepted beats
   * expired, so a revoked link never reads as merely expired.
   */
  state(i: Invitation): 'accepted' | 'revoked' | 'expired' | 'live' {
    if (i.revokedAt) return 'revoked';
    if (i.acceptedAt) return 'accepted';
    if (new Date(i.expiresAt).getTime() <= Date.now()) return 'expired';
    return 'live';
  }

  roleLabel(role: Role): string {
    return role === 'COMPANY_ADMIN' ? 'Company admin' : 'Store user';
  }

  storeLabel(i: Invitation): string {
    if (i.storeIds.length === 0) return 'All (admin)';
    const names = this.storeNames();
    return i.storeIds.map((id) => names.get(id) ?? `#${id}`).join(', ');
  }

  copy(text: string): void {
    void navigator.clipboard?.writeText(text);
  }

  private show(inv: Invitation): void {
    // The link is the point of this screen: it is the fallback when the email is
    // exactly what is not working. It is returned once, so it is shown once.
    this.lastLink.set(inv.acceptUrl ?? null);
    this.lastEmail.set(inv.email);
    this.warning.set(inv.emailWarning ?? null);
  }

  private reset(): void {
    this.invitations.set([]);
    this.stores.set([]);
    this.picked.set(new Set());
    this.lastLink.set(null);
    this.lastEmail.set(null);
    this.warning.set(null);
    this.error.set(null);
    this.email = '';
    this.role = 'COMPANY_ADMIN';
  }
}
