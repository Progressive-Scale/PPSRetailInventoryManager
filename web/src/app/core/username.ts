/**
 * Username rules, restated for the client.
 *
 * DUPLICATED DELIBERATELY. The source of truth is api/src/auth/username.util.ts —
 * api and web are separate npm installs with no shared package, so there is no
 * import path between them. This copy exists only to catch a typo before a round
 * trip; the server validates independently and owns every verdict the client
 * cannot know, such as whether a name is already taken.
 *
 * If you change the rule, change it in BOTH files.
 */
export const USERNAME_INPUT_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{1,30}[A-Za-z0-9]$/;

export const USERNAME_RULE =
  'Username must be 3–32 characters using letters, numbers, dot, underscore or ' +
  'hyphen, starting and ending with a letter or number.';
