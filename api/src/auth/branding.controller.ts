import { Controller, Get } from '@nestjs/common';
import { CurrentCompany } from '../tenancy/current-tenant.decorator';
import { Company } from '../db/schema';

/** Public per-tenant branding for theming the login page. */
@Controller('branding')
export class BrandingController {
  @Get()
  get(@CurrentCompany() company: Company) {
    return {
      name: company.name,
      slug: company.slug,
      branding: company.branding ?? {},
    };
  }
}
