import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { DatabaseModule } from './db/database.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { AuthModule } from './auth/auth.module';
import { InventoryModule } from './inventory/inventory.module';
import { CompanyModule } from './company/company.module';
import { ProductsModule } from './products/products.module';
import { SyncModule } from './sync/sync.module';
import { AdminModule } from './admin/admin.module';
import { CycleCountsModule } from './cycle-counts/cycle-counts.module';
import { LocationsModule } from './locations/locations.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReordersModule } from './reorders/reorders.module';
import { ReleasesModule } from './releases/releases.module';
import { ReportsModule } from './reports/reports.module';
import { MailModule } from './mail/mail.module';
import { AuditModule } from './audit/audit.module';
import { AppThrottlerGuard } from './common/app-throttler.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    DatabaseModule,
    TenancyModule,
    AuthModule,
    InventoryModule,
    CompanyModule,
    ProductsModule,
    SyncModule,
    AdminModule,
    CycleCountsModule,
    LocationsModule,
    NotificationsModule,
    ReordersModule,
    ReleasesModule,
    ReportsModule,
    MailModule,
    // Global: every feature emits audit events, so nothing has to remember to import it.
    AuditModule,
  ],
  controllers: [AppController],
  providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
})
export class AppModule {}
