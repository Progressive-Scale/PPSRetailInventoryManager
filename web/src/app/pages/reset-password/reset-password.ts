import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ResetState } from '../../core/models';
import { homePathForRole } from '../../core/tenant';

/**
 * Step two of a forgotten password: redeem the link.
 *
 * Mirrors accept-invite's handling of a token that has a lifecycle: the state is
 * resolved on load so a dead link explains itself instead of failing after the user
 * has typed a password, and re-checked on submit because it can die in between.
 */
@Component({
  selector: 'app-reset-password',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="wrap">
      <form class="card" (ngSubmit)="submit()">
        <h1>Choose a new password</h1>

        @if (checking()) {
          <p class="sub">Checking your link…</p>
        } @else if (state() !== 'VALID') {
          <p class="error">{{ stateMessage() }}</p>
          <a class="link" routerLink="/forgot-password">Request a new link</a>
          <a class="link" routerLink="/login">Back to sign in</a>
        } @else {
          <p class="sub">
            Setting a new password for <strong>{{ username() }}</strong>. You'll be
            signed in straight afterwards.
          </p>

          <label>
            New password
            <input
              type="password"
              name="newPassword"
              [(ngModel)]="newPassword"
              autocomplete="new-password"
              minlength="8"
              required
            />
            <small class="hint">At least 8 characters.</small>
          </label>

          <label>
            Confirm new password
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
            {{ loading() ? 'Saving…' : 'Set password & sign in' }}
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
        line-height: 1.45;
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
        font-family: inherit;
      }
      .hint {
        font-size: 0.72rem;
        color: var(--muted);
      }
      button {
        padding: 0.55rem 0.9rem;
        border-radius: 8px;
        font-family: inherit;
        font-size: 0.95rem;
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
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
export class ResetPasswordComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly token = signal<string | null>(null);
  newPassword = '';
  confirm = '';
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly checking = signal(true);
  readonly state = signal<ResetState>('INVALID');
  readonly stateMessage = signal('This reset link is not valid.');
  readonly username = signal<string | null>(null);

  ngOnInit(): void {
    const t = this.route.snapshot.queryParamMap.get('token');
    this.token.set(t);
    if (!t) {
      this.dead('This reset link is not valid.');
      return;
    }
    this.api.resetStatus(t).subscribe({
      next: (res) => {
        this.checking.set(false);
        this.state.set(res.state);
        this.stateMessage.set(res.message);
        this.username.set(res.username ?? null);
      },
      error: () => this.dead('This reset link is not valid.'),
    });
  }

  private dead(message: string): void {
    this.checking.set(false);
    this.state.set('INVALID');
    this.stateMessage.set(message);
  }

  submit(): void {
    const t = this.token();
    if (!t) return;
    if (this.newPassword.length < 8) {
      this.error.set('Password must be at least 8 characters.');
      return;
    }
    if (this.newPassword !== this.confirm) {
      this.error.set('Passwords do not match.');
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    this.auth.resetPassword(t, this.newPassword).subscribe({
      next: (res) => {
        this.loading.set(false);
        void this.router.navigate([homePathForRole(res.user.role)]);
      },
      error: (err: HttpErrorResponse) => {
        this.loading.set(false);
        const raw = (err.error as { message?: string | string[] } | null)?.message;
        const msg = Array.isArray(raw) ? raw.join(', ') : typeof raw === 'string' ? raw : '';
        // The server re-validates on submit, so a link that died since page load
        // reports its real state here rather than a generic failure.
        const matched = this.stateFromMessage(msg);
        if (matched) {
          this.state.set(matched);
          this.stateMessage.set(msg);
          return;
        }
        this.error.set(msg || 'Could not set your password. The link may have expired.');
      },
    });
  }

  /** Recognise a lifecycle rejection returned by the reset endpoint. */
  private stateFromMessage(msg: string): ResetState | null {
    const m = msg.toLowerCase();
    if (m.includes('already been used')) return 'USED';
    if (m.includes('newer reset link')) return 'SUPERSEDED';
    if (m.includes('expired')) return 'EXPIRED';
    if (m.includes('not valid')) return 'INVALID';
    return null;
  }
}
