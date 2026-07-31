import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { TransactionsController } from './transactions.controller';
import { SyncModule } from '../sync/sync.module';

@Module({
  // SyncModule for ImportChecksService: the website's "check for imported
  // inventory" button drives the SAME state machine as the agent loop rather than
  // a parallel copy of it.
  imports: [AuthModule, SyncModule],
  controllers: [InventoryController, TransactionsController],
  providers: [InventoryService],
})
export class InventoryModule {}
