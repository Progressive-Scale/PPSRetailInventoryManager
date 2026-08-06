import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { messageFor } from '../../core/http-error';
import { Profile, roleLabel } from '../../core/models';
import { USERNAME_INPUT_PATTERN, USERNAME_RULE } from '../../core/username';

/**
 * Your own account: what you sign in as, and your password. Deliberately separate
 * from Manage → Users, which is an admin editing *other* people — an admin cannot
 * change somebody's username there, and nobody can change their own role or store
 * here. The two screens never overlap.
 */
@Component({
  selector: 'app-profile',
  imports: [FormsModule, DatePipe],
  template: `
    <main class="container">
      <h1>My profile</h1>

      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else if (loadError()) {
        <p class="error">{{ loadError() }}</p>
      } @else if (profile(); as p) {
        <section class="card">
          <h2>Account</h2>
          <dl class="facts">
            <dt>Email</dt>
            <dd>{{ p.email }}</dd>
            <dt>Role</dt>
            <dd>{{ roleLabel(p.role) }}</dd>
            <dt>Member since</dt>
            <dd>{{ p.createdAt | date: 'mediumDate' }}</dd>
          </dl>
          <p class="muted small">
            Your email and role are set by an administrator. Ask them if either needs
            to change.
          </p>
        </section>

        <section class="card">
          <h2>Username</h2>
          <p class="muted small">
            You can sign in with this or your email address.
          </p>
          <form class="stack" (ngSubmit)="saveUsername()">
            <label>
              Username
              <input
                type="text"
                name="username"
                [ngModel]="username"
                (ngModelChange)="onUsernameInput($event)"
                autocomplete="username"
                autocapitalize="none"
                spellcheck="false"
                maxlength="32"
                required
              />
              <small class="hint">{{ usernameRule }}</small>
            </label>
            @if (usernameError()) {
              <p class="error">{{ usernameError() }}</p>
            }
            @if (usernameSaved()) {
              <p class="ok">Username updated.</p>
            }
            <div class="row">
              <button type="submit" [disabled]="savingUsername() || !usernameChanged()">
                {{ savingUsername() ? 'Saving…' : 'Save username' }}
              </button>
              <button
                type="button"
                class="ghost"
                (click)="resetUsername()"
                [disabled]="savingUsername() || !usernameChanged()"
              >
                Cancel
              </button>
            </div>
          </form>
        </section>

        <section class="card">
          <h2>Password</h2>
          <form class="stack" (ngSubmit)="savePassword()">
            <label>
              Current password
              <input
                type="password"
                name="currentPassword"
                [(ngModel)]="currentPassword"
                autocomplete="current-password"
                required
              />
            </label>
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
                name="confirmPassword"
                [(ngModel)]="confirmPassword"
                autocomplete="new-password"
                required
              />
            </label>
            @if (passwordError()) {
              <p class="error">{{ passwordError() }}</p>
            }
            @if (passwordSaved()) {
              <p class="ok">
                Password changed. Sessions already signed in elsewhere stay signed in
                until they expire.
              </p>
            }
            <div class="row">
              <button type="submit" [disabled]="savingPassword()">
                {{ savingPassword() ? 'Changing…' : 'Change password' }}
              </button>
            </div>
          </form>
        </section>
      }
    </main>
  `,
  styles: [
    `
      .container {
        max-width: 640px;
        margin: 1.5rem auto;
        padding: 0 1rem;
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
      }
      h1 {
        margin: 0;
        font-size: 1.3rem;
      }
      h2 {
        margin: 0 0 0.5rem;
        font-size: 1.05rem;
      }
      .card {
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--surface);
        padding: 1.25rem;
      }
      .facts {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 0.35rem 1rem;
        margin: 0 0 0.75rem;
        font-size: 0.9rem;
      }
      .facts dt {
        color: var(--muted);
      }
      .facts dd {
        margin: 0;
      }
      .stack {
        display: flex;
        flex-direction: column;
        gap: 0.85rem;
        margin-top: 0.85rem;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        font-size: 0.85rem;
        color: var(--muted);
      }
      input {
        padding: 0.5rem 0.6rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.95rem;
        font-family: inherit;
      }
      .hint {
        font-size: 0.72rem;
        line-height: 1.35;
        color: var(--muted);
      }
      .row {
        display: flex;
        gap: 0.5rem;
      }
      .row button {
        padding: 0.45rem 0.9rem;
        border-radius: 8px;
        font-family: inherit;
        font-size: 0.9rem;
        cursor: pointer;
      }
      .row button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
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
        margin: 0;
      }
      .ok {
        color: #067647;
        font-size: 0.85rem;
        margin: 0;
      }
    `,
  ],
})
export class ProfileComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  readonly usernameRule = USERNAME_RULE;

  readonly profile = signal<Profile | null>(null);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);

  username = '';
  readonly savingUsername = signal(false);
  readonly usernameError = signal<string | null>(null);
  readonly usernameSaved = signal(false);

  currentPassword = '';
  newPassword = '';
  confirmPassword = '';
  readonly savingPassword = signal(false);
  readonly passwordError = signal<string | null>(null);
  readonly passwordSaved = signal(false);

  // What is in the box, mirrored into a signal so usernameChanged() recomputes as
  // you type — a plain ngModel field is not reactive.
  private readonly usernameInput = signal('');

  /** Nothing to save until the field actually differs from what is stored. */
  readonly usernameChanged = computed(() => {
    const p = this.profile();
    return !!p && this.usernameInput().trim().toLowerCase() !== p.username;
  });

  onUsernameInput(v: string): void {
    this.username = v;
    this.usernameInput.set(v);
    this.usernameSaved.set(false);
  }

  ngOnInit(): void {
    this.api.profile().subscribe({
      next: (p) => {
        this.profile.set(p);
        this.setUsername(p.username);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.loadError.set(messageFor(err));
      },
    });
  }

  private setUsername(v: string): void {
    this.username = v;
    this.usernameInput.set(v);
  }

  resetUsername(): void {
    const p = this.profile();
    if (p) this.setUsername(p.username);
    this.usernameError.set(null);
  }

  saveUsername(): void {
    const wanted = this.username.trim();
    this.usernameSaved.set(false);
    if (!USERNAME_INPUT_PATTERN.test(wanted)) {
      this.usernameError.set(USERNAME_RULE);
      return;
    }
    this.savingUsername.set(true);
    this.usernameError.set(null);
    this.api.changeUsername(wanted).subscribe({
      next: (p) => {
        this.savingUsername.set(false);
        this.profile.set(p);
        this.setUsername(p.username);
        this.usernameSaved.set(true);
        // Keeps the header (and anything else reading the session) in step without
        // forcing a re-login; the token does not carry the username.
        this.auth.patchUser({ username: p.username });
      },
      error: (err) => {
        this.savingUsername.set(false);
        this.usernameError.set(messageFor(err));
      },
    });
  }

  savePassword(): void {
    this.passwordSaved.set(false);
    if (this.newPassword.length < 8) {
      this.passwordError.set('New password must be at least 8 characters.');
      return;
    }
    if (this.newPassword !== this.confirmPassword) {
      this.passwordError.set('New passwords do not match.');
      return;
    }
    this.savingPassword.set(true);
    this.passwordError.set(null);
    this.api.changePassword(this.currentPassword, this.newPassword).subscribe({
      next: () => {
        this.savingPassword.set(false);
        this.passwordSaved.set(true);
        this.currentPassword = '';
        this.newPassword = '';
        this.confirmPassword = '';
      },
      error: (err) => {
        this.savingPassword.set(false);
        this.passwordError.set(messageFor(err));
      },
    });
  }

  readonly roleLabel = roleLabel;
}
