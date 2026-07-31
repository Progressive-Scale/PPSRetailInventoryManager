import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth.service';
import { BrandingStore } from './core/branding.store';
import { NotificationStore } from './core/notification.store';
import { AppNotification, Role } from './core/models';
import { isAdminHost } from './core/tenant';

interface NavLink {
  path: string;
  label: string;
  icon: string;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, DatePipe],
  template: `
    @if (auth.isLoggedIn() && auth.user(); as u) {
      <div class="shell" [class.drawer-open]="drawerOpen()">
        <aside class="drawer">
          <div class="drawer-brand">
            @if (logoUrl()) {
              <img class="logo" [src]="logoUrl()" alt="" />
            }
            <strong>{{ appName() }}</strong>
          </div>
          <nav class="nav">
            @for (link of navLinks(); track link.path) {
              <a
                [routerLink]="link.path"
                routerLinkActive="active"
                (click)="drawerOpen.set(false)"
              >
                <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
                  <path [attr.d]="link.icon" />
                </svg>
                <span>{{ link.label }}</span>
              </a>
            }
          </nav>
        </aside>

        <div class="main">
          <header class="topbar">
            <div class="left">
              <button class="hamburger ghost" (click)="toggleDrawer()" aria-label="Toggle menu">
                <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z" />
                </svg>
              </button>
              <span class="topbar-brand">
                @if (logoUrl()) {
                  <img class="logo" [src]="logoUrl()" alt="" />
                }
                <strong class="company">{{ appName() }}</strong>
              </span>
            </div>
            <div class="user">
              @if (showBell()) {
                <div class="bell-wrap">
                  <button class="ghost bell" (click)="toggleBell()" aria-label="Notifications">
                    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" />
                    </svg>
                    @if (notifications.unread() > 0) {
                      <span class="bell-badge">{{ notifications.unread() }}</span>
                    }
                  </button>
                  @if (bellOpen()) {
                    <div class="bell-dropdown">
                      <div class="bell-head">
                        <strong>Alerts</strong>
                        <a routerLink="/notifications" (click)="bellOpen.set(false)">
                          View all
                        </a>
                      </div>
                      @if (notifications.loading()) {
                        <p class="muted pad">Loading…</p>
                      } @else if (notifications.items().length === 0) {
                        <p class="muted pad">No alerts.</p>
                      } @else {
                        <ul class="notif-list">
                          @for (n of notifications.items(); track n.id) {
                            <li [class.read]="n.status !== 'UNREAD'">
                              <button class="notif-main" type="button" (click)="openNotification(n)">
                                @if (n.type === 'INVITE_ACCEPTED') {
                                  <span class="notif-title">
                                    {{ n.payload.email }}
                                    <span class="notif-serial">joined</span>
                                  </span>
                                  <span class="notif-sub">
                                    Accepted their invitation as
                                    {{ n.payload.role === 'COMPANY_ADMIN' ? 'Company Admin' : 'Store User' }}
                                  </span>
                                } @else {
                                  <span class="notif-title">
                                    {{ n.payload.productName }}
                                    <span class="notif-serial">{{ n.payload.serial }}</span>
                                  </span>
                                  <span class="notif-sub" [class.exp]="n.payload.expired">
                                    @if (n.payload.expired) {
                                      Expired {{ n.payload.expirationDate | date: 'shortDate' }}
                                    } @else {
                                      Expires in {{ n.payload.daysLeft }} day(s)
                                    }
                                  </span>
                                }
                              </button>
                              <div class="notif-actions">
                                @if (n.status === 'UNREAD') {
                                  <button class="link" (click)="notifications.markRead(n.id)">Read</button>
                                }
                                <button class="link" (click)="notifications.dismiss(n.id)">Dismiss</button>
                              </div>
                            </li>
                          }
                        </ul>
                      }
                    </div>
                  }
                </div>
              }
              <span class="email">{{ u.email }}</span>
              <span class="badge">{{ roleLabel(u.role) }}</span>
              <button class="ghost" (click)="signOut()">Sign out</button>
            </div>
          </header>
          <div class="content">
            <router-outlet />
          </div>
        </div>

        <div class="scrim" (click)="drawerOpen.set(false)"></div>
      </div>
    } @else {
      <router-outlet />
    }
  `,
  styles: [
    `
      .shell {
        display: flex;
        min-height: 100vh;
      }
      .drawer {
        width: 240px;
        flex-shrink: 0;
        background: var(--surface);
        border-right: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 0.85rem 0.75rem;
        position: sticky;
        top: 0;
        align-self: flex-start;
        height: 100vh;
      }
      .drawer-brand {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.35rem 0.5rem 0.75rem;
        border-bottom: 1px solid var(--border);
      }
      .drawer-brand strong {
        color: var(--brand, var(--accent));
        font-size: 1rem;
        line-height: 1.2;
      }
      .logo {
        width: 32px;
        height: 32px;
        object-fit: contain;
        border-radius: 6px;
      }
      .nav {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
      }
      .nav a {
        display: flex;
        align-items: center;
        gap: 0.65rem;
        text-decoration: none;
        color: var(--muted);
        padding: 0.55rem 0.65rem;
        border-radius: 8px;
        font-size: 0.92rem;
      }
      .nav a:hover {
        background: var(--bg);
      }
      .nav a.active {
        color: var(--brand, var(--accent));
        background: var(--accent-soft);
      }
      .ico {
        width: 20px;
        height: 20px;
        flex-shrink: 0;
        fill: currentColor;
      }
      .main {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }
      .topbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        padding: 0.6rem 1.25rem;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
        flex-wrap: wrap;
      }
      .left {
        display: flex;
        align-items: center;
        gap: 0.6rem;
      }
      .company {
        color: var(--brand, var(--accent));
      }
      /* The drawer already shows the logo and company name, so this is a duplicate
         whenever the drawer is on screen. Kept only for the narrow layout, where
         the drawer is off-canvas and this is the sole branding. */
      .topbar-brand {
        display: none;
      }
      .hamburger {
        display: none;
        padding: 0.35rem;
        line-height: 0;
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
      .content {
        flex: 1;
        min-width: 0;
      }
      .bell-wrap {
        position: relative;
      }
      .bell {
        position: relative;
        padding: 0.3rem;
        line-height: 0;
      }
      .bell-badge {
        position: absolute;
        top: -4px;
        right: -4px;
        min-width: 16px;
        height: 16px;
        padding: 0 4px;
        border-radius: 999px;
        background: #b42318;
        color: #fff;
        font-size: 0.64rem;
        line-height: 16px;
        text-align: center;
      }
      .bell-dropdown {
        position: absolute;
        right: 0;
        top: calc(100% + 6px);
        width: 320px;
        max-height: 60vh;
        overflow-y: auto;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
        z-index: 70;
      }
      .bell-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.6rem 0.75rem;
        border-bottom: 1px solid var(--border);
      }
      .bell-head a {
        font-size: 0.78rem;
        color: var(--brand, var(--accent));
      }
      .pad {
        padding: 0.75rem;
        margin: 0;
      }
      /* .notif-main is a button so the whole alert is clickable, but it must read
         as the plain stacked text it replaced. */
      .notif-main {
        display: flex;
        flex-direction: column;
        gap: 0.1rem;
        width: 100%;
        padding: 0;
        border: none;
        background: none;
        font: inherit;
        color: inherit;
        text-align: left;
        cursor: pointer;
      }
      .notif-main:hover .notif-title {
        text-decoration: underline;
      }
      .notif-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .notif-list li {
        display: flex;
        justify-content: space-between;
        gap: 0.5rem;
        padding: 0.55rem 0.75rem;
        border-bottom: 1px solid var(--border);
      }
      .notif-list li.read {
        opacity: 0.55;
      }
      .notif-main {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        min-width: 0;
      }
      .notif-title {
        font-size: 0.85rem;
      }
      .notif-serial {
        font-family: ui-monospace, monospace;
        font-size: 0.72rem;
        color: var(--muted);
        margin-left: 0.3rem;
      }
      .notif-sub {
        font-size: 0.75rem;
        color: #b54708;
      }
      .notif-sub.exp {
        color: #b42318;
        font-weight: 600;
      }
      .notif-actions {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        white-space: nowrap;
      }
      .notif-actions .link {
        background: transparent;
        border: none;
        color: var(--brand, var(--accent));
        font-size: 0.75rem;
        cursor: pointer;
        padding: 0;
      }
      .scrim {
        display: none;
      }

      @media (max-width: 720px) {
        .drawer {
          position: fixed;
          z-index: 60;
          height: 100vh;
          transform: translateX(-100%);
          transition: transform 0.2s ease;
        }
        .drawer-open .drawer {
          transform: translateX(0);
        }
        .hamburger {
          display: inline-flex;
        }
        .topbar-brand {
          display: inline-flex;
          align-items: center;
          gap: 0.6rem;
        }
        .drawer-open .scrim {
          display: block;
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.4);
          z-index: 55;
        }
      }
    `,
  ],
})
export class App implements OnInit {
  readonly auth = inject(AuthService);
  private readonly branding = inject(BrandingStore);
  readonly notifications = inject(NotificationStore);
  private readonly router = inject(Router);

