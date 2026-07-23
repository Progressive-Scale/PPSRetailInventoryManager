import { HttpErrorResponse } from '@angular/common/http';

/** Extract a human-readable message from a NestJS-style error response. */
export function messageFor(err: unknown, fallback = 'Request failed. Please try again.'): string {
  if (err instanceof HttpErrorResponse) {
    const msg = (err.error as { message?: string | string[] } | null)?.message;
    if (Array.isArray(msg)) return msg.join(', ');
    if (typeof msg === 'string') return msg;
  }
  return fallback;
}
