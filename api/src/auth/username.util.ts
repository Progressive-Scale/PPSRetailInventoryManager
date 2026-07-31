/**
 * Username rules, in one place because three callers have to agree on them: the
 * accept-invite DTO that validates what a new user types, the login lookup that
 * decides whether the identifier is a username or an email, and migration 0016
 * which derived a username for every account that predates this feature.
 *
 * Deliberately narrow: lowercase letters, digits, dot, underscore and hyphen,
 * 3–32 characters, and it must start and end with a letter or digit. That keeps
 * usernames typeable on a scan-gun keypad and unambiguous in a URL, and it means
 * a username can never contain '@' — which is what lets login tell the two kinds
 * of identifier apart without asking.
 */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/;

/**
 * What a user is allowed to *type*. Uppercase is accepted and folded down rather
 * than rejected — refusing "Alice" would be needless friction when "alice" is
 * what gets stored. Only the stored form has to match USERNAME_PATTERN.
 */
export const USERNAME_INPUT_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{1,30}[A-Za-z0-9]$/;

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;

/** Human-readable form of the rule, for validation messages. */
export const USERNAME_RULE =
  'Username must be 3–32 characters using letters, numbers, dot, underscore or ' +
  'hyphen, starting and ending with a letter or number.';

/** Usernames are stored and compared lowercase; input is folded, not rejected. */
export function normaliseUsername(input: string): string {
  return input.trim().toLowerCase();
}

export function isValidUsername(input: string): boolean {
  return USERNAME_PATTERN.test(normaliseUsername(input));
}

/**
 * An identifier is treated as an email as soon as it contains '@' — usernames
 * cannot, so there is no overlap and no guessing.
 */
export function looksLikeEmail(identifier: string): boolean {
  return identifier.includes('@');
}
