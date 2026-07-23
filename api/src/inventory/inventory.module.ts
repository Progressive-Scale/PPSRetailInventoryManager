import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { TransactionsController } from './transactions.controller';

@Module({
  imports: [AuthModule],
  controllers: [InventoryController, TransactionsController],
  providers: [InventoryService],
})
export class InventoryModule {}
