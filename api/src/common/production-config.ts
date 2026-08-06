/**
 * Refuse to start a production deploy that is configured like a development one.
 *
 * These are all things that work perfectly on the bench and are wrong in a way
 * nothing surfaces later: a signing secret everybody can read from a committed
 * example file, a tenant domain nobody owns. There is no runtime symptom for
 * either — the app just runs, and either anyone can mint a valid token or no
 * customer's subdomain resolves.
 *
 * Development is untouched: every check below is a no-op unless NODE_ENV is
 * production, because these are exactly the values a laptop is supposed to have.
 *
 * Reads the real process environment, deliberately, because it runs before Nest
 * and its ConfigModule exist. On Railway (and any other host that injects real
 * variables) that is the same thing. A NODE_ENV=production that lives only in a
 * .env file would not be seen here — but that is not a production deploy.
 */

/** Values shipped in .env.example / the README. Present in git, so public. */
const PUBLISHED_SECRETS = new Set([
  'dev-only-change-me',
  'change-me',
  'secret',
  'changeme',
]);

/** Hostnames used as stand-ins in docs. Nobody owns them. */
const PLACEHOLDER_DOMAINS = new Set([
  'yourapp.com',
  'yourapp.local',
  'example.com',
  'localhost',
]);

const MIN_SECRET_LENGTH = 32;

export function assertProductionConfig(env = process.env): void {
  if (env.NODE_ENV !== 'production') return;

  const problems: string[] = [];

  const secret = env.JWT_SECRET ?? '';
  if (!secret) {
    problems.push('JWT_SECRET is not set.');
  } else if (PUBLISHED_SECRETS.has(secret.trim().toLowerCase())) {
    problems.push(
      'JWT_SECRET is one of the published example values — it is in the repo, ' +
        'so anyone can forge a token. Generate a new one.',
    );
  } else if (secret.length < MIN_SECRET_LENGTH) {
    problems.push(
      `JWT_SECRET is ${secret.length} characters; use at least ${MIN_SECRET_LENGTH} ` +
        '(e.g. `openssl rand -base64 48`).',
    );
  }

  const domain = (env.ROOT_DOMAIN ?? '').trim().toLowerCase();
  if (!domain) {
    problems.push(
      'ROOT_DOMAIN is not set — tenant subdomains cannot be resolved.',
    );
  } else if (PLACEHOLDER_DOMAINS.has(domain)) {
    problems.push(
      `ROOT_DOMAIN is the placeholder "${domain}". Set the domain whose ` +
        'wildcard record actually points at this service.',
    );
  }

  if (problems.length > 0) {
    throw new Error(
      'Refusing to start in production with a development configuration:\n' +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
  }
}
