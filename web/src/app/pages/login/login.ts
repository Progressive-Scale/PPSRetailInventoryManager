import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../../core/auth.service';
import { ApiService } from '../../core/api.service';
import { homePathForRole, isAdminHost } from '../../core/tenant';
import { Role } from '../../core/models';

@Component({
  selector: 'app-login',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="login-wrap" [style.--brand]="brandColor()">
      <form class="card" (ngSubmit)="submit()">
        @if (logoUrl()) {
          <img class="logo" [src]="logoUrl()" [alt]="title()" />
        }
        <h1>{{ title() }}</h1>
        <p class="sub">
          {{ adminHost ? 'Sign in to the platform console.' : 'Sign in to manage inventory.' }}
        </p>

        @if (storeChoices().length === 0) {
          <label>
            Username or email
            <!-- type="text", not "email": the browser would otherwise refuse to
                 submit a bare username as malformed. -->
            <input
              type="text"
              name="identifier"
              [(ngModel)]="identifier"
              autocomplete="username"
              autocapitalize="none"
              spellcheck="false"
              required
            />
          </label>

          <label>
            Password
            <input
              type="password"
              name="password"
              [(ngModel)]="password"
              autocomplete="current-password"
              required
            />
          </label>

          @if (error()) {
            <p class="error">{{ error() }}</p>
          }

          <button type="submit" [disabled]="loading()">
            {{ loading() ? 'Signing in…' : 'Sign in' }}
          </button>

          <a class="link" routerLink="/forgot-password">Forgot your password?</a>
        } @else {
          <p class="sub">Choose the store you're working in:</p>
          @if (error()) {
            <p class="error">{{ error() }}</p>
          }
          <div class="store-list">
            @for (s of storeChoices(); track s.id) {
              <button type="button" class="store-btn" [disabled]="loading()" (click)="chooseStore(s.id)">
                {{ s.name }}
              </button>
            }
          </div>
        }
      </form>
    </div>
  `,
  styles: [
    `
      .login-wrap {
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
        max-height: 48px;
        object-fit: contain;
        align-self: flex-start;
      }
      h1 {
        margin: 0;
        font-size: 1.25rem;
        color: var(--brand, var(--accent));
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
      button {
        margin-top: 0.5rem;
        background: var(--brand, var(--accent));
        border-color: var(--brand, var(--accent));
      }
      .store-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .store-btn {
        width: 100%;
        text-align: left;
        padding: 0.65rem 0.75rem;
      }
      .link {
        align-self: center;
        font-size: 0.85rem;
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
export class LoginComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  readonly adminHost = isAdminHost();

  /** Username or email address — the API tells them apart by the '@'. */
  identifier = '';
  password = '';
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly title = signal(this.adminHost ? 'Platform Admin' : 'PPS Retail Inventory');
  readonly brandColor = signal<string | null>(null);
  readonly logoUrl = signal<string | null>(null);

  // Store-choice step: set after login when several stores are permitted.
  readonly storeChoices = signal<{ id: number; name: string }[]>([]);
  readonly pendingRole = signal<Role | null>(null);

  ngOnInit(): void {
    if (this.adminHost) return;
    this.api.branding().subscribe({
      next: (b) => {
        this.title.set(b.name);
        this.brandColor.set(b.branding?.primaryColor ?? null);
        this.logoUrl.set(b.branding?.logoUrl ?? null);
      },
      error: () => {
        /* keep defaults if branding is unavailable */
      },
    });
  }

  submit(): void {
    if (!this.identifier || !this.password) {
      this.error.set('A username or email and a password are required.');
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    this.auth.login(this.identifier, this.password).subscribe({
      next: (res) => {
        this.loading.set(false);
        // A user permitted several stores picks one before entering the app.
        if (res.storeSelectionRequired && (res.availableStores?.length ?? 0) > 1) {
          this.storeChoices.set(res.availableStores ?? []);
          this.pendingRole.set(res.user.role);
          return;
        }
        void this.router.navigate([homePathForRole(res.user.role)]);
      },
      error: (err: HttpErrorResponse) => {
        this.loading.set(false);
        this.error.set(
          err.status === 401
            ? 'Invalid credentials.'
            : 'Something went wrong. Please try again.',
        );
      },
    });
  }

  /** Activate the chosen store, then enter the app. */
  chooseStore(storeId: number): void {
    this.loading.set(true);
    this.error.set(null);
    this.auth.selectStore(storeId).subscribe({
      next: (res) => {
        this.loading.set(false);
        void this.router.navigate([homePathForRole(res.user.role)]);
      },
      error: () => {
        this.loading.set(false);
        this.error.set('Could not select that store. Please try again.');
      },
    });
  }
}
