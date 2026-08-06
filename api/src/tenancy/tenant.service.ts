import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle.constants';
import { companies, Company } from '../db/schema';
import { HostContext } from './tenant-context';

@Injectable()
export class TenantService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly config: ConfigService,
  ) {}

  private get rootDomain(): string {
    return this.config.get<string>('ROOT_DOMAIN') ?? 'yourapp.local';
  }

  /** Resolve a Host header to a tenant context. companies has no RLS. */
  async resolve(rawHost?: string): Promise<HostContext> {
    const root = this.rootDomain.toLowerCase();
    const host = (rawHost ?? '').split(':')[0].trim().toLowerCase();
    if (!host) return { kind: 'unknown' };

    if (host === `admin.${root}`) return { kind: 'admin' };

    // A subdomain of the root is a slug, and only a slug: an unmatched one is
    // unknown rather than something to keep looking for.
    if (host !== root && host.endsWith(`.${root}`)) {
      const slug = host.slice(0, host.length - (root.length + 1));
      if (!slug || slug === 'www' || slug.includes('.')) {
        return { kind: 'unknown' };
      }
      const company = await this.findBySlug(slug);
      return company ? { kind: 'company', company } : { kind: 'unknown' };
    }

    // Any other host, INCLUDING the root itself, may be registered as a company's
    // custom domain.
    //
    // The root used to be rejected outright as "not a tenant", which is right when
    // companies live on subdomains — but it made a single-host deployment
    // impossible. On a host that gives you one name and no subdomains of it (a
    // *.up.railway.app, an internal server), the only way to reach a company is to
    // register that exact name, and ROOT_DOMAIN can then honestly be that name
    // instead of a domain nobody owns. An explicit registration is a decision
    // somebody made; the default is still "unknown".
    const company = await this.findByCustomDomain(host);
    return company ? { kind: 'company', company } : { kind: 'unknown' };
  }

  private async findBySlug(slug: string): Promise<Company | undefined> {
    const [row] = await this.db
      .select()
      .from(companies)
      .where(eq(companies.slug, slug))
      .limit(1);
    return row;
  }

  private async findByCustomDomain(domain: string): Promise<Company | undefined> {
    const [row] = await this.db
      .select()
      .from(companies)
      .where(eq(companies.customDomain, domain))
      .limit(1);
    return row;
  }
}