  readonly drawerOpen = signal(false);
  readonly bellOpen = signal(false);

  /** The bell is for company/store users on a company host (not platform admin). */
  readonly showBell = computed(() => {
    const u = this.auth.user();
    return !isAdminHost() && !!u && u.role !== 'PLATFORM_ADMIN';
  });

  readonly isCompanyAdmin = computed(() => this.auth.user()?.role === 'COMPANY_ADMIN');

  readonly logoUrl = computed(() => (isAdminHost() ? null : this.branding.logoUrl()));

  readonly appName = computed(() => {
    if (isAdminHost()) return 'Platform Admin';
    return this.branding.name() ?? 'PPS Retail Inventory';
  });

  // Icon path data (24x24, currentColor fill).
  private static readonly ICONS = {
    inventory:
      'M20 2H4c-1.1 0-2 .9-2 2v3.01c0 .72.43 1.34 1 1.69V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.57-.35 1-.97 1-1.69V4c0-1.1-.9-2-2-2zm-5 12H9v-2h6v2zm5-7H4V4h16v3z',
    cycle:
      'M12 6v3l4-4-4-4v3c-4.42 0-8 3.58-8 8 0 1.57.46 3.03 1.24 4.26L6.7 14.8c-.45-.83-.7-1.79-.7-2.8 0-3.31 2.69-6 6-6zm6.76 1.74L17.3 9.2c.44.84.7 1.79.7 2.8 0 3.31-2.69 6-6 6v-3l-4 4 4 4v-3c4.42 0 8-3.58 8-8 0-1.57-.46-3.03-1.24-4.26z',
    products:
      'M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58s1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41s-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z',
    manage:
      'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
    settings:
      'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
    platform:
      'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
    alerts:
      'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z',
  };

