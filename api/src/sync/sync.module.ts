import { Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { ApiKeyGuard } from './api-key.guard';

@Module({
  controllers: [SyncController],
  providers: [SyncService, ApiKeyGuard],
})
export class SyncModule {}
