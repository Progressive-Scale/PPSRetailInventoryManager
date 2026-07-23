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
    if (host === root) return { kind: 'unknown' }; // apex is not a tenant

    if (host.endsWith(`.${root}`)) {
      const slug = host.slice(0, host.length - (root.length + 1));
      if (!slug || slug === 'www' || slug.includes('.')) {
        return { kind: 'unknown' };
      }
      const company = await this.findBySlug(slug);
      return company ? { kind: 'company', company } : { kind: 'unknown' };
    }

    // Otherwise treat the whole host as a custom domain.
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
