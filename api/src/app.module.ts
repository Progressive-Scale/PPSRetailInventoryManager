import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { DatabaseModule } from './db/database.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { AuthModule } from './auth/auth.module';
import { InventoryModule } from './inventory/inventory.module';
import { CompanyModule } from './company/company.module';
import { SyncModule } from './sync/sync.module';
import { AdminModule } from './admin/admin.module';
import { CycleCountsModule } from './cycle-counts/cycle-counts.module';
import { AppThrottlerGuard } from './common/app-throttler.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    DatabaseModule,
    TenancyModule,
    AuthModule,
    InventoryModule,
    CompanyModule,
    SyncModule,
    AdminModule,
    CycleCountsModule,
  ],
  controllers: [AppController],
  providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
})
export class AppModule {}
