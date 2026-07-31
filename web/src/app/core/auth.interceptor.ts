import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * Attaches the JWT to outgoing requests and logs out on a 401.
 *
 * CONTRACT FOR API ROUTES: a 401 from an authenticated route means "this session is
 * no longer valid", and the user is ejected to the login screen. An endpoint that
 * checks a credential supplied in the request *body* — a current-password
 * confirmation, say — must not answer 401 when that value is wrong, or a single typo
 * signs the user out. Use 400 there; the session was never in question.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const token = auth.token;
  const authReq = token
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;

  const isAuthCall =
    req.url.includes('/auth/login') || req.url.includes('/auth/accept-invite');

  return next(authReq).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status === 401 && !isAuthCall) {
        auth.logout();
        void router.navigate(['/login']);
      }
      return throwError(() => err);
    }),
  );
};
