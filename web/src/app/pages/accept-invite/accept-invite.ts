import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../../core/auth.service';
import { homePathForRole } from '../../core/tenant';

@Component({
  selector: 'app-accept-invite',
  imports: [FormsModule],
  template: `
    <div class="wrap">
      <form class="card" (ngSubmit)="submit()">
        <h1>Accept invitation</h1>
        @if (!token()) {
          <p class="error">Missing or invalid invitation token.</p>
        } @else {
          <p class="sub">Choose a password to activate your account.</p>

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
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly token = signal<string | null>(null);
  password = '';
  confirm = '';
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  ngOnInit(): void {
    const t = this.route.snapshot.queryParamMap.get('token');
    this.token.set(t);
  }

  submit(): void {
    const t = this.token();
    if (!t) return;
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
    this.auth.acceptInvite(t, this.password).subscribe({
      next: (res) => {
        this.loading.set(false);
        void this.router.navigate([homePathForRole(res.user.role)]);
      },
      error: (err: HttpErrorResponse) => {
        this.loading.set(false);
        const msg = (err.error as { message?: string | string[] } | null)?.message;
        this.error.set(
          Array.isArray(msg)
            ? msg.join(', ')
            : typeof msg === 'string'
              ? msg
              : 'Could not accept the invitation. It may have expired.',
        );
      },
    });
  }
}
