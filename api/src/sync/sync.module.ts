import { Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { ImportChecksService } from './import-checks.service';
import { ApiKeyGuard } from './api-key.guard';
import { ReordersModule } from '../reorders/reorders.module';

@Module({
  // The reorder contract endpoints live on this controller (they are X-Api-Key work)
  // but the logic belongs with the table that owns reorders.
  imports: [ReordersModule],
  controllers: [SyncController],
  providers: [SyncService, ImportChecksService, ApiKeyGuard],
  // Exported so the website's "check for imported inventory" button reuses the same
  // state machine as the agent loop rather than reimplementing it.
  exports: [ImportChecksService],
})
export class SyncModule {}
