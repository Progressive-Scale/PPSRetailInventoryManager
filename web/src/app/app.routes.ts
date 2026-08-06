import { inject } from '@angular/core';
import { Routes, Router, UrlTree } from '@angular/router';
import { authGuard, roleGuard } from './core/auth.guard';
import { AuthService } from './core/auth.service';
import { homePathForRole } from './core/tenant';

/** Root path: send users to the right landing page based on login + role. */
function rootRedirect(): UrlTree {
  const auth = inject(AuthService);
  const router = inject(Router);
  const user = auth.user();
  if (!user) return router.createUrlTree(['/login']);
  return router.createUrlTree([homePathForRole(user.role)]);
}

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./pages/login/login').then((m) => m.LoginComponent),
  },
  {
    path: 'accept-invite',
    loadComponent: () =>
      import('./pages/accept-invite/accept-invite').then((m) => m.AcceptInviteComponent),
  },
  {
    // Both steps of a forgotten password. Public: whoever needs them cannot sign in.
    path: 'forgot-password',
    loadComponent: () =>
      import('./pages/forgot-password/forgot-password').then(
        (m) => m.ForgotPasswordComponent,
      ),
  },
  {
    path: 'reset-password',
    loadComponent: () =>
      import('./pages/reset-password/reset-password').then(
        (m) => m.ResetPasswordComponent,
      ),
  },
  {
    path: 'inventory',
    canActivate: [authGuard, roleGuard(['STORE_USER', 'STORE_MANAGER', 'COMPANY_ADMIN'])],
    loadComponent: () => import('./pages/inventory/inventory').then((m) => m.InventoryComponent),
  },
  {
    path: 'cycle-counts',
    canActivate: [authGuard, roleGuard(['STORE_USER', 'STORE_MANAGER', 'COMPANY_ADMIN'])],
    loadComponent: () =>
      import('./pages/cycle-counts/cycle-counts').then((m) => m.CycleCountsComponent),
  },
  {
    // Catalog maintenance, so a store manager gets it too.
    path: 'products',
    canActivate: [authGuard, roleGuard(['COMPANY_ADMIN', 'STORE_MANAGER'])],
    loadComponent: () => import('./pages/products/products').then((m) => m.ProductsComponent),
  },
  // Old Review route now lives as a sub-tab of Products.
  { path: 'needs-review', redirectTo: 'products', pathMatch: 'full' },
  {
    path: 'manage',
    canActivate: [authGuard, roleGuard(['COMPANY_ADMIN'])],
    loadComponent: () => import('./pages/manage/manage').then((m) => m.ManageComponent),
  },
  {
    path: 'settings',
    canActivate: [authGuard, roleGuard(['COMPANY_ADMIN'])],
    loadComponent: () => import('./pages/settings/settings').then((m) => m.SettingsComponent),
  },
  {
    // Store users too: whoever raised a request is who wants to know its fate.
    path: 'reorders',
    canActivate: [authGuard, roleGuard(['STORE_USER', 'STORE_MANAGER', 'COMPANY_ADMIN'])],
    loadComponent: () => import('./pages/reorders/reorders').then((m) => m.ReordersComponent),
  },
  {
    // Full notification history (all statuses), with bulk removal.
    path: 'notifications',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/notifications/notifications').then((m) => m.NotificationsComponent),
  },
  {
    // Alert configuration moved into Settings as a section.
    path: 'notification-settings',
    redirectTo: 'settings',
    pathMatch: 'full',
  },
  {
    // Your own account. Every role has one, platform admins included, so this is
    // guarded on being signed in and nothing more.
    path: 'profile',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/profile/profile').then((m) => m.ProfileComponent),
  },
  {
    path: 'platform',
    canActivate: [authGuard, roleGuard(['PLATFORM_ADMIN'])],
    loadComponent: () => import('./pages/platform/platform').then((m) => m.PlatformComponent),
  },
  { path: '', pathMatch: 'full', canActivate: [() => rootRedirect()], children: [] },
  { path: '**', redirectTo: '' },
];
