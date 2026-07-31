import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { isAdminHost } from '../../core/tenant';

/**
 * Step one of a forgotten password: ask for the link.
 *
 * A 404 here means no active account has that address, and we say so — that is a
 * deliberate product decision (see REVEAL_UNKNOWN_EMAIL on the API side), traded
 * against the fact that it lets someone probe which addresses are registered.
 */
@Component({
  selector: 'app-forgot-password',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="wrap">
      <form class="card" (ngSubmit)="submit()">
        @if (logoUrl()) {
          <img class="logo" [src]="logoUrl()" alt="" />
        }
        <h1>{{ title() }}</h1>

        @if (sent()) {
          <p class="sub">
            We've emailed a reset link to <strong>{{ sentTo() }}</strong>. It works
            once and expires in an hour.
          </p>
          <p class="sub">
            Nothing arrived? Check the spam folder, or try again in a minute.
          </p>
          <a class="link" routerLink="/login">Back to sign in</a>
        } @else {
          <p class="sub">
            Enter the email address on your account and we'll send you a link to
            choose a new password.
          </p>

          <label>
            Email
            <input
              type="email"
              name="email"
              [(ngModel)]="email"
              autocomplete="email"
              autocapitalize="none"
              spellcheck="false"
              required
            />
          </label>

          @if (error()) {
            <p class="error">{{ error() }}</p>
          }

          <button type="submit" [disabled]="loading()">
            {{ loading() ? 'Sending…' : 'Send reset link' }}
          </button>
          <a class="link" routerLink="/login">Back to sign in</a>
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
      .logo {
        max-height: 44px;
        align-self: flex-start;
      }
      h1 {
        margin: 0;
        font-size: 1.25rem;
      }
      .sub {
        margin: 0;
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
export class ForgotPasswordComponent implements OnInit {
  private readonly api = inject(ApiService);

  readonly adminHost = isAdminHost();

  email = '';
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly sent = signal(false);
  readonly sentTo = signal('');
  readonly title = signal(this.adminHost ? 'Platform Admin' : 'Forgot password');
  readonly logoUrl = signal<string | null>(null);

  ngOnInit(): void {
    if (this.adminHost) return;
    // Same branding treatment as the login screen, so the flow does not suddenly
    // look like a different product mid-way.
    this.api.branding().subscribe({
      next: (b) => this.logoUrl.set(b.branding?.logoUrl ?? null),
      error: () => {
        /* branding is decoration; the form works without it */
      },
    });
  }

  submit(): void {
    const email = this.email.trim();
    if (!email) {
      this.error.set('Enter your email address.');
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    this.api.forgotPassword(email).subscribe({
      next: () => {
        this.loading.set(false);
        this.sentTo.set(email);
        this.sent.set(true);
      },
      error: (err: HttpErrorResponse) => {
        this.loading.set(false);
        const raw = (err.error as { message?: string | string[] } | null)?.message;
        const msg = Array.isArray(raw) ? raw.join(', ') : raw;
        if (err.status === 404) {
          this.error.set(msg || 'No active account was found with that email address.');
          return;
        }
        if (err.status === 429) {
          this.error.set('Too many attempts. Wait a minute and try again.');
          return;
        }
        this.error.set(msg || 'Something went wrong. Please try again.');
      },
    });
  }
}
