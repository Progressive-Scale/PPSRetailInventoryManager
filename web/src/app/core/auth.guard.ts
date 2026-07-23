import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';
import { Role } from './models';
import { homePathForRole } from './tenant';

/** Allow only logged-in users; otherwise send to /login. */
export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.isLoggedIn() ? true : router.createUrlTree(['/login']);
};

/** Factory: allow only users whose role is in `roles`, else send home. */
export function roleGuard(roles: Role[]): CanActivateFn {
  return () => {
    const auth = inject(AuthService);
    const router = inject(Router);
    const user = auth.user();
    if (!user) return router.createUrlTree(['/login']);
    if (roles.includes(user.role)) return true;
    return router.createUrlTree([homePathForRole(user.role)]);
  };
}
