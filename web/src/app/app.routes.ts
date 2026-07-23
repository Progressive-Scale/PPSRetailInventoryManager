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
    path: 'inventory',
    canActivate: [authGuard, roleGuard(['STORE_USER', 'COMPANY_ADMIN'])],
    loadComponent: () => import('./pages/inventory/inventory').then((m) => m.InventoryComponent),
  },
  {
    path: 'cycle-counts',
    canActivate: [authGuard, roleGuard(['STORE_USER', 'COMPANY_ADMIN'])],
    loadComponent: () =>
      import('./pages/cycle-counts/cycle-counts').then((m) => m.CycleCountsComponent),
  },
  {
    path: 'needs-review',
    canActivate: [authGuard, roleGuard(['COMPANY_ADMIN'])],
    loadComponent: () =>
      import('./pages/needs-review/needs-review').then((m) => m.NeedsReviewComponent),
  },
  {
    path: 'manage',
    canActivate: [authGuard, roleGuard(['COMPANY_ADMIN'])],
    loadComponent: () => import('./pages/manage/manage').then((m) => m.ManageComponent),
  },
  {
    path: 'platform',
    canActivate: [authGuard, roleGuard(['PLATFORM_ADMIN'])],
    loadComponent: () => import('./pages/platform/platform').then((m) => m.PlatformComponent),
  },
  { path: '', pathMatch: 'full', canActivate: [() => rootRedirect()], children: [] },
  { path: '**', redirectTo: '' },
];
