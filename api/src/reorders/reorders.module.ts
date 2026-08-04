import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReordersController } from './reorders.controller';
import { ReorderContractService, ReordersService } from './reorders.service';

@Module({
  imports: [AuthModule],
  controllers: [ReordersController],
  providers: [ReordersService, ReorderContractService],
  // SyncModule consumes the contract half for the ERP-facing endpoints.
  exports: [ReorderContractService],
})
export class ReordersModule {}
