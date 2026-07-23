import { Role } from './models';

/** True when the browser is on the platform-admin host (admin.*). */
export function isAdminHost(): boolean {
  return window.location.hostname.startsWith('admin.');
}

/**
 * Derive a company host from the current admin host by swapping the leading
 * `admin.` for `<slug>.`. e.g. admin.yourapp.local -> demo.yourapp.local.
 */
export function companyHostForSlug(slug: string): string {
  const host = window.location.hostname;
  const rest = host.startsWith('admin.') ? host.slice('admin.'.length) : host;
  return `${slug}.${rest}`;
}

/** Full origin (protocol + host + optional port) for a company slug. */
export function companyOriginForSlug(slug: string): string {
  const { protocol, port } = window.location;
  const host = companyHostForSlug(slug);
  return `${protocol}//${host}${port ? ':' + port : ''}`;
}

/** Accept-invite URL on a company subdomain for a given slug + token. */
export function companyAcceptUrl(slug: string, token: string): string {
  return `${companyOriginForSlug(slug)}/accept-invite?token=${encodeURIComponent(token)}`;
}

/** Accept-invite URL on the current origin. */
export function localAcceptUrl(token: string): string {
  return `${window.location.origin}/accept-invite?token=${encodeURIComponent(token)}`;
}

/** Landing route for a role after login. */
export function homePathForRole(role: Role): string {
  return role === 'PLATFORM_ADMIN' ? '/platform' : '/inventory';
}