  readonly navLinks = computed<NavLink[]>(() => {
    const u = this.auth.user();
    if (!u) return [];
    const I = App.ICONS;
    switch (u.role) {
      case 'PLATFORM_ADMIN':
        return [{ path: '/platform', label: 'Platform', icon: I.platform }];
      case 'COMPANY_ADMIN':
        return [
          { path: '/inventory', label: 'Inventory', icon: I.inventory },
          { path: '/cycle-counts', label: 'Cycle Counts', icon: I.cycle },
          { path: '/products', label: 'Products', icon: I.products },
          { path: '/manage', label: 'Manage', icon: I.manage },
          { path: '/notifications', label: 'Notifications', icon: I.alerts },
          { path: '/settings', label: 'Settings', icon: I.settings },
        ];
      default:
        return [
          { path: '/inventory', label: 'Inventory', icon: I.inventory },
          { path: '/cycle-counts', label: 'Cycle Counts', icon: I.cycle },
        ];
    }
  });

  ngOnInit(): void {
    // On a company host, load branding to theme the shell + show company name.
    if (!isAdminHost()) {
      this.branding.refresh();
    }
    if (this.showBell()) {
      this.notifications.start();
    }
  }

  toggleDrawer(): void {
    this.drawerOpen.update((v) => !v);
  }

  toggleBell(): void {
    const open = !this.bellOpen();
    this.bellOpen.set(open);
    if (open) this.notifications.refreshList();
  }

  /**
   * Clicking an alert takes you to the thing it is about: an expiration warning
   * opens that unit in Inventory (the item id is passed so the page can select it
   * once the row loads); an accepted invitation opens the users list. Marking it
   * read is implicit — you have now seen it.
   */
  openNotification(n: AppNotification): void {
    this.bellOpen.set(false);
    if (n.status === 'UNREAD') this.notifications.markRead(n.id);
    if (n.type === 'INVITE_ACCEPTED') {
      this.router.navigate(['/manage'], { queryParams: { tab: 'users' } });
      return;
    }
    this.router.navigate(['/inventory'], {
      queryParams: { itemId: n.payload.itemId, serial: n.payload.serial },
    });
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
