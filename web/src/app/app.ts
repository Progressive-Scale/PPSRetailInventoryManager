import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth.service';
import { ApiService } from './core/api.service';
import { Role } from './core/models';
import { isAdminHost } from './core/tenant';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    @if (auth.isLoggedIn() && auth.user(); as u) {
      <header class="appbar">
        <div class="brand">
          <strong>{{ appName() }}</strong>
          <nav class="nav">
            @for (link of navLinks(); track link.path) {
              <a [routerLink]="link.path" routerLinkActive="active">{{ link.label }}</a>
            }
          </nav>
        </div>
        <div class="user">
          <span class="email">{{ u.email }}</span>
          <span class="badge">{{ roleLabel(u.role) }}</span>
          <button class="ghost" (click)="signOut()">Sign out</button>
        </div>
      </header>
    }
    <router-outlet />
  `,
  styles: [
    `
      .appbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        padding: 0.6rem 1.25rem;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
        flex-wrap: wrap;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 1.25rem;
      }
      .brand strong {
        color: var(--brand, var(--accent));
      }
      .nav {
        display: flex;
        gap: 0.35rem;
      }
      .nav a {
        text-decoration: none;
        color: var(--muted);
        padding: 0.3rem 0.6rem;
        border-radius: 8px;
        font-size: 0.9rem;
      }
      .nav a.active {
        color: var(--brand, var(--accent));
        background: var(--accent-soft);
      }
      .user {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        font-size: 0.85rem;
      }
      .email {
        color: var(--text);
      }
      .badge {
        padding: 0.1rem 0.5rem;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--brand, var(--accent));
        font-size: 0.72rem;
        white-space: nowrap;
      }
    `,
  ],
})
export class App implements OnInit {
  readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  private readonly companyName = signal<string | null>(null);

  readonly appName = computed(() => {
    if (isAdminHost()) return 'Platform Admin';
    return this.companyName() ?? 'PPS Retail Inventory';
  });

  readonly navLinks = computed<{ path: string; label: string }[]>(() => {
    const u = this.auth.user();
    if (!u) return [];
    switch (u.role) {
      case 'PLATFORM_ADMIN':
        return [{ path: '/platform', label: 'Platform' }];
      case 'COMPANY_ADMIN':
        return [
          { path: '/inventory', label: 'Inventory' },
          { path: '/cycle-counts', label: 'Cycle Counts' },
          { path: '/needs-review', label: 'Review' },
          { path: '/manage', label: 'Manage' },
        ];
      default:
        return [
          { path: '/inventory', label: 'Inventory' },
          { path: '/cycle-counts', label: 'Cycle Counts' },
        ];
    }
  });

  ngOnInit(): void {
    // On a company host, load branding to theme the shell + show company name.
    if (!isAdminHost()) {
      this.api.branding().subscribe({
        next: (b) => {
          this.companyName.set(b.name);
          if (b.branding?.primaryColor) {
            document.documentElement.style.setProperty('--brand', b.branding.primaryColor);
          }
        },
        error: () => {
          /* non-fatal; keep defaults */
        },
      });
    }
  }

  roleLabel(role: Role): string {
    switch (role) {
      case 'PLATFORM_ADMIN':
        return 'Platform Admin';
      case 'COMPANY_ADMIN':
        return 'Company Admin';
      default:
        return 'Store User';
    }
  }

  signOut(): void {
    this.auth.logout();
    void this.router.navigate(['/login']);
  }
}
