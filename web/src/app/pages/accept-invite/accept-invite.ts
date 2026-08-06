import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../../core/auth.service';
import { ApiService } from '../../core/api.service';
import { InvitationState, Role } from '../../core/models';
import { homePathForRole } from '../../core/tenant';
import { USERNAME_INPUT_PATTERN, USERNAME_RULE } from '../../core/username';

@Component({
  selector: 'app-accept-invite',
  imports: [FormsModule],
  template: `
    <div class="wrap">
      <form class="card" (ngSubmit)="submit()">
        <h1>Accept invitation</h1>
        @if (checking()) {
          <p class="sub">Checking your invitation…</p>
        } @else if (state() !== 'VALID') {
          <p class="error">{{ stateMessage() }}</p>
          @if (state() === 'ALREADY_ACCEPTED') {
            <a class="link" href="/login">Go to sign in</a>
          }
        } @else {
          <p class="sub">
            You've been invited to <strong>{{ companyName() }}</strong> as
            {{ roleLabel() }}. Choose a username and password to activate
            <strong>{{ email() }}</strong>.
          </p>

          <label>
            Username
            <input
              type="text"
              name="username"
              [(ngModel)]="username"
              autocomplete="username"
              autocapitalize="none"
              spellcheck="false"
              maxlength="32"
              required
            />
            <small class="hint">
              You'll sign in with this or your email address. 3–32 characters:
              letters, numbers, dot, underscore or hyphen.
            </small>
          </label>

          <label>
            New password
            <input
              type="password"
              name="password"
              [(ngModel)]="password"
              autocomplete="new-password"
              minlength="8"
              required
            />
          </label>

          <label>
            Confirm password
            <input
              type="password"
              name="confirm"
              [(ngModel)]="confirm"
              autocomplete="new-password"
              required
            />
          </label>

          @if (error()) {
            <p class="error">{{ error() }}</p>
          }

          <button type="submit" [disabled]="loading()">
            {{ loading() ? 'Activating…' : 'Set password & sign in' }}
          </button>
        }
      </form>
    </div>
  `,
  styles: [
    `
      .wrap {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 1rem;
      }
      .card {
        width: 100%;
        max-width: 360px;
        display: flex;
        flex-direction: column;
        gap: 0.85rem;
        padding: 2rem;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--surface);
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.06);
      }
      h1 {
        margin: 0;
        font-size: 1.25rem;
      }
      .sub {
        margin: 0 0 0.5rem;
        color: var(--muted);
        font-size: 0.9rem;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        font-size: 0.85rem;
        color: var(--muted);
      }
      input {
        padding: 0.55rem 0.6rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.95rem;
      }
      .hint {
        font-size: 0.72rem;
        line-height: 1.35;
        color: var(--muted);
      }
      .link {
        font-size: 0.9rem;
        color: var(--brand, var(--accent));
      }
      .error {
        color: #b42318;
        font-size: 0.85rem;
        margin: 0;
      }
    `,
  ],
})
export class AcceptInviteComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly token = signal<string | null>(null);
  username = '';
  password = '';
  confirm = '';
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  // Invitation lifecycle state, resolved on load and re-checked on submit.
  readonly checking = signal(true);
  readonly state = signal<InvitationState>('INVALID');
  readonly stateMessage = signal('This invitation link is not valid.');
  readonly email = signal<string | null>(null);
  readonly companyName = signal<string | null>(null);
  readonly role = signal<Role | null>(null);

  ngOnInit(): void {
    const t = this.route.snapshot.queryParamMap.get('token');
    this.token.set(t);
    if (!t) {
      this.checking.set(false);
      this.state.set('INVALID');
      this.stateMessage.set('This invitation link is not valid.');
      return;
    }
    this.api.invitationStatus(t).subscribe({
      next: (res) => {
        this.checking.set(false);
        this.state.set(res.state);
        this.stateMessage.set(res.message);
        this.email.set(res.email ?? null);
        this.companyName.set(res.companyName ?? null);
        this.role.set(res.role ?? null);
      },
      error: () => {
        this.checking.set(false);
        this.state.set('INVALID');
        this.stateMessage.set('This invitation link is not valid.');
      },
    });
  }

  roleLabel(): string {
    switch (this.role()) {
      case 'COMPANY_ADMIN':
        return 'a company admin';
      case 'STORE_MANAGER':
        return 'a store manager';
      default:
        return 'a store user';
    }
  }

  submit(): void {
    const t = this.token();
    if (!t) return;
    // Mirrors the server rule so a typo is caught before a round trip. The server
    // re-validates and owns the "already taken" verdict, which only it can know.
    const username = this.username.trim().toLowerCase();
    if (!USERNAME_INPUT_PATTERN.test(this.username.trim())) {
      this.error.set(USERNAME_RULE);
      return;
    }
    if (this.password.length < 8) {
      this.error.set('Password must be at least 8 characters.');
      return;
    }
    if (this.password !== this.confirm) {
      this.error.set('Passwords do not match.');
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    this.auth.acceptInvite(t, username, this.password).subscribe({
      next: (res) => {
        this.loading.set(false);
        void this.router.navigate([homePathForRole(res.user.role)]);
      },
      error: (err: HttpErrorResponse) => {
        this.loading.set(false);
        const raw = (err.error as { message?: string | string[] } | null)?.message;
        const msg = Array.isArray(raw) ? raw.join(', ') : typeof raw === 'string' ? raw : '';
        // The server re-validates at submit time; surface the same lifecycle
        // message (e.g. revoked between page load and submit).
        const matched = this.stateFromMessage(msg);
        if (matched) {
          this.state.set(matched);
          this.stateMessage.set(msg);
          return;
        }
        this.error.set(msg || 'Could not accept the invitation. It may have expired.');
      },
    });
  }

  /** Recognise a lifecycle rejection returned by the accept endpoint. */
  private stateFromMessage(msg: string): InvitationState | null {
    const m = msg.toLowerCase();
    if (m.includes('revoked')) return 'REVOKED';
    if (m.includes('expired')) return 'EXPIRED';
    if (m.includes('already used')) return 'ALREADY_ACCEPTED';
    if (m.includes('not valid')) return 'INVALID';
    return null;
  }
}
