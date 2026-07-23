import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TenantService } from './tenant.service';
import { TenantGuard } from './tenant.guard';

@Global()
@Module({
  providers: [
    TenantService,
    // Global: resolves the tenant for every /api route (before other guards).
    { provide: APP_GUARD, useClass: TenantGuard },
  ],
  exports: [TenantService],
})
export class TenancyModule {}
