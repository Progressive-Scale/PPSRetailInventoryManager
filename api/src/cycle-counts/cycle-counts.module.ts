import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CycleCountsController } from './cycle-counts.controller';
import { CycleCountsService } from './cycle-counts.service';

@Module({
  imports: [AuthModule],
  controllers: [CycleCountsController],
  providers: [CycleCountsService],
})
export class CycleCountsModule {}
